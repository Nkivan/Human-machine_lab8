// npm run perf:client -- --label before [--bots 8] [--seconds 30] [--no-build]
//
// A repeatable version of "DevTools -> Performance -> record 30 s" for the M3 before/after tables:
//   1. builds the client, starts the server (child process), adds N bots to a fresh room;
//   2. opens the game in Chrome with ?autopilot (scripted flight, trigger held) and ?perf=<seconds>;
//   3. PASS 1 (clean): the page's own recorder gives frame p50/p95/p99 + spans; a trace gives every GC pause;
//   4. PASS 2 (profilers on): CDP CPU profile -> top self-time functions; sampling heap profile -> top allocators;
//   5. writes perf/client-<label>.json + .md, and perf/<label>.cpuprofile / .heapprofile / -trace.json
//      (all three open in DevTools: Performance panel -> "Load profile", Memory panel -> "Load").
// Chrome: Playwright's own (npx playwright install chromium) or PW_CHROMIUM_EXECUTABLE=/path/to/chrome.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";
import { z } from "zod";
import type { DebugApi } from "../client/src/debug.ts"; // also brings the `window.__dogfight` declaration
import type { PerfReport } from "../client/src/perf.ts";

export type { DebugApi };
import { hotFunctions, topN, where, type CallFrame } from "../server/tools/cpuprofile.ts";
import { argValue, createRoom, postJson, sleep, startServer } from "../server/tools/serverproc.ts";

const label = argValue("label", "run");
const bots = Number(argValue("bots", "8"));
const seconds = Number(argValue("seconds", "30"));
const profileSeconds = Number(argValue("profile-seconds", "15"));
const port = Number(argValue("port", "3300"));
const throttle = Number(argValue("throttle", "1")); // DevTools "CPU throttling": 4 = a weak laptop
const extra = argValue("params", ""); // extra URL params, e.g. "particles=worker"
const outDir = path.resolve("perf");
mkdirSync(outDir, { recursive: true });

if (!process.argv.includes("--no-build")) {
  // Same code as `npm run build`, but NOT minified (+ source maps): profiles then show real function names
  // (sample, toItem, decodeServer...) instead of `df` and `Rl`.
  const build = spawnSync("npx", ["vite", "build", "--minify", "false", "--sourcemap", "--logLevel", "warn"], {
    cwd: "client",
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

// ---------- helpers: heap sampling -> top-N table (CPU profiles: ../server/tools/cpuprofile.ts) ----------
interface HeapNode {
  callFrame: CallFrame;
  selfSize: number;
  children: HeapNode[];
}
function allocations(head: HeapNode): { total: number; byFn: Map<string, number> } {
  const byFn = new Map<string, number>();
  let total = 0;
  const walk = (n: HeapNode): void => {
    if (n.selfSize) {
      const key = where(n.callFrame);
      byFn.set(key, (byFn.get(key) ?? 0) + n.selfSize);
      total += n.selfSize;
    }
    n.children.forEach(walk);
  };
  walk(head);
  return { total, byFn };
}

// A trace file is input like any other: parsed by a schema, not cast.
const TraceFile = z.object({
  traceEvents: z.array(
    z.object({
      name: z.string(),
      ph: z.string(),
      dur: z.number().optional(),
      pid: z.number(),
      tid: z.number(),
      args: z.object({ name: z.string().optional() }).loose().optional(),
    }),
  ),
});
function gcPauses(file: string): Record<string, { count: number; totalMs: number; maxMs: number }> {
  const events = TraceFile.parse(JSON.parse(readFileSync(file, "utf8"))).traceEvents;
  const threads = new Map<string, string>();
  for (const e of events) if (e.name === "thread_name" && e.args?.name) threads.set(`${e.pid}:${e.tid}`, e.args.name);
  const out: Record<string, { count: number; totalMs: number; maxMs: number }> = {};
  for (const e of events) {
    if ((e.name !== "MinorGC" && e.name !== "MajorGC") || e.ph !== "X") continue; // DevTools' "Minor GC" / "Major GC"
    const thread = threads.get(`${e.pid}:${e.tid}`) ?? "?";
    if (thread !== "CrRendererMain") continue; // the page's main thread: the one that paints
    const ms = (e.dur ?? 0) / 1000;
    const s = (out[e.name] ??= { count: 0, totalMs: 0, maxMs: 0 });
    s.count++;
    s.totalMs += ms;
    s.maxMs = Math.max(s.maxMs, ms);
  }
  return out;
}

async function waitFor<T>(page: Page, fn: () => T | null, timeoutMs: number): Promise<T> {
  const handle = await page.waitForFunction(fn, undefined, { timeout: timeoutMs, polling: 250 });
  const value = await handle.jsonValue();
  if (value === null) throw new Error("waitForFunction resolved with null");
  return value;
}

// ---------- the run ----------
const server = await startServer({ port, env: { STATIC_DIR: "../client/dist", DEBUG_ROUTES: "1", MAX_BOTS: "64" } });
const browser = await chromium.launch({
  headless: true,
  ...(process.env["PW_CHROMIUM_EXECUTABLE"] ? { executablePath: process.env["PW_CHROMIUM_EXECUTABLE"] } : {}),
});
try {
  const roomId = await createRoom(server.base, "perf", { asteroids: 8, pickupEvery: 6, seed: 7 });
  await postJson(server.base, `/api/rooms/${roomId}/bots`, { count: bots });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("pageerror", (e) => console.error("[page]", e.message));
  const cdp = await page.context().newCDPSession(page);
  if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  const url = `${server.base}/?room=${roomId}&name=Perf&autopilot=1&perf=${seconds}${extra ? `&${extra}` : ""}`;
  console.log(`[perf] ${label}: ${bots} bots, CPU throttle x${throttle}, ${seconds} s recording -> ${url}`);
  await page.goto(url);
  await page.waitForFunction(() => window.__dogfight?.status() === "connected", undefined, { timeout: 20_000 });

  // PASS 1: no profiler attached. Trace only timeline/GC/user-timing events (cheap) during the recording window.
  await sleep(3000); // the page's recorder resets at +3 s (warm-up)
  const traceFile = path.join(outDir, `${label}-trace.json`);
  await browser.startTracing(page, {
    path: traceFile,
    categories: ["devtools.timeline", "v8", "blink.user_timing", "disabled-by-default-devtools.timeline"],
  });
  const report = await waitFor<PerfReport>(page, () => window.__dogfight?.perfReport() ?? null, (seconds + 30) * 1000);
  const markdown = await page.evaluate(() => window.__dogfight?.perfMarkdown() ?? "");
  await browser.stopTracing();
  const gc = gcPauses(traceFile);

  if (process.argv.includes("--no-profile")) {
    const short = {
      label,
      throttle,
      frames: report.frames,
      work: report.work,
      dropped: report.dropped,
      spans: report.spans,
      gc,
    };
    writeFileSync(path.join(outDir, `client-${label}.json`), JSON.stringify(short, null, 2));
    console.log(
      `${label}: dropped ${report.dropped}, frame p99 ${report.frames.p99}, work p99 ${report.work.p99}, ` +
        `minor ${gc["MinorGC"]?.count ?? 0} (${(gc["MinorGC"]?.totalMs ?? 0).toFixed(1)} ms), ` +
        `major ${gc["MajorGC"]?.count ?? 0} (${(gc["MajorGC"]?.totalMs ?? 0).toFixed(1)} ms)`,
    );
    process.exitCode = 0;
  } else {
    // PASS 2: CPU profile + allocation sampling (incl. objects already collected: we want WHO ALLOCATES, not who leaks).
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("HeapProfiler.enable");
    await cdp.send("Profiler.start");
    await cdp.send("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    await sleep(profileSeconds * 1000);
    const { profile } = await cdp.send("Profiler.stop");
    const { profile: heap } = await cdp.send("HeapProfiler.stopSampling");
    writeFileSync(path.join(outDir, `${label}.cpuprofile`), JSON.stringify(profile));
    writeFileSync(path.join(outDir, `${label}.heapprofile`), JSON.stringify(heap));

    const cpu = hotFunctions(profile, 10);
    const alloc = allocations(heap.head);
    const allocTop = topN(alloc.byFn, 10);
    const result = {
      label,
      bots,
      seconds,
      throttle,
      chrome: browser.version(),
      report,
      gc,
      allocMBperSec: alloc.total / 1024 / 1024 / profileSeconds,
      gcShareOfBusyCpu: cpu.busyMs ? cpu.gcMs / cpu.busyMs : 0,
      topSelfMs: cpu.rows,
      topAllocKB: allocTop.map(([fn, bytes]) => ({ fn, kb: +(bytes / 1024).toFixed(0) })),
    };
    writeFileSync(path.join(outDir, `client-${label}.json`), JSON.stringify(result, null, 2));

    const gcLine = (k: string): string => {
      const g = gc[k];
      return g ? `${g.count} pauses, ${g.totalMs.toFixed(1)} ms total, max ${g.maxMs.toFixed(2)} ms` : "0";
    };
    const md = [
      `### Client, ${label} (${bots} bots, CPU throttle x${throttle}, Chrome ${browser.version()}, headless)`,
      "",
      markdown,
      "",
      `- Minor GC (scavenge): ${gcLine("MinorGC")}`,
      `- Major GC (mark-compact): ${gcLine("MajorGC")}`,
      `- allocation rate (sampled, ${profileSeconds} s): ${result.allocMBperSec.toFixed(2)} MB/s; GC = ${(result.gcShareOfBusyCpu * 100).toFixed(1)} % of busy CPU`,
      "",
      "| top self time | ms | share |",
      "|---|---|---|",
      ...result.topSelfMs.map((r) => `| \`${r.fn}\` | ${r.ms} | ${(r.share * 100).toFixed(1)} % |`),
      "",
      "| top allocators | KB in " + `${profileSeconds} s |`,
      "|---|---|",
      ...result.topAllocKB.map((r) => `| \`${r.fn}\` | ${r.kb} |`),
    ].join("\n");
    writeFileSync(path.join(outDir, `client-${label}.md`), md + "\n");
    console.log(md);
  }
} finally {
  await browser.close();
  await server.stop();
}

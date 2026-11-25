// npm run loadtest -w server -- --label before [--ramp 8,32,64,128,192,256] [--measure 12]
// Spawns the server (child process), then for each N: N headless WebSocket clients join ONE room and fly scripted
// paths (30 inputs/s each, like the browser), warm up, then measure:
//   server tick p50/p95/p99, ticks/s actually achieved, event-loop utilization, RSS, bytes/s out,
//   snapshots/s each client actually received (the slow-client policy drops snapshots when a peer cannot keep up).
// Capacity = the largest N whose tick p99 stays under the 33.3 ms budget.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { encodeInputs } from "@dogfight/shared/codec/binary";
import { PROTOCOL_VERSION, TICK_MS } from "@dogfight/shared/protocol/constants";
import { asSeq } from "@dogfight/shared/protocol/ids";
import type { Input } from "@dogfight/shared/sim/shipmove";
import { argValue, createRoom, getStats, serverDir, sleep, startServer } from "./serverproc.ts";

const label = argValue("label", "run");
const ramp = argValue("ramp", "8,32,64,128,192,256").split(",").map(Number);
const warmup = Number(argValue("warmup", "4"));
const measure = Number(argValue("measure", "12"));
const port = Number(argValue("port", "3500"));
const perfDir = path.resolve(serverDir, "..", "perf");
mkdirSync(perfDir, { recursive: true });

interface Client {
  readonly ws: WebSocket;
  readonly index: number;
  seq: number;
  readonly recent: Input[];
  binFrames: number;
}

function connect(base: string, room: string, index: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`, { perMessageDeflate: false });
    const c: Client = { ws, index, seq: 0, recent: [], binFrames: 0 };
    ws.on("message", (_data, isBinary) => {
      if (isBinary) c.binFrames++; // snapshots: counted, not decoded (the generator must stay cheap)
    });
    ws.once("open", () => {
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "join", room, name: `load${index}` }));
      resolve(c);
    });
    ws.once("error", reject);
  });
}

// A scripted pilot per client: different phase per index, mostly thrusting, firing two thirds of the time.
function nextInput(c: Client): Input {
  const i = (c.seq + c.index * 17) % 120;
  return {
    seq: asSeq(++c.seq),
    turn: i < 35 ? 1 : i < 60 ? 0 : i < 95 ? -1 : 0,
    thrust: i % 30 < 21,
    fire: (c.seq + c.index) % 30 < 20,
  };
}

const cpuProf = process.argv.includes("--cpu-prof"); // also profile the server: perf/server-load-<label>.cpuprofile
const server = await startServer({
  port,
  nodeArgs: cpuProf
    ? ["--cpu-prof", `--cpu-prof-dir=${perfDir}`, `--cpu-prof-name=server-load-${label}.cpuprofile`]
    : [],
  env: {
    MAX_PLAYERS: "512",
    MAX_ROOMS: "50",
    LOG_DIR: path.join(perfDir, "logs"),
    TICK_STATS_WINDOW: String(measure * 30),
  },
});
const rows: Record<string, number | string>[] = [];
try {
  for (const n of ramp) {
    const roomId = await createRoom(server.base, `load-${n}`, { asteroids: 6, pickupEvery: 8, seed: n });
    const clients: Client[] = [];
    for (let i = 0; i < n; i += 16) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(16, n - i) }, (_, k) => connect(server.base, roomId, i + k)),
      );
      clients.push(...batch);
    }
    // ONE timer drives every client (not N timers): 30 inputs/s each, the last 3 repeated like the browser does.
    const timer = setInterval(() => {
      for (const c of clients) {
        if (c.ws.readyState !== WebSocket.OPEN) continue;
        c.recent.push(nextInput(c));
        if (c.recent.length > 3) c.recent.shift();
        c.ws.send(encodeInputs(c.recent));
      }
    }, TICK_MS);

    await sleep(warmup * 1000);
    const s0 = await getStats(server.base);
    const frames0 = clients.reduce((a, c) => a + c.binFrames, 0);
    const t0 = performance.now();
    const elu: number[] = [];
    let rss = 0;
    for (let t = 0; t < measure; t++) {
      await sleep(1000);
      const s = await getStats(server.base);
      elu.push(s.elu);
      rss = Math.max(rss, s.rss);
    }
    const s1 = await getStats(server.base);
    const dt = (performance.now() - t0) / 1000;
    const frames1 = clients.reduce((a, c) => a + c.binFrames, 0);
    const m1 = s1.matches.find((m) => m.room === roomId);
    const m0 = s0.matches.find((m) => m.room === roomId);
    clearInterval(timer);
    for (const c of clients) c.ws.close();
    await sleep(1500); // the empty room is deleted, its match stops

    const row = {
      n,
      tickP50: m1?.p50Ms ?? 0,
      tickP95: m1?.p95Ms ?? 0,
      tickP99: m1?.p99Ms ?? 0,
      tickMax: m1?.maxMs ?? 0,
      ticksPerSec: m1 && m0 ? (m1.ticks - m0.ticks) / dt : 0,
      elu: elu.reduce((a, b) => a + b, 0) / elu.length,
      rssMB: rss / 1048576,
      outMBps: (s1.traffic.bytesOut - s0.traffic.bytesOut) / dt / 1048576,
      snapsPerClient: (frames1 - frames0) / dt / n,
    };
    rows.push(row);
    console.log(
      `[load] N=${n}: tick p50 ${row.tickP50} p99 ${row.tickP99} ms, ${row.ticksPerSec.toFixed(1)} ticks/s, ` +
        `ELU ${(row.elu * 100).toFixed(0)} %, RSS ${row.rssMB.toFixed(0)} MB, out ${row.outMBps.toFixed(2)} MB/s, ` +
        `${row.snapsPerClient.toFixed(1)} snapshots/s per client`,
    );
    if (row.tickP99 > TICK_MS * 2) break; // far past the budget: no point going higher
  }
} finally {
  await server.stop();
}

// Capacity: tick p99 within the 33.3 ms budget AND every client still gets (almost) all 30 snapshots per second.
// Past ~300 MB/s the slow-client policy drops snapshots: the tick looks fine, but the players do not get the game.
const capacity = rows
  .filter((r) => Number(r["tickP99"]) <= TICK_MS && Number(r["snapsPerClient"]) >= 29)
  .reduce((a, r) => Math.max(a, Number(r["n"])), 0);
writeFileSync(path.join(perfDir, `loadtest-${label}.json`), JSON.stringify({ label, capacity, rows }, null, 2));
const f = (x: number | string | undefined, d = 2): string => Number(x).toFixed(d);
const md = [
  `### Load test, ${label} (capacity N = ${capacity}: tick p99 <= 33.3 ms and >= 29 snapshots/s per client)`,
  "",
  "| N | tick p50 ms | tick p95 ms | tick p99 ms | ticks/s | ELU | RSS MB | out MB/s | snapshots/s per client |",
  "|---|---|---|---|---|---|---|---|---|",
  ...rows.map(
    (r) =>
      `| ${r["n"]} | ${f(r["tickP50"])} | ${f(r["tickP95"])} | ${f(r["tickP99"])} | ${f(r["ticksPerSec"], 1)} | ` +
      `${f(Number(r["elu"]) * 100, 0)} % | ${f(r["rssMB"], 0)} | ${f(r["outMBps"])} | ${f(r["snapsPerClient"], 1)} |`,
  ),
].join("\n");
writeFileSync(path.join(perfDir, `loadtest-${label}.md`), md + "\n");
console.log(md);

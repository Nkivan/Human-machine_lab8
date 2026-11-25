// npm run profile:match -w server -- --label before [--bots 8] [--seconds 60]
// "node --cpu-prof server.ts" for a whole match: starts the server under the V8 CPU profiler, fills a room with bots,
// lets it play, stops it gracefully (the profile is written on exit), then prints:
//   - tick time p50/p95/p99 over the WHOLE match (TICK_STATS_WINDOW covers every tick),
//   - event-loop utilization and RSS,
//   - the top self-time functions (the Bottom-Up view of DevTools).
// The .cpuprofile lands in ../perf/ and opens in Chrome DevTools (Performance -> Load profile) as a flame chart.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CpuProfile, hotFunctions } from "./cpuprofile.ts";
import { argValue, createRoom, getStats, postJson, serverDir, sleep, startServer } from "./serverproc.ts";

const label = argValue("label", "run");
const bots = Number(argValue("bots", "8"));
const seconds = Number(argValue("seconds", "60"));
const port = Number(argValue("port", "3400"));
const perfDir = path.resolve(serverDir, "..", "perf");
mkdirSync(perfDir, { recursive: true });
const profName = `server-${label}-${bots}bots.cpuprofile`;

const server = await startServer({
  port,
  nodeArgs: ["--cpu-prof", `--cpu-prof-dir=${perfDir}`, `--cpu-prof-name=${profName}`],
  env: { MAX_BOTS: "128", TICK_STATS_WINDOW: String(seconds * 30 + 300), LOG_DIR: path.join(perfDir, "logs") },
});
const roomId = await createRoom(server.base, "profile", { asteroids: 8, pickupEvery: 6, seed: 7 });
await postJson(server.base, `/api/rooms/${roomId}/bots`, { count: bots });
console.log(`[profile] ${label}: ${bots} bots for ${seconds} s (room ${roomId})`);

const elu: number[] = [];
let rss = 0;
for (let t = 0; t < seconds; t++) {
  await sleep(1000);
  const s = await getStats(server.base);
  if (t >= 2) elu.push(s.elu); // skip start-up
  rss = Math.max(rss, s.rss);
}
const match = (await getStats(server.base)).matches.find((m) => m.room === roomId);
await server.stop();

const profile = CpuProfile.parse(JSON.parse(readFileSync(path.join(perfDir, profName), "utf8")));
const hot = hotFunctions(profile, 12);
const avgElu = elu.reduce((a, b) => a + b, 0) / Math.max(1, elu.length);
const result = { label, bots, seconds, match, elu: avgElu, rssMB: rss / 1024 / 1024, ...hot };
writeFileSync(path.join(perfDir, `server-${label}-${bots}bots.json`), JSON.stringify(result, null, 2));

const md = [
  `### Server, ${label}: ${bots} bots, ${seconds} s match`,
  "",
  match
    ? `tick p50 ${match.p50Ms} ms, p95 ${match.p95Ms} ms, **p99 ${match.p99Ms} ms**, max ${match.maxMs} ms ` +
      `(${match.ticks} ticks, ${match.overruns} over 33 ms); ELU ${(avgElu * 100).toFixed(1)} %; RSS ${(rss / 1048576).toFixed(0)} MB; ` +
      `GC ${((hot.gcMs / Math.max(1, hot.busyMs)) * 100).toFixed(1)} % of busy CPU`
    : "(no match stats)",
  "",
  "| self time | ms | share of busy |",
  "|---|---|---|",
  ...hot.rows.map((r) => `| \`${r.fn}\` | ${r.ms} | ${(r.share * 100).toFixed(1)} % |`),
].join("\n");
writeFileSync(path.join(perfDir, `server-${label}-${bots}bots.md`), md + "\n");
console.log(md);

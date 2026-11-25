// tsx tools/rss-sampler.ts [seconds]  -> CSV "seconds,rss_mb" from /api/stats every 500 ms (paste into a spreadsheet and chart it)
import { z } from "zod";

const Stats = z.object({ rss: z.number() });
const base = process.env["BASE"] ?? "http://127.0.0.1:3000";
const seconds = Number(process.argv[2] ?? 60);
const t0 = Date.now();
console.log("seconds,rss_mb");
const timer = setInterval(() => {
  void (async () => {
    try {
      const { rss } = Stats.parse(await (await fetch(`${base}/api/stats`)).json());
      console.log(`${((Date.now() - t0) / 1000).toFixed(1)},${(rss / 1024 / 1024).toFixed(1)}`);
    } catch (err) {
      console.error("sample failed:", err instanceof Error ? err.message : err);
    }
    if (Date.now() - t0 > seconds * 1000) clearInterval(timer);
  })();
}, 500);

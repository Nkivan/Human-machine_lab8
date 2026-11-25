// npx tsx tools/chart.ts -> docs/capacity.svg : server tick p99 vs number of clients, before and after (load test JSON).
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

const File = z.object({
  capacity: z.number(),
  rows: z.array(z.object({ n: z.number(), tickP99: z.number(), snapsPerClient: z.number() })),
});
const series = [
  {
    name: "before (Lab 6 server)",
    color: "#2a78d6",
    data: File.parse(JSON.parse(readFileSync("perf/loadtest-before.json", "utf8"))),
  },
  {
    name: "after (Lab 7 fixes)",
    color: "#eb6834",
    data: File.parse(JSON.parse(readFileSync("perf/loadtest-after.json", "utf8"))),
  },
];
const W = 760,
  H = 430,
  L = 60,
  R = 170,
  T = 50,
  B = 70;
const maxN = 640,
  maxY = 45;
const x = (n: number): number => L + (n / maxN) * (W - L - R);
const y = (v: number): number => T + (1 - v / maxY) * (H - T - B);
const out: string[] = [];
out.push(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif" font-size="12">`,
);
out.push(`<rect width="${W}" height="${H}" fill="#fcfcfb"/>`);
out.push(
  `<text x="${L}" y="24" font-size="15" font-weight="600" fill="#1f1f1d">Server tick p99 vs. clients in one room</text>`,
);
for (let v = 0; v <= 40; v += 10) {
  out.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e4e3df"/>`);
  out.push(`<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" fill="#6b6a64">${v}</text>`);
}
for (const n of [0, 128, 256, 384, 512, 640])
  out.push(`<text x="${x(n)}" y="${H - B + 18}" text-anchor="middle" fill="#6b6a64">${n}</text>`);
out.push(`<text x="${(L + W - R) / 2}" y="${H - B + 36}" text-anchor="middle" fill="#45443f">clients (N)</text>`);
out.push(
  `<text x="16" y="${(T + H - B) / 2}" transform="rotate(-90 16 ${(T + H - B) / 2})" text-anchor="middle" fill="#45443f">tick p99, ms</text>`,
);
out.push(`<line x1="${L}" x2="${W - R}" y1="${y(33.3)}" y2="${y(33.3)}" stroke="#6b6a64" stroke-dasharray="4 4"/>`);
out.push(`<text x="${W - R + 6}" y="${y(33.3) + 4}" fill="#45443f">33.3 ms budget</text>`);
for (const s of series) {
  const pts = s.data.rows.map((r) => `${x(r.n)},${y(r.tickP99)}`).join(" ");
  out.push(`<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`);
  for (const r of s.data.rows) {
    out.push(
      `<circle cx="${x(r.n)}" cy="${y(r.tickP99)}" r="4" fill="${s.color}" stroke="#fcfcfb" stroke-width="2"><title>${s.name}: N=${r.n}, p99 ${r.tickP99.toFixed(1)} ms, ${r.snapsPerClient.toFixed(1)} snapshots/s per client</title></circle>`,
    );
  }
  out.push(
    `<line x1="${x(s.data.capacity)}" x2="${x(s.data.capacity)}" y1="${T}" y2="${H - B}" stroke="${s.color}" stroke-width="1" stroke-dasharray="2 3"/>`,
  );
  out.push(`<text x="${x(s.data.capacity) + 4}" y="${T + 12}" fill="#45443f">capacity ${s.data.capacity}</text>`);
}
// legend (identity is never color alone: names next to swatches)
series.forEach((s, i) => {
  out.push(
    `<line x1="${W - R + 6}" x2="${W - R + 26}" y1="${T + 40 + i * 20}" y2="${T + 40 + i * 20}" stroke="${s.color}" stroke-width="2"/>`,
  );
  out.push(`<text x="${W - R + 32}" y="${T + 44 + i * 20}" fill="#1f1f1d">${s.name}</text>`);
});
out.push(
  `<text x="${L}" y="${H - 8}" fill="#6b6a64" font-size="11">After N=512 the tick is fine but each client gets only 24 of 30 snapshots/s (~300 MB/s send cap).</text>`,
);
out.push("</svg>");
writeFileSync("docs/capacity.svg", out.join("\n"));
console.log("docs/capacity.svg");

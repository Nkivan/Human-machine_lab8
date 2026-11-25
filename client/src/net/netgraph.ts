import type { View } from "../render/canvas.ts";
import type { NetStats } from "./netstats.ts";

function strip(
  ctx: CanvasRenderingContext2D,
  data: readonly number[],
  x: number,
  y: number,
  w: number,
  h: number,
  max: number,
  color: string,
): void {
  ctx.strokeStyle = "#16203a";
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = color;
  const bw = w / 120;
  for (let i = 0; i < data.length; i++) {
    const bh = Math.min(1, (data[i] ?? 0) / max) * h;
    ctx.fillRect(x + i * bw, y + h - bh, Math.max(1, bw - 0.5), bh);
  }
}

// The seven text lines are rebuilt at most 4 times per second (numbers you can read do not change faster).
let cachedLines: string[] = [];
let cachedAt = -Infinity;

export interface NetgraphInfo {
  readonly stats: NetStats;
  readonly ageMs: number;
  readonly pending: number;
  readonly interpDelay: number;
  readonly status: string;
}

// The instrument for the whole lab: RTT, snapshot age, bytes/s, pending inputs, correction magnitude.
export function drawNetgraph(
  ctx: CanvasRenderingContext2D,
  view: View,
  { stats, ageMs, pending, interpDelay, status }: NetgraphInfo,
): void {
  const s = stats.data;
  const x = view.cssW - 300;
  ctx.save();
  ctx.font = "12px ui-monospace, monospace";
  ctx.fillStyle = "rgba(5, 7, 13, 0.7)";
  ctx.fillRect(x - 8, 8, 304, 190);
  ctx.fillStyle = "#e6edf7";
  const sim = s.simSettings;
  const now = performance.now();
  if (now - cachedAt > 250) {
    cachedAt = now;
    cachedLines = [
      `net: ${status}`,
      `RTT ${s.rtt.toFixed(0)} ms (jitter ${s.rttJitter.toFixed(0)})`,
      `snapshot age ${ageMs.toFixed(0)} ms   interp delay ${interpDelay.toFixed(0)} ms`,
      `in ${(s.inRate / 1024).toFixed(1)} KB/s   out ${(s.outRate / 1024).toFixed(2)} KB/s`,
      `pending inputs ${pending}`,
      `correction ${s.corrLast.toFixed(3)} px   max/s ${s.corrMax.toFixed(2)} px`,
      `injector: rtt ${sim.latency} ms  jitter ${sim.jitter}  drop ${(sim.drop * 100).toFixed(0)}%`,
    ];
  }
  for (let i = 0; i < cachedLines.length; i++) ctx.fillText(cachedLines[i] ?? "", x, 26 + i * 16);
  ctx.fillStyle = "#7d88a8";
  ctx.fillText("RTT", x, 148);
  strip(ctx, s.rttHistory, x + 30, 138, 250, 20, 300, "#3b6cff");
  ctx.fillStyle = "#7d88a8";
  ctx.fillText("corr", x, 176);
  strip(ctx, s.corrHistory, x + 30, 164, 250, 20, 20, "#ff6b6b");
  ctx.fillStyle = "#7d88a8";
  ctx.fillText("L = injector  [ ] = interp delay  N = netgraph", x - 8, 214);
  ctx.restore();
}

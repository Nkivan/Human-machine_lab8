import { ARENA } from "@dogfight/shared/sim/arena";
import type { LoopStats } from "../loop.ts";
import type { View } from "./canvas.ts";

export function drawBackground(ctx: CanvasRenderingContext2D, view: View): void {
  ctx.fillStyle = "#05070d";
  ctx.fillRect(0, 0, view.cssW, view.cssH);
  ctx.save();
  ctx.translate(view.offsetX, view.offsetY);
  ctx.scale(view.scale, view.scale);
  ctx.fillStyle = "#0a0f1c";
  ctx.fillRect(0, 0, ARENA.width, ARENA.height);
  ctx.strokeStyle = "#16203a";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= ARENA.width; x += 80) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, ARENA.height);
  }
  for (let y = 0; y <= ARENA.height; y += 80) {
    ctx.moveTo(0, y);
    ctx.lineTo(ARENA.width, y);
  }
  ctx.stroke();
  ctx.strokeStyle = "#2c3e6b";
  ctx.strokeRect(0, 0, ARENA.width, ARENA.height);
  ctx.restore();
}

// Text lines change a few times per second, not every frame: the caller caches them (see hudText in game.ts).
// Lab 6 rebuilt three template strings and an array (plus a forEach closure) on every frame.
export function loopLines(stats: LoopStats): string[] {
  return [
    `steps/s : ${stats.stepsPerSec.toFixed(1)}`,
    `frames/s: ${stats.fps.toFixed(1)}`,
    `frame ms: ${stats.frameMs.toFixed(1)}`,
  ];
}

export function drawHud(
  ctx: CanvasRenderingContext2D,
  stats: LoopStats,
  loop: readonly string[],
  extra: readonly string[],
): void {
  ctx.save();
  ctx.font = "14px ui-monospace, monospace";
  ctx.fillStyle = stats.frameMs > 16.7 * 1.5 ? "#ff6b6b" : "#9be28f";
  for (let i = 0; i < loop.length; i++) ctx.fillText(loop[i] ?? "", 12, 22 + i * 18);
  ctx.fillStyle = "#e6edf7";
  for (let i = 0; i < extra.length; i++) ctx.fillText(extra[i] ?? "", 12, 82 + i * 18);
  ctx.restore();
}

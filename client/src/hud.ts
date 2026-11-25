import type { GameBus } from "./events.ts";
import type { View } from "./render/canvas.ts";

interface Popup {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly born: number;
}

// Floating "+10" popups. Subscribes to the "score" event; the sim never imports this.
export function createHud(bus: GameBus): { draw(ctx: CanvasRenderingContext2D, view: View, now: number): void } {
  const popups: Popup[] = [];
  bus.on("pickup", ({ type, x, y }) => {
    popups.push({ text: type.toUpperCase(), x, y, born: performance.now() }); // "SHIELD", "RAPID", "HOMING"
  });
  bus.on("score", ({ delta, x, y }) => {
    popups.push({ text: `+${delta}`, x, y, born: performance.now() });
  });
  return {
    draw(ctx, view, now) {
      let keep = 0; // in-place filter: no new array per frame
      for (const p of popups) if (now - p.born < 900) popups[keep++] = p;
      popups.length = keep;
      if (keep === 0) return;
      ctx.save();
      ctx.translate(view.offsetX, view.offsetY);
      ctx.scale(view.scale, view.scale);
      ctx.font = "bold 18px ui-monospace, monospace";
      ctx.textAlign = "center";
      for (const p of popups) {
        const t = (now - p.born) / 900;
        ctx.globalAlpha = 1 - t;
        ctx.fillStyle = "#ffe27a";
        ctx.fillText(p.text, p.x, p.y - 20 - t * 30);
      }
      ctx.restore();
    },
  };
}

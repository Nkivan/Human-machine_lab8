import { ARENA } from "@dogfight/shared/sim/arena";

export interface View {
  scale: number;
  offsetX: number;
  offsetY: number;
  cssW: number;
  cssH: number;
  dpr: number;
}

// DPR-aware canvas; the world (ARENA) is scaled to fit the window, letterboxed.
export function setupCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; view: View } {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is not available");
  const view: View = { scale: 1, offsetX: 0, offsetY: 0, cssW: 0, cssH: 0, dpr: 1 };

  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    view.dpr = dpr;
    view.cssW = window.innerWidth;
    view.cssH = window.innerHeight;
    canvas.width = Math.round(view.cssW * dpr);
    canvas.height = Math.round(view.cssH * dpr);
    view.scale = Math.min(view.cssW / ARENA.width, view.cssH / ARENA.height);
    view.offsetX = (view.cssW - ARENA.width * view.scale) / 2;
    view.offsetY = (view.cssH - ARENA.height * view.scale) / 2;
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  window.addEventListener("resize", resize);
  resize();
  return { ctx, view };
}

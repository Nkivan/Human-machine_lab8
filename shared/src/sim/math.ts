export const TAU = Math.PI * 2;
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// Shortest-path angle interpolation (fixes the 359 -> 1 degree spin bug).
export function lerpAngle(a: number, b: number, t: number): number {
  const d = ((((b - a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  return a + d * t;
}

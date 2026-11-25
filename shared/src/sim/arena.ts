import type { MutVec2 } from "./vector.ts";

export const ARENA = { width: 1280, height: 720 } as const;

export function wrapPos(p: MutVec2): void {
  p.x = ((p.x % ARENA.width) + ARENA.width) % ARENA.width;
  p.y = ((p.y % ARENA.height) + ARENA.height) % ARENA.height;
}

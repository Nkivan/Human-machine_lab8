import { asSeq } from "../protocol/ids.ts";
import { Ship } from "./ship.ts";
import type { Input } from "./shipmove.ts";
import { World } from "./world.ts";

const STEP = 1 / 30;
const cmd = (turn: -1 | 0 | 1, thrust: boolean, fire: boolean): Input => ({ seq: asSeq(0), turn, thrust, fire });

// Same inputs -> same hash, on every machine/engine. Run it in Node AND in the browser console and compare.
export function simHash(steps = 1000): string {
  const world = new World(42, { asteroids: 5 });
  const a = world.spawn(new Ship({ x: 300, y: 300 }));
  const b = world.spawn(new Ship({ x: 900, y: 400 }));
  for (let i = 0; i < steps; i++) {
    const ia = cmd(i % 90 < 30 ? 1 : i % 90 < 45 ? 0 : -1, i % 50 < 35, i % 7 === 0);
    const ib = cmd(i % 60 < 20 ? -1 : 1, i % 40 < 25, i % 11 === 0);
    world.step(
      STEP,
      new Map([
        [a.id, [ia]],
        [b.id, [ib]],
      ]),
    );
  }
  let h = 0x811c9dc5; // FNV-1a
  const feed = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const e of world) {
    feed(
      `${e.kind}:${e.pos.x.toFixed(9)},${e.pos.y.toFixed(9)},${e.vel.x.toFixed(9)},${e.vel.y.toFixed(9)},${e.angle.toFixed(3)};`,
    );
  }
  feed(JSON.stringify([...world.scores.values()]));
  return h.toString(16).padStart(8, "0");
}

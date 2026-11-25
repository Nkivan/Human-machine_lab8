import { ARENA } from "./arena.ts";
import type { AnyEntity, World } from "./world.ts";

// The naive O(n^2) version: kept as the REFERENCE (a property test checks the spatial hash against it).
export function findCollisions(world: World): [AnyEntity, AnyEntity][] {
  const list: AnyEntity[] = [];
  for (const e of world) if (e.alive) list.push(e);
  const pairs: [AnyEntity, AnyEntity][] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (!a || !b) continue; // noUncheckedIndexedAccess: indexing can be undefined, even inside a loop
      const r = a.radius + b.radius;
      const dx = a.pos.x - b.pos.x;
      const dy = a.pos.y - b.pos.y;
      if (dx * dx + dy * dy <= r * r) pairs.push([a, b]);
    }
  }
  return pairs;
}

// Uniform-grid spatial hash (Lab 7). Added only after measurement: at 512 clients findCollisions was the server's
// second hottest function (7.9 % of CPU) once snapshot encoding was fixed.
//  - cell size >= the largest possible r_a + r_b (2 x 40 px asteroids), so overlapping circles are always in the same
//    or a neighbouring cell: checking the 3x3 neighbourhood finds every pair the naive loop finds;
//  - each pair is reported once (only j > i) and the pairs are SORTED by (i, j): exactly the naive order, so collision
//    resolution, and therefore the whole simulation, stays bit-identical (the determinism hash does not change);
//  - every buffer is preallocated and reused: no allocation per tick once warmed up.
export const CELL = 80;

export class SpatialHash {
  readonly #cols = Math.ceil(ARENA.width / CELL);
  readonly #rows = Math.ceil(ARENA.height / CELL);
  readonly #head = new Int32Array(this.#cols * this.#rows);
  #next = new Int32Array(256);
  #cellOf = new Int32Array(256);
  #keys = new Float64Array(1024); // i * n + j (exact in a double for any realistic n)
  readonly #list: AnyEntity[] = [];
  #pairCount = 0;

  // Calls `fn(a, b)` for every overlapping pair, in the same order as findCollisions().
  forEachPair(world: World, fn: (a: AnyEntity, b: AnyEntity) => void): void {
    const list = this.#list;
    list.length = 0;
    for (const e of world) if (e.alive) list.push(e);
    const n = list.length;
    if (this.#next.length < n) {
      this.#next = new Int32Array(n * 2);
      this.#cellOf = new Int32Array(n * 2);
    }
    this.#head.fill(-1);
    const cols = this.#cols;
    const rows = this.#rows;
    // Insert back to front so each cell's linked list is in ascending index order (not required, but tidy).
    for (let i = n - 1; i >= 0; i--) {
      const e = list[i];
      if (!e) continue;
      const cx = Math.min(cols - 1, Math.max(0, Math.floor(e.pos.x / CELL)));
      const cy = Math.min(rows - 1, Math.max(0, Math.floor(e.pos.y / CELL)));
      const c = cy * cols + cx;
      this.#cellOf[i] = c;
      this.#next[i] = this.#head[c] ?? -1;
      this.#head[c] = i;
    }
    this.#pairCount = 0;
    for (let i = 0; i < n; i++) {
      const a = list[i];
      if (!a) continue;
      const c = this.#cellOf[i] ?? 0;
      const cx = c % cols;
      const cy = (c - cx) / cols;
      for (let ny = Math.max(0, cy - 1); ny <= Math.min(rows - 1, cy + 1); ny++) {
        for (let nx = Math.max(0, cx - 1); nx <= Math.min(cols - 1, cx + 1); nx++) {
          for (let j = this.#head[ny * cols + nx] ?? -1; j !== -1; j = this.#next[j] ?? -1) {
            if (j <= i) continue; // each pair once, i < j like the naive loop
            const b = list[j];
            if (!b) continue;
            const r = a.radius + b.radius;
            const dx = a.pos.x - b.pos.x;
            const dy = a.pos.y - b.pos.y;
            if (dx * dx + dy * dy <= r * r) this.#push(i * n + j);
          }
        }
      }
    }
    const keys = this.#keys.subarray(0, this.#pairCount).sort(); // numeric sort: the naive (i, j) order
    for (const k of keys) {
      const j = k % n;
      const a = list[(k - j) / n];
      const b = list[j];
      if (a && b) fn(a, b);
    }
  }

  #push(key: number): void {
    if (this.#pairCount === this.#keys.length) {
      const bigger = new Float64Array(this.#keys.length * 2);
      bigger.set(this.#keys);
      this.#keys = bigger;
    }
    this.#keys[this.#pairCount++] = key;
  }
}

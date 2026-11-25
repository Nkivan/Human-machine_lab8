// Explosion particles as an OBJECT POOL in structure-of-arrays form (Nystrom, "Object Pool"; Lab 7).
// Lab 6 pushed a new {x, y, vx, vy, life} object per particle and removed dead ones with splice (O(n) each).
// Here the state lives in preallocated Float32Arrays: spawning writes 5 numbers, a dead particle is replaced by the
// last live one (swap-remove, O(1)), and nothing is allocated after the pool has grown to its working size.
// Pure (no DOM): the same class runs on the main thread and inside particles.worker.ts.

export class Particles {
  count = 0;
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  life: Float32Array;

  constructor(capacity = 256) {
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
  }

  get capacity(): number {
    return this.x.length;
  }

  #grow(): void {
    const cap = this.capacity * 2; // rare: doubling, and the pool never shrinks
    const g = (a: Float32Array): Float32Array => {
      const b = new Float32Array(cap);
      b.set(a);
      return b;
    };
    this.x = g(this.x);
    this.y = g(this.y);
    this.vx = g(this.vx);
    this.vy = g(this.vy);
    this.life = g(this.life);
  }

  spawn(x: number, y: number, vx: number, vy: number, life: number): void {
    if (this.count === this.capacity) this.#grow();
    const i = this.count++;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = life;
  }

  // An explosion: n particles in random directions (visual only, so Math.random is fine here).
  burst(x: number, y: number, n = 24, random: () => number = Math.random): void {
    for (let k = 0; k < n; k++) {
      const a = random() * Math.PI * 2;
      const sp = 40 + random() * 220;
      this.spawn(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.4 + random() * 0.5);
    }
  }

  update(dt: number): void {
    let i = 0;
    while (i < this.count) {
      const life = (this.life[i] ?? 0) - dt;
      if (life <= 0) {
        const last = --this.count; // swap-remove: move the last live particle into slot i
        this.x[i] = this.x[last] ?? 0;
        this.y[i] = this.y[last] ?? 0;
        this.vx[i] = this.vx[last] ?? 0;
        this.vy[i] = this.vy[last] ?? 0;
        this.life[i] = this.life[last] ?? 0;
        continue; // re-examine slot i (it now holds a different particle)
      }
      this.life[i] = life;
      this.x[i] = (this.x[i] ?? 0) + (this.vx[i] ?? 0) * dt;
      this.y[i] = (this.y[i] ?? 0) + (this.vy[i] ?? 0) * dt;
      i++;
    }
  }

  clear(): void {
    this.count = 0;
  }
}

// What the renderer needs: positions and life of `count` particles. The main-thread pool provides it directly;
// the worker variant provides a Float32Array of [x, y, life] triples it received (transferred) from the worker.
export interface ParticleView {
  readonly count: number;
  xAt(i: number): number;
  yAt(i: number): number;
  lifeAt(i: number): number;
}

export const viewOf = (p: Particles): ParticleView => ({
  get count() {
    return p.count;
  },
  xAt: (i) => p.x[i] ?? 0,
  yAt: (i) => p.y[i] ?? 0,
  lifeAt: (i) => p.life[i] ?? 0,
});

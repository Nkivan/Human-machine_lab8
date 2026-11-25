// Benchmark statistics, the same rules everywhere (client frames, server ticks, load test):
// report the median and the tail (p95/p99), never just the mean: a game feels its WORST frames, not its average one.

export interface Summary {
  readonly count: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

// Nearest-rank percentile on an ASCENDING sorted array (p in [0, 100]).
export function percentile(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const i = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[i] ?? 0;
}

export function summarize(values: ArrayLike<number>): Summary {
  const n = values.length;
  if (n === 0) return { count: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = Float64Array.from(values).sort(); // a typed-array sort is numeric (Array#sort would compare strings)
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i] ?? 0;
  return {
    count: n,
    mean: sum / n,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[n - 1] ?? 0,
  };
}

// Fixed-capacity ring of samples: recording is one store into a preallocated Float64Array (no allocation per sample).
export class SampleRing {
  readonly #data: Float64Array;
  #next = 0;
  #size = 0;

  constructor(capacity: number) {
    this.#data = new Float64Array(capacity);
  }

  get size(): number {
    return this.#size;
  }

  push(x: number): void {
    this.#data[this.#next] = x;
    this.#next = (this.#next + 1) % this.#data.length;
    if (this.#size < this.#data.length) this.#size++;
  }

  clear(): void {
    this.#next = 0;
    this.#size = 0;
  }

  // Oldest first. Allocates: call it when reporting, not per frame.
  values(): Float64Array {
    const cap = this.#data.length;
    const out = new Float64Array(this.#size);
    const start = this.#size < cap ? 0 : this.#next;
    for (let i = 0; i < this.#size; i++) out[i] = this.#data[(start + i) % cap] ?? 0;
    return out;
  }

  summary(): Summary {
    return summarize(this.values());
  }
}

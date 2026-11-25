// Client performance instrumentation (Lab 7).
//  - Every frame's interval and work time go into preallocated rings -> p50/p95/p99 at report time.
//  - Named spans (simulate, render, decode, reconcile, particles) are timed the same way, and with `marks` on they are
//    ALSO emitted with performance.measure(), so they appear in the DevTools Performance panel's "Timings" track.
// Pure (no DOM): `now` and `measure` are injectable, so it is unit-tested in Node.
import { SampleRing, summarize, type Summary } from "@dogfight/shared/stats";

export const SPANS = ["simulate", "render", "decode", "reconcile", "particles"] as const;
export type SpanName = (typeof SPANS)[number];
const SPAN_INDEX: Readonly<Record<SpanName, number>> = {
  simulate: 0,
  render: 1,
  decode: 2,
  reconcile: 3,
  particles: 4,
};

export const FRAME_BUDGET_MS = 1000 / 60;

export interface PerfReport {
  readonly seconds: number;
  readonly frames: Summary; // rAF-to-rAF interval: what the player sees (16.7 ms when nothing is dropped)
  readonly work: Summary; // time inside the rAF callback (simulate + render): the budget actually used
  readonly dropped: number; // frames whose interval exceeded 1.5x the 60 Hz budget (a visible hitch)
  readonly spans: Readonly<Record<SpanName, Summary>>;
}

export interface PerfOptions {
  readonly marks?: boolean; // emit performance.measure() for the DevTools timeline (only with ?perf: it allocates)
  readonly capacity?: number; // samples kept per series (ring buffers)
  readonly now?: () => number;
  readonly measure?: (name: string, start: number, end: number) => void;
  readonly clearMeasures?: () => void;
}

export interface Perf {
  readonly marks: boolean;
  begin(name: SpanName): void;
  end(name: SpanName): void;
  record(name: SpanName, ms: number): void; // a duration measured elsewhere (e.g. inside an event handler)
  frame(frameMs: number, workMs: number): void;
  reset(): void;
  report(): PerfReport;
}

export function createPerf({
  marks = false,
  capacity = 8192,
  now = () => performance.now(),
  measure = (name, start, end) => void performance.measure(name, { start, end }),
  clearMeasures = () => performance.clearMeasures(),
}: PerfOptions = {}): Perf {
  const frames = new SampleRing(capacity);
  const work = new SampleRing(capacity);
  const spans = SPANS.map(() => new SampleRing(capacity));
  const starts = new Float64Array(SPANS.length);
  let dropped = 0;
  let measures = 0;
  let firstFrameAt = 0;
  let lastFrameAt = 0;

  return {
    marks,
    begin(name) {
      starts[SPAN_INDEX[name]] = now();
    },
    end(name) {
      const i = SPAN_INDEX[name];
      const t = now();
      const start = starts[i] ?? t;
      spans[i]?.push(t - start);
      if (marks) {
        measure(name, start, t);
        // The performance timeline BUFFERS every entry: 300 measures/s would leak memory over a long session.
        // DevTools records them from the trace, so clearing the buffer loses nothing.
        if (++measures >= 1000) {
          clearMeasures();
          measures = 0;
        }
      }
    },
    record(name, ms) {
      spans[SPAN_INDEX[name]]?.push(ms);
    },
    frame(frameMs, workMs) {
      const t = now();
      if (!firstFrameAt) firstFrameAt = t;
      lastFrameAt = t;
      frames.push(frameMs);
      work.push(workMs);
      if (frameMs > FRAME_BUDGET_MS * 1.5) dropped++;
    },
    reset() {
      frames.clear();
      work.clear();
      for (const s of spans) s.clear();
      dropped = 0;
      firstFrameAt = lastFrameAt = 0;
    },
    report() {
      const bySpan: Partial<Record<SpanName, Summary>> = {};
      SPANS.forEach((name, i) => (bySpan[name] = spans[i]?.summary() ?? summarize([])));
      return {
        seconds: (lastFrameAt - firstFrameAt) / 1000,
        frames: frames.summary(),
        work: work.summary(),
        dropped,
        spans: {
          simulate: bySpan.simulate ?? summarize([]),
          render: bySpan.render ?? summarize([]),
          decode: bySpan.decode ?? summarize([]),
          reconcile: bySpan.reconcile ?? summarize([]),
          particles: bySpan.particles ?? summarize([]),
        },
      };
    },
  };
}

const f = (x: number): string => x.toFixed(2);

// Markdown, ready for the README.
export function formatReport(r: PerfReport): string {
  const row = (name: string, s: Summary): string =>
    `| ${name} | ${s.count} | ${f(s.p50)} | ${f(s.p95)} | ${f(s.p99)} | ${f(s.max)} |`;
  return [
    `${r.seconds.toFixed(1)} s, ${r.frames.count} frames, ${r.dropped} dropped (> 25 ms)`,
    "",
    "| series (ms) | n | p50 | p95 | p99 | max |",
    "|---|---|---|---|---|---|",
    row("frame interval", r.frames),
    row("frame work", r.work),
    ...SPANS.map((name) => row(name, r.spans[name])),
  ].join("\n");
}

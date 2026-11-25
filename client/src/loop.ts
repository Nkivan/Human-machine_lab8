export interface LoopStats {
  stepsPerSec: number;
  fps: number;
  frameMs: number; // time between two rAF callbacks (what the player feels; ~16.7 ms at 60 Hz)
  workMs: number; // time spent INSIDE the callback (simulate + render): the headroom left in the frame budget
}
export interface LoopOptions {
  readonly step?: number;
  readonly maxFrame?: number;
  // Function properties, not methods: they are destructured below, and a method may depend on `this`
  // (the type-checked lint rule unbound-method flagged the Lab 6 version).
  readonly simulate: (dt: number) => void;
  readonly render: (alpha: number, stats: LoopStats) => void; // alpha in [0, 1): how far between two simulation steps
  readonly onFrame?: (frameMs: number, workMs: number) => void; // perf recorder hook (Lab 7)
  // Injected so tests can drive the loop with fake timers, without a browser (designed for testability).
  readonly raf?: (cb: (now: number) => void) => number;
  readonly caf?: (id: number) => void;
  readonly now?: () => number;
}
export interface Loop {
  readonly stats: LoopStats;
  start(): void;
  stop(): void;
}

// Fixed-timestep loop (Fiedler, "Fix Your Timestep!") on top of requestAnimationFrame.
export function createLoop({
  step = 1 / 60,
  maxFrame = 0.25,
  simulate,
  render,
  onFrame,
  raf = (cb) => requestAnimationFrame(cb),
  caf = (id) => cancelAnimationFrame(id),
  now = () => performance.now(),
}: LoopOptions): Loop {
  let acc = 0;
  let last = 0;
  let rafId = 0;
  let running = false;
  let windowStart = 0;
  let stepCount = 0;
  let frameCount = 0;
  const stats: LoopStats = { stepsPerSec: 0, fps: 0, frameMs: 0, workMs: 0 };

  // One function object for the whole life of the loop: no closure is allocated per frame.
  function frame(t: number): void {
    if (!running) return;
    const workStart = now();
    const dtMs = Math.max(0, t - last);
    last = t;
    stats.frameMs = dtMs;

    acc += Math.min(dtMs / 1000, maxFrame); // clamp: no spiral of death after a hitch
    while (acc >= step) {
      simulate(step);
      acc -= step;
      stepCount++;
    }
    frameCount++;

    if (t - windowStart >= 1000) {
      const elapsed = (t - windowStart) / 1000;
      stats.stepsPerSec = stepCount / elapsed;
      stats.fps = frameCount / elapsed;
      stepCount = 0;
      frameCount = 0;
      windowStart = t;
    }

    render(acc / step, stats);
    stats.workMs = now() - workStart;
    onFrame?.(dtMs, stats.workMs);
    rafId = raf(frame);
  }

  return {
    stats,
    start() {
      if (running) return;
      running = true;
      last = windowStart = now();
      acc = 0;
      rafId = raf(frame);
    },
    stop() {
      running = false;
      caf(rafId);
    },
  };
}

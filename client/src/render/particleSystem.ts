// Explosion particles behind one interface, two implementations (the Lab 7 Web Worker experiment):
//   "main"   - the pooled SoA simulation (particles.ts) runs on the main thread, inside the frame.
//   "worker" - the same simulation runs in particles.worker.ts; per frame the main thread only posts the spawns and a
//              buffer (transferred), and draws the last result it got back (one frame behind).
// The game measures both with the "particles" perf span (main-thread time only); see the README for the go/no-go.
import { isResultMessage, type FrameMessage } from "./particleMessages.ts";
import { Particles, viewOf, type ParticleView } from "./particles.ts";

export type ParticleMode = "main" | "worker";

export interface ParticleSystem {
  readonly mode: ParticleMode;
  readonly view: ParticleView;
  burst(x: number, y: number): void;
  update(dt: number): void;
}

export interface ParticleSystemOptions {
  readonly perBurst?: number; // particles per explosion (?particlestress=N raises it to find where a worker could win)
  readonly onMainThreadWork?: (ms: number) => void; // the worker variant reports its message-handling time here
}

export function createParticleSystem(mode: ParticleMode, opts: ParticleSystemOptions = {}): ParticleSystem {
  return mode === "worker" ? createWorkerSystem(opts) : createMainSystem(opts);
}

function createMainSystem({ perBurst = 24 }: ParticleSystemOptions): ParticleSystem {
  const p = new Particles(256);
  return { mode: "main", view: viewOf(p), burst: (x, y) => p.burst(x, y, perBurst), update: (dt) => p.update(dt) };
}

function createWorkerSystem({ perBurst = 24, onMainThreadWork }: ParticleSystemOptions): ParticleSystem {
  const worker = new Worker(new URL("./particles.worker.ts", import.meta.url), { type: "module" });
  let spawns = new Float32Array(64);
  let spawnCount = 0;
  let spare: Float32Array<ArrayBuffer> | null = new Float32Array(3 * 1024); // ours to send
  let front: Float32Array<ArrayBuffer> = new Float32Array(3 * 1024); // the last result: what we draw
  let frontCount = 0;
  let pendingDt = 0;

  worker.addEventListener("message", (e: MessageEvent) => {
    const t0 = performance.now();
    const msg: unknown = e.data;
    if (!isResultMessage(msg)) return;
    spare = front; // double buffering: the old front becomes the next buffer to send
    front = msg.buf;
    frontCount = msg.count;
    onMainThreadWork?.(performance.now() - t0);
  });

  const view: ParticleView = {
    get count() {
      return frontCount;
    },
    xAt: (i) => front[i * 3] ?? 0,
    yAt: (i) => front[i * 3 + 1] ?? 0,
    lifeAt: (i) => front[i * 3 + 2] ?? 0,
  };

  return {
    mode: "worker",
    view,
    burst(x, y) {
      if (spawnCount * 2 + 2 > spawns.length) {
        const bigger = new Float32Array(spawns.length * 2);
        bigger.set(spawns);
        spawns = bigger;
      }
      spawns[spawnCount * 2] = x;
      spawns[spawnCount * 2 + 1] = y;
      spawnCount++;
    },
    update(dt) {
      pendingDt += dt;
      if (!spare) return; // the worker still has our only spare buffer: skip a frame, keep the dt and the spawns
      const msg: FrameMessage = {
        type: "frame",
        dt: pendingDt,
        perBurst,
        spawnCount,
        spawns: spawns.slice(0, spawnCount * 2), // a few bytes: cloned
        out: spare,
      };
      worker.postMessage(msg, { transfer: [spare.buffer] }); // zero-copy; `spare` is now detached (byteLength 0)
      spare = null;
      spawnCount = 0;
      pendingDt = 0;
    },
  };
}

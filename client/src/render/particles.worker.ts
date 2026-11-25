// The Web Worker side of the particle experiment (?particles=worker). It owns the simulation (the same Particles pool
// the main thread uses), and answers every frame message with the positions packed as [x, y, life] triples in the
// Float32Array the main thread sent: that buffer is TRANSFERRED both ways, so nothing is copied.
import { isFrameMessage, type ResultMessage } from "./particleMessages.ts";
import { Particles } from "./particles.ts";

const particles = new Particles(1024);

self.addEventListener("message", (e: MessageEvent) => {
  const msg: unknown = e.data;
  if (!isFrameMessage(msg)) return;
  for (let i = 0; i + 1 < msg.spawnCount * 2; i += 2)
    particles.burst(msg.spawns[i] ?? 0, msg.spawns[i + 1] ?? 0, msg.perBurst);
  particles.update(msg.dt);

  let out: Float32Array<ArrayBuffer> = msg.out;
  if (out.length < particles.count * 3) out = new Float32Array(particles.capacity * 3); // rare: the pool grew
  for (let i = 0; i < particles.count; i++) {
    out[i * 3] = particles.x[i] ?? 0;
    out[i * 3 + 1] = particles.y[i] ?? 0;
    out[i * 3 + 2] = particles.life[i] ?? 0;
  }
  const result: ResultMessage = { type: "result", count: particles.count, buf: out };
  self.postMessage(result, { transfer: [out.buffer] });
});

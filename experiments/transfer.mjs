// node experiments/transfer.mjs : structured clone vs transfer of a 50 MB ArrayBuffer to a worker (worker_threads)
import { Worker } from "node:worker_threads";
const w = new Worker(
  "const { parentPort } = require('node:worker_threads'); parentPort.on('message', () => parentPort.postMessage(1));",
  { eval: true },
);
const roundtrip = (buf, transfer) =>
  new Promise((r) => {
    const t = performance.now();
    w.once("message", () => r(performance.now() - t));
    w.postMessage(buf, transfer ? [buf] : []);
  });
const a = new ArrayBuffer(50 * 1024 * 1024);
console.log(`clone:    ${(await roundtrip(a, false)).toFixed(1)} ms, sender byteLength after = ${a.byteLength}`);
const b = new ArrayBuffer(50 * 1024 * 1024);
console.log(`transfer: ${(await roundtrip(b, true)).toFixed(1)} ms, sender byteLength after = ${b.byteLength}`);
await w.terminate();

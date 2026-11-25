// npm run bench  -> the JSON vs binary table for the README (4 players, 30 Hz).
import { performance } from "node:perf_hooks";
import { decodeClient, encodeInputs } from "../src/codec/binary.ts";
import { binaryCodec, jsonCodec } from "../src/codec/codec.ts";
import { snapshotWorld } from "../src/codec/snapshot.ts";
import { asSeq, asTick } from "../src/protocol/ids.ts";
import { Ship } from "../src/sim/ship.ts";
import type { Input } from "../src/sim/shipmove.ts";
import { World } from "../src/sim/world.ts";

const world = new World(5, { asteroids: 6 });
const ships = [0, 1, 2, 3].map((i) => world.spawn(new Ship({ x: 200 + i * 250, y: 300 })));
for (let i = 0; i < 120; i++) {
  world.step(
    1 / 30,
    new Map(ships.map((s, k) => [s.id, [{ turn: k % 2 ? 1 : -1, thrust: true, fire: i % 4 === k }]] as const)),
  );
}
const entities = snapshotWorld(world);
const snap = { tick: asTick(120), ack: asSeq(119), entities };
const inputs3: Input[] = [1, 2, 3].map((n) => ({ seq: asSeq(n), turn: 1, thrust: true, fire: false }));

const enc = new TextEncoder();
const jsonSnap = enc.encode(jsonCodec.encode(snap)).byteLength;
const binSnap = binaryCodec.encode(snap).byteLength;
const jsonUp = enc.encode(JSON.stringify(inputs3)).byteLength;
const binUp = encodeInputs(inputs3).byteLength;

function micros(fn: () => unknown, n = 20000): number {
  for (let i = 0; i < 2000; i++) fn();
  const t = performance.now();
  for (let i = 0; i < n; i++) fn();
  return ((performance.now() - t) * 1000) / n;
}
const jsonUs = micros(() => jsonCodec.decode(jsonCodec.encode(snap)));
const binUs = micros(() => binaryCodec.decode(binaryCodec.encode(snap)));
const jsonUpUs = micros(() => JSON.parse(JSON.stringify(inputs3)));
const binUpUs = micros(() => decodeClient(encodeInputs(inputs3)));

const kbs = (bytes: number): string => ((bytes * 30) / 1024).toFixed(1);
console.log(`entities in snapshot: ${entities.length} (4 ships + asteroids + bullets)`);
console.log(
  "| Codec | Bytes/snapshot | KB/s per client (down) | KB/s per client (up) | Snapshot enc+dec us | Input enc+dec us |",
);
console.log("|---|---|---|---|---|---|");
console.log(
  `| JSON (validated by zod) | ${jsonSnap} | ${kbs(jsonSnap)} | ${kbs(jsonUp)} | ${jsonUs.toFixed(1)} | ${jsonUpUs.toFixed(1)} |`,
);
console.log(
  `| Binary (DataView) | ${binSnap} | ${kbs(binSnap)} | ${kbs(binUp)} | ${binUs.toFixed(1)} | ${binUpUs.toFixed(1)} |`,
);
console.log(`ratio down: ${(jsonSnap / binSnap).toFixed(1)}x, up: ${(jsonUp / binUp).toFixed(1)}x`);

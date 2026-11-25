import assert from "node:assert/strict";
import { test } from "vitest";
import {
  decodeClient,
  decodeServer,
  encodeInputs,
  encodePing,
  encodePong,
  encodeSnapshot,
} from "../src/codec/binary.ts";
import { binaryCodec, jsonCodec } from "../src/codec/codec.ts";
import { snapshotWorld } from "../src/codec/snapshot.ts";
import { asEntityId, asSeq, asTick } from "../src/protocol/ids.ts";
import type { Snapshot } from "../src/protocol/messages.ts";
import { Ship } from "../src/sim/ship.ts";
import type { Input } from "../src/sim/shipmove.ts";
import { World } from "../src/sim/world.ts";

function flownWorld(): { world: World; snapshot: Snapshot } {
  const world = new World(3, { asteroids: 5 });
  const ship = world.spawn(new Ship({ x: 300, y: 300 }));
  for (let i = 0; i < 200; i++) {
    const cmd: Input = { seq: asSeq(i + 1), turn: 1, thrust: true, fire: i % 5 === 0 };
    world.step(1 / 30, new Map([[ship.id, [cmd]]]));
  }
  return { world, snapshot: { tick: asTick(200), ack: asSeq(199), entities: snapshotWorld(world) } };
}

test("inputs round-trip exactly", () => {
  const inputs: Input[] = [
    { seq: asSeq(7), turn: -1, thrust: true, fire: false },
    { seq: asSeq(4_000_000_000), turn: 1, thrust: false, fire: true },
  ];
  const res = decodeClient(encodeInputs(inputs));
  assert.ok(res.ok && res.value.type === "inputs");
  assert.deepEqual(res.value.inputs, inputs);
});

test("client frames are validated: cheats, garbage and a wrong protocol version are rejected", () => {
  const buf = encodeInputs([{ seq: asSeq(1), turn: 0, thrust: false, fire: false }]);
  new DataView(buf).setInt8(6, 100); // a turn of 100
  assert.equal(decodeClient(buf).ok, false);
  assert.equal(decodeClient(new ArrayBuffer(0)).ok, false);
  const wrongVersion = encodePing(1);
  new DataView(wrongVersion).setUint8(0, (9 << 4) | 3);
  const res = decodeClient(wrongVersion);
  assert.ok(!res.ok);
  assert.match(res.error, /version/);
  assert.equal(decodeClient(new Uint8Array([(2 << 4) | 1, 9, 0]).buffer).ok, false); // count 9 > 5
  assert.equal(decodeClient(new Uint8Array([(2 << 4) | 15]).buffer).ok, false); // unknown type
});

test("ping/pong round-trip", () => {
  const ping = decodeClient(encodePing(1234.5));
  assert.ok(ping.ok && ping.value.type === "ping");
  assert.equal(ping.value.t, 1234.5);
  const pong = decodeServer(encodePong(99.25, asTick(42)));
  assert.ok(pong.ok);
  assert.deepEqual(pong.value, { type: "pong", t: 99.25, tick: 42 });
});

test("a snapshot of a REAL world round-trips losslessly through the binary codec", () => {
  const { snapshot } = flownWorld();
  const buf = binaryCodec.encode(snapshot);
  assert.equal(buf.byteLength, 11 + 28 * snapshot.entities.length);
  const decoded = binaryCodec.decode(buf);
  assert.ok(decoded.ok);
  assert.equal(decoded.value.tick, 200);
  assert.equal(decoded.value.ack, 199);
  assert.equal(decoded.value.entities.length, snapshot.entities.length);
  snapshot.entities.forEach((before, i) => {
    const after = decoded.value.entities[i];
    assert.ok(after);
    assert.equal(after.kind, before.kind);
    if (before.kind === "ship")
      assert.deepEqual(after, before, "ships must be bit-exact (this is what prediction needs)");
    else {
      assert.ok(Math.abs(after.x - before.x) < 0.01);
      assert.ok(Math.abs(after.y - before.y) < 0.01);
    }
  });
});

test("JSON and binary codecs agree on the same snapshot", () => {
  const { snapshot } = flownWorld();
  const fromBinary = binaryCodec.decode(binaryCodec.encode(snapshot));
  const fromJson = jsonCodec.decode(jsonCodec.encode(snapshot));
  assert.ok(fromBinary.ok && fromJson.ok);
  const ships = (s: Snapshot) => s.entities.filter((e) => e.kind === "ship");
  assert.deepEqual(ships(fromJson.value), ships(fromBinary.value));
  assert.ok(
    jsonCodec.encode(snapshot).length > binaryCodec.encode(snapshot).byteLength * 3,
    "JSON is several times bigger",
  );
});

test("malformed frames return an error and never throw", () => {
  assert.equal(decodeServer(new Uint8Array([(2 << 4) | 2, 0, 0]).buffer).ok, false); // short snapshot
  assert.equal(decodeServer(new ArrayBuffer(0)).ok, false);
  const buf = encodeSnapshot(flownWorld().snapshot);
  const view = new DataView(buf);
  view.setUint8(11 + 2, 77); // first entity gets an unknown kind
  assert.equal(decodeServer(buf).ok, false);
  assert.equal(jsonCodec.decode("{not json").ok, false);
  assert.equal(jsonCodec.decode('{"v":2,"type":"snapshot","tick":1,"ack":1,"entities":[{"kind":"ship"}]}').ok, false);
});

test("pickups, ship effects and homing bullets survive the binary round trip", () => {
  const world = new World(5, { asteroids: 0, pickupEvery: 1 });
  const ship = world.spawn(new Ship({ x: 100, y: 100 }));
  ship.applyPickup("rapid");
  ship.applyPickup("shield");
  ship.applyPickup("homing");
  for (let i = 0; i < 40; i++) world.step(1 / 30, new Map([[ship.id, [{ turn: 0, thrust: false, fire: true }]]]));
  const entities = snapshotWorld(world);
  assert.ok(
    entities.some((e) => e.kind === "pickup"),
    "a pickup has spawned",
  );
  assert.ok(
    entities.some((e) => e.kind === "bullet" && e.homing),
    "the bullets were fired while homing was active",
  );

  const decoded = binaryCodec.decode(binaryCodec.encode({ tick: asTick(1), ack: asSeq(1), entities }));
  assert.ok(decoded.ok);
  const before = entities.find((e) => e.kind === "ship");
  const after = decoded.value.entities.find((e) => e.kind === "ship");
  assert.deepEqual(after, before, "a ship with all three effects is bit-exact");
  assert.ok(after && after.rapid > 0 && after.shield > 0 && after.homing > 0);
  assert.deepEqual(
    decoded.value.entities.filter((e) => e.kind === "pickup").map((e) => e.type),
    entities.filter((e) => e.kind === "pickup").map((e) => e.type),
  );
  assert.ok(decoded.value.entities.some((e) => e.kind === "bullet" && e.homing));
});

test("an unknown pickup type is rejected by the decoder, not trusted", () => {
  const snap: Snapshot = {
    tick: asTick(1),
    ack: asSeq(0),
    entities: [{ kind: "pickup", id: asEntityId(1), x: 5, y: 5, vx: 0, vy: 0, angle: 0, type: "rapid" }],
  };
  const buf = binaryCodec.encode(snap);
  assert.equal(binaryCodec.decode(buf).ok, true);
  new DataView(buf).setUint16(11 + 22, 9, true); // aux of the first entity = pickup type index + 1; 9 does not exist
  assert.equal(binaryCodec.decode(buf).ok, false);
});

import assert from "node:assert/strict";
import { test } from "vitest";
import { loadConfig } from "../src/config.ts";
import { createNetsim } from "../src/netsim.ts";
import { createTokenBucket } from "../src/ratelimit.ts";
import { Room, RoomManager, type Player } from "../src/rooms.ts";

const player = (id: string, name: string, sink: string[] = []): Player => ({
  id,
  name,
  send: (m) => {
    sink.push(m.type);
  },
  sendSnapshot: () => {},
});

test("token bucket: burst, then refill over time", () => {
  let now = 0;
  const bucket = createTokenBucket({ ratePerSec: 2, burst: 3, now: () => now });
  assert.deepEqual([bucket.take(), bucket.take(), bucket.take(), bucket.take()], [true, true, true, false]);
  now += 500; // +1 token
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), false);
});

test("Room is a TYPED EventEmitter: join/leave/empty events carry their payload types", () => {
  const room = new Room({ id: "r", name: "R", arena: { asteroids: 0, pickupEvery: 8, seed: 1 }, max: 2 });
  const seen: string[] = [];
  room.on("join", (p) => seen.push(`join:${p.name}`)); // p is a Player: p.name type-checks
  room.on("leave", (p) => seen.push(`leave:${p.name}`));
  room.on("empty", (r) => seen.push(`empty:${r.id}`));
  const sent: string[] = [];
  room.join(player("1", "Ann", sent));
  room.leave("1");
  assert.deepEqual(seen, ["join:Ann", "leave:Ann", "empty:r"]);
  assert.ok(sent.includes("roster") && sent.includes("welcome"), "joining starts the match: the player gets a welcome");
  room.match.stop();
});

test("RoomManager: caps rooms, deletes empty non-persistent rooms", async () => {
  const manager = new RoomManager({ maxRooms: 2, maxPlayersPerRoom: 2, logDir: "/tmp/dogfight-test-units" });
  const a = manager.create({ name: "A" });
  manager.create({ name: "B", persistent: true });
  assert.throws(() => manager.create({ name: "C" }), /too many rooms/);
  a.join(player("1", "x"));
  a.leave("1"); // empty -> deleted
  assert.equal(manager.size, 1);
  await manager.closeAll();
  assert.equal(manager.size, 0);
});

test("netsim keeps delivery IN ORDER and drops only droppable messages", () => {
  const sim = createNetsim({ latency: 0, jitter: 0, drop: 1 }, () => 0.5);
  const log: string[] = [];
  sim.in(() => log.push("control")); // never dropped
  sim.in(() => log.push("input"), { droppable: true }); // drop = 1: always dropped
  assert.deepEqual(log, ["control"]);
});

test("config: defaults, coercion, and a clear failure for bad values", () => {
  const c = loadConfig({ PORT: "8080", DEBUG_ROUTES: "1" });
  assert.equal(c.port, 8080);
  assert.equal(c.debugRoutes, true);
  assert.equal(c.snapshotCodec, "binary");
  assert.equal(loadConfig({ PORT: "" }).port, 3000, "an empty variable means not set");
  assert.throws(() => loadConfig({ PORT: "99999" }), /Invalid configuration: PORT/);
  assert.throws(() => loadConfig({ SNAPSHOT_CODEC: "xml" }), /SNAPSHOT_CODEC/);
});

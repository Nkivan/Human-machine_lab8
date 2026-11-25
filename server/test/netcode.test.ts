import assert from "node:assert/strict";
import { test } from "vitest";
import { encodeInputs, encodePing } from "@dogfight/shared/codec/binary";
import { PROTOCOL_VERSION, STEP } from "@dogfight/shared/protocol/constants";
import { asSeq, type Seq } from "@dogfight/shared/protocol/ids";
import type { ShipRecord } from "@dogfight/shared/protocol/messages";
import type { Input } from "@dogfight/shared/sim/shipmove";
import { createPredictor } from "../../client/src/net/netcode.ts"; // the SAME module the browser runs
import { connect, createRoom, join, sendMsg, sleep, start, waitJson, type TestClient } from "./helpers.ts";

// Run the real client netcode against the real server for `steps` fixed steps (30/s); returns the measurements.
async function fly(c: TestClient, steps: number, { noise = 0 }: { noise?: number } = {}) {
  const welcome = await waitJson(c, "welcome");
  const predictor = createPredictor({ noise });
  const corrections: number[] = [];
  const rtts: number[] = [];
  let seq = 0;
  let lastAck: Seq = asSeq(0);
  let snapshots = 0;
  const recent: Input[] = [];
  c.events.on("bin", (frame) => {
    if (frame.type === "pong") {
      rtts.push(performance.now() - frame.t);
      return;
    }
    snapshots++;
    const { ack, entities } = frame.snapshot;
    lastAck = ack;
    const mine = entities.find((e): e is ShipRecord => e.kind === "ship" && e.id === welcome.you);
    if (mine) corrections.push(predictor.reconcile(mine, ack, STEP));
  });
  c.ws.send(encodePing(performance.now()));
  for (let i = 0; i < steps; i++) {
    const cmd: Input = {
      seq: asSeq(++seq),
      turn: i % 60 < 20 ? 1 : i % 60 < 40 ? -1 : 0,
      thrust: i % 45 < 30,
      fire: false,
    };
    recent.push(cmd);
    if (recent.length > 3) recent.shift();
    c.ws.send(encodeInputs(recent));
    predictor.apply(cmd.seq, cmd, STEP);
    if (i === 20) c.ws.send(encodePing(performance.now()));
    await sleep(1000 * STEP);
  }
  await sleep(400);
  return { corrections, rtts, snapshots, lastAck, seq, predictor };
}

async function quietRoom(extra: Record<string, string> = {}) {
  const h = await start({ DEBUG_ROUTES: "1", SEED_ROOMS: "0", ...extra });
  const roomId = await createRoom(h.base, { name: "quiet", arena: { asteroids: 0, seed: 7 } });
  return { h, roomId };
}

test("end to end, 100 ms RTT + jitter + 2% loss: prediction matches the server exactly", async () => {
  const { h, roomId } = await quietRoom();
  try {
    const c = await connect(h.base, "?lat=100&jitter=20&drop=0.02");
    join(c, roomId);
    const r = await fly(c, 120);
    assert.ok(r.snapshots > 80, `snapshots ${r.snapshots}`);
    assert.ok(r.lastAck > 100, `server applied inputs up to ${r.lastAck}`);
    assert.equal(Math.max(...r.corrections), 0, "corrections must read 0 in open space");
    assert.ok(
      Math.min(...r.rtts) >= 80,
      `RTT should reflect the injector, got ${r.rtts.map((x) => x.toFixed(0)).join(", ")}`,
    );
    c.ws.close();
  } finally {
    await h.cleanup();
  }
});

test("end to end: random noise in the prediction makes corrections appear (the determinism experiment)", async () => {
  const { h, roomId } = await quietRoom();
  try {
    const c = await connect(h.base, "?lat=60");
    join(c, roomId);
    const r = await fly(c, 90, { noise: 4 });
    assert.ok(Math.max(...r.corrections) > 0.05, `max correction ${Math.max(...r.corrections)}`);
    c.ws.close();
  } finally {
    await h.cleanup();
  }
});

test("the tick loop keeps its cadence: /api/stats reports duration and jitter", async () => {
  const { h, roomId } = await quietRoom();
  try {
    const c = await connect(h.base);
    join(c, roomId);
    await waitJson(c, "welcome");
    const match = h.app.manager.get(roomId)?.match;
    assert.ok(match);
    await sleep(1500);
    const stats: unknown = await (await fetch(`http://${h.base}/api/stats`)).json();
    assert.ok(typeof stats === "object" && stats !== null && "matches" in stats && Array.isArray(stats.matches));
    const m = match.info();
    assert.equal(m.running, true);
    assert.ok(m.ticks > 30, `ticks ${m.ticks}`);
    assert.ok(Math.abs(m.intervalMs - 1000 / 30) < 3, `interval ${m.intervalMs} ms (absolute-target scheduling)`);
    assert.ok(m.avgMs < 5 && m.jitterMs < 10, `avg ${m.avgMs} ms, jitter ${m.jitterMs} ms`);
    c.ws.close();
    await sleep(200);
    assert.equal(match.running, false, "no players: the loop stops (and the empty room is deleted)");
  } finally {
    await h.cleanup();
  }
});

test("server validates binary frames: cheats, garbage, early frames, wrong versions and floods are rejected", async () => {
  const { h, roomId } = await quietRoom();
  try {
    const early = await connect(h.base);
    early.ws.send(encodeInputs([{ seq: asSeq(1), turn: 0, thrust: false, fire: false }]));
    assert.equal(await early.closed, 4004, "inputs before join");

    const keeper = await connect(h.base); // keeps the room alive: an EMPTY room is deleted
    join(keeper, roomId, "Keeper");
    await waitJson(keeper, "welcome");

    const cheat = await connect(h.base);
    join(cheat, roomId);
    await waitJson(cheat, "welcome");
    const buf = encodeInputs([{ seq: asSeq(1), turn: 0, thrust: false, fire: false }]);
    new DataView(buf).setInt8(6, 100); // a turn of 100
    cheat.ws.send(buf);
    assert.equal(await cheat.closed, 4003, "a turn of 100 is a cheat");

    const old = await connect(h.base);
    join(old, roomId);
    await waitJson(old, "welcome");
    const stale = encodePing(1);
    new DataView(stale).setUint8(0, (1 << 4) | 3); // protocol version 1
    old.ws.send(stale);
    assert.equal(await old.closed, 4003, "wrong protocol version");

    const flood = await connect(h.base);
    join(flood, roomId);
    await waitJson(flood, "welcome");
    for (let i = 0; i < 400; i++) flood.ws.send(encodePing(i));
    assert.equal(await flood.closed, 4008, "binary rate limit");
    keeper.ws.close();
  } finally {
    await h.cleanup();
  }
});

test("runtime netsim message changes the injector and is confirmed", async () => {
  const { h, roomId } = await quietRoom();
  try {
    const c = await connect(h.base);
    join(c, roomId);
    await waitJson(c, "welcome");
    sendMsg(c, { v: PROTOCOL_VERSION, type: "netsim", latency: 120, jitter: 10, drop: 0.01 });
    const m = await waitJson(c, "netsim");
    assert.deepEqual([m.latency, m.jitter, m.drop], [120, 10, 0.01]);
    c.ws.close();
  } finally {
    await h.cleanup();
  }
});

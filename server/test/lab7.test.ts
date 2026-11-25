import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asEntityId, asSeq, asTick } from "@dogfight/shared/protocol/ids";
import type { EntityRecord, ShipRecord, Snapshot } from "@dogfight/shared/protocol/messages";
import { createBrain, decide } from "../src/bot.ts";
import { createHeartbeat, type HeartbeatPeer } from "../src/heartbeat.ts";
import { createTickStats } from "../src/match.ts";
import { createNetsim } from "../src/netsim.ts";
import { createTokenBucket } from "../src/ratelimit.ts";
import { connect, createRoom, join, sleep, start, waitFor } from "./helpers.ts";

class FakePeer implements HeartbeatPeer {
  pings = 0;
  terminated = false;
  answers = true;
  #pong: (() => void) | null = null;
  ping(): void {
    this.pings++;
    if (this.answers) queueMicrotask(() => this.#pong?.());
  }
  terminate(): void {
    this.terminated = true;
  }
  on(_event: "pong", listener: () => void): this {
    this.#pong = listener;
    return this;
  }
}

describe("fake timers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("heartbeat: a peer that answers lives; one that stops answering is terminated after 2 missed pongs", async () => {
    const alive = new FakePeer();
    const dead = new FakePeer();
    dead.answers = false;
    const hb = createHeartbeat(() => [alive, dead], 1000);
    hb.track(alive);
    hb.track(dead);
    await vi.advanceTimersByTimeAsync(2000); // two rounds: dead has missed 2
    expect(dead.terminated).toBe(false);
    expect(hb.missed(dead)).toBe(2);
    await vi.advanceTimersByTimeAsync(1000); // third round: terminated
    expect(dead.terminated).toBe(true);
    expect(alive.terminated).toBe(false);
    expect(alive.pings).toBe(3);
    expect(hb.missed(alive)).toBe(0);
    hb.stop();
  });

  it("token bucket refills with the (fake) clock", () => {
    const bucket = createTokenBucket({ ratePerSec: 10, burst: 2, now: () => performance.now() });
    expect([bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, false]);
    vi.advanceTimersByTime(100); // +1 token
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });

  it("netsim delays by half the RTT and keeps order despite jitter", () => {
    let r = 0;
    const rnd = () => [0.9, 0.1, 0.5][r++ % 3] ?? 0;
    const sim = createNetsim({ latency: 100, jitter: 40 }, rnd);
    const got: number[] = [];
    for (const n of [1, 2, 3]) sim.out(() => got.push(n));
    vi.advanceTimersByTime(49);
    expect(got).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(got).toEqual([1, 2, 3]); // never reordered (TCP-like)
  });

  it("tick stats: percentiles over the window, overruns counted", () => {
    const s = createTickStats(100);
    for (let i = 0; i < 100; i++) s.record(i * 33.3, i === 99 ? 50 : 1 + (i % 10) / 10);
    const snap = s.snapshot();
    expect(snap.overruns).toBe(1);
    expect(snap.p50Ms).toBeCloseTo(1.4, 6);
    expect(snap.maxMs).toBe(50);
    expect(snap.intervalMs).toBeCloseTo(33.3, 3);
  });
});

describe("bot AI (pure decide)", () => {
  const me = (over: Partial<ShipRecord> = {}): ShipRecord => ({
    kind: "ship",
    id: asEntityId(1),
    x: 400,
    y: 300,
    vx: 0,
    vy: 0,
    angle: 0,
    thrust: false,
    invuln: false,
    hp: 100,
    cooldown: 0,
    rapid: 0,
    shield: 0,
    homing: 0,
    ...over,
  });
  const snap = (...entities: EntityRecord[]): Snapshot => ({ tick: asTick(1), ack: asSeq(0), entities });
  const brain = createBrain(1);

  it("idle before it knows its ship, or while dead", () => {
    expect(decide(null, 1, brain)).toEqual({ turn: 0, thrust: false, fire: false });
    expect(decide(snap(), 1, brain)).toEqual({ turn: 0, thrust: false, fire: false });
  });
  it("fires at an enemy straight ahead", () => {
    expect(decide(snap(me(), me({ id: asEntityId(2), x: 600 })), 1, brain).fire).toBe(true);
  });
  it("turns toward an enemy that is to the side (and does not fire yet)", () => {
    const cmd = decide(snap(me(), me({ id: asEntityId(2), x: 400, y: 500 })), 1, brain); // +y = angle +pi/2
    expect(cmd.turn).toBe(1);
    expect(cmd.fire).toBe(false);
  });
  it("evades an asteroid that is close and closing in", () => {
    const rock: EntityRecord = {
      kind: "asteroid",
      id: asEntityId(3),
      x: 400,
      y: 360,
      vx: 0,
      vy: -80,
      angle: 0,
      radius: 30,
      seeker: false,
    };
    expect(decide(snap(me(), rock), 1, brain).thrust).toBe(true);
  });
  it("aims across the wrap-around edge (the shortest way)", () => {
    const cmd = decide(snap(me({ x: 1270, angle: 0 }), me({ id: asEntityId(2), x: 30 })), 1, brain);
    expect(cmd.fire).toBe(true); // 40 px to the right through the edge, not 1240 px to the left
  });
});

describe("bots endpoint (real server)", () => {
  it("adds N bots that play like clients: roster, snapshots with their ships, room info, auto-removal", async () => {
    const h = await start({ SEED_ROOMS: "0", MAX_BOTS: "4" });
    try {
      const roomId = await createRoom(h.base, { name: "botroom", arena: { asteroids: 2, seed: 4 } });
      const post = (count: number) =>
        fetch(`http://${h.base}/api/rooms/${roomId}/bots`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ count }),
        });
      expect((await post(3)).status).toBe(201);
      expect((await post(5)).status).toBe(201); // capped at MAX_BOTS = 4: only one more
      expect((await post(1)).status).toBe(409);
      expect((await post(0)).status).toBe(400);
      expect((await fetch(`http://${h.base}/api/rooms/nope/bots`, { method: "POST", body: "{}" })).status).toBe(404);

      const c = await connect(h.base);
      join(c, roomId, "Human");
      await waitFor(c, (m) => m.type === "roster" && m.players.length === 5); // 4 bots + me
      await sleep(500);
      const last = c.bin.filter((f) => f.type === "snapshot").at(-1);
      expect(last?.type === "snapshot" && last.snapshot.entities.filter((e) => e.kind === "ship").length).toBe(5);
      const rooms: unknown = await (await fetch(`http://${h.base}/api/rooms`)).json();
      expect(JSON.stringify(rooms)).toContain('"players":1,"bots":4');

      c.ws.close(); // the last human leaves -> the bots leave -> the (non-persistent) room is deleted
      await sleep(300);
      expect(h.app.manager.get(roomId)).toBeUndefined();
    } finally {
      await h.cleanup();
    }
  });

  it("/api/stats reports event-loop utilization, traffic and tick percentiles", async () => {
    const h = await start();
    try {
      const s: unknown = await (await fetch(`http://${h.base}/api/stats`)).json();
      const ok = typeof s === "object" && s !== null && "elu" in s && typeof s.elu === "number" && "traffic" in s;
      expect(ok).toBe(true);
    } finally {
      await h.cleanup();
    }
  });
});

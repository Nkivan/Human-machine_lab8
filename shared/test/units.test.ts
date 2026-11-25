import { describe, expect, it } from "vitest";
import { Bus } from "../src/bus.ts";
import { withAck, encodeSnapshot, decodeServer } from "../src/codec/binary.ts";
import { asEntityId, asSeq, asTick } from "../src/protocol/ids.ts";
import { ARENA, wrapPos } from "../src/sim/arena.ts";
import { Asteroid } from "../src/sim/asteroid.ts";
import { Bullet } from "../src/sim/bullet.ts";
import { findCollisions, SpatialHash } from "../src/sim/collision.ts";
import { lerpAngle } from "../src/sim/math.ts";
import { Ship } from "../src/sim/ship.ts";
import { stepShip, TUNING, type ShipBody } from "../src/sim/shipmove.ts";
import { addScaledInPlace, Vector2 } from "../src/sim/vector.ts";
import { World } from "../src/sim/world.ts";
import { percentile, SampleRing, summarize } from "../src/stats.ts";
import { assertNever } from "../src/util.ts";

const body = (over: Partial<ShipBody> = {}): ShipBody => ({
  pos: { x: 100, y: 100 },
  vel: { x: 0, y: 0 },
  angle: 0,
  cooldown: 0,
  rapid: 0,
  thrust: false,
  ...over,
});

describe("Vector2", () => {
  it("add / sub / scale / dot / length", () => {
    const a = new Vector2(3, 4);
    expect(a.length()).toBe(5);
    expect(a.sub(new Vector2(1, 1))).toEqual(new Vector2(2, 3));
    expect(a.scale(2)).toEqual(new Vector2(6, 8));
    expect(a.dot(new Vector2(2, 0))).toBe(6);
  });
  it("normalize: unit length, and the zero vector stays zero (no NaN)", () => {
    expect(new Vector2(3, 4).normalize().length()).toBeCloseTo(1, 12);
    expect(new Vector2().normalize()).toEqual(new Vector2(0, 0));
  });
  it("rotate and fromAngle agree", () => {
    const r = new Vector2(1, 0).rotate(Math.PI / 2);
    expect(r.x).toBeCloseTo(0, 12);
    expect(r.y).toBeCloseTo(1, 12);
    expect(Vector2.fromAngle(Math.PI, 2).x).toBeCloseTo(-2, 12);
  });
  it("addScaledInPlace mutates the target and allocates nothing", () => {
    const p = { x: 1, y: 1 };
    addScaledInPlace(p, { x: 2, y: -4 }, 0.5);
    expect(p).toEqual({ x: 2, y: -1 });
  });
});

describe("integration with known inputs", () => {
  it("one thrust step from rest: v = a*dt*exp(-drag*dt), x += v*dt (float32)", () => {
    const s = body();
    const dt = 1 / 30;
    stepShip(s, { turn: 0, thrust: true, fire: false }, dt);
    const v = Math.fround(TUNING.thrustAccel * dt * Math.exp(-TUNING.drag * dt));
    expect(s.vel.x).toBe(v);
    expect(s.vel.y).toBe(0);
    expect(s.pos.x).toBe(Math.fround(100 + v * dt));
  });
  it("turning is quantized to 1/1000 rad and wraps into [0, 2pi)", () => {
    const s = body({ angle: 0 });
    stepShip(s, { turn: -1, thrust: false, fire: false }, 1 / 30);
    expect(s.angle).toBe(Math.round((2 * Math.PI - TUNING.turnSpeed / 30) * 1000) / 1000);
  });
  it("wrapPos wraps both axes, negative values included", () => {
    const p = { x: -10, y: ARENA.height + 5 };
    wrapPos(p);
    expect(p).toEqual({ x: ARENA.width - 10, y: 5 });
  });
  it("lerpAngle takes the short way round (359 deg -> 1 deg)", () => {
    const a = (359 * Math.PI) / 180;
    const b = (1 * Math.PI) / 180;
    const mid = lerpAngle(a, b, 0.5); // 0 deg (or 360), NOT 180
    expect(Math.cos(mid)).toBeCloseTo(1, 9);
    expect(Math.sin(mid)).toBeCloseTo(0, 9);
  });
});

describe("collision cases", () => {
  const pairCount = (w: World): number => findCollisions(w).length;
  const world = (...es: (Asteroid | Bullet | Ship)[]): World => {
    const w = new World(1, { asteroids: 0 });
    for (const e of es) w.spawn(e);
    return w;
  };
  const rock = (x: number, r = 20): Asteroid => new Asteroid({ x, y: 100, vx: 0, vy: 0, radius: r });

  it("touching (distance == r1 + r2) counts as a hit", () => expect(pairCount(world(rock(100), rock(140)))).toBe(1));
  it("overlapping is a hit", () => expect(pairCount(world(rock(100), rock(120)))).toBe(1));
  it("missing (distance > r1 + r2) is not", () => expect(pairCount(world(rock(100), rock(140.01)))).toBe(0));
  it("the spatial hash agrees across cell borders", () => {
    const w = world(rock(79, 30), rock(81, 30), rock(500, 10));
    const pairs: number[] = [];
    new SpatialHash().forEachPair(w, () => pairs.push(1));
    expect(pairs.length).toBe(pairCount(w));
  });

  it("fast bullet TUNNELING: yes, ours can skip a ship (discrete checks, documented limitation)", () => {
    // Fastest bullet = ship speed + bullet speed = 1040 px/s = 34.7 px per step; a bullet-ship hit zone is 2 * (3 + 14)
    // = 34 px wide. Placed just before the ship, one step carries the bullet past it without any overlap.
    const ship = new Ship({ x: 200, y: 100 });
    ship.invuln = 0;
    const speed = TUNING.maxSpeed + TUNING.bulletSpeed;
    const w = new World(1, { asteroids: 0 });
    w.spawn(ship);
    const bullet = w.spawn(
      new Bullet({ pos: { x: 200 - 17.5, y: 100 }, vel: { x: speed, y: 0 }, owner: asEntityId(99999) }),
    );
    w.step(1 / 30);
    expect(bullet.pos.x).toBeGreaterThan(200 + 17); // it is past the ship now...
    expect(ship.hp).toBe(100); // ...and never touched it
  });

  it("slower bullets (under 34 px per step) cannot tunnel through a ship", () => {
    const ship = new Ship({ x: 200, y: 100 });
    const w = new World(1, { asteroids: 0 });
    w.spawn(ship);
    for (const start of [160, 165, 170, 175, 180]) {
      w.spawn(new Bullet({ pos: { x: start, y: 100 }, vel: { x: 900, y: 0 }, owner: asEntityId(99999) }));
    }
    for (let i = 0; i < 3; i++) w.step(1 / 30);
    expect([...w.ofKind("bullet")].length).toBe(0); // every one of them hit
  });
});

describe("stats, bus, ack patching", () => {
  it("percentile / summarize: nearest rank, sorted numerically (not as strings)", () => {
    const s = summarize([10, 9, 100, 1, 2, 3, 4, 5, 6, 7]);
    expect([s.p50, s.p95, s.p99, s.max, s.mean]).toEqual([5, 100, 100, 100, 14.7]);
    expect(percentile(new Float64Array(0), 99)).toBe(0);
    expect(summarize([]).count).toBe(0);
  });
  it("SampleRing keeps the newest `capacity` samples, oldest first", () => {
    const r = new SampleRing(3);
    for (const x of [1, 2, 3, 4, 5]) r.push(x);
    expect([...r.values()]).toEqual([3, 4, 5]);
    expect(r.summary().max).toBe(5);
    r.clear();
    expect(r.size).toBe(0);
  });
  it("Bus: typed events, unsubscribe works", () => {
    const bus = new Bus<{ ping: { n: number } }>();
    const seen: number[] = [];
    const off = bus.on("ping", (p) => seen.push(p.n));
    bus.emit("ping", { n: 1 });
    off();
    bus.emit("ping", { n: 2 });
    expect(seen).toEqual([1]);
  });
  it("withAck: a copy with only the ack changed (encode once per tick, not once per client)", () => {
    const enc = encodeSnapshot({ tick: asTick(5), ack: asSeq(1), entities: [] });
    const patched = withAck(enc, 77);
    const r = decodeServer(patched);
    expect(r.ok && r.value.type === "snapshot" && r.value.snapshot.ack).toBe(77);
    const orig = decodeServer(enc);
    expect(orig.ok && orig.value.type === "snapshot" && orig.value.snapshot.ack).toBe(1); // original untouched
  });
  it("assertNever throws for an unhandled case", () => {
    expect(() => assertNever("x" as never)).toThrow(/unhandled/); // eslint-disable-line @typescript-eslint/consistent-type-assertions -- simulating an impossible value
  });
});

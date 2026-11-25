// Property-based tests (fast-check): state an invariant, let the library generate thousands of inputs and SHRINK any
// failure to a minimal counterexample.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decodeClient, decodeServer, encodeInputs, encodeSnapshot } from "../src/codec/binary.ts";
import { snapshotWorld } from "../src/codec/snapshot.ts";
import { asEntityId, asSeq, asTick } from "../src/protocol/ids.ts";
import { parseClientMessage, type EntityRecord } from "../src/protocol/messages.ts";
import { ARENA } from "../src/sim/arena.ts";
import { findCollisions, SpatialHash } from "../src/sim/collision.ts";
import { Asteroid } from "../src/sim/asteroid.ts";
import { PICKUP_TYPES } from "../src/sim/pickup.ts";
import { Ship } from "../src/sim/ship.ts";
import { stepShip, TUNING, type ShipBody, type ShipCommand } from "../src/sim/shipmove.ts";
import { World } from "../src/sim/world.ts";

const id = fc.integer({ min: 0, max: 0xffff }).map(asEntityId);
const coord = fc.double({ min: -1e5, max: 1e5, noNaN: true });
const angle = fc.double({ min: -Math.PI, max: Math.PI, noNaN: true });
const u8 = fc.integer({ min: 0, max: 255 });
const body = { id, x: coord, y: coord, vx: coord, vy: coord, angle };
const entity: fc.Arbitrary<EntityRecord> = fc.oneof(
  fc.record({
    kind: fc.constant("ship" as const),
    ...body,
    thrust: fc.boolean(),
    invuln: fc.boolean(),
    hp: fc.integer({ min: 0, max: 100 }),
    cooldown: u8,
    rapid: u8,
    shield: u8,
    homing: u8,
  }),
  fc.record({ kind: fc.constant("bullet" as const), ...body, owner: id, homing: fc.boolean() }),
  fc.record({
    kind: fc.constant("asteroid" as const),
    ...body,
    radius: fc.double({ min: 0, max: 6000, noNaN: true }),
    seeker: fc.boolean(),
  }),
  fc.record({ kind: fc.constant("pickup" as const), ...body, type: fc.constantFrom(...PICKUP_TYPES) }),
);
const snapshot = fc.record({
  tick: fc.nat({ max: 2 ** 32 - 1 }).map(asTick),
  ack: fc.nat({ max: 2 ** 32 - 1 }).map(asSeq),
  entities: fc.array(entity, { maxLength: 40 }),
});
const command: fc.Arbitrary<ShipCommand> = fc.record({
  turn: fc.constantFrom(-1 as const, 0 as const, 1 as const),
  thrust: fc.boolean(),
  fire: fc.boolean(),
});

describe("binary codec properties", () => {
  it("round-trip: decode(encode(s)) equals s within the quantization of the wire format", () => {
    fc.assert(
      fc.property(snapshot, (s) => {
        const r = decodeServer(encodeSnapshot(s));
        if (!r.ok || r.value.type !== "snapshot") return false;
        const out = r.value.snapshot;
        expect(out.tick).toBe(s.tick);
        expect(out.ack).toBe(s.ack);
        expect(out.entities).toHaveLength(s.entities.length);
        s.entities.forEach((a, i) => {
          const b = out.entities[i];
          expect(b?.kind).toBe(a.kind);
          if (!b) return;
          expect(b.id).toBe(a.id);
          for (const k of ["x", "y", "vx", "vy"] as const) expect(Math.abs(b[k] - Math.fround(a[k]))).toBe(0); // f32
          expect(Math.abs(b.angle - a.angle)).toBeLessThanOrEqual(0.0005 + 1e-9); // 1/1000 rad
          if (a.kind === "asteroid" && b.kind === "asteroid")
            expect(Math.abs(b.radius - a.radius)).toBeLessThanOrEqual(0.05 + 1e-9);
          if (a.kind === "ship" && b.kind === "ship")
            expect([b.hp, b.cooldown, b.rapid]).toEqual([a.hp, a.cooldown, a.rapid]);
        });
        return true;
      }),
      { numRuns: 300 },
    );
  });

  it("length matches the spec: 11 + 28 * entities, and 2 + 6 * inputs", () => {
    fc.assert(fc.property(snapshot, (s) => encodeSnapshot(s).byteLength === 11 + 28 * s.entities.length));
    fc.assert(
      fc.property(fc.array(command, { minLength: 1, maxLength: 5 }), (cmds) => {
        const inputs = cmds.map((c, i) => ({ seq: asSeq(i + 1), ...c }));
        const buf = encodeInputs(inputs);
        const r = decodeClient(buf);
        return buf.byteLength === 2 + 6 * inputs.length && r.ok && r.value.type === "inputs";
      }),
    );
  });

  it("arbitrary garbage never throws: it decodes or returns a typed error", () => {
    const garbage = fc.oneof(
      fc.uint8Array({ maxLength: 300 }),
      // a VALID header followed by garbage reaches deeper code paths
      fc
        .tuple(fc.constantFrom(0x21, 0x22, 0x23, 0x24), fc.uint8Array({ maxLength: 300 }))
        .map(([h, rest]) => Uint8Array.from([h, ...rest])),
    );
    fc.assert(
      fc.property(garbage, (bytes) => {
        const buf = bytes.slice().buffer;
        for (const r of [decodeServer(buf), decodeClient(buf)]) {
          if (!r.ok) expect(typeof r.error).toBe("string");
        }
      }),
      { numRuns: 2000 },
    );
  });
});

describe("simulation properties", () => {
  it("a ship stays inside the arena, finite and under max speed over 1,000 random input steps", () => {
    fc.assert(
      fc.property(fc.array(command, { minLength: 1000, maxLength: 1000 }), (cmds) => {
        const s: ShipBody = {
          pos: { x: 640, y: 360 },
          vel: { x: 0, y: 0 },
          angle: 0,
          cooldown: 0,
          rapid: 0,
          thrust: false,
        };
        for (const c of cmds) {
          stepShip(s, c, 1 / 30);
          if (!(s.pos.x >= 0 && s.pos.x < ARENA.width && s.pos.y >= 0 && s.pos.y < ARENA.height)) return false;
          if (Math.hypot(s.vel.x, s.vel.y) > TUNING.maxSpeed + 1e-3) return false;
        }
        return true;
      }),
      { numRuns: 50 },
    );
  });

  it("energy is bounded under drag: with no thrust the speed never increases", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -500, max: 500, noNaN: true }),
        fc.double({ min: -500, max: 500, noNaN: true }),
        (vx, vy) => {
          const s: ShipBody = {
            pos: { x: 10, y: 10 },
            vel: { x: vx, y: vy },
            angle: 0,
            cooldown: 0,
            rapid: 0,
            thrust: false,
          };
          let speed = Math.hypot(vx, vy);
          for (let i = 0; i < 60; i++) {
            stepShip(s, { turn: 0, thrust: false, fire: false }, 1 / 30);
            const now = Math.hypot(s.vel.x, s.vel.y);
            if (now > speed + 1e-3) return false; // float32 rounding allowance
            speed = now;
          }
          return true;
        },
      ),
    );
  });

  it("determinism: the same seed + the same random inputs give an identical world (a 'clone' by replay)", () => {
    // A World cannot be structurally cloned (behaviors are closures, ids come from a global counter), so it is
    // cloned the way prediction relies on: replaying the same seed and inputs. Ids are left out of the comparison.
    const run = (cmds: readonly ShipCommand[][]) => {
      const w = new World(11, { asteroids: 5, pickupEvery: 3 });
      const ships = [w.spawn(new Ship({ x: 300, y: 300 })), w.spawn(new Ship({ x: 900, y: 400 }))];
      for (const step of cmds)
        w.step(
          1 / 30,
          new Map(ships.map((s, i) => [s.id, [step[i] ?? step[0] ?? { turn: 0, thrust: false, fire: false }]])),
        );
      return {
        entities: snapshotWorld(w)
          .map((e) => ({ ...e, id: 0 }))
          .map((rest) => ("owner" in rest ? { ...rest, owner: 0 } : rest)),
        scores: [...w.scores.values()],
      };
    };
    fc.assert(
      fc.property(
        fc.array(fc.array(command, { minLength: 2, maxLength: 2 }), { minLength: 50, maxLength: 200 }),
        (cmds) => {
          expect(run(cmds)).toEqual(run(cmds));
        },
      ),
      { numRuns: 25 },
    );
  });

  it("the spatial hash finds exactly the naive pairs, in exactly the naive order", () => {
    const circle = fc.record({
      x: fc.double({ min: 0, max: ARENA.width - 0.001, noNaN: true }),
      y: fc.double({ min: 0, max: ARENA.height - 0.001, noNaN: true }),
      r: fc.double({ min: 3, max: 40, noNaN: true }),
    });
    fc.assert(
      fc.property(fc.array(circle, { maxLength: 80 }), (circles) => {
        const w = new World(1, { asteroids: 0 });
        for (const c of circles) w.spawn(new Asteroid({ x: c.x, y: c.y, vx: 0, vy: 0, radius: c.r }));
        const naive = findCollisions(w).map(([a, b]) => `${a.id}-${b.id}`);
        const hashed: string[] = [];
        new SpatialHash().forEachPair(w, (a, b) => hashed.push(`${a.id}-${b.id}`));
        expect(hashed).toEqual(naive);
      }),
      { numRuns: 300 },
    );
  });
});

describe("parseClientMessage properties", () => {
  const nameChars = fc.constantFrom(..."abcXYZ019_-. ".split(""));
  const name = fc.string({ unit: nameChars, minLength: 1, maxLength: 16 }).filter((s) => s.trim().length > 0);
  const valid = fc.oneof(
    fc.record({ v: fc.constant(2), type: fc.constant("join"), room: fc.stringMatching(/^[\w-]{1,40}$/), name }),
    fc.record({
      v: fc.constant(2),
      type: fc.constant("chat"),
      text: fc
        .string({ minLength: 1, maxLength: 200 })
        .filter((s) => s.trim().length > 0 && ![...s].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)),
    }),
    fc.record({
      v: fc.constant(2),
      type: fc.constant("netsim"),
      latency: fc.double({ min: 0, max: 1000, noNaN: true }),
      jitter: fc.double({ min: 0, max: 500, noNaN: true }),
      drop: fc.double({ min: 0, max: 0.5, noNaN: true }),
    }),
  );

  it("accepts every generated valid message", () => {
    fc.assert(
      fc.property(valid, (m) => parseClientMessage(m).ok),
      { numRuns: 1000 },
    );
  });

  it("rejects every generated mutation of a valid message", () => {
    type Msg = Record<string, unknown>;
    const mutations: ((m: Msg) => Msg)[] = [
      (m) => ({ ...m, v: 3 }), // wrong protocol version
      (m) => ({ ...m, type: "nope" }), // unknown type
      (m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== Object.keys(m).at(-1))), // drop a field
      (m) => ({ ...m, [Object.keys(m).at(-1) ?? "v"]: { nested: true } }), // a field of the wrong type
      (m) =>
        m["type"] === "join"
          ? { ...m, name: "x".repeat(17) }
          : m["type"] === "chat"
            ? { ...m, text: "bad\nline" }
            : { ...m, drop: 0.75 }, // out-of-range values
    ];
    fc.assert(
      fc.property(valid, fc.integer({ min: 0, max: mutations.length - 1 }), (m, k) => {
        const mutate = mutations[k];
        return mutate ? !parseClientMessage(mutate({ ...m })).ok : false;
      }),
      { numRuns: 1000 },
    );
  });
});

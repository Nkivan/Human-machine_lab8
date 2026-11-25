// Pure netcode logic (no DOM, no WebSocket): testable in Node, used by the browser game.
// Lab 7: the per-frame and per-step paths allocate nothing once warmed up (see "Allocation" comments).
import { TICK_MS } from "@dogfight/shared/protocol/constants";
import type { Seq } from "@dogfight/shared/protocol/ids";
import type { ShipRecord, Snapshot } from "@dogfight/shared/protocol/messages";
import { ARENA } from "@dogfight/shared/sim/arena";
import type { EntityKind } from "@dogfight/shared/sim/entity";
import { lerp, lerpAngle } from "@dogfight/shared/sim/math";
import { PICKUP_TYPES } from "@dogfight/shared/sim/pickup";
import {
  BULLET_TTL,
  SHIP_RADIUS,
  stepShip,
  TUNING,
  type ShipBody,
  type ShipCommand,
} from "@dogfight/shared/sim/shipmove";
import type { RenderList } from "./render.ts";

export const makeBody = (): ShipBody => ({
  pos: { x: 0, y: 0 },
  vel: { x: 0, y: 0 },
  angle: 0,
  cooldown: 0,
  rapid: 0,
  thrust: false,
});
// Copy INTO an existing body: Lab 6 cloned the whole state ({...pos}, {...vel}, a new object) on every step.
export function copyBody(to: ShipBody, from: ShipBody): void {
  to.pos.x = from.pos.x;
  to.pos.y = from.pos.y;
  to.vel.x = from.vel.x;
  to.vel.y = from.vel.y;
  to.angle = from.angle;
  to.cooldown = from.cooldown;
  to.rapid = from.rapid;
  to.thrust = from.thrust;
}
export function setFromRecord(to: ShipBody, r: ShipRecord): void {
  to.pos.x = r.x;
  to.pos.y = r.y;
  to.vel.x = r.vx;
  to.vel.y = r.vy;
  to.angle = r.angle;
  to.cooldown = r.cooldown;
  to.rapid = r.rapid;
  to.thrust = r.thrust;
}

// Shortest signed distance on a wrapping axis (the arena wraps around).
const wrapDelta = (d: number, size: number): number => (Math.abs(d) > size / 2 ? d - Math.sign(d) * size : d);
const wrapLerp = (a: number, b: number, t: number, size: number): number =>
  Math.abs(b - a) > size / 2 ? b : lerp(a, b, t);
const wrapInto = (v: number, size: number): number => ((v % size) + size) % size;

export interface PendingInput {
  readonly seq: Seq;
  readonly input: ShipCommand;
}
export type Stepper = (body: ShipBody, input: ShipCommand, dt: number) => boolean;

// ---------------------------------------------------------------------------------------------------------------
// Reconciliation as a PURE function of (server state, input buffer, ack): no clock, no socket, no hidden state.
//   state = the server's state for my ship, then every input the server has NOT applied yet (seq > ack) replayed on it.
//   prev  = the state one step before `state` (the renderer interpolates prev -> state by alpha).
// replayInto() is the allocation-free version the predictor runs; reconcileState() wraps it for tests and readers.
// ---------------------------------------------------------------------------------------------------------------
export function replayInto(
  state: ShipBody,
  prev: ShipBody,
  server: ShipRecord,
  pending: readonly PendingInput[],
  ack: Seq,
  dt: number,
  step: Stepper = stepShip,
): void {
  setFromRecord(state, server);
  copyBody(prev, state);
  for (const p of pending) {
    if (p.seq <= ack) continue; // already part of the server state
    copyBody(prev, state);
    step(state, p.input, dt);
  }
}

export function reconcileState(
  server: ShipRecord,
  pending: readonly PendingInput[],
  ack: Seq,
  dt: number,
): { state: ShipBody; prev: ShipBody; remaining: PendingInput[] } {
  const state = makeBody();
  const prev = makeBody();
  replayInto(state, prev, server, pending, ack, dt);
  return { state, prev, remaining: pending.filter((p) => p.seq > ack) };
}

export interface PredictedBullet {
  readonly seq: Seq;
  x: number;
  y: number;
  readonly vx: number;
  readonly vy: number;
  ttl: number;
}
export interface Pose {
  x: number;
  y: number;
  angle: number;
  thrust: boolean;
}
export interface PredictorOptions {
  readonly noise?: number; // > 0 deliberately BREAKS determinism (the README experiment): corrections then grow
}
export interface Predictor {
  readonly ready: boolean;
  readonly pendingCount: number;
  readonly predictedBullets: readonly PredictedBullet[];
  readonly errorMagnitude: number;
  clear(): void;
  apply(seq: Seq, input: ShipCommand, dt: number): boolean;
  reconcile(record: ShipRecord, ack: Seq, dt: number): number;
  stepBullets(dt: number): void;
  dropAckedBullets(ack: Seq): void;
  decayError(dtSec: number, tau?: number): void;
  renderPose(alpha: number): Readonly<Pose> | null; // the SAME object every call: read it, do not keep it
}

// ---------------------------------------------------------------------------------------------------------------
// Prediction + reconciliation for the LOCAL ship.
//  apply():     run the shared stepShip with my own input right now (the ship responds instantly) and remember the input.
//  reconcile(): a snapshot arrived for an OLD tick: replayInto() the server state + my unacknowledged inputs.
//  The difference between "where I was" and "where I am after replay" is the correction; it is hidden by decaying it.
// Allocation: state/prev/scratch bodies and the pose are allocated once; the per-step clone of Lab 6 is gone.
// ---------------------------------------------------------------------------------------------------------------
export function createPredictor({ noise = 0 }: PredictorOptions = {}): Predictor {
  let ready = false;
  const state = makeBody();
  const prev = makeBody();
  const pose: Pose = { x: 0, y: 0, angle: 0, thrust: false };
  let errX = 0;
  let errY = 0;
  const pending: PendingInput[] = []; // sent but not yet acknowledged
  const bullets: PredictedBullet[] = []; // predicted local bullets

  const step: Stepper = (body, input, dt) => {
    const fired = stepShip(body, input, dt);
    if (noise) body.vel.x += (Math.random() - 0.5) * noise; // <- non-determinism, on purpose
    return fired;
  };

  return {
    get ready() {
      return ready;
    },
    get pendingCount() {
      return pending.length;
    },
    get predictedBullets() {
      return bullets;
    },
    get errorMagnitude() {
      return Math.hypot(errX, errY);
    },

    clear() {
      ready = false;
      pending.length = 0;
      bullets.length = 0;
      errX = errY = 0;
    },

    apply(seq, input, dt) {
      pending.push({ seq, input }); // ALWAYS remember it: before the first snapshot there is no state yet, but the
      if (pending.length > 120) pending.shift(); // replay after the first reconcile needs these inputs. (Bounded while dead.)
      if (!ready) return false;
      copyBody(prev, state);
      const fired = step(state, input, dt);
      if (fired) {
        const c = Math.cos(state.angle);
        const s = Math.sin(state.angle);
        bullets.push({
          seq,
          x: state.pos.x + c * (SHIP_RADIUS + 4),
          y: state.pos.y + s * (SHIP_RADIUS + 4),
          vx: state.vel.x + c * TUNING.bulletSpeed,
          vy: state.vel.y + s * TUNING.bulletSpeed,
          ttl: BULLET_TTL,
        });
      }
      return fired;
    },

    // Returns the correction magnitude in pixels.
    reconcile(record, ack, dt) {
      const hadState = ready;
      const beforeX = state.pos.x;
      const beforeY = state.pos.y;
      while (pending[0] && pending[0].seq <= ack) pending.shift();
      replayInto(state, prev, record, pending, ack, dt, step); // replay the unacknowledged inputs
      ready = true;
      if (!hadState) return 0; // first snapshot (or respawn): nothing to compare with
      const dx = wrapDelta(beforeX - state.pos.x, ARENA.width);
      const dy = wrapDelta(beforeY - state.pos.y, ARENA.height);
      errX += dx; // smoothing: keep drawing where I WAS and let the error melt away
      errY += dy;
      return Math.hypot(dx, dy);
    },

    stepBullets(dt) {
      for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        if (!b) continue;
        b.x = wrapInto(b.x + b.vx * dt, ARENA.width);
        b.y = wrapInto(b.y + b.vy * dt, ARENA.height);
        b.ttl -= dt;
        if (b.ttl <= 0) bullets.splice(i, 1);
      }
    },
    // Predicted bullets are replaced by the server's authoritative ones once the server has processed that input.
    dropAckedBullets(ack) {
      for (let i = bullets.length - 1; i >= 0; i--) if ((bullets[i]?.seq ?? Infinity) <= ack) bullets.splice(i, 1);
    },

    decayError(dtSec, tau = 0.1) {
      const k = Math.exp(-dtSec / tau);
      errX *= k;
      errY *= k;
    },

    // Pose to DRAW: interpolate the last two predicted steps by alpha plus the decaying error.
    renderPose(alpha) {
      if (!ready) return null;
      pose.x = wrapLerp(prev.pos.x, state.pos.x, alpha, ARENA.width) + errX;
      pose.y = wrapLerp(prev.pos.y, state.pos.y, alpha, ARENA.height) + errY;
      pose.angle = lerpAngle(prev.angle, state.angle, alpha);
      pose.thrust = state.thrust;
      return pose;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Entity interpolation for REMOTE entities: draw them `delayMs` in the past, between the two snapshots that bracket
// that moment. Time is SERVER time (tick * TICK_MS) so network jitter does not shake the clock.
//
// Storage (Lab 7): every snapshot is copied into a reusable SLOT of typed arrays (structure of arrays). Lab 6 kept the
// decoded record objects themselves for a whole second (30 snapshots x every entity): long enough to survive two
// scavenges, get PROMOTED to the old generation and eventually trigger a major GC in the middle of a frame.
// Now the records die young (right after push) and the slots are recycled forever.
// ---------------------------------------------------------------------------------------------------------------
const KINDS: readonly EntityKind[] = ["ship", "bullet", "asteroid", "pickup"];
const KIND_CODE: Readonly<Record<EntityKind, number>> = { ship: 0, bullet: 1, asteroid: 2, pickup: 3 };
const F_THRUST = 1;
const F_INVULN = 2;
const F_SHIELD = 4;
const F_SEEKER = 8;
const F_HOMING = 16;

class SnapSlot {
  t = 0;
  count = 0;
  id = new Uint16Array(64);
  kind = new Uint8Array(64);
  flags = new Uint8Array(64);
  pickup = new Uint8Array(64);
  x = new Float64Array(64);
  y = new Float64Array(64);
  angle = new Float64Array(64);
  radius = new Float32Array(64);

  reserve(n: number): void {
    if (n <= this.id.length) return;
    let cap = this.id.length;
    while (cap < n) cap *= 2; // grows rarely (doubling), never shrinks
    const grow = <T extends Uint8Array | Uint16Array | Float32Array | Float64Array>(
      a: T,
      make: (n: number) => T,
    ): T => {
      const b = make(cap);
      b.set(a);
      return b;
    };
    this.id = grow(this.id, (k) => new Uint16Array(k));
    this.kind = grow(this.kind, (k) => new Uint8Array(k));
    this.flags = grow(this.flags, (k) => new Uint8Array(k));
    this.pickup = grow(this.pickup, (k) => new Uint8Array(k));
    this.x = grow(this.x, (k) => new Float64Array(k));
    this.y = grow(this.y, (k) => new Float64Array(k));
    this.angle = grow(this.angle, (k) => new Float64Array(k));
    this.radius = grow(this.radius, (k) => new Float32Array(k));
  }
}

export interface Interpolator {
  delayMs: number;
  readonly size: number;
  push(snapshot: Snapshot, nowMs: number): void;
  ageMs(nowMs: number): number;
  // Appends every remote entity at render time `nowMs - delay` to `out` (except the ship `skipId`). Returns how many.
  sample(nowMs: number, out: RenderList, skipId?: number): number;
}

export function createInterpolator({ delayMs: initialDelay = 2 * TICK_MS, maxSnapshots = 24 } = {}): Interpolator {
  const slots = Array.from({ length: maxSnapshots }, () => new SnapSlot()); // a ring, allocated once
  let head = 0; // oldest
  let len = 0;
  let delay = initialDelay;
  let offset: number | null = null; // serverTimeMs - localTimeMs, smoothed
  let lastArrival = 0;
  // id -> index in the older snapshot of the bracket. Wire ids are 16-bit, so a flat table works; a generation stamp
  // means it never has to be cleared (O(1) "reset" per frame instead of O(65536)).
  const stamp = new Uint32Array(65536);
  const indexOf = new Int32Array(65536);
  let generation = 0;

  const at = (i: number): SnapSlot | undefined => slots[(head + i) % maxSnapshots];

  return {
    get delayMs() {
      return delay;
    },
    set delayMs(v: number) {
      delay = Math.max(0, Math.min(500, v));
    },
    get size() {
      return len;
    },

    push(snapshot, nowMs) {
      const t = snapshot.tick * TICK_MS;
      const newest = len ? at(len - 1) : undefined;
      if (newest && t <= newest.t) {
        if (t < newest.t - 1000) {
          len = 0;
          offset = null;
        } // server restarted: forget the past
        else return; // duplicate / out of order
      }
      const sample = t - nowMs;
      offset = offset === null ? sample : offset + (sample - offset) * 0.05;
      lastArrival = nowMs;

      let slot: SnapSlot | undefined;
      if (len < maxSnapshots) {
        slot = at(len);
        len++;
      } else {
        slot = at(0); // overwrite the oldest
        head = (head + 1) % maxSnapshots;
      }
      if (!slot) return;
      const n = snapshot.entities.length;
      slot.reserve(n);
      slot.t = t;
      slot.count = n;
      for (let i = 0; i < n; i++) {
        const e = snapshot.entities[i];
        if (!e) continue;
        slot.id[i] = e.id;
        slot.kind[i] = KIND_CODE[e.kind];
        slot.x[i] = e.x;
        slot.y[i] = e.y;
        slot.angle[i] = e.angle;
        let flags = 0;
        let radius = 0;
        let pickup = 0;
        switch (e.kind) {
          case "ship":
            flags = (e.thrust ? F_THRUST : 0) | (e.invuln ? F_INVULN : 0) | (e.shield > 0 ? F_SHIELD : 0);
            break;
          case "bullet":
            flags = e.homing ? F_HOMING : 0;
            break;
          case "asteroid":
            flags = e.seeker ? F_SEEKER : 0;
            radius = e.radius;
            break;
          case "pickup":
            pickup = PICKUP_TYPES.indexOf(e.type);
            break;
        }
        slot.flags[i] = flags;
        slot.radius[i] = radius;
        slot.pickup[i] = pickup;
      }
    },

    ageMs(nowMs) {
      return lastArrival ? nowMs - lastArrival : 0;
    },

    // Entities that vanished are skipped, new ones appear at once. Allocates nothing (writes into `out`'s pool).
    sample(nowMs, out, skipId = -1) {
      if (!len || offset === null) return 0;
      const rt = nowMs + offset - delay;
      let i = len - 1;
      while (i > 0 && (at(i - 1)?.t ?? 0) > rt) i--; // at(i-1).t <= rt < at(i).t (when i > 0)
      const b = at(i);
      if (!b) return 0;
      const a = i > 0 ? at(i - 1) : undefined;
      const between = a !== undefined && rt < b.t; // otherwise: before the first / after the last snapshot -> hold b
      const f = between ? (rt - a.t) / (b.t - a.t) : 1;
      if (between) {
        generation = (generation + 1) >>> 0 || 1;
        for (let j = 0; j < a.count; j++) {
          const id = a.id[j] ?? 0;
          stamp[id] = generation;
          indexOf[id] = j;
        }
      }
      let added = 0;
      for (let j = 0; j < b.count; j++) {
        const id = b.id[j] ?? 0;
        const kind = KINDS[b.kind[j] ?? 0] ?? "ship";
        if (kind === "ship" && id === skipId) continue; // my own ship comes from prediction
        const flags = b.flags[j] ?? 0;
        const e = out.next();
        e.id = id;
        e.kind = kind;
        e.radius = b.radius[j] ?? 0;
        e.thrust = (flags & F_THRUST) !== 0;
        e.invuln = (flags & F_INVULN) !== 0;
        e.shield = (flags & F_SHIELD) !== 0;
        e.seeker = (flags & F_SEEKER) !== 0;
        e.homing = (flags & F_HOMING) !== 0;
        e.pickup = PICKUP_TYPES[b.pickup[j] ?? 0] ?? "shield";
        e.me = false;
        const bx = b.x[j] ?? 0;
        const by = b.y[j] ?? 0;
        const ba = b.angle[j] ?? 0;
        const ja = between && stamp[id] === generation ? (indexOf[id] ?? -1) : -1;
        if (ja >= 0 && a) {
          e.x = wrapLerp(a.x[ja] ?? bx, bx, f, ARENA.width);
          e.y = wrapLerp(a.y[ja] ?? by, by, f, ARENA.height);
          e.angle = lerpAngle(a.angle[ja] ?? ba, ba, f);
        } else {
          e.x = bx;
          e.y = by;
          e.angle = ba;
        }
        added++;
      }
      return added;
    },
  };
}

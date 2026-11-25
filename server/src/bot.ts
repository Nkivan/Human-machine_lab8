// Server-side AI players (Lab 7). A Bot is a PlayerInput like a WebSocket client:
//  - it SEES only what a browser sees: the "welcome" message (its ship id) and the snapshots;
//  - it ACTS only the way a browser acts: seq-numbered Inputs through Match.receiveInputs (same dedup, same limits).
// It never reads the World directly, so it cannot cheat, and the Match cannot tell it from a human.
import { randomUUID } from "node:crypto";
import { asSeq } from "@dogfight/shared/protocol/ids";
import type { EntityRecord, ServerMessage, ShipRecord, Snapshot } from "@dogfight/shared/protocol/messages";
import { ARENA } from "@dogfight/shared/sim/arena";
import { TAU } from "@dogfight/shared/sim/math";
import { mulberry32 } from "@dogfight/shared/sim/random";
import { SHIP_RADIUS, TUNING, type Input, type ShipCommand } from "@dogfight/shared/sim/shipmove";
import type { PlayerInput, Room } from "./rooms.ts";

const wrapDelta = (d: number, size: number): number => (Math.abs(d) > size / 2 ? d - Math.sign(d) * size : d);
const wrapAngle = (a: number): number => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;

// The bot's "personality" and short-term memory. Seeded: the same seed gives the same pilot.
export interface BotBrain {
  readonly aimTolerance: number; // radians: how well aligned before pulling the trigger
  readonly preferredRange: number; // px: closes in when farther than this
  readonly dangerRange: number; // px of clearance below which an approaching asteroid is a threat
  wander: number; // heading used when there is nothing to chase
  readonly rng: () => number;
}

export function createBrain(seed: number): BotBrain {
  const rng = mulberry32(seed);
  return {
    aimTolerance: 0.12 + rng() * 0.2,
    preferredRange: 160 + rng() * 180,
    dangerRange: 50 + rng() * 40,
    wander: rng() * TAU,
    rng,
  };
}

const IDLE: ShipCommand = { turn: 0, thrust: false, fire: false };
const steer = (diff: number, deadZone = 0.06): -1 | 0 | 1 => (diff > deadZone ? 1 : diff < -deadZone ? -1 : 0);

interface Rel {
  readonly dx: number;
  readonly dy: number;
  readonly dist: number;
}
const rel = (me: ShipRecord, e: EntityRecord): Rel => {
  const dx = wrapDelta(e.x - me.x, ARENA.width);
  const dy = wrapDelta(e.y - me.y, ARENA.height);
  return { dx, dy, dist: Math.hypot(dx, dy) };
};

// Pure decision: (what I can see, who I am, my brain) -> one command. Chase, evade, shoot.
export function decide(snapshot: Snapshot | null, you: number | null, brain: BotBrain): ShipCommand {
  if (!snapshot || you === null) return IDLE;
  let me: ShipRecord | undefined;
  for (const e of snapshot.entities) if (e.kind === "ship" && e.id === you) me = e;
  if (!me) return IDLE; // dead: waiting for the respawn

  // 1) EVADE: the most threatening asteroid that is close AND closing in.
  let threat: { rel: Rel; clearance: number } | null = null;
  for (const e of snapshot.entities) {
    if (e.kind !== "asteroid") continue;
    const r = rel(me, e);
    const clearance = r.dist - e.radius - SHIP_RADIUS;
    const closing = (e.vx - me.vx) * r.dx + (e.vy - me.vy) * r.dy < 0; // relative velocity points at me
    if (clearance < brain.dangerRange && closing && (!threat || clearance < threat.clearance)) {
      threat = { rel: r, clearance };
    }
  }
  if (threat) {
    const away = Math.atan2(-threat.rel.dy, -threat.rel.dx);
    const toward = wrapAngle(Math.atan2(threat.rel.dy, threat.rel.dx) - me.angle);
    // Shoot it if it is already in front of us; otherwise turn away and burn.
    return { turn: steer(wrapAngle(away - me.angle)), thrust: true, fire: Math.abs(toward) < brain.aimTolerance };
  }

  // 2) CHASE: the nearest enemy ship, else the nearest asteroid.
  let target: EntityRecord | null = null;
  let best = Infinity;
  for (const pass of ["ship", "asteroid"] as const) {
    for (const e of snapshot.entities) {
      if (e.kind !== pass || (e.kind === "ship" && e.id === you)) continue;
      const d = rel(me, e).dist;
      if (d < best) {
        best = d;
        target = e;
      }
    }
    if (target) break;
  }
  if (!target) {
    if (brain.rng() < 0.02) brain.wander = brain.rng() * TAU; // nothing around: cruise, change course now and then
    return { turn: steer(wrapAngle(brain.wander - me.angle)), thrust: Math.hypot(me.vx, me.vy) < 120, fire: false };
  }

  // 3) AIM with lead: where the target will be when a bullet gets there.
  const r = rel(me, target);
  const t = r.dist / TUNING.bulletSpeed;
  const ax = r.dx + (target.vx - me.vx) * t;
  const ay = r.dy + (target.vy - me.vy) * t;
  const diff = wrapAngle(Math.atan2(ay, ax) - me.angle);
  return {
    turn: steer(diff),
    thrust: r.dist > brain.preferredRange && Math.abs(diff) < 1.2,
    fire: Math.abs(diff) < brain.aimTolerance && r.dist < 560,
  };
}

let botCounter = 0;

export class Bot implements PlayerInput {
  readonly id = `bot-${randomUUID()}`;
  readonly name: string;
  readonly #room: Room;
  readonly #brain: BotBrain;
  #you: number | null = null;
  #latest: Snapshot | null = null;
  #seq = 0;
  #scheduled = false;
  #stopped = false;

  constructor(room: Room, seed: number, name = `Bot-${++botCounter}`) {
    this.#room = room;
    this.#brain = createBrain(seed);
    this.name = name;
  }

  // ---- output side: exactly what a WebSocket client receives ----
  send(msg: ServerMessage): void {
    if (msg.type === "welcome") this.#you = msg.you; // the same "welcome" a browser gets: that is how it knows its ship
  }

  sendSnapshot(snapshot: Snapshot): void {
    this.#latest = snapshot;
    // Think AFTER the tick (setImmediate): the AI's CPU time is not counted as tick time, like a client on its own thread.
    if (!this.#scheduled && !this.#stopped) {
      this.#scheduled = true;
      setImmediate(this.#think);
    }
  }

  // ---- input side: exactly what a WebSocket client sends ----
  readonly #think = (): void => {
    this.#scheduled = false;
    if (this.#stopped) return;
    const cmd = decide(this.#latest, this.#you, this.#brain);
    const input: Input = { seq: asSeq(++this.#seq), ...cmd };
    this.#room.match.receiveInputs(this.id, [input]);
  };

  stop(): void {
    this.#stopped = true;
  }
}

// ---- bot management (the HTTP endpoint lives in app.ts) ----
const botsByRoom = new WeakMap<Room, Map<string, Bot>>();

export function addBots(room: Room, count: number, maxBots: number): Bot[] {
  let bots = botsByRoom.get(room);
  if (!bots) {
    const created = new Map<string, Bot>();
    bots = created;
    botsByRoom.set(room, created);
    // When the last HUMAN leaves, the bots leave too: a room nobody watches must not burn CPU forever.
    room.on("leave", (player) => {
      if (!created.has(player.id) && room.humans === 0 && created.size > 0) removeBots(room);
    });
  }
  const n = Math.max(0, Math.min(count, maxBots - bots.size));
  const added: Bot[] = [];
  for (let i = 0; i < n; i++) {
    const bot = new Bot(room, (room.arena.seed + bots.size * 7919 + 1) >>> 0);
    bots.set(bot.id, bot);
    room.bots.add(bot.id);
    room.join(bot); // same path as a human: roster, "joined" message, Match.addPlayer -> "welcome"
    added.push(bot);
  }
  return added;
}

export function removeBots(room: Room): number {
  const bots = botsByRoom.get(room);
  if (!bots) return 0;
  const all = [...bots.values()];
  bots.clear();
  for (const bot of all) {
    bot.stop();
    room.bots.delete(bot.id);
    room.leave(bot.id);
  }
  return all.length;
}

export const botCount = (room: Room): number => botsByRoom.get(room)?.size ?? 0;

// ONE source of truth for every JSON message: zod schema -> inferred TypeScript type -> runtime parser.
// Types are erased at runtime, so a type alone cannot stop a client sending { turn: 1e9 }; the schema can.
import { z } from "zod";
import { err, ok, type Result } from "../util.ts";
import { PROTOCOL_VERSION } from "./constants.ts";
import { asEntityId, asSeq, asTick, type EntityId, type Seq, type Tick } from "./ids.ts";
import { PICKUP_TYPES } from "../sim/pickup.ts";

export const LIMITS = { name: 16, text: 200 } as const;

const v = z.literal(PROTOCOL_VERSION);
const wireId = z.number().int().min(0).max(0xffff).transform(asEntityId);
const tick = z.number().int().min(0).transform(asTick);
const seq = z.number().int().min(0).transform(asSeq);
const num = z.number();

function hasNoControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return false;
  }
  return true;
}
const name = z.string().trim().min(1).max(LIMITS.name).refine(hasNoControlChars, "control characters are not allowed");
const text = z.string().trim().min(1).max(LIMITS.text).refine(hasNoControlChars, "control characters are not allowed");

export const NetsimSettings = z.object({
  latency: z.number().min(0).max(1000),
  jitter: z.number().min(0).max(500),
  drop: z.number().min(0).max(0.5),
});
export type NetsimSettings = z.infer<typeof NetsimSettings>;

// ---------- entities as they travel in a snapshot (a discriminated union on `kind`) ----------
const body = { id: wireId, x: num, y: num, vx: num, vy: num, angle: num } as const; // asteroids carry angle 0: one layout for all
export const ShipRecord = z.object({
  kind: z.literal("ship"),
  ...body,
  thrust: z.boolean(),
  invuln: z.boolean(),
  hp: z.number().int().min(0).max(100),
  cooldown: z.number().int().min(0).max(255),
  rapid: z.number().int().min(0).max(255), // steps left (1 step = 1/30 s)
  shield: z.number().int().min(0).max(255),
  homing: z.number().int().min(0).max(255),
});
export const BulletRecord = z.object({ kind: z.literal("bullet"), ...body, owner: wireId, homing: z.boolean() });
export const AsteroidRecord = z.object({
  kind: z.literal("asteroid"),
  ...body,
  radius: z.number().min(0),
  seeker: z.boolean(),
});
export const PickupRecord = z.object({ kind: z.literal("pickup"), ...body, type: z.enum(PICKUP_TYPES) });
export const EntityRecord = z.discriminatedUnion("kind", [ShipRecord, BulletRecord, AsteroidRecord, PickupRecord]);
export type ShipRecord = z.infer<typeof ShipRecord>;
export type BulletRecord = z.infer<typeof BulletRecord>;
export type AsteroidRecord = z.infer<typeof AsteroidRecord>;
export type PickupRecord = z.infer<typeof PickupRecord>;
export type EntityRecord = z.infer<typeof EntityRecord>;

export interface Snapshot {
  readonly tick: Tick;
  readonly ack: Seq; // last input seq the server applied for THIS client
  readonly entities: readonly EntityRecord[];
}
const snapshotFields = { tick, ack: seq, entities: z.array(EntityRecord) } as const;

// ---------- events the sim announces, as they travel to clients ----------
export const WireEvent = z.discriminatedUnion("k", [
  z.object({ k: z.literal("fired"), shipId: wireId, x: num, y: num }),
  z.object({ k: z.literal("pickup"), shipId: wireId, type: z.enum(PICKUP_TYPES), x: num, y: num }),
  z.object({ k: z.literal("hit"), x: num, y: num }),
  z.object({ k: z.literal("exploded"), x: num, y: num, kind: z.enum(["ship", "asteroid"]) }),
  z.object({ k: z.literal("score"), owner: wireId, delta: z.number().int(), total: z.number().int(), x: num, y: num }),
]);
export type WireEvent = z.infer<typeof WireEvent>;

// ---------- client -> server ----------
export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ v, type: z.literal("join"), room: z.string().regex(/^[\w-]{1,40}$/, "bad room id"), name }),
  z.object({ v, type: z.literal("chat"), text }),
  z.object({ v, type: z.literal("netsim"), ...NetsimSettings.shape }), // latency injector control (debug servers only)
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ---------- server -> client ----------
export const ServerMessage = z.discriminatedUnion("type", [
  z.object({ v, type: z.literal("roster"), players: z.array(z.string()) }),
  z.object({ v, type: z.literal("chat"), from: z.string(), text: z.string(), t: num }),
  z.object({ v, type: z.literal("system"), text: z.string() }),
  z.object({ v, type: z.literal("error"), code: z.string(), message: z.string() }),
  z.object({ v, type: z.literal("welcome"), you: wireId, tick, tickRate: num, seed: num }),
  z.object({ v, type: z.literal("events"), list: z.array(WireEvent) }),
  z.object({ v, type: z.literal("scores"), list: z.array(z.tuple([z.string(), z.number().int()])) }),
  z.object({ v, type: z.literal("netsim"), ...NetsimSettings.shape }),
  z.object({ v, type: z.literal("snapshot"), ...snapshotFields }), // only when the JSON codec is selected
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

// ---------- the HTTP API ----------
export const ArenaConfig = z.object({
  asteroids: z.number().int().min(0).max(30),
  pickupEvery: z.number().int().min(2).max(60),
  seed: z
    .number()
    .int()
    .min(0)
    .max(2 ** 31 - 1),
});
export type ArenaConfig = z.infer<typeof ArenaConfig>;
export const RoomInfo = z.object({
  id: z.string(),
  name: z.string(),
  players: z.number().int(),
  bots: z.number().int().min(0).default(0), // Lab 7: server-side AI players (not counted in `players`)
  max: z.number().int(),
  arena: ArenaConfig,
});
export type RoomInfo = z.infer<typeof RoomInfo>;
export const RoomsResponse = z.object({ rooms: z.array(RoomInfo) });

export const SnapshotMessage = z.object({ v, type: z.literal("snapshot"), ...snapshotFields });

// ---------- parsers: NEVER throw on bad input, return a Result ----------
function describe(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid message";
  const path = issue.path.join(".");
  return (path ? `${path}: ${issue.message}` : issue.message).slice(0, 100); // a close reason is limited to 123 bytes
}

function parse<T>(schema: z.ZodType<T>, data: unknown): Result<T> {
  const r = schema.safeParse(data);
  return r.success ? ok(r.data) : err(describe(r.error));
}

export const parseClientMessage = (data: unknown): Result<ClientMessage> => parse(ClientMessage, data);
export const parseServerMessage = (data: unknown): Result<ServerMessage> => parse(ServerMessage, data);
export const parseRoomsResponse = (data: unknown): Result<z.infer<typeof RoomsResponse>> => parse(RoomsResponse, data);

// A type guard factory: `msgs.filter(messageIs("welcome"))` gives Extract<ServerMessage, { type: "welcome" }>[] with NO cast.
export function messageIs<T extends ServerMessage["type"]>(
  type: T,
): (m: ServerMessage) => m is Extract<ServerMessage, { type: T }> {
  return (m): m is Extract<ServerMessage, { type: T }> => m.type === type;
}

export type { EntityId };

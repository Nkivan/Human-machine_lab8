// ============================================================================
// BINARY PROTOCOL SPEC v2   (little-endian everywhere)
//
// Byte 0 of EVERY frame:  high nibble = protocol version (2), low nibble = message type.
//   A frame with another version is rejected (a version guard that costs no extra byte).
//
// C->S  INPUT    (1)  u8 hdr | u8 count (1..5) | count x { u32 seq | i8 turn (-1,0,1) | u8 flags (bit0 thrust, bit1 fire) }
//                     = 2 + 6*count bytes. The last few inputs are repeated in every packet (redundancy against loss).
// C->S  PING     (3)  u8 hdr | f64 clientTime                                        = 9 bytes
// S->C  PONG     (4)  u8 hdr | f64 clientTime (echoed) | u32 serverTick              = 13 bytes
// S->C  SNAPSHOT (2)  u8 hdr | u32 tick | u32 ack | u16 count | count x ENTITY       = 11 + 28*count bytes
//        ENTITY (28 bytes): u16 id | u8 kind | u8 flags | f32 x | f32 y | f32 vx | f32 vy | i16 angle (1/1000 rad) | u16 aux
//                           | u8 rapid | u8 shield | u8 homing | u8 reserved   (ship effects, in 1/30 s steps; 0 for other kinds)
//        kind 1 ship     flags bit0 thrust, bit1 invulnerable     aux = hp | cooldownSteps << 8
//        kind 2 bullet   flags bit3 homing                          aux = owner id
//        kind 4 pickup                                              aux = type index + 1 (shield, rapid, homing)
//        kind 3 asteroid flags bit2 seeker                          aux = radius * 10 (angle is always 0)
//
// Decoding NEVER throws: it returns a typed message or an error string (a malformed frame must not take the server down).
// Why lossless: the sim keeps x/y/vx/vy as float32 and the angle in whole milliradians.
// ============================================================================
import { MAX_INPUTS_PER_PACKET, MSG, PROTOCOL_VERSION, type MsgType } from "../protocol/constants.ts";
import { asEntityId, asSeq, asTick, type Tick } from "../protocol/ids.ts";
import { PICKUP_TYPES } from "../sim/pickup.ts";
import type { EntityRecord, Snapshot } from "../protocol/messages.ts";
import type { Input } from "../sim/shipmove.ts";
import { assertNever, err, ok, type Result } from "../util.ts";

const LE = true;
const HEADER = 11;
const ENTITY = 28;
const KIND_CODE = { ship: 1, bullet: 2, asteroid: 3, pickup: 4 } as const;

export type ClientBinary =
  { readonly type: "inputs"; readonly inputs: readonly Input[] } | { readonly type: "ping"; readonly t: number };
export type ServerBinary =
  | { readonly type: "snapshot"; readonly snapshot: Snapshot }
  | { readonly type: "pong"; readonly t: number; readonly tick: Tick };

const header = (type: MsgType): number => (PROTOCOL_VERSION << 4) | type;

export function encodeInputs(inputs: readonly Input[]): ArrayBuffer {
  const buf = new ArrayBuffer(2 + inputs.length * 6);
  const v = new DataView(buf);
  v.setUint8(0, header(MSG.INPUT));
  v.setUint8(1, inputs.length);
  inputs.forEach((inp, i) => {
    const o = 2 + i * 6;
    v.setUint32(o, inp.seq >>> 0, LE);
    v.setInt8(o + 4, inp.turn);
    v.setUint8(o + 5, (inp.thrust ? 1 : 0) | (inp.fire ? 2 : 0));
  });
  return buf;
}

export function encodePing(clientTime: number): ArrayBuffer {
  const buf = new ArrayBuffer(9);
  const v = new DataView(buf);
  v.setUint8(0, header(MSG.PING));
  v.setFloat64(1, clientTime, LE);
  return buf;
}

export function encodePong(clientTime: number, tick: Tick): ArrayBuffer {
  const buf = new ArrayBuffer(13);
  const v = new DataView(buf);
  v.setUint8(0, header(MSG.PONG));
  v.setFloat64(1, clientTime, LE);
  v.setUint32(9, tick >>> 0, LE);
  return buf;
}

function writeEntity(v: DataView, o: number, e: EntityRecord): void {
  let flags = 0;
  let aux = 0;
  let rapid = 0;
  let shield = 0;
  let homingSteps = 0;
  switch (e.kind) {
    case "ship":
      flags = (e.thrust ? 1 : 0) | (e.invuln ? 2 : 0);
      aux = e.hp | (e.cooldown << 8);
      rapid = e.rapid;
      shield = e.shield;
      homingSteps = e.homing;
      break;
    case "bullet":
      flags = e.homing ? 8 : 0;
      aux = e.owner;
      break;
    case "asteroid":
      flags = e.seeker ? 4 : 0;
      aux = Math.min(0xffff, Math.round(e.radius * 10));
      break;
    case "pickup":
      aux = PICKUP_TYPES.indexOf(e.type) + 1;
      break;
    default:
      return assertNever(e);
  }
  v.setUint16(o, e.id & 0xffff, LE);
  v.setUint8(o + 2, KIND_CODE[e.kind]);
  v.setUint8(o + 3, flags);
  v.setFloat32(o + 4, e.x, LE);
  v.setFloat32(o + 8, e.y, LE);
  v.setFloat32(o + 12, e.vx, LE);
  v.setFloat32(o + 16, e.vy, LE);
  v.setInt16(o + 20, Math.round(e.angle * 1000), LE);
  v.setUint16(o + 22, aux, LE);
  v.setUint8(o + 24, rapid);
  v.setUint8(o + 25, shield);
  v.setUint8(o + 26, homingSteps);
}

export function encodeSnapshot(s: Snapshot): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER + s.entities.length * ENTITY);
  const v = new DataView(buf);
  v.setUint8(0, header(MSG.SNAPSHOT));
  v.setUint32(1, s.tick >>> 0, LE);
  v.setUint32(5, s.ack >>> 0, LE);
  v.setUint16(9, s.entities.length, LE);
  s.entities.forEach((e, i) => writeEntity(v, HEADER + i * ENTITY, e));
  return buf;
}

// The snapshot is the same for every client of a room except the 4-byte `ack` (bytes 5..8). Encoding it once per tick
// and handing each client a COPY with its own ack turns O(clients x entities) encoding work into O(entities) + memcpy.
// (Found by --cpu-prof under load in Lab 7: writeEntity was 19 % of the server's CPU at 192 clients.)
export function withAck(encoded: ArrayBuffer, ack: number): ArrayBuffer {
  const copy = encoded.slice(0); // a copy: the original may still be queued for another socket
  new DataView(copy).setUint32(5, ack >>> 0, LE);
  return copy;
}

// Server side: NEVER trust a client frame.
export function decodeClient(buf: ArrayBuffer): Result<ClientBinary> {
  if (buf.byteLength < 1) return err("empty frame");
  const v = new DataView(buf);
  const first = v.getUint8(0);
  if (first >> 4 !== PROTOCOL_VERSION) return err("protocol version mismatch");
  switch (first & 15) {
    case MSG.INPUT: {
      if (buf.byteLength < 2) return err("short input");
      const count = v.getUint8(1);
      if (count < 1 || count > MAX_INPUTS_PER_PACKET) return err("bad input count");
      if (buf.byteLength !== 2 + count * 6) return err("bad input length");
      const inputs: Input[] = [];
      for (let i = 0; i < count; i++) {
        const o = 2 + i * 6;
        const turn = v.getInt8(o + 4);
        const flags = v.getUint8(o + 5);
        if (turn !== -1 && turn !== 0 && turn !== 1) return err("bad turn"); // a turn of 1000 is a cheat; this also narrows `turn`
        if (flags > 3) return err("bad flags");
        inputs.push({ seq: asSeq(v.getUint32(o, LE)), turn, thrust: (flags & 1) !== 0, fire: (flags & 2) !== 0 });
      }
      return ok({ type: "inputs", inputs });
    }
    case MSG.PING:
      if (buf.byteLength !== 9) return err("bad ping length");
      return ok({ type: "ping", t: v.getFloat64(1, LE) });
    default:
      return err("unknown binary type");
  }
}

function readEntity(v: DataView, o: number): Result<EntityRecord> {
  const id = asEntityId(v.getUint16(o, LE));
  const flags = v.getUint8(o + 3);
  const x = v.getFloat32(o + 4, LE);
  const y = v.getFloat32(o + 8, LE);
  const vx = v.getFloat32(o + 12, LE);
  const vy = v.getFloat32(o + 16, LE);
  const angle = v.getInt16(o + 20, LE) / 1000;
  const aux = v.getUint16(o + 22, LE);
  if (![x, y, vx, vy].every(Number.isFinite)) return err("non-finite number");
  const b = { id, x, y, vx, vy, angle };
  switch (v.getUint8(o + 2)) {
    case KIND_CODE.ship: {
      const hp = aux & 0xff;
      if (hp > 100) return err("bad hp");
      return ok({
        kind: "ship",
        ...b,
        thrust: (flags & 1) !== 0,
        invuln: (flags & 2) !== 0,
        hp,
        cooldown: aux >> 8,
        rapid: v.getUint8(o + 24),
        shield: v.getUint8(o + 25),
        homing: v.getUint8(o + 26),
      });
    }
    case KIND_CODE.bullet:
      return ok({ kind: "bullet", ...b, owner: asEntityId(aux), homing: (flags & 8) !== 0 });
    case KIND_CODE.asteroid:
      return ok({ kind: "asteroid", ...b, radius: aux / 10, seeker: (flags & 4) !== 0 });
    case KIND_CODE.pickup: {
      const type = PICKUP_TYPES[aux - 1]; // index -1 or past the end is undefined: rejected below
      if (!type) return err("bad pickup type");
      return ok({ kind: "pickup", ...b, type });
    }
    default:
      return err("unknown entity kind");
  }
}

// Client side: the server is trusted, but a malformed frame must not throw inside the render loop.
export function decodeServer(buf: ArrayBuffer): Result<ServerBinary> {
  if (buf.byteLength < 1) return err("empty frame");
  const v = new DataView(buf);
  const first = v.getUint8(0);
  if (first >> 4 !== PROTOCOL_VERSION) return err("protocol version mismatch");
  switch (first & 15) {
    case MSG.SNAPSHOT: {
      if (buf.byteLength < HEADER) return err("short snapshot");
      const count = v.getUint16(9, LE);
      if (buf.byteLength !== HEADER + count * ENTITY) return err("bad snapshot length");
      const entities: EntityRecord[] = [];
      for (let i = 0; i < count; i++) {
        const r = readEntity(v, HEADER + i * ENTITY);
        if (!r.ok) return r;
        entities.push(r.value);
      }
      return ok({
        type: "snapshot",
        snapshot: { tick: asTick(v.getUint32(1, LE)), ack: asSeq(v.getUint32(5, LE)), entities },
      });
    }
    case MSG.PONG:
      if (buf.byteLength !== 13) return err("bad pong length");
      return ok({ type: "pong", t: v.getFloat64(1, LE), tick: asTick(v.getUint32(9, LE)) });
    default:
      return err("unknown binary type");
  }
}

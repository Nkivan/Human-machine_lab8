import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ArenaConfig, RoomInfo, Snapshot } from "@dogfight/shared/protocol/messages";
import type { ServerMessage } from "@dogfight/shared/protocol/messages";
import { HttpError } from "./errors.ts";
import type { RoomLogBody, RoomLogEvent } from "./log/events.ts";
import { createMatchLog } from "./log/matchlog.ts";
import { Match } from "./match.ts";
import { serverMsg } from "./protocol.ts";

export interface SendOptions {
  readonly critical?: boolean; // survives the slow-client policy (it is only dropped when the peer is hopeless)
  readonly droppable?: boolean; // may be lost by the latency injector
}
// What a Room and its Match know about ANY participant (the lab calls it PlayerInput).
// Output side: it receives the same JSON messages and snapshots a browser receives.
// Input side: its commands enter the simulation only through Match.receiveInputs, as seq-numbered Inputs.
// ws.ts implements it for a human behind a WebSocket, bot.ts for an AI: the match cannot tell them apart.
export interface PlayerInput {
  readonly id: string;
  readonly name: string;
  send(msg: ServerMessage, opts?: SendOptions): void;
  sendSnapshot(snapshot: Snapshot): void;
}
export type Player = PlayerInput; // the Lab 6 name, still used across the server

// A typed EventEmitter: the event name decides the listener's argument types.
export interface RoomEvents {
  join: [player: Player];
  leave: [player: Player];
  chat: [player: Player, text: string];
  empty: [room: Room];
  event: [event: RoomLogEvent];
  error: [error: Error];
}

export interface RoomInit {
  readonly id: string;
  readonly name: string;
  readonly arena: ArenaConfig;
  readonly max: number;
  readonly persistent?: boolean;
  readonly statsWindow?: number;
}

export class Room extends EventEmitter<RoomEvents> {
  readonly id: string;
  readonly name: string;
  readonly arena: ArenaConfig;
  readonly max: number;
  readonly persistent: boolean;
  readonly statsWindow: number;
  readonly players = new Map<string, Player>();
  readonly bots = new Set<string>(); // ids of the players that are bots (bookkeeping only: the Match does not look)
  readonly match: Match;
  logFile = "";
  logDone: Promise<void> = Promise.resolve();

  constructor({ id, name, arena, max, persistent = false, statsWindow = 300 }: RoomInit) {
    super();
    this.statsWindow = statsWindow;
    this.id = id;
    this.name = name;
    this.arena = arena;
    this.max = max;
    this.persistent = persistent;
    this.match = new Match(this); // one authoritative simulation per room; ticks only while someone is inside
    this.on("join", (player) => this.match.addPlayer(player));
    this.on("leave", (player) => this.match.removePlayer(player.id));
  }

  // The player cap is for humans: bots never lock people out of a room.
  get humans(): number {
    return this.players.size - this.bots.size;
  }

  get info(): RoomInfo {
    return {
      id: this.id,
      name: this.name,
      players: this.humans,
      bots: this.bots.size,
      max: this.max,
      arena: this.arena,
    };
  }

  // Everything loggable goes through here; matchlog.ts consumes the "event" stream.
  record(body: RoomLogBody): void {
    this.emit("event", { t: Date.now(), ...body });
  }

  join(player: Player): void {
    this.players.set(player.id, player);
    this.record({ type: "join", name: player.name });
    player.send(serverMsg.system(`Welcome to ${this.name}`));
    this.broadcast(serverMsg.system(`${player.name} joined`), player.id);
    this.#sendRoster();
    this.emit("join", player);
  }

  leave(id: string): void {
    const player = this.players.get(id);
    if (!player) return;
    this.players.delete(id);
    this.record({ type: "leave", name: player.name });
    this.broadcast(serverMsg.system(`${player.name} left`));
    this.#sendRoster();
    this.emit("leave", player);
    if (this.players.size === 0) this.emit("empty", this);
  }

  chat(player: Player, text: string): void {
    this.record({ type: "chat", name: player.name, text });
    this.broadcast(serverMsg.chat(player.name, text, Date.now()), null, { critical: false });
    this.emit("chat", player, text);
  }

  broadcast(msg: ServerMessage, exceptId: string | null = null, opts?: SendOptions): void {
    for (const p of this.players.values()) if (p.id !== exceptId) p.send(msg, opts);
  }

  close(): void {
    this.record({ type: "closed" });
  }

  #sendRoster(): void {
    this.broadcast(serverMsg.roster([...this.players.values()].map((p) => p.name)));
  }
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 20) || "room";

// Fill in what a client left out (the schema already guarantees the ranges).
export function normalizeArena(a: Partial<ArenaConfig> = {}): ArenaConfig {
  return {
    asteroids: a.asteroids ?? 6,
    pickupEvery: a.pickupEvery ?? 8,
    seed: a.seed ?? Math.floor(Math.random() * 2 ** 31),
  };
}

export interface RoomManagerOptions {
  readonly maxRooms: number;
  readonly maxPlayersPerRoom: number;
  readonly logDir: string;
  readonly tickStatsWindow?: number;
}

export interface CreateRoom {
  readonly id?: string;
  readonly name: string;
  readonly arena?: Partial<ArenaConfig>;
  readonly persistent?: boolean;
}

export class RoomManager {
  readonly #rooms = new Map<string, Room>();
  readonly #closing = new Set<Promise<void>>();
  readonly #opts: RoomManagerOptions;

  constructor(opts: RoomManagerOptions) {
    this.#opts = opts;
  }

  create({ id, name, arena, persistent = false }: CreateRoom): Room {
    if (this.#rooms.size >= this.#opts.maxRooms) throw new HttpError(409, "too many rooms");
    const roomId = id ?? `${slug(name)}-${randomBytes(2).toString("hex")}`;
    if (this.#rooms.has(roomId)) throw new HttpError(409, "room id already exists");
    const room = new Room({
      id: roomId,
      name,
      arena: normalizeArena(arena),
      max: this.#opts.maxPlayersPerRoom,
      persistent,
      ...(this.#opts.tickStatsWindow ? { statsWindow: this.#opts.tickStatsWindow } : {}),
    });
    room.on("error", (err) => console.error(`[room ${roomId}]`, err)); // an "error" event with no listener would crash the process
    const log = createMatchLog({ dir: this.#opts.logDir, room });
    room.logFile = log.file;
    room.logDone = log.done;
    room.record({ type: "created", name, arena: room.arena });
    room.on("empty", () => {
      if (!room.persistent) this.delete(room.id);
    });
    this.#rooms.set(roomId, room);
    return room;
  }

  get(id: string): Room | undefined {
    return this.#rooms.get(id);
  }
  list(): RoomInfo[] {
    return [...this.#rooms.values()].map((r) => r.info);
  }
  get size(): number {
    return this.#rooms.size;
  }
  matchStats(): ReturnType<Match["info"]>[] {
    return [...this.#rooms.values()].map((r) => r.match.info());
  }

  delete(id: string): void {
    const room = this.#rooms.get(id);
    if (!room) return;
    this.#rooms.delete(id);
    room.match.stop();
    room.close(); // emits "closed": the match log flushes and ends
    const p: Promise<void> = room.logDone
      .catch((err: unknown) => console.error(`[room ${id}] match log failed`, err))
      .finally(() => this.#closing.delete(p));
    this.#closing.add(p);
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.#rooms.keys()]) this.delete(id);
    await Promise.allSettled([...this.#closing]);
  }
}

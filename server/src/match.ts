import { STEP, TICK_MS, TICK_RATE } from "@dogfight/shared/protocol/constants";
import { asSeq, asTick, toWireId, type EntityId, type Seq, type Tick } from "@dogfight/shared/protocol/ids";
import type { WireEvent } from "@dogfight/shared/protocol/messages";
import { snapshotWorld } from "@dogfight/shared/codec/snapshot";
import { Ship } from "@dogfight/shared/sim/ship";
import type { Input } from "@dogfight/shared/sim/shipmove";
import { World } from "@dogfight/shared/sim/world";
import { SampleRing } from "@dogfight/shared/stats";
import { serverMsg } from "./protocol.ts";
import type { Player, Room } from "./rooms.ts";

const MAX_INPUTS_PER_TICK = 4; // a client cannot "speed-hack" by sending 100 inputs at once
const MAX_QUEUE = 30;
const SCORE_EVERY_TICKS = TICK_RATE;

export interface TickStatsSnapshot {
  readonly ticks: number;
  readonly overruns: number;
  readonly avgMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly intervalMs: number;
  readonly jitterMs: number;
}
export interface TickStats {
  record(start: number, duration: number): void;
  reset(): void;
  snapshot(): TickStatsSnapshot;
}

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

// Rolling tick statistics: how long a tick takes (median AND tail) and how steady the cadence is (/api/stats).
// Samples go into preallocated rings: recording a tick allocates nothing.
export function createTickStats(window = 300): TickStats {
  const durations = new SampleRing(window);
  const gaps = new SampleRing(window);
  let lastStart = 0;
  let overruns = 0;
  let ticks = 0;
  return {
    record(start, duration) {
      ticks++;
      durations.push(duration);
      if (lastStart) gaps.push(start - lastStart);
      lastStart = start;
      if (duration > TICK_MS) overruns++; // CPU-bound: the tick took longer than its budget
    },
    reset() {
      lastStart = 0;
    },
    snapshot() {
      const d = durations.summary();
      const g = gaps.values();
      const m = g.length ? g.reduce((s, x) => s + x, 0) / g.length : 0;
      const variance = g.length ? g.reduce((s, x) => s + (x - m) ** 2, 0) / g.length : 0;
      return {
        ticks,
        overruns,
        avgMs: round3(d.mean),
        p50Ms: round3(d.p50),
        p95Ms: round3(d.p95),
        p99Ms: round3(d.p99),
        maxMs: round3(d.max),
        intervalMs: round3(m),
        jitterMs: round3(Math.sqrt(variance)), // std-dev of the tick interval
      };
    },
  };
}

interface PlayerState {
  readonly player: Player;
  readonly ship: Ship;
  readonly queue: Input[];
  lastQueued: Seq;
  lastSeq: Seq;
  dropped: number;
}

// One authoritative simulation per room: applies inputs, steps the shared world, broadcasts snapshots.
export class Match {
  readonly room: Room;
  readonly world: World;
  readonly players = new Map<string, PlayerState>();
  readonly stats: TickStats;
  tickNo: Tick = asTick(0);
  #pending: WireEvent[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #next = 0;
  #running = false;

  constructor(room: Room) {
    this.room = room;
    this.stats = createTickStats(room.statsWindow);
    this.world = new World(room.arena.seed, { asteroids: room.arena.asteroids, pickupEvery: room.arena.pickupEvery });
    const { events } = this.world;
    events.on("fired", (e) => this.#pending.push({ k: "fired", shipId: toWireId(e.shipId), x: e.x, y: e.y }));
    events.on("hit", (e) => this.#pending.push({ k: "hit", x: e.x, y: e.y }));
    events.on("pickup", (e) =>
      this.#pending.push({ k: "pickup", shipId: toWireId(e.shipId), type: e.type, x: e.x, y: e.y }),
    );
    events.on("exploded", (e) => this.#pending.push({ k: "exploded", x: e.x, y: e.y, kind: e.kind }));
    events.on("score", (e) =>
      this.#pending.push({ k: "score", owner: toWireId(e.owner), delta: e.delta, total: e.total, x: e.x, y: e.y }),
    );
  }

  get running(): boolean {
    return this.#running;
  }

  addPlayer(player: Player): void {
    const { x, y } = this.world.safeSpot();
    const ship = this.world.spawn(new Ship({ x, y }));
    ship.invuln = 2;
    this.players.set(player.id, { player, ship, queue: [], lastQueued: asSeq(0), lastSeq: asSeq(0), dropped: 0 });
    player.send(
      serverMsg.welcome({ you: toWireId(ship.id), tick: this.tickNo, tickRate: TICK_RATE, seed: this.room.arena.seed }),
    );
    this.start();
  }

  removePlayer(id: string): void {
    const st = this.players.get(id);
    if (!st) return;
    this.world.removeShip(st.ship);
    this.players.delete(id);
    if (this.players.size === 0) this.stop();
  }

  // Inputs arrive redundantly (each packet repeats the last few): keep only the ones we have not seen.
  receiveInputs(id: string, inputs: readonly Input[]): void {
    const st = this.players.get(id);
    if (!st) return;
    for (const input of inputs) {
      if (input.seq <= st.lastQueued) continue;
      if (st.queue.length >= MAX_QUEUE) {
        st.dropped++;
        continue;
      }
      st.queue.push(input);
      st.lastQueued = input.seq;
    }
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.stats.reset();
    this.#next = performance.now() + TICK_MS;
    this.#schedule();
  }

  stop(): void {
    this.#running = false;
    clearTimeout(this.#timer);
  }

  // setInterval(tick, 33) drifts and coalesces. Instead each tick is scheduled against an ABSOLUTE target time.
  #schedule(): void {
    this.#timer = setTimeout(() => this.#onTimer(), Math.max(0, this.#next - performance.now()));
  }

  #onTimer(): void {
    if (!this.#running) return;
    const start = performance.now();
    this.tick();
    this.stats.record(start, performance.now() - start);
    this.#next += TICK_MS;
    const now = performance.now();
    if (this.#next < now - 5 * TICK_MS) this.#next = now + TICK_MS; // hopelessly behind: skip ticks instead of spiralling
    this.#schedule();
  }

  tick(): void {
    const inputs = new Map<EntityId, readonly Input[]>();
    for (const st of this.players.values()) {
      const taken = st.queue.splice(0, MAX_INPUTS_PER_TICK);
      const last = taken[taken.length - 1];
      if (!last) continue;
      st.lastSeq = last.seq; // ack even if the ship is dead (inputs are simply discarded)
      if (st.ship.alive) inputs.set(st.ship.id, taken);
    }
    this.world.step(STEP, inputs);
    this.tickNo = asTick(this.tickNo + 1);

    const entities = snapshotWorld(this.world);
    for (const st of this.players.values()) st.player.sendSnapshot({ tick: this.tickNo, ack: st.lastSeq, entities });
    if (this.#pending.length) {
      this.room.broadcast(serverMsg.events(this.#pending), null, { critical: false });
      this.#pending = [];
    }
    if (this.tickNo % SCORE_EVERY_TICKS === 0 && this.players.size) {
      const list = [...this.players.values()].map((st): [string, number] => [
        st.player.name,
        this.world.scores.get(st.ship.id) ?? 0,
      ]);
      this.room.broadcast(serverMsg.scores(list), null, { critical: false });
    }
  }

  info(): { room: string; players: number; running: boolean; tick: number } & ReturnType<TickStats["snapshot"]> {
    return {
      room: this.room.id,
      players: this.players.size,
      running: this.#running,
      tick: this.tickNo,
      ...this.stats.snapshot(),
    };
  }
}

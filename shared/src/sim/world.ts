import type { EntityId } from "../protocol/ids.ts";
import { Bus } from "../bus.ts";
import { Asteroid } from "./asteroid.ts";
import { ARENA } from "./arena.ts";
import { homing } from "./behaviors.ts";
import type { Bullet } from "./bullet.ts";
import { SpatialHash } from "./collision.ts";
import type { EntityKind } from "./entity.ts";
import { TAU } from "./math.ts";
import { Pickup, PICKUP_TYPES, type PickupType } from "./pickup.ts";
import { mulberry32 } from "./random.ts";
import type { Ship } from "./ship.ts";
import type { ShipCommand } from "./shipmove.ts";

export type AnyEntity = Ship | Bullet | Asteroid | Pickup; // discriminated by `kind`

// What the sim ANNOUNCES. Audio/HUD/network subscribe; the sim imports none of them.
export interface WorldEvents {
  fired: { shipId: EntityId; x: number; y: number };
  hit: { x: number; y: number };
  exploded: { x: number; y: number; kind: "ship" | "asteroid" };
  score: { owner: EntityId; delta: number; total: number; x: number; y: number };
  pickup: { shipId: EntityId; type: PickupType; x: number; y: number };
}

function isKind<K extends EntityKind>(e: AnyEntity, kind: K): e is Extract<AnyEntity, { kind: K }> {
  return e.kind === kind;
}

// Returns the two entities in the order of the requested kinds, or null. A type predicate does the narrowing: no casts.
function pair<A extends EntityKind, B extends EntityKind>(
  a: AnyEntity,
  b: AnyEntity,
  ka: A,
  kb: B,
): [Extract<AnyEntity, { kind: A }>, Extract<AnyEntity, { kind: B }>] | null {
  if (isKind(a, ka) && isKind(b, kb)) return [a, b];
  if (isKind(b, ka) && isKind(a, kb)) return [b, a];
  return null;
}

export interface WorldOptions {
  readonly asteroids?: number;
  readonly pickupEvery?: number; // seconds between pickups; 0 (the default) = no pickups
}

// Pure, seeded, DOM-free. inputs: Map<shipId, commands[]>: every command is applied as ONE step of dt.
export class World {
  readonly events = new Bus<WorldEvents>();
  readonly scores = new Map<EntityId, number>();
  readonly rng: () => number;
  readonly targetAsteroids: number;
  readonly pickupEvery: number;
  readonly #entities = new Map<EntityId, AnyEntity>();
  #incoming: AnyEntity[] = [];
  #stepping = false;
  #respawns: { ship: Ship; t: number }[] = [];
  #pickupTimer: number;
  readonly #grid = new SpatialHash();
  readonly #onPair = (a: AnyEntity, b: AnyEntity): void => this.#collide(a, b); // one closure per world, not per tick

  constructor(seed = 1, { asteroids = 6, pickupEvery = 0 }: WorldOptions = {}) {
    this.rng = mulberry32(seed);
    this.targetAsteroids = asteroids;
    this.pickupEvery = pickupEvery;
    this.#pickupTimer = pickupEvery;
  }

  rand(min: number, max: number): number {
    return min + (max - min) * this.rng();
  }

  spawn<T extends AnyEntity>(e: T): T {
    if (this.#stepping)
      this.#incoming.push(e); // never grow the Map mid-iteration
    else this.#entities.set(e.id, e);
    return e;
  }
  despawn(id: EntityId): void {
    const e = this.#entities.get(id);
    if (e) e.alive = false;
  }
  removeShip(ship: Ship): void {
    ship.removed = true;
    ship.alive = false;
  } // the player left
  get(id: EntityId): AnyEntity | undefined {
    return this.#entities.get(id);
  }
  *[Symbol.iterator](): Generator<AnyEntity> {
    yield* this.#entities.values();
  }
  *ofKind<K extends EntityKind>(kind: K): Generator<Extract<AnyEntity, { kind: K }>> {
    for (const e of this) if (isKind(e, kind)) yield e;
  }

  step(dt: number, inputs: ReadonlyMap<EntityId, readonly ShipCommand[]> = new Map()): void {
    this.#stepping = true;
    for (const e of this) {
      e.savePrev();
      if (e.kind === "ship") for (const input of inputs.get(e.id) ?? []) e.applyInput(input, dt, this);
      e.update(dt, this);
    }
    this.#grid.forEachPair(this, this.#onPair); // same pairs, same order as the naive findCollisions()
    this.#sweep();
    this.#stepping = false;
    for (const e of this.#incoming) this.#entities.set(e.id, e);
    this.#incoming = [];
    this.#maintain(dt);
    for (const ship of this.ofKind("ship")) ship.settle();
  }

  #addScore(owner: EntityId, delta: number, pos: { x: number; y: number }): void {
    const total = (this.scores.get(owner) ?? 0) + delta;
    this.scores.set(owner, total);
    this.events.emit("score", { owner, delta, total, x: pos.x, y: pos.y });
  }

  #collide(a: AnyEntity, b: AnyEntity): void {
    if (!a.alive || !b.alive) return;
    const bs = pair(a, b, "bullet", "ship");
    if (bs) {
      const [bullet, ship] = bs;
      if (bullet.owner === ship.id) return; // no self-hits
      const wasAlive = ship.alive;
      if (ship.damage(bullet.damage)) this.events.emit("hit", { x: ship.pos.x, y: ship.pos.y });
      bullet.alive = false;
      if (wasAlive && !ship.alive) this.#addScore(bullet.owner, 50, ship.pos);
      return;
    }
    const ba = pair(a, b, "bullet", "asteroid");
    if (ba) {
      const [bullet, ast] = ba;
      ast.hp -= bullet.damage;
      bullet.alive = false;
      this.events.emit("hit", { x: ast.pos.x, y: ast.pos.y });
      if (ast.hp <= 0) {
        ast.alive = false;
        this.#addScore(bullet.owner, 10, ast.pos);
      }
      return;
    }
    const sa = pair(a, b, "ship", "asteroid");
    if (sa) {
      const [ship] = sa;
      if (ship.damage(20)) {
        ship.vel.x *= -0.5;
        ship.vel.y *= -0.5;
      }
      return;
    }
    const sp = pair(a, b, "ship", "pickup");
    if (sp) {
      const [ship, pickup] = sp;
      ship.applyPickup(pickup.type);
      pickup.alive = false;
      this.events.emit("pickup", { shipId: ship.id, type: pickup.type, x: pickup.pos.x, y: pickup.pos.y });
    }
  }

  #sweep(): void {
    for (const e of [...this.#entities.values()]) {
      if (e.alive) continue;
      if (e.kind === "ship" && !e.removed) {
        this.events.emit("exploded", { x: e.pos.x, y: e.pos.y, kind: "ship" });
        this.#respawns.push({ ship: e, t: 2 });
      } else if (e.kind === "asteroid") {
        this.events.emit("exploded", { x: e.pos.x, y: e.pos.y, kind: "asteroid" });
      }
      this.#entities.delete(e.id);
    }
  }

  #maintain(dt: number): void {
    this.#respawns = this.#respawns.filter((r) => {
      if (r.ship.removed) return false;
      r.t -= dt;
      if (r.t > 0) return true;
      const { x, y } = this.safeSpot();
      r.ship.reset(x, y);
      this.spawn(r.ship); // same entity id: clients keep recognizing the ship
      return false;
    });
    let asteroids = 0;
    let pickups = 0;
    for (const e of this) {
      if (e.kind === "asteroid") asteroids++;
      else if (e.kind === "pickup") pickups++;
    }
    for (; asteroids < this.targetAsteroids; asteroids++) this.#spawnAsteroid();

    if (this.pickupEvery > 0) {
      this.#pickupTimer -= dt;
      if (this.#pickupTimer <= 0 && pickups < 2) {
        const type = PICKUP_TYPES[Math.floor(this.rng() * PICKUP_TYPES.length)] ?? "shield";
        this.spawn(new Pickup({ x: this.rand(80, ARENA.width - 80), y: this.rand(80, ARENA.height - 80), type }));
        this.#pickupTimer = this.pickupEvery;
      }
    }
  }

  #spawnAsteroid(): void {
    const onTop = this.rng() < 0.5;
    const speed = this.rand(30, 80);
    const dir = this.rand(0, TAU);
    const a = new Asteroid({
      x: onTop ? this.rand(0, ARENA.width) : 0,
      y: onTop ? 0 : this.rand(0, ARENA.height),
      vx: Math.cos(dir) * speed,
      vy: Math.sin(dir) * speed,
      radius: this.rand(18, 40),
    });
    if (this.rng() < 0.2) {
      a.behaviors.push(homing({ kinds: ["ship"], turnRate: 0.5 }));
      a.seeker = true;
    }
    this.spawn(a);
  }

  safeSpot(): { x: number; y: number } {
    let spot = { x: 0, y: 0 };
    for (let i = 0; i < 10; i++) {
      spot = { x: Math.fround(this.rand(100, ARENA.width - 100)), y: Math.fround(this.rand(100, ARENA.height - 100)) };
      let safe = true;
      for (const a of this.ofKind("asteroid")) {
        if (Math.hypot(a.pos.x - spot.x, a.pos.y - spot.y) < 120 + a.radius) {
          safe = false;
          break;
        }
      }
      if (safe) break;
    }
    return spot;
  }
}

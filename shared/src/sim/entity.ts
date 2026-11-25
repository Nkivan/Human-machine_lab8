import { asEntityId, type EntityId } from "../protocol/ids.ts";
import { wrapPos } from "./arena.ts";
import type { MutVec2 } from "./vector.ts";
import { addScaledInPlace } from "./vector.ts";
import type { World } from "./world.ts";

export type EntityKind = "ship" | "bullet" | "asteroid" | "pickup";
// Composition: extra abilities are plain functions attached to an entity (homing, ...), not subclasses.
export type Behavior = (e: Entity, dt: number, world: World) => void;

export interface EntityInit {
  readonly x?: number;
  readonly y?: number;
  readonly vx?: number;
  readonly vy?: number;
  readonly angle?: number;
  readonly radius: number;
}

// Subclasses (ONE level) pin `kind` to a literal type, which makes Ship | Bullet | Asteroid a discriminated union.
export abstract class Entity {
  static #nextId = 1;
  readonly #id: EntityId = asEntityId(Entity.#nextId++);
  abstract readonly kind: EntityKind;
  readonly pos: MutVec2;
  readonly vel: MutVec2;
  readonly prevPos: MutVec2;
  angle: number;
  prevAngle: number;
  readonly radius: number;
  alive = true;
  readonly behaviors: Behavior[] = [];

  constructor({ x = 0, y = 0, vx = 0, vy = 0, angle = 0, radius }: EntityInit) {
    this.pos = { x, y };
    this.vel = { x: vx, y: vy };
    this.prevPos = { x, y };
    this.angle = angle;
    this.prevAngle = angle;
    this.radius = radius;
  }

  get id(): EntityId {
    return this.#id;
  }

  savePrev(): void {
    this.prevPos.x = this.pos.x;
    this.prevPos.y = this.pos.y;
    this.prevAngle = this.angle;
  }

  update(dt: number, world: World): void {
    for (const behave of this.behaviors) behave(this, dt, world);
    addScaledInPlace(this.pos, this.vel, dt);
    wrapPos(this.pos);
  }
}

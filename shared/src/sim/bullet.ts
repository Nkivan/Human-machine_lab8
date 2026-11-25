import type { EntityId } from "../protocol/ids.ts";
import { Entity } from "./entity.ts";
import { BULLET_TTL } from "./shipmove.ts";
import type { Vec2 } from "./vector.ts";
import type { World } from "./world.ts";

export interface BulletInit {
  readonly pos: Vec2;
  readonly vel: Vec2;
  readonly owner: EntityId;
  readonly ttl?: number;
  readonly damage?: number;
}

export class Bullet extends Entity {
  readonly kind = "bullet";
  readonly owner: EntityId;
  readonly damage: number;
  ttl: number;
  homing = false; // true when it carries the homing behavior (so clients can draw it differently)

  constructor({ pos, vel, owner, ttl = BULLET_TTL, damage = 10 }: BulletInit) {
    super({ x: pos.x, y: pos.y, vx: vel.x, vy: vel.y, angle: Math.atan2(vel.y, vel.x), radius: 3 });
    this.owner = owner;
    this.ttl = ttl;
    this.damage = damage;
  }

  override update(dt: number, world: World): void {
    this.ttl -= dt;
    if (this.ttl <= 0) this.alive = false;
    super.update(dt, world);
  }
}

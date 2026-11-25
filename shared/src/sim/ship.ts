import { homing } from "./behaviors.ts";
import { Bullet } from "./bullet.ts";
import { Entity } from "./entity.ts";
import type { PickupType } from "./pickup.ts";
import { quantizeAngle, SHIP_RADIUS, stepShip, TUNING, type ShipBody, type ShipCommand } from "./shipmove.ts";
import { Vector2 } from "./vector.ts";
import type { World } from "./world.ts";

// Effect durations in STEPS (1 step = 1/30 s): integers, so they travel in one byte and stay exact on both sides.
const EFFECT_STEPS = { shield: 180, rapid: 240, homing: 240 } satisfies Record<PickupType, number>; // 6 s, 8 s, 8 s

// One level of inheritance. Movement is NOT here: it is stepShip() so the client can run the very same code.
export class Ship extends Entity implements ShipBody {
  readonly kind = "ship";
  #hp = 100;
  cooldown = 0;
  thrust = false;
  invuln = 0;
  rapid = 0; // rapid fire: also part of ShipBody, because the prediction must know it
  shieldSteps = 0; // server-side effect: blocks damage
  homingSteps = 0; // server-side effect: bullets seek targets
  removed = false; // true = the player left: never respawn

  constructor({ x = 0, y = 0 }: { x?: number; y?: number } = {}) {
    super({ x, y, radius: SHIP_RADIUS, angle: quantizeAngle(-Math.PI / 2) });
  }

  get hp(): number {
    return this.#hp;
  }

  damage(n: number): boolean {
    if (this.invuln > 0 || this.shieldSteps > 0) return false;
    this.#hp = Math.max(0, this.#hp - n);
    this.invuln = 0.3;
    if (this.#hp === 0) this.alive = false;
    return true;
  }

  applyPickup(type: PickupType): void {
    switch (type) {
      case "shield":
        this.shieldSteps = EFFECT_STEPS.shield;
        break;
      case "rapid":
        this.rapid = EFFECT_STEPS.rapid;
        break;
      case "homing":
        this.homingSteps = EFFECT_STEPS.homing;
        break;
    }
  }

  reset(x: number, y: number): void {
    this.#hp = 100;
    this.alive = true;
    this.removed = false;
    this.pos.x = x;
    this.pos.y = y;
    this.vel.x = 0;
    this.vel.y = 0;
    this.angle = quantizeAngle(-Math.PI / 2);
    this.cooldown = 0;
    this.rapid = 0;
    this.shieldSteps = 0;
    this.homingSteps = 0;
    this.invuln = 2;
    this.savePrev();
  }

  // One input == one simulation step (the server applies every input it received since the last tick).
  applyInput(input: ShipCommand, dt: number, world: World): void {
    if (!stepShip(this, input, dt)) return;
    const dir = Vector2.fromAngle(this.angle);
    world.events.emit("fired", { shipId: this.id, x: this.pos.x, y: this.pos.y });
    const bullet = new Bullet({
      pos: new Vector2(this.pos.x, this.pos.y).add(dir.scale(SHIP_RADIUS + 4)),
      vel: new Vector2(this.vel.x, this.vel.y).add(dir.scale(TUNING.bulletSpeed)), // inherits ship velocity
      owner: this.id,
    });
    if (this.homingSteps > 0) {
      bullet.homing = true;
      bullet.behaviors.push(homing({ kinds: ["asteroid", "ship"], excludeId: this.id, turnRate: 3 }));
    }
    world.spawn(bullet);
  }

  // ships move only via applyInput; here only the server-side timers tick
  override update(dt: number): void {
    this.invuln = Math.max(0, this.invuln - dt);
    if (this.shieldSteps > 0) this.shieldSteps--;
    if (this.homingSteps > 0) this.homingSteps--;
  }

  settle(): void {
    // collision knockback produces doubles: snap back to float32 so snapshots stay lossless
    this.pos.x = Math.fround(this.pos.x);
    this.pos.y = Math.fround(this.pos.y);
    this.vel.x = Math.fround(this.vel.x);
    this.vel.y = Math.fround(this.vel.y);
  }
}

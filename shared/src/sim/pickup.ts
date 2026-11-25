import { Entity } from "./entity.ts";

// The order matters: the binary protocol sends the type as its index + 1 (see codec/binary.ts).
export const PICKUP_TYPES = ["shield", "rapid", "homing"] as const;
export type PickupType = (typeof PICKUP_TYPES)[number];

export interface PickupInit {
  readonly x: number;
  readonly y: number;
  readonly type: PickupType;
}

// Stationary + collidable, but NOT a ship: this is what a deep hierarchy would struggle with.
export class Pickup extends Entity {
  readonly kind = "pickup";
  readonly type: PickupType;
  ttl = 12; // seconds before it disappears

  constructor({ x, y, type }: PickupInit) {
    super({ x, y, radius: 12 });
    this.type = type;
  }

  // pickups do not move
  override update(dt: number): void {
    this.ttl -= dt;
    if (this.ttl <= 0) this.alive = false;
  }
}

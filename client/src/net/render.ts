// What the renderer draws, as ONE class with every field initialized in the constructor, in the same order.
// Lab 6 drew a union of four object literals (built with spreads), so `it.x` in drawWorld saw many hidden classes;
// now every entity has the same shape (monomorphic inline caches) and the objects are reused frame after frame.
import type { PickupType } from "@dogfight/shared/sim/pickup";
import type { EntityKind } from "@dogfight/shared/sim/entity";

export class RenderEntity {
  id = 0;
  kind: EntityKind = "ship";
  x = 0;
  y = 0;
  angle = 0;
  radius = 0; // asteroids
  thrust = false; // ships
  invuln = false;
  shield = false;
  me = false;
  seeker = false; // asteroids
  homing = false; // bullets
  pickup: PickupType = "shield"; // pickups
}

// A pool + a count: `next()` hands out the next pooled entity (allocating only the first time the list grows that big),
// `clear()` makes them all reusable. Nothing is allocated per frame once the pool has warmed up.
export class RenderList {
  count = 0;
  readonly items: RenderEntity[] = [];

  next(): RenderEntity {
    let e = this.items[this.count];
    if (!e) {
      e = new RenderEntity();
      this.items.push(e);
    }
    this.count++;
    return e;
  }

  clear(): void {
    this.count = 0;
  }

  // Tests and debugging only (allocates a copy of the live part).
  toArray(): RenderEntity[] {
    return this.items.slice(0, this.count);
  }
}

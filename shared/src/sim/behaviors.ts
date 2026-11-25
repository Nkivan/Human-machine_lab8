import type { EntityId } from "../protocol/ids.ts";
import { TAU } from "./math.ts";
import type { Behavior, Entity, EntityKind } from "./entity.ts";
import type { AnyEntity, World } from "./world.ts";

export function nearest(
  world: World,
  from: Entity,
  kinds: readonly EntityKind[],
  excludeId?: EntityId,
): AnyEntity | null {
  let best: AnyEntity | null = null;
  let bestD = Infinity;
  for (const e of world) {
    if (e === from || e.id === excludeId || !e.alive || !kinds.includes(e.kind)) continue;
    const d = (e.pos.x - from.pos.x) ** 2 + (e.pos.y - from.pos.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

export interface HomingOptions {
  readonly kinds: readonly EntityKind[];
  readonly excludeId?: EntityId;
  readonly turnRate: number;
}

// Composition: ONE behavior, attachable to a bullet OR an asteroid (anything with pos/vel).
export function homing({ kinds, excludeId, turnRate }: HomingOptions): Behavior {
  return (e, dt, world) => {
    const target = nearest(world, e, kinds, excludeId);
    const speed = Math.hypot(e.vel.x, e.vel.y);
    if (!target || speed === 0) return;
    const cur = Math.atan2(e.vel.y, e.vel.x);
    const want = Math.atan2(target.pos.y - e.pos.y, target.pos.x - e.pos.x);
    const diff = ((((want - cur + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
    const turn = Math.max(-turnRate * dt, Math.min(turnRate * dt, diff));
    e.vel.x = Math.cos(cur + turn) * speed;
    e.vel.y = Math.sin(cur + turn) * speed;
    e.angle = cur + turn;
  };
}

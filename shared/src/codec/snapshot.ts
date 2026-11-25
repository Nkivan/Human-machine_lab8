import { toWireId } from "../protocol/ids.ts";
import type { EntityRecord } from "../protocol/messages.ts";
import type { World } from "../sim/world.ts";
import { assertNever } from "../util.ts";

const u8 = (n: number): number => Math.min(255, Math.max(0, n));

// World -> typed records. Ships, bullets, asteroids and pickups travel in snapshots; explosions and sounds are events.
export function snapshotWorld(world: World): EntityRecord[] {
  const out: EntityRecord[] = [];
  for (const e of world) {
    const b = { id: toWireId(e.id), x: e.pos.x, y: e.pos.y, vx: e.vel.x, vy: e.vel.y };
    switch (e.kind) {
      case "ship":
        out.push({
          kind: "ship",
          ...b,
          angle: e.angle,
          thrust: e.thrust,
          invuln: e.invuln > 0,
          hp: e.hp,
          cooldown: e.cooldown,
          rapid: u8(e.rapid),
          shield: u8(e.shieldSteps),
          homing: u8(e.homingSteps),
        });
        break;
      case "bullet":
        out.push({
          kind: "bullet",
          ...b,
          angle: Math.atan2(e.vel.y, e.vel.x),
          owner: toWireId(e.owner),
          homing: e.homing,
        });
        break;
      case "asteroid":
        out.push({ kind: "asteroid", ...b, angle: 0, radius: e.radius, seeker: e.seeker });
        break;
      case "pickup":
        out.push({ kind: "pickup", ...b, angle: 0, type: e.type });
        break;
      default:
        return assertNever(e);
    }
  }
  return out;
}

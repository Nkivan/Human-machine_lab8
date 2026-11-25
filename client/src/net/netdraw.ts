import type { Manifest } from "../assets/loader.ts";
import type { View } from "../render/canvas.ts";
import type { ParticleView } from "../render/particles.ts";
import type { RenderList } from "./render.ts";

export interface Sprites {
  readonly sheet: ImageBitmap;
  readonly frames: Manifest["frames"];
}

type Frame = readonly [number, number, number, number];
// Looked up once, not per entity per frame (Lab 6 built `pickup_${type}` strings and did a dictionary lookup each time).
interface FrameSet {
  readonly ship?: Frame;
  readonly drone?: Frame;
  readonly asteroid?: Frame;
  readonly bullet?: Frame;
  readonly bulletHoming?: Frame;
  readonly pickupShield?: Frame;
  readonly pickupRapid?: Frame;
  readonly pickupHoming?: Frame;
}
const frameSets = new WeakMap<Sprites, FrameSet>();
function framesOf(s: Sprites): FrameSet {
  let f = frameSets.get(s);
  if (!f) {
    const fr = s.frames;
    f = {
      ship: fr["ship"],
      drone: fr["drone"],
      asteroid: fr["asteroid"],
      bullet: fr["bullet"],
      bulletHoming: fr["bullet_homing"],
      pickupShield: fr["pickup_shield"],
      pickupRapid: fr["pickup_rapid"],
      pickupHoming: fr["pickup_homing"],
    };
    frameSets.set(s, f);
  }
  return f;
}

function sprite(ctx: CanvasRenderingContext2D, sheet: ImageBitmap, f: Frame | undefined, size: number): void {
  if (f) ctx.drawImage(sheet, f[0], f[1], f[2], f[3], -size / 2, -size / 2, size, size);
}

// One monomorphic pass over a pooled list (see render.ts). Each entity gets ONE setTransform call
// (Lab 6: save + translate + rotate + restore = four canvas calls per entity).
export function drawWorld(
  ctx: CanvasRenderingContext2D,
  view: View,
  list: RenderList,
  particles: ParticleView,
  sprites: Sprites,
  time: number,
): void {
  const fs = framesOf(sprites);
  const k = view.scale * view.dpr;
  const ox = view.offsetX * view.dpr;
  const oy = view.offsetY * view.dpr;
  const blinkOff = Math.floor(time / 80) % 2 === 0;
  const flame = 14 + Math.sin(time / 30) * 5;
  for (let i = 0; i < list.count; i++) {
    const it = list.items[i];
    if (!it) continue;
    const rot = it.kind === "ship" ? it.angle : it.kind === "asteroid" ? it.id : 0; // asteroids spin by id (as before)
    const c = Math.cos(rot) * k;
    const s = Math.sin(rot) * k;
    ctx.setTransform(c, s, -s, c, ox + it.x * k, oy + it.y * k);
    switch (it.kind) {
      case "asteroid":
        sprite(ctx, sprites.sheet, fs.asteroid, it.radius * 2.2);
        if (it.seeker) {
          ctx.strokeStyle = "#ff6b6b";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(0, 0, it.radius + 4, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      case "bullet":
        sprite(ctx, sprites.sheet, it.homing ? fs.bulletHoming : fs.bullet, 14);
        break;
      case "ship":
        if (it.invuln && blinkOff) break; // blink while invulnerable
        if (it.thrust) {
          ctx.fillStyle = "#ff9d2e";
          ctx.beginPath();
          ctx.moveTo(-10, -5);
          ctx.lineTo(-10 - flame, 0);
          ctx.lineTo(-10, 5);
          ctx.closePath();
          ctx.fill();
        }
        sprite(ctx, sprites.sheet, it.me ? fs.ship : fs.drone, 46);
        if (it.shield) {
          ctx.strokeStyle = "#4fd1ff";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(0, 0, 24, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      case "pickup":
        sprite(
          ctx,
          sprites.sheet,
          it.pickup === "shield" ? fs.pickupShield : it.pickup === "rapid" ? fs.pickupRapid : fs.pickupHoming,
          30,
        );
        break;
    }
  }
  // Particles: one transform for all of them.
  ctx.setTransform(k, 0, 0, k, ox, oy);
  ctx.fillStyle = "#ff9d2e";
  for (let i = 0; i < particles.count; i++) {
    ctx.globalAlpha = Math.min(1, particles.lifeAt(i) * 2);
    ctx.fillRect(particles.xAt(i) - 1.5, particles.yAt(i) - 1.5, 3, 3);
  }
  ctx.globalAlpha = 1;
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0); // back to the base transform (CSS pixels)
}

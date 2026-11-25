export interface Vec2 {
  readonly x: number;
  readonly y: number;
}
// A mutable position/velocity, for the simulation's hot path (entities are updated in place, 30 times a second).
export interface MutVec2 {
  x: number;
  y: number;
}

// Immutable: every method returns a NEW vector, so `a.add(b)` can never change `a`.
export class Vector2 implements Vec2 {
  readonly x: number;
  readonly y: number;
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
  add(v: Vec2): Vector2 {
    return new Vector2(this.x + v.x, this.y + v.y);
  }
  sub(v: Vec2): Vector2 {
    return new Vector2(this.x - v.x, this.y - v.y);
  }
  scale(k: number): Vector2 {
    return new Vector2(this.x * k, this.y * k);
  }
  length(): number {
    return Math.hypot(this.x, this.y);
  }
  normalize(): Vector2 {
    const l = this.length();
    return l === 0 ? new Vector2() : this.scale(1 / l);
  }
  rotate(a: number): Vector2 {
    const c = Math.cos(a),
      s = Math.sin(a);
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c);
  }
  dot(v: Vec2): number {
    return this.x * v.x + this.y * v.y;
  }
  static fromAngle(a: number, len = 1): Vector2 {
    return new Vector2(Math.cos(a) * len, Math.sin(a) * len);
  }
}

export function addScaledInPlace(target: MutVec2, v: Vec2, k: number): void {
  target.x += v.x * k;
  target.y += v.y * k;
}

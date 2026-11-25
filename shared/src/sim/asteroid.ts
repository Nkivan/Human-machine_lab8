import { Entity } from "./entity.ts";

export interface AsteroidInit {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly radius: number;
}

export class Asteroid extends Entity {
  readonly kind = "asteroid";
  hp: number;
  seeker = false;

  constructor(init: AsteroidInit) {
    super(init);
    this.hp = init.radius; // bigger = tougher
  }
}

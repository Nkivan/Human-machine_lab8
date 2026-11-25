import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "vitest";
import { asSeq } from "../src/protocol/ids.ts";
import { simHash } from "../src/sim/selftest.ts";
import { Pickup } from "../src/sim/pickup.ts";
import { Ship } from "../src/sim/ship.ts";
import { stepShip, TUNING, type ShipBody, type ShipCommand } from "../src/sim/shipmove.ts";
import { Vector2 } from "../src/sim/vector.ts";
import { World } from "../src/sim/world.ts";

const dir = new URL("../src/", import.meta.url);

test("the shared code is pure: no DOM, no Node built-ins, no clocks, no Math.random", () => {
  assert.equal("window" in globalThis, false);
  assert.equal("document" in globalThis, false);
  const forbidden =
    /\b(document|window|localStorage|performance|Date\.now|Math\.random|requestAnimationFrame|setTimeout|node:)\b/;
  for (const sub of ["sim", "codec", "protocol", "."]) {
    for (const file of readdirSync(new URL(`${sub}/`, dir)).filter((f) => f.endsWith(".ts"))) {
      const code = readFileSync(new URL(`${sub}/${file}`, dir), "utf8").replace(/\/\/.*$/gm, "");
      assert.doesNotMatch(code, forbidden, `${sub}/${file} uses a forbidden global`);
    }
  }
});

test("determinism: same inputs -> same hash, run after run (the sim is unchanged by the TypeScript migration)", () => {
  const a = simHash(1000),
    b = simHash(1000);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(a, "e34f5d00", "the Lab 5 JavaScript sim produced exactly this hash");
});

test("Vector2 is immutable: methods return new vectors", () => {
  const a = new Vector2(1, 2);
  const b = a.add(new Vector2(3, 4));
  assert.deepEqual([a.x, a.y, b.x, b.y], [1, 2, 4, 6]);
  assert.equal(Object.isFrozen(a), false); // immutability is enforced by `readonly` (compile time), not by freezing
});

test("stepShip works on ANY ShipBody (structural typing) and counts the fire cooldown in steps", () => {
  const body: ShipBody = {
    pos: { x: 100, y: 100 },
    vel: { x: 0, y: 0 },
    angle: 0,
    cooldown: 0,
    rapid: 0,
    thrust: false,
  };
  const cmd: ShipCommand = { turn: 0, thrust: false, fire: true };
  let fired = 0;
  for (let i = 0; i < TUNING.fireDelaySteps * 3; i++) if (stepShip(body, cmd, 1 / 30)) fired++;
  assert.equal(fired, 3);
});

test("world: kills score for the shooter; a killed ship respawns with the same id; events are typed", () => {
  const world = new World(1, { asteroids: 0 });
  const ship = world.spawn(new Ship({ x: 200, y: 200 }));
  const victim = world.spawn(new Ship({ x: 400, y: 200 }));
  ship.angle = 0;
  let died = false;
  let fired = 0;
  world.events.on("exploded", (e) => {
    if (e.kind === "ship") died = true;
  }); // e is typed: e.kind exists
  world.events.on("fired", () => {
    fired++;
  });
  const fire = new Map([[ship.id, [{ turn: 0, thrust: false, fire: true } satisfies ShipCommand]]]);
  for (let i = 0; i < 400 && !died; i++) world.step(1 / 30, fire);
  assert.ok((world.scores.get(ship.id) ?? 0) >= 50, "the shooter must have killed the victim");
  assert.ok(fired > 0);
  assert.equal(victim.alive, false);
  for (let i = 0; i < 90; i++) world.step(1 / 30);
  assert.equal(victim.alive, true, "respawned after 2 s");
  assert.equal(world.get(victim.id), victim, "same entity id");
  assert.equal(asSeq(1), 1);
});

test("a ship that touches a pickup gets its effect, the world announces it, and the pickup is consumed", () => {
  const world = new World(1, { asteroids: 0 });
  const ship = world.spawn(new Ship({ x: 300, y: 300 }));
  world.spawn(new Pickup({ x: 300, y: 300, type: "rapid" }));
  const seen: string[] = [];
  world.events.on("pickup", (e) => seen.push(e.type)); // e is typed: e.type is "shield" | "rapid" | "homing"
  world.step(1 / 30);
  assert.deepEqual(seen, ["rapid"]);
  assert.ok(ship.rapid > 0);
  assert.equal([...world.ofKind("pickup")].length, 0);
});

test("shield blocks damage until it runs out", () => {
  const ship = new Ship({ x: 0, y: 0 });
  ship.applyPickup("shield");
  assert.equal(ship.damage(50), false);
  assert.equal(ship.hp, 100);
  for (let i = 0; i < 180; i++) ship.update(1 / 30); // 180 steps = 6 s
  assert.equal(ship.damage(50), true);
  assert.equal(ship.hp, 50);
});

test("rapid fire shoots more than twice as often, and its timer counts down in steps", () => {
  const cmd: ShipCommand = { turn: 0, thrust: false, fire: true };
  const run = (rapid: number): { fires: number; left: number } => {
    const body: ShipBody = {
      pos: { x: 100, y: 100 },
      vel: { x: 0, y: 0 },
      angle: 0,
      cooldown: 0,
      rapid,
      thrust: false,
    };
    let fires = 0;
    for (let i = 0; i < 30; i++) if (stepShip(body, cmd, 1 / 30)) fires++;
    return { fires, left: body.rapid };
  };
  const normal = run(0);
  const rapid = run(240);
  assert.ok(rapid.fires > normal.fires * 2, `rapid ${rapid.fires} vs normal ${normal.fires}`);
  assert.equal(rapid.left, 210);
  assert.equal(normal.left, 0);
});

test("pickups: none by default, on schedule when asked, never more than two at once", () => {
  const off = new World(1, { asteroids: 0 });
  for (let i = 0; i < 300; i++) off.step(1 / 30);
  assert.equal([...off.ofKind("pickup")].length, 0);

  const on = new World(1, { asteroids: 0, pickupEvery: 1 });
  let seen = 0;
  for (let i = 0; i < 400; i++) {
    on.step(1 / 30);
    const n = [...on.ofKind("pickup")].length;
    assert.ok(n <= 2, `${n} pickups`);
    seen = Math.max(seen, n);
  }
  assert.ok(seen >= 1);
});

test("a ship with the homing effect fires homing bullets", () => {
  const world = new World(1, { asteroids: 0 });
  const ship = world.spawn(new Ship({ x: 300, y: 300 }));
  ship.applyPickup("homing");
  world.step(1 / 30, new Map([[ship.id, [{ turn: 0, thrust: false, fire: true }]]]));
  const bullets = [...world.ofKind("bullet")];
  assert.equal(bullets.length, 1);
  assert.ok(bullets.every((b) => b.homing && b.behaviors.length === 1));
});

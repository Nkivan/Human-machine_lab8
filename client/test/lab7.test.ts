import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STEP } from "@dogfight/shared/protocol/constants";
import { asEntityId, asSeq } from "@dogfight/shared/protocol/ids";
import type { ShipRecord } from "@dogfight/shared/protocol/messages";
import { stepShip, type ShipCommand } from "@dogfight/shared/sim/shipmove";
import { createLoop } from "../src/loop.ts";
import { createPredictor, makeBody, reconcileState, type PendingInput } from "../src/net/netcode.ts";
import { RenderList } from "../src/net/render.ts";
import { createPerf, formatReport } from "../src/perf.ts";
import { Particles } from "../src/render/particles.ts";

const ship = (x: number, over: Partial<ShipRecord> = {}): ShipRecord => ({
  kind: "ship",
  id: asEntityId(1),
  x,
  y: 50,
  vx: 0,
  vy: 0,
  angle: 0,
  thrust: false,
  invuln: false,
  hp: 100,
  cooldown: 0,
  rapid: 0,
  shield: 0,
  homing: 0,
  ...over,
});
const thrust: ShipCommand = { turn: 0, thrust: true, fire: false };

describe("fixed-timestep loop driven by fake timers (no browser, no waiting)", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }));
  afterEach(() => vi.useRealTimers());

  // requestAnimationFrame stand-in: a 60 Hz timer, which the fake clock advances instantly.
  const fakeRaf = (frameMs = 1000 / 60) => ({
    raf: (cb: (t: number) => void): number => Number(setTimeout(() => cb(performance.now()), frameMs)),
    caf: (id: number) => clearTimeout(id),
    now: () => performance.now(),
  });

  it("runs exactly 30 simulation steps per simulated second at 60 frames/s", () => {
    const steps: number[] = [];
    const loop = createLoop({ step: 1 / 30, simulate: (dt) => steps.push(dt), render: () => {}, ...fakeRaf() });
    loop.start();
    vi.advanceTimersByTime(1000);
    expect(steps.length).toBeGreaterThanOrEqual(29);
    expect(steps.length).toBeLessThanOrEqual(30);
    expect(steps.every((dt) => dt === 1 / 30)).toBe(true); // the step is fixed, whatever the frame rate
    loop.stop();
  });

  it("the accumulator carries the remainder: alpha in [0, 1) tells render how far between two steps it is", () => {
    const alphas: number[] = [];
    const loop = createLoop({ step: 1 / 30, simulate: () => {}, render: (a) => alphas.push(a), ...fakeRaf() });
    loop.start();
    vi.advanceTimersByTime(500);
    expect(alphas.every((a) => a >= 0 && a < 1)).toBe(true);
    expect(new Set(alphas.map((a) => a.toFixed(2))).size).toBeGreaterThan(1); // alternates ~0 and ~0.5 at 60/30
    loop.stop();
  });

  it("a long hitch is clamped (maxFrame): no spiral of death", () => {
    let steps = 0;
    const loop = createLoop({
      step: 1 / 30,
      maxFrame: 0.25,
      simulate: () => steps++,
      render: () => {},
      ...fakeRaf(2000),
    });
    loop.start();
    vi.advanceTimersByTime(2000); // ONE frame 2 s late
    expect(steps).toBe(7); // 0.25 s worth (7.5 steps), not 60 steps
    loop.stop();
  });

  it("stop() really stops; onFrame reports interval and work time", () => {
    const frames: number[] = [];
    const loop = createLoop({ simulate: () => {}, render: () => {}, onFrame: (f) => frames.push(f), ...fakeRaf() });
    loop.start();
    vi.advanceTimersByTime(100);
    loop.stop();
    const n = frames.length;
    vi.advanceTimersByTime(1000);
    expect(frames.length).toBe(n);
    expect(frames.every((f) => Math.abs(f - 1000 / 60) < 1)).toBe(true);
  });
});

describe("reconciliation as a pure function of (state, buffer, ack)", () => {
  const pending: PendingInput[] = [1, 2, 3, 4].map((n) => ({ seq: asSeq(n), input: thrust }));

  it("drops acknowledged inputs and replays the rest on top of the server state", () => {
    const r = reconcileState(ship(100), pending, asSeq(2), STEP);
    expect(r.remaining.map((p) => p.seq)).toEqual([3, 4]);
    const expected = makeBody();
    expected.pos.x = 100;
    expected.pos.y = 50;
    stepShip(expected, thrust, STEP);
    stepShip(expected, thrust, STEP);
    expect(r.state).toEqual(expected);
  });

  it("is pure: same arguments, same result; the arguments are not modified", () => {
    const before = JSON.stringify(pending);
    expect(reconcileState(ship(100), pending, asSeq(1), STEP)).toEqual(
      reconcileState(ship(100), pending, asSeq(1), STEP),
    );
    expect(JSON.stringify(pending)).toBe(before);
  });

  it("everything acknowledged -> exactly the server state; prev = state", () => {
    const r = reconcileState(ship(321, { vx: 5 }), pending, asSeq(4), STEP);
    expect(r.state.pos.x).toBe(321);
    expect(r.prev).toEqual(r.state);
  });

  it("the predictor's renderPose is one reused object (no allocation per frame)", () => {
    const p = createPredictor();
    p.reconcile(ship(10), asSeq(0), STEP);
    expect(p.renderPose(0.5)).toBe(p.renderPose(0.2));
  });
});

describe("pools", () => {
  it("Particles: swap-remove keeps live particles, capacity grows and is reused", () => {
    const p = new Particles(4);
    for (let i = 0; i < 6; i++) p.spawn(i, 0, 10, 0, i < 3 ? 0.05 : 1); // 3 short-lived, 3 long-lived
    expect(p.capacity).toBe(8);
    p.update(0.1);
    expect(p.count).toBe(3);
    expect([...p.life.slice(0, 3)].every((l) => l > 0)).toBe(true);
    expect([...p.x.slice(0, 3)].sort()).toEqual([4, 5, 6]); // x + 10 * 0.1 for particles 3, 4, 5
    p.burst(0, 0, 3, () => 0.5);
    expect(p.count).toBe(6);
    expect(p.capacity).toBe(8); // reused, not grown
  });

  it("RenderList reuses its pooled entities after clear()", () => {
    const list = new RenderList();
    const a = list.next();
    list.next();
    list.clear();
    expect(list.next()).toBe(a);
    expect(list.count).toBe(1);
    expect(list.items.length).toBe(2);
  });
});

describe("perf recorder", () => {
  it("spans, frames, dropped frames, percentiles; measure() only when marks are on", () => {
    let t = 0;
    const measured: string[] = [];
    const perf = createPerf({ marks: true, now: () => t, measure: (n) => measured.push(n), clearMeasures: () => {} });
    for (let i = 0; i < 100; i++) {
      perf.begin("render");
      t += i === 99 ? 20 : 1;
      perf.end("render");
      perf.frame(i === 50 ? 40 : 16.7, 1);
    }
    const r = perf.report();
    expect(r.spans.render.p50).toBe(1);
    expect(r.spans.render.max).toBe(20);
    expect(r.dropped).toBe(1);
    expect(measured).toHaveLength(100);
    expect(formatReport(r)).toContain("| render | 100 |");
    perf.reset();
    expect(perf.report().frames.count).toBe(0);
  });
});

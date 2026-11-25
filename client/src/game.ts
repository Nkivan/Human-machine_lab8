import { decodeServer, encodeInputs, encodePing } from "@dogfight/shared/codec/binary";
import { PROTOCOL_VERSION, STEP, TICK_RATE } from "@dogfight/shared/protocol/constants";
import { asSeq, type EntityId } from "@dogfight/shared/protocol/ids";
import type { NetsimSettings, RoomInfo, ShipRecord, Snapshot, WireEvent } from "@dogfight/shared/protocol/messages";
import type { Input, ShipCommand } from "@dogfight/shared/sim/shipmove";
import { assertNever } from "@dogfight/shared/util";
import type { LoadedAssets } from "./assets/loader.ts";
import type { Audio } from "./audio.ts";
import { createChatView } from "./chatView.ts";
import { installDebugApi, type DebugShip } from "./debug.ts";
import { createConnection } from "./connection.ts";
import { createGameBus } from "./events.ts";
import { createHud } from "./hud.ts";
import { createKeyboard } from "./input.ts";
import { createLoop, type LoopStats } from "./loop.ts";
import { createInterpolator, createPredictor } from "./net/netcode.ts";
import { drawNetgraph } from "./net/netgraph.ts";
import { drawWorld, type Sprites } from "./net/netdraw.ts";
import { RenderList } from "./net/render.ts";
import { createNetStats } from "./net/netstats.ts";
import { createPerf, formatReport, SPANS, type PerfReport } from "./perf.ts";
import type { View } from "./render/canvas.ts";
import { drawBackground, drawHud, loopLines } from "./render/draw.ts";
import { createParticleSystem } from "./render/particleSystem.ts";

declare const __APP_VERSION__: string;

const PRESETS = [
  // L cycles the latency injector (rtt ms, jitter ms, drop)
  { latency: 0, jitter: 0, drop: 0 },
  { latency: 50, jitter: 10, drop: 0 },
  { latency: 100, jitter: 30, drop: 0.02 },
  { latency: 200, jitter: 60, drop: 0.05 },
] satisfies readonly NetsimSettings[];

// "SHIELD 4s  RAPID 7s": remaining time of each active effect (steps / 30 = seconds)
function effectsLine(e: { shield: number; rapid: number; homing: number }): string {
  const parts: string[] = [];
  if (e.shield > 0) parts.push(`SHIELD ${Math.ceil(e.shield / TICK_RATE)}s`);
  if (e.rapid > 0) parts.push(`RAPID ${Math.ceil(e.rapid / TICK_RATE)}s`);
  if (e.homing > 0) parts.push(`HOMING ${Math.ceil(e.homing / TICK_RATE)}s`);
  return parts.join("  ");
}

export interface GameOptions {
  readonly ctx: CanvasRenderingContext2D;
  readonly view: View;
  readonly room: RoomInfo;
  readonly name: string;
  readonly assets: LoadedAssets;
  readonly audio: Audio;
  readonly params: URLSearchParams;
}

export function startNetGame({ ctx, view, room, name, assets, audio, params }: GameOptions): void {
  const sheet = assets.images["sheet"];
  if (!sheet) throw new Error("the sprite sheet is missing from the loaded assets");
  const sprites: Sprites = { sheet, frames: assets.frames };

  const bus = createGameBus(); // server events -> audio and HUD: they listen, nobody imports them
  audio.attach(bus);
  const hud = createHud(bus);
  const keys = createKeyboard(window);
  const stats = createNetStats();
  const interp = createInterpolator();
  const predictor = createPredictor({ noise: Number(params.get("noise") ?? 0) }); // ?noise=1 breaks determinism on purpose
  // ?perf=30 -> record 30 s (after 3 s of warm-up: the JIT needs iterations) and report p50/p95/p99.
  const perfSeconds = Number(params.get("perf") ?? 0);
  const perf = createPerf({ marks: params.has("perf") }); // spans in the DevTools "Timings" track only with ?perf
  const autopilot = params.has("autopilot"); // scripted flight + constant fire: a repeatable heavy-shooting session
  let perfReport: PerfReport | null = null;
  let showPerf = false;
  let perfLines: string[] = [];
  let perfLinesAt = 0;

  let you: EntityId | null = null; // my ship's entity id (from "welcome")
  let seq = 0;
  let scores: [string, number][] = [];
  let showHud = true;
  let showNet = true;
  let preset = 0;
  let netStatus = "connecting";
  let lastInvuln = false;
  let myEffects = { shield: 0, rapid: 0, homing: 0 }; // steps left (1 step = 1/30 s), from my ship in the last snapshot
  const recent: Input[] = []; // the last few inputs, repeated in every packet (redundancy against dropped packets)
  // Explosion particles: a pooled SoA system on the main thread, or (?particles=worker) the Web Worker experiment.
  const particles = createParticleSystem(params.get("particles") === "worker" ? "worker" : "main", {
    perBurst: Number(params.get("particlestress") ?? 24), // ?particlestress=2000: find where a worker could pay off
    onMainThreadWork: (ms) => perf.record("particles", ms),
  });
  const drawList = new RenderList(); // pooled draw items, reused every frame
  let hudLines: string[] = [];
  let hudLoop: string[] = [];
  let hudAt = -Infinity;

  // --- connection ---------------------------------------------------------------------------------------------
  const sim = ["lat", "jitter", "drop", "codec"]
    .filter((k) => params.has(k))
    .map((k) => `${k}=${params.get(k)}`)
    .join("&");
  const chat = createChatView({ onSend: (text) => conn.send({ v: PROTOCOL_VERSION, type: "chat", text }) });

  function handleSnapshot(s: Snapshot): void {
    const now = performance.now();
    stats.snapshot();
    interp.push(s, now);
    const mine = you === null ? undefined : s.entities.find((e): e is ShipRecord => e.kind === "ship" && e.id === you);
    if (mine) {
      lastInvuln = mine.invuln;
      myEffects = { shield: mine.shield, rapid: mine.rapid, homing: mine.homing };
      perf.begin("reconcile");
      stats.correction(predictor.reconcile(mine, s.ack, STEP)); // server truth + replay of unacknowledged inputs
      perf.end("reconcile");
      predictor.dropAckedBullets(s.ack);
    } else predictor.clear(); // dead (or not spawned yet): stop predicting until a snapshot has me again
  }

  function handleEvent(ev: WireEvent): void {
    switch (ev.k) {
      case "fired":
        if (ev.shipId !== you) bus.emit("fired", { x: ev.x, y: ev.y }); // my own shot already played locally (prediction)
        return;
      case "hit":
        bus.emit("hit", { x: ev.x, y: ev.y });
        return;
      case "exploded":
        particles.burst(ev.x, ev.y); // visual only: client-side randomness is fine
        bus.emit("exploded", { x: ev.x, y: ev.y, kind: ev.kind });
        return;
      case "pickup":
        if (ev.shipId === you) bus.emit("pickup", { type: ev.type, x: ev.x, y: ev.y }); // popups only for my pickups
        return;
      case "score":
        if (ev.owner === you) bus.emit("score", { delta: ev.delta, x: ev.x, y: ev.y }); // popups only for my points
        return;
      default:
        return assertNever(ev);
    }
  }

  const conn = createConnection({
    url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws${sim ? `?${sim}` : ""}`,
    onOpen: () => {
      you = null;
      conn.send({ v: PROTOCOL_VERSION, type: "join", room: room.id, name });
    },
    onStatus: (s) => {
      chat.setStatus(s);
      netStatus = s;
    },
    onTraffic: (dir, n) => (dir === "in" ? stats.bytesIn(n) : stats.bytesOut(n)),
    onBinary: (buf) => {
      perf.begin("decode");
      const r = decodeServer(buf);
      perf.end("decode");
      if (!r.ok) return;
      const frame = r.value;
      switch (frame.type) {
        case "pong":
          stats.rtt(performance.now() - frame.t);
          return;
        case "snapshot":
          handleSnapshot(frame.snapshot);
          return;
        default:
          return assertNever(frame);
      }
    },
  });
  conn.on("welcome", (m) => {
    you = m.you;
  });
  conn.on("roster", (m) => chat.setRoster(m.players));
  conn.on("chat", (m) => chat.addLine(`${m.from}: ${m.text}`));
  conn.on("system", (m) => chat.addLine(m.text, "sys"));
  conn.on("error", (m) => chat.addLine(`error: ${m.message}`, "sys"));
  conn.on("scores", (m) => {
    scores = m.list;
  });
  conn.on("netsim", (m) => stats.setSim({ latency: m.latency, jitter: m.jitter, drop: m.drop }));
  conn.on("events", (m) => {
    for (const ev of m.list) handleEvent(ev);
  });
  conn.on("snapshot", (m) => handleSnapshot(m)); // only when the JSON codec is selected (?codec=json)
  setInterval(() => conn.sendBinary(encodePing(performance.now())), 1000); // application-level RTT measurement

  // --- simulation: ONE step per input, 30 per second, exactly like a server tick -------------------------------
  function readCommand(): ShipCommand {
    if (autopilot) {
      // Weave left and right, mostly thrusting, trigger held down: lots of bullets and explosions, every run the same.
      const i = seq % 120;
      return { turn: i < 40 ? 1 : i < 60 ? 0 : i < 100 ? -1 : 0, thrust: i % 30 < 22, fire: true };
    }
    const left = keys.isDown("ArrowLeft") || keys.isDown("KeyA");
    const right = keys.isDown("ArrowRight") || keys.isDown("KeyD");
    const turn = left === right ? 0 : right ? 1 : -1; // typed as -1 | 0 | 1, not just `number`
    return { turn, thrust: keys.isDown("ArrowUp") || keys.isDown("KeyW"), fire: keys.isDown("Space") };
  }

  function simulate(dt: number): void {
    if (keys.justPressed("KeyH")) showHud = !showHud;
    if (keys.justPressed("KeyN")) showNet = !showNet;
    if (keys.justPressed("KeyP")) showPerf = !showPerf;
    if (keys.justPressed("BracketLeft")) interp.delayMs -= 10;
    if (keys.justPressed("BracketRight")) interp.delayMs += 10;
    if (keys.justPressed("KeyL")) {
      preset = (preset + 1) % PRESETS.length;
      const p = PRESETS[preset];
      if (p) conn.send({ v: PROTOCOL_VERSION, type: "netsim", ...p });
    }

    const cmd: Input = { seq: asSeq(++seq), ...readCommand() };
    recent.push(cmd);
    if (recent.length > 3) recent.shift();
    conn.sendBinary(encodeInputs(recent)); // inputs go up, never positions
    if (predictor.apply(cmd.seq, cmd, dt)) {
      const pose = predictor.renderPose(1);
      bus.emit("fired", { x: pose?.x ?? 0, y: pose?.y ?? 0 }); // instant local sound
    }
    predictor.stepBullets(dt);
    keys.endStep();
  }

  // --- rendering ----------------------------------------------------------------------------------------------
  function render(alpha: number, loopStats: LoopStats): void {
    const now = performance.now();
    const frameDt = loopStats.frameMs / 1000;
    stats.frame(now);
    predictor.decayError(frameDt);
    perf.begin("particles");
    particles.update(frameDt);
    perf.end("particles");

    // Build the frame's draw list from POOLED entities (render.ts): no filter/map chains, no objects per entity.
    drawList.clear();
    interp.sample(now, drawList, you ?? -1); // remote entities; my own ship comes from prediction
    for (const b of predictor.predictedBullets) {
      const e = drawList.next();
      e.kind = "bullet";
      e.x = b.x;
      e.y = b.y;
      e.homing = false;
    }
    const pose = predictor.renderPose(alpha);
    if (pose && you !== null) {
      const e = drawList.next();
      e.kind = "ship";
      e.id = you;
      e.x = pose.x;
      e.y = pose.y;
      e.angle = pose.angle;
      e.thrust = pose.thrust;
      e.invuln = lastInvuln;
      e.shield = myEffects.shield > 0;
      e.me = true;
    }

    drawBackground(ctx, view);
    drawWorld(ctx, view, drawList, particles.view, sprites, now);
    hud.draw(ctx, view, now);
    if (showHud) {
      if (now - hudAt > 250) {
        hudAt = now; // text that changes a few times per second is rebuilt a few times per second
        hudLoop = loopLines(loopStats);
        hudLines = [
          `${name} @ ${room.name} [${typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "v1.0.0"}]`,
          ...scores.map(([n, s]) => `${n}: ${s}`),
          predictor.ready ? effectsLine(myEffects) : "destroyed / waiting for spawn...",
        ];
      }
      drawHud(ctx, loopStats, hudLoop, hudLines);
    }
    if (showNet) {
      netInfo.ageMs = interp.ageMs(now);
      netInfo.pending = predictor.pendingCount;
      netInfo.interpDelay = interp.delayMs;
      netInfo.status = netStatus;
      drawNetgraph(ctx, view, netInfo);
    }
    if (showPerf) drawPerf(now);
  }

  const netInfo = { stats, ageMs: 0, pending: 0, interpDelay: 0, status: "" }; // reused every frame

  // P: live percentiles of the last ~2 minutes of frames (the strings are rebuilt twice a second, not every frame).
  function drawPerf(now: number): void {
    if (now - perfLinesAt > 500) {
      perfLinesAt = now;
      const r = perf.report();
      const ms = (s: { p50: number; p95: number; p99: number }): string =>
        `${s.p50.toFixed(1)} / ${s.p95.toFixed(1)} / ${s.p99.toFixed(1)}`;
      perfLines = [
        "perf  p50 / p95 / p99 ms",
        `frame   ${ms(r.frames)}  dropped ${r.dropped}`,
        `work    ${ms(r.work)}`,
        ...SPANS.map((name) => `${name.padEnd(9)} ${ms(r.spans[name])}`),
      ];
    }
    ctx.save();
    ctx.font = "12px ui-monospace, monospace";
    ctx.fillStyle = "rgba(5, 7, 13, 0.75)";
    ctx.fillRect(8, view.cssH - 20 - perfLines.length * 16, 300, perfLines.length * 16 + 12);
    ctx.fillStyle = "#9be28f";
    perfLines.forEach((t, i) => ctx.fillText(t, 16, view.cssH - 8 - (perfLines.length - i) * 16));
    ctx.restore();
  }

  // ?perf=<seconds>: one repeatable recording; the report goes to the console and to window.__dogfight.perfReport()
  if (perfSeconds > 0) {
    setTimeout(() => {
      perf.reset();
      setTimeout(() => {
        perfReport = perf.report();
        console.log(`[perf]\n${formatReport(perfReport)}`);
      }, perfSeconds * 1000);
    }, 3000);
  }

  if (params.has("e2e") || params.has("perf")) {
    installDebugApi({
      you: () => you,
      status: () => netStatus,
      ships() {
        const out: DebugShip[] = [];
        const list = new RenderList();
        interp.sample(performance.now(), list, you ?? -1);
        for (const r of list.toArray()) if (r.kind === "ship") out.push({ id: r.id, x: r.x, y: r.y, me: false });
        const pose = predictor.renderPose(1);
        if (pose && you !== null) out.push({ id: you, x: pose.x, y: pose.y, me: true });
        return out;
      },
      perfReport: () => perfReport,
      perfMarkdown: () => (perfReport ? formatReport(perfReport) : null),
    });
  }

  createLoop({
    step: STEP,
    simulate(dt) {
      perf.begin("simulate");
      simulate(dt);
      perf.end("simulate");
    },
    render(alpha, loopStats) {
      perf.begin("render");
      render(alpha, loopStats);
      perf.end("render");
    },
    onFrame: (frameMs, workMs) => perf.frame(frameMs, workMs),
  }).start();
}

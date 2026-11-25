import type { GameBus } from "./events.ts";

export interface Audio {
  readonly ctx: AudioContext;
  play(name: string): void;
  setBuffers(buffers: Readonly<Record<string, AudioBuffer | null>>): void;
  attach(bus: GameBus): void;
}

// Owns the AudioContext. The sim never imports this: audio SUBSCRIBES to events.
export function createAudio(): Audio {
  const ctx = new AudioContext(); // starts "suspended" until a user gesture
  const buffers = new Map<string, AudioBuffer>();
  const master = ctx.createGain();
  master.gain.value = 0.4;
  master.connect(ctx.destination);

  const unlock = (): void => {
    if (ctx.state === "suspended") void ctx.resume();
  };
  for (const type of ["pointerdown", "keydown"] as const) window.addEventListener(type, unlock);

  function play(name: string): void {
    const buffer = buffers.get(name);
    if (!buffer || ctx.state !== "running") return;
    const src = ctx.createBufferSource(); // one-shot node per playback (cheap, allows overlap)
    src.buffer = buffer;
    src.connect(master);
    src.start();
  }

  return {
    ctx,
    play,
    setBuffers(map) {
      for (const [name, buffer] of Object.entries(map)) if (buffer) buffers.set(name, buffer);
    },
    attach(bus) {
      bus.on("fired", () => play("shoot"));
      bus.on("hit", () => play("hit"));
      bus.on("exploded", () => play("explosion"));
    },
  };
}

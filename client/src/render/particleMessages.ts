// Messages between the main thread and particles.worker.ts. `MessageEvent.data` is `any`: narrowed by guards, not cast.

export interface FrameMessage {
  readonly type: "frame";
  readonly dt: number;
  readonly perBurst: number;
  readonly spawnCount: number;
  readonly spawns: Float32Array; // [x, y] per explosion this frame (small: structured-cloned)
  readonly out: Float32Array<ArrayBuffer>; // the buffer to fill (transferred: the main thread loses it until the result comes back)
}
export interface ResultMessage {
  readonly type: "result";
  readonly count: number;
  readonly buf: Float32Array<ArrayBuffer>; // [x, y, life] * count (transferred back)
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

export const isFrameMessage = (x: unknown): x is FrameMessage =>
  isObject(x) &&
  x["type"] === "frame" &&
  typeof x["dt"] === "number" &&
  typeof x["perBurst"] === "number" &&
  typeof x["spawnCount"] === "number" &&
  x["spawns"] instanceof Float32Array &&
  x["out"] instanceof Float32Array &&
  x["out"].buffer instanceof ArrayBuffer; // only an ArrayBuffer is transferable (a SharedArrayBuffer is shared instead)

export const isResultMessage = (x: unknown): x is ResultMessage =>
  isObject(x) &&
  x["type"] === "result" &&
  typeof x["count"] === "number" &&
  x["buf"] instanceof Float32Array &&
  x["buf"].buffer instanceof ArrayBuffer;

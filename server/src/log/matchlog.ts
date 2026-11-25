import { on } from "node:events";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Room } from "../rooms.ts";
import { RoomLogEvent } from "./events.ts";

// Object-mode in, text out: one JSON object -> one NDJSON line.
export class NdjsonTransform extends Transform {
  constructor() {
    super({ writableObjectMode: true });
  }
  override _transform(obj: unknown, _enc: BufferEncoding, cb: TransformCallback): void {
    try {
      cb(null, JSON.stringify(obj) + "\n");
    } catch (error) {
      cb(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export interface MatchLog {
  readonly file: string;
  readonly done: Promise<void>;
}

// A room's events become a stream: events.on(room, "event") -> Readable -> Transform -> file.
// pipeline() wires backpressure, error propagation and cleanup for us.
export function createMatchLog({ dir, room }: { dir: string; room: Room }): MatchLog {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${room.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`);

  const events = on(room, "event"); // listener is attached NOW, so no event is missed
  async function* source(): AsyncGenerator<RoomLogEvent> {
    for await (const args of events) {
      // `args` comes from Node's untyped API: validate before trusting it
      const ev = RoomLogEvent.safeParse(args[0]);
      if (!ev.success) continue;
      yield ev.data;
      if (ev.data.type === "closed") return; // returning detaches the listener and ends the stream
    }
  }

  const done = pipeline(Readable.from(source(), { objectMode: true }), new NdjsonTransform(), createWriteStream(file));
  return { file, done };
}

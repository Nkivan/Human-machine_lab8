import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { RoomLogEvent } from "./events.ts";

// Async generator over an NDJSON file: constant memory however large the file is. Every line is validated.
export async function* replay(file: string): AsyncGenerator<RoomLogEvent> {
  const input = createReadStream(file);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      } // a torn last line must not abort the replay
      const ev = RoomLogEvent.safeParse(raw);
      if (ev.success) yield ev.data;
    }
  } finally {
    input.destroy(); // if the consumer breaks early, do not leak the file descriptor
  }
}

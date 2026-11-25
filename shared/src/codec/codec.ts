import { PROTOCOL_VERSION } from "../protocol/constants.ts";
import { SnapshotMessage, type Snapshot } from "../protocol/messages.ts";
import { err, ok, type Result } from "../util.ts";
import { decodeServer, encodeSnapshot } from "./binary.ts";

// A snapshot codec: the SAME snapshot, two wire formats. The server picks one (SNAPSHOT_CODEC / ?codec=json).
export interface SnapshotCodec<Wire extends string | ArrayBuffer> {
  readonly name: string;
  encode(s: Snapshot): Wire;
  decode(wire: Wire): Result<Snapshot>;
}

export const binaryCodec: SnapshotCodec<ArrayBuffer> = {
  name: "binary",
  encode: encodeSnapshot,
  decode(buf) {
    const r = decodeServer(buf);
    if (!r.ok) return r;
    return r.value.type === "snapshot" ? ok(r.value.snapshot) : err("not a snapshot");
  },
};

export const jsonCodec: SnapshotCodec<string> = {
  name: "json",
  encode: (s) =>
    JSON.stringify({ v: PROTOCOL_VERSION, type: "snapshot", tick: s.tick, ack: s.ack, entities: s.entities }),
  decode(text) {
    let raw: unknown; // JSON.parse is untyped input: `unknown`, then validated by the schema
    try {
      raw = JSON.parse(text);
    } catch {
      return err("invalid JSON");
    }
    const r = SnapshotMessage.safeParse(raw);
    return r.success ? ok({ tick: r.data.tick, ack: r.data.ack, entities: r.data.entities }) : err("invalid snapshot");
  },
};

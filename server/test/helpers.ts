import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { decodeServer, type ServerBinary } from "@dogfight/shared/codec/binary";
import { PROTOCOL_VERSION } from "@dogfight/shared/protocol/constants";
import {
  messageIs,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "@dogfight/shared/protocol/messages";
import { createApp, type App } from "../src/app.ts";
import { loadConfig, type EnvVars } from "../src/config.ts";

export interface Harness {
  readonly app: App;
  readonly dir: string;
  readonly base: string;
  cleanup(): Promise<void>;
}

export async function start(extra: EnvVars = {}): Promise<Harness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dogfight-"));
  const app = createApp(loadConfig({ PORT: "0", HOST: "127.0.0.1", LOG_DIR: dir, STATIC_DIR: dir, ...extra }));
  const { port } = await app.listen();
  return {
    app,
    dir,
    base: `127.0.0.1:${port}`,
    async cleanup() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function createRoom(base: string, body: unknown): Promise<string> {
  const res = await fetch(`http://${base}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: unknown = await res.json();
  if (
    typeof data === "object" &&
    data !== null &&
    "room" in data &&
    typeof data.room === "object" &&
    data.room !== null &&
    "id" in data.room &&
    typeof data.room.id === "string"
  )
    return data.room.id;
  throw new Error(`could not create a room: ${JSON.stringify(data)}`);
}

// A test client that records every VALIDATED message the server sends.
export interface TestClient {
  readonly ws: WebSocket;
  readonly json: ServerMessage[];
  readonly bin: ServerBinary[];
  readonly closed: Promise<number>;
  readonly events: EventEmitter<{ json: [ServerMessage]; bin: [ServerBinary] }>;
}

export function connect(base: string, query = ""): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/ws${query}`);
    ws.binaryType = "arraybuffer";
    const events = new EventEmitter<{ json: [ServerMessage]; bin: [ServerBinary] }>();
    const client: TestClient = {
      ws,
      json: [],
      bin: [],
      events,
      closed: new Promise((r) => ws.once("close", (code) => r(code))),
    };
    ws.on("message", (data, isBinary) => {
      if (isBinary && data instanceof ArrayBuffer) {
        const r = decodeServer(data);
        if (r.ok) {
          client.bin.push(r.value);
          events.emit("bin", r.value);
        }
      } else if (!isBinary) {
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString() // RawData may be fragments: Buffer[].toString() would not be the message
          : data instanceof ArrayBuffer
            ? Buffer.from(data).toString()
            : data.toString();
        const m = parseServerMessage(JSON.parse(text));
        if (!m.ok) throw new Error(`server sent an invalid message: ${m.error}`);
        client.json.push(m.value);
        events.emit("json", m.value);
      }
    });
    ws.once("open", () => resolve(client));
    ws.once("error", reject);
  });
}

export function waitJson<T extends ServerMessage["type"]>(
  c: TestClient,
  type: T,
  ms = 3000,
): Promise<Extract<ServerMessage, { type: T }>> {
  const is = messageIs(type);
  const found = c.json.find(is);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
    const onMsg = (m: ServerMessage): void => {
      if (is(m)) {
        clearTimeout(timer);
        c.events.off("json", onMsg);
        resolve(m);
      }
    };
    c.events.on("json", onMsg);
  });
}

export function waitFor(c: TestClient, pred: (m: ServerMessage) => boolean, ms = 3000): Promise<ServerMessage> {
  const found = c.json.find(pred);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for a message")), ms);
    const onMsg = (m: ServerMessage): void => {
      if (pred(m)) {
        clearTimeout(timer);
        c.events.off("json", onMsg);
        resolve(m);
      }
    };
    c.events.on("json", onMsg);
  });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const sendMsg = (c: TestClient, msg: ClientMessage): void => c.ws.send(JSON.stringify(msg));
export const join = (c: TestClient, room: string, name = "Pilot"): void =>
  sendMsg(c, { v: PROTOCOL_VERSION, type: "join", room, name });

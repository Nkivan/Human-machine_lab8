import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { decodeClient, encodePong, encodeSnapshot, withAck } from "@dogfight/shared/codec/binary";
import { jsonCodec } from "@dogfight/shared/codec/codec";
import { MSG } from "@dogfight/shared/protocol/constants";
import {
  parseClientMessage,
  type ClientMessage,
  type EntityRecord,
  type ServerMessage,
  type Snapshot,
} from "@dogfight/shared/protocol/messages";
import { assertNever } from "@dogfight/shared/util";
import type { IncomingMessage, Server } from "node:http";
import type { ServerConfig } from "./config.ts";
import { createHeartbeat } from "./heartbeat.ts";
import { createNetsim, parseNetsim } from "./netsim.ts";
import type { Logger, Observability } from "./obs.ts";
import { serverMsg } from "./protocol.ts";
import { createTokenBucket } from "./ratelimit.ts";
import type { Player, Room, RoomManager, SendOptions } from "./rooms.ts";
import type { Traffic } from "./traffic.ts";

const CLOSE = {
  JOIN_TIMEOUT: 4001,
  BAD_JSON: 4002,
  BAD_MESSAGE: 4003,
  NOT_JOINED: 4004,
  ALREADY_JOINED: 4005,
  NO_ROOM: 4006,
  ROOM_FULL: 4007,
  RATE: 4008,
  ORIGIN_DENIED: 4009,
  IP_LIMIT: 4010,
} as const;

const toBuffer = (data: RawData): Buffer =>
  Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;

const toArrayBuffer = (buf: Buffer): ArrayBuffer => {
  const out = new ArrayBuffer(buf.length);
  new Uint8Array(out).set(buf);
  return out;
};

const encodedSnapshots = new WeakMap<readonly EntityRecord[], ArrayBuffer>();
const serialized = new WeakMap<ServerMessage, string>();

function encodeShared(s: Snapshot): ArrayBuffer {
  let encoded = encodedSnapshots.get(s.entities);
  if (!encoded) {
    encoded = encodeSnapshot(s);
    encodedSnapshots.set(s.entities, encoded);
    return encoded;
  }
  return withAck(encoded, s.ack);
}

function stringifyShared(msg: ServerMessage): string {
  let text = serialized.get(msg);
  if (text === undefined) {
    text = JSON.stringify(msg);
    serialized.set(msg, text);
  }
  return text;
}

function extractClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim().length > 0) {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }
  return req.socket.remoteAddress ?? "unknown";
}

function isOriginAllowed(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  if (allowedOrigins.length === 0) return true;
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}

export interface WsDeps {
  readonly server: Server;
  readonly manager: RoomManager;
  readonly config: ServerConfig;
  readonly traffic: Traffic;
  readonly logger: Logger;
  readonly obs: Observability;
}

export function attachWebSocket({ server, manager, config, traffic, logger, obs }: WsDeps): WebSocketServer {
  const connsPerIp = new Map<string, number>();

  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: config.maxPayload,
    verifyClient: (info, cb) => {
      const clientIp = extractClientIp(info.req);
      const originHeader = typeof info.origin === "string" ? info.origin : info.req.headers.origin;
      if (!isOriginAllowed(originHeader, config.allowedOrigins)) {
        obs.recordRejection("origin");
        logger.warn("ws.rejected", { reason: "origin_not_allowed", ip: clientIp });
        cb(false, 403, "Origin not allowed");
        return;
      }
      const currentIpCount = connsPerIp.get(clientIp) ?? 0;
      if (currentIpCount >= config.maxConnectionsPerIp) {
        obs.recordRejection("ipLimit");
        logger.warn("ws.rejected", { reason: "ip_limit", ip: clientIp });
        cb(false, 429, "Too many connections from IP");
        return;
      }
      cb(true);
    },
  });

  const heartbeat = createHeartbeat(() => wss.clients, config.heartbeatMs);
  wss.on("close", () => heartbeat.stop());

  wss.on("connection", (socket, req) => {
    const clientIp = extractClientIp(req);
    connsPerIp.set(clientIp, (connsPerIp.get(clientIp) ?? 0) + 1);
    heartbeat.track(socket);

    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const id = randomUUID();
    let room: Room | null = null;
    let player: Player | null = null;
    const jsonBucket = createTokenBucket({ ratePerSec: config.msgPerSec, burst: config.msgBurst });
    const binBucket = createTokenBucket({ ratePerSec: config.binPerSec, burst: config.binBurst });
    const net = createNetsim(config.debugRoutes ? parseNetsim(params) : {});
    const useJsonSnapshots = config.snapshotCodec === "json" || (config.debugRoutes && params.get("codec") === "json");

    function transmit(data: string | ArrayBuffer, { critical = true, droppable = false }: SendOptions = {}): void {
      net.out(
        () => {
          if (socket.readyState !== WebSocket.OPEN) return;
          if (socket.bufferedAmount > config.bufferLimit) {
            if (!critical) return;
            if (socket.bufferedAmount > config.bufferLimit * 4) {
              socket.close(1013, "too slow");
              return;
            }
          }
          socket.send(data);
          traffic.bytesOut += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
          traffic.framesOut++;
        },
        { droppable },
      );
    }
    const send = (msg: ServerMessage, opts?: SendOptions): void => transmit(stringifyShared(msg), opts);
    const sendSnapshot = (s: Snapshot): void => {
      const wire = useJsonSnapshots ? jsonCodec.encode(s) : encodeShared(s);
      transmit(wire, { critical: false, droppable: true });
    };

    const joinTimer = setTimeout(() => socket.close(CLOSE.JOIN_TIMEOUT, "join timeout"), config.joinTimeoutMs);

    function handleJoin(msg: Extract<ClientMessage, { type: "join" }>): void {
      if (room) return socket.close(CLOSE.ALREADY_JOINED, "already joined");
      const target = manager.get(msg.room);
      if (!target) {
        send(serverMsg.error("no_such_room", "no such room"));
        return socket.close(CLOSE.NO_ROOM, "no such room");
      }
      if (target.humans >= target.max) {
        obs.recordRejection("roomFull");
        logger.warn("ws.rejected", { reason: "room_full", roomId: target.id, playerId: id });
        send(serverMsg.error("room_full", "room is full"));
        return socket.close(CLOSE.ROOM_FULL, "room full");
      }
      clearTimeout(joinTimer);
      room = target;
      player = { id, name: msg.name, send, sendSnapshot };
      target.join(player);
      logger.info("player.joined", { roomId: target.id, playerId: id });
    }

    function handleBinary(data: Buffer): void {
      if (!room) return socket.close(CLOSE.NOT_JOINED, "join first");
      const res = decodeClient(toArrayBuffer(data));
      if (!res.ok) {
        obs.recordRejection("badMessage");
        logger.warn("ws.rejected", { reason: "bad_binary", roomId: room.id, playerId: id });
        return socket.close(CLOSE.BAD_MESSAGE, res.error);
      }
      const frame = res.value;
      switch (frame.type) {
        case "inputs":
          return room.match.receiveInputs(id, frame.inputs);
        case "ping":
          return transmit(encodePong(frame.t, room.match.tickNo), { critical: true, droppable: false });
        default:
          return assertNever(frame);
      }
    }

    function handleText(data: Buffer): void {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        obs.recordRejection("badMessage");
        logger.warn("ws.rejected", { reason: "bad_json", playerId: id });
        return socket.close(CLOSE.BAD_JSON, "bad json");
      }
      const res = parseClientMessage(raw);
      if (!res.ok) {
        obs.recordRejection("badMessage");
        logger.warn("ws.rejected", { reason: "bad_message", playerId: id });
        return socket.close(CLOSE.BAD_MESSAGE, res.error);
      }
      const msg = res.value;
      switch (msg.type) {
        case "join":
          return handleJoin(msg);
        case "chat":
          if (!room || !player) return socket.close(CLOSE.NOT_JOINED, "join first");
          return room.chat(player, msg.text);
        case "netsim":
          if (!room) return socket.close(CLOSE.NOT_JOINED, "join first");
          if (!config.debugRoutes) return send(serverMsg.error("disabled", "netsim needs DEBUG_ROUTES=1"));
          net.set({ latency: msg.latency, jitter: msg.jitter, drop: msg.drop });
          return send(serverMsg.netsim(net.settings));
        default:
          return assertNever(msg);
      }
    }

    socket.on("message", (raw, isBinary) => {
      if (!(isBinary ? binBucket : jsonBucket).take()) {
        obs.recordRejection("rateLimit");
        logger.warn("ws.rejected", { reason: "rate_limit", ...(room ? { roomId: room.id } : {}), playerId: id });
        return socket.close(CLOSE.RATE, "rate limit");
      }
      const data = toBuffer(raw);
      traffic.bytesIn += data.length;
      traffic.framesIn++;
      const droppable = isBinary && ((data[0] ?? 0) & 15) === MSG.INPUT;
      net.in(() => (isBinary ? handleBinary(data) : handleText(data)), { droppable });
    });

    socket.on("close", () => {
      clearTimeout(joinTimer);
      const prev = connsPerIp.get(clientIp) ?? 0;
      if (prev <= 1) connsPerIp.delete(clientIp);
      else connsPerIp.set(clientIp, prev - 1);
      if (room) logger.info("player.left", { roomId: room.id, playerId: id });
      room?.leave(id);
    });
    socket.on("error", (err) => logger.error("ws.socket_error", { playerId: id, err: err.message }));
  });

  return wss;
}

import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import http, { type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { WebSocket, type WebSocketServer } from "ws";
import { z } from "zod";
import { ArenaConfig } from "@dogfight/shared/protocol/messages";
import { addBots, botCount, removeBots } from "./bot.ts";
import type { ServerConfig } from "./config.ts";
import { HttpError } from "./errors.ts";
import { createLogger, createObservability, type Logger, type Observability } from "./obs.ts";
import { serverMsg } from "./protocol.ts";
import { RoomManager } from "./rooms.ts";
import { createStaticHandler } from "./static.ts";
import { createTraffic } from "./traffic.ts";
import { attachWebSocket } from "./ws.ts";

const BODY_LIMIT = 4096;

const CreateRoomBody = z.object({ name: z.string().trim().min(1).max(24), arena: ArenaConfig.partial().optional() });
const AddBotsBody = z.object({ count: z.number().int().min(1).max(128) });
const BOTS_PATH = /^\/api\/rooms\/([\w-]{1,40})\/bots$/;

function badRequest(error: z.ZodError): HttpError {
  const issue = error.issues[0];
  return new HttpError(400, issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid body");
}

function json(res: ServerResponse, status: number, body: unknown, headers: OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit = BODY_LIMIT): Promise<unknown> {
  if (Number(req.headers["content-length"]) > limit) throw new HttpError(413, "body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const raw: unknown = chunk;
    const buf = typeof raw === "string" ? Buffer.from(raw) : Buffer.isBuffer(raw) ? raw : null;
    if (!buf) throw new HttpError(400, "unexpected body chunk");
    size += buf.length;
    if (size > limit) throw new HttpError(413, "body too large");
    chunks.push(buf);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

export interface App {
  readonly server: Server;
  readonly manager: RoomManager;
  readonly wss: WebSocketServer;
  readonly logger: Logger;
  readonly obs: Observability;
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
}

export function createApp(config: ServerConfig): App {
  const logger = createLogger(config.logLevel);
  const obs = createObservability();
  const manager = new RoomManager(config);
  let shuttingDown = false;

  if (config.seedRooms) {
    manager.create({
      id: "alpha",
      name: "Alpha (calm)",
      arena: { asteroids: 4, pickupEvery: 6, seed: 1 },
      persistent: true,
    });
    manager.create({
      id: "bravo",
      name: "Bravo (rocky)",
      arena: { asteroids: 10, pickupEvery: 8, seed: 2 },
      persistent: true,
    });
    logger.info("rooms.seeded", { count: manager.size });
  }
  const serveStatic = createStaticHandler(config.staticDir);
  const traffic = createTraffic();

  let eluPrev = performance.eventLoopUtilization();
  let elu = 0;
  let prevBytesIn = traffic.bytesIn;
  let prevBytesOut = traffic.bytesOut;
  let prevFramesIn = traffic.framesIn;
  let prevFramesOut = traffic.framesOut;
  let bytesInPerSec = 0;
  let bytesOutPerSec = 0;
  let framesInPerSec = 0;
  let framesOutPerSec = 0;

  const sampleTimer = setInterval(() => {
    const now = performance.eventLoopUtilization();
    elu = performance.eventLoopUtilization(now, eluPrev).utilization;
    eluPrev = now;
    bytesInPerSec = traffic.bytesIn - prevBytesIn;
    bytesOutPerSec = traffic.bytesOut - prevBytesOut;
    framesInPerSec = traffic.framesIn - prevFramesIn;
    framesOutPerSec = traffic.framesOut - prevFramesOut;
    prevBytesIn = traffic.bytesIn;
    prevBytesOut = traffic.bytesOut;
    prevFramesIn = traffic.framesIn;
    prevFramesOut = traffic.framesOut;
  }, 1000);
  sampleTimer.unref();

  function maxTickP99(): number {
    let maxP99 = 0;
    for (const m of manager.matchStats()) {
      if (m.p99Ms > maxP99) maxP99 = m.p99Ms;
    }
    return maxP99;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname } = url;

    if (pathname === "/health") {
      return json(res, 200, { status: "ok", version: config.appVersion, uptime: process.uptime() });
    }

    if (pathname === "/ready") {
      if (shuttingDown) return json(res, 503, { status: "shutting_down", version: config.appVersion });
      return json(res, 200, { status: "ready", version: config.appVersion, rooms: manager.size });
    }

    if (pathname === "/metrics") {
      const body = obs.formatPrometheus({
        version: config.appVersion,
        connections: wss.clients.size,
        rooms: manager.size,
        bytesInPerSec,
        bytesOutPerSec,
        framesInPerSec,
        framesOutPerSec,
        tickP99Ms: maxTickP99(),
        elu,
      });
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(body);
      return;
    }

    if (pathname === "/api/stats") {
      const { rss, heapUsed, heapTotal, external, arrayBuffers } = process.memoryUsage();
      return json(res, 200, {
        version: config.appVersion,
        rss,
        heapUsed,
        heapTotal,
        external,
        arrayBuffers,
        elu: Math.round(elu * 1000) / 1000,
        traffic,
        uptime: process.uptime(),
        rooms: manager.size,
        connections: wss.clients.size,
        rejections: obs.rejections,
        matches: manager.matchStats(),
      });
    }

    if (pathname === "/api/rooms") {
      if (req.method === "GET") return json(res, 200, { rooms: manager.list() });
      if (req.method === "POST") {
        const body = CreateRoomBody.safeParse(await readJson(req));
        if (!body.success) throw badRequest(body.error);
        const room = manager.create({ name: body.data.name, ...(body.data.arena ? { arena: body.data.arena } : {}) });
        logger.info("room.created", { roomId: room.id });
        return json(res, 201, { room: room.info });
      }
      throw new HttpError(405, "method not allowed");
    }

    const botsRoute = BOTS_PATH.exec(pathname);
    if (botsRoute) {
      const room = manager.get(botsRoute[1] ?? "");
      if (!room) throw new HttpError(404, "no such room");
      if (req.method === "POST") {
        const body = AddBotsBody.safeParse(await readJson(req));
        if (!body.success) throw badRequest(body.error);
        const added = addBots(room, body.data.count, config.maxBotsPerRoom);
        if (added.length === 0) throw new HttpError(409, `bot limit reached (${config.maxBotsPerRoom} per room)`);
        logger.info("bots.added", { roomId: room.id, added: added.length, totalBots: botCount(room) });
        return json(res, 201, { added: added.map((b) => b.name), bots: botCount(room), room: room.info });
      }
      if (req.method === "DELETE") {
        const removed = removeBots(room);
        logger.info("bots.removed", { roomId: room.id, removed });
        return json(res, 200, { removed, room: room.info });
      }
      throw new HttpError(405, "method not allowed");
    }

    if (pathname === "/api/replays" && req.method === "GET") {
      const files = (await readdir(config.logDir).catch(() => [])).filter((f) => f.endsWith(".ndjson"));
      const replays = await Promise.all(
        files.map(async (id) => ({ id, size: (await stat(path.join(config.logDir, id))).size })),
      );
      return json(res, 200, { replays });
    }

    if (pathname.startsWith("/api/replays/") && req.method === "GET") {
      const id = pathname.slice("/api/replays/".length);
      if (!/^[\w.-]+\.ndjson$/.test(id) || id.includes("..")) throw new HttpError(400, "bad replay id");
      const file = path.join(config.logDir, id);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) throw new HttpError(404, "no such replay");
      res.writeHead(200, { "content-type": "application/x-ndjson", "content-length": info.size });
      return pipeline(createReadStream(file), res).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ERR_STREAM_PREMATURE_CLOSE") throw err;
      });
    }

    if (config.debugRoutes) {
      if (pathname === "/api/slow") {
        const ms = Math.min(Number(url.searchParams.get("ms") ?? 300), 5000);
        const t = performance.now();
        while (performance.now() - t < ms) {
          /* synchronous busy-wait */
        }
        return json(res, 200, { blockedMs: ms });
      }
      if (pathname === "/api/debug/error") {
        const emitter = new EventEmitter();
        if (url.searchParams.has("safe")) emitter.on("error", (err: Error) => console.error("handled:", err.message));
        setImmediate(() => emitter.emit("error", new Error("boom")));
        return json(res, 200, { scheduled: true, safe: url.searchParams.has("safe") });
      }
      if (pathname === "/api/debug/reject") {
        const p = Promise.reject(new Error("unhandled rejection demo"));
        if (url.searchParams.has("safe")) p.catch((err: Error) => console.error("handled:", err.message));
        return json(res, 200, { scheduled: true, safe: url.searchParams.has("safe") });
      }
    }

    if (pathname.startsWith("/api/")) throw new HttpError(404, "not found");
    return serveStatic(req, res, pathname);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy(err instanceof Error ? err : undefined);
        return;
      }
      if (err instanceof HttpError) {
        json(res, err.status, { error: err.message }, err.status === 413 ? { connection: "close" } : {});
        return;
      }
      logger.error("http.unhandled_error", { err: err instanceof Error ? err.message : String(err) });
      json(res, 500, { error: "internal error" });
    });
  });
  const wss = attachWebSocket({ server, manager, config, traffic, logger, obs });

  return {
    server,
    manager,
    wss,
    logger,
    obs,
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("server is not listening on a TCP port");
      return address;
    },
    async close() {
      shuttingDown = true;
      clearInterval(sampleTimer);
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      const notice = JSON.stringify(serverMsg.system("server shutting down; reconnecting..."));
      for (const socket of wss.clients) {
        if (socket.readyState === WebSocket.OPEN) socket.send(notice);
        socket.close(1001, "server shutting down");
      }
      wss.close();
      await manager.closeAll();
      server.closeIdleConnections();
      const force = setTimeout(() => server.closeAllConnections(), Math.min(config.shutdownTimeoutMs, 2000));
      await closed;
      clearTimeout(force);
    },
  };
}

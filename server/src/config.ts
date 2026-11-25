import path from "node:path";
import { z } from "zod";

// ALL configuration comes from the environment, parsed ONCE by this schema (types inferred, defaults in one place).
const flag = z.enum(["0", "1"]).transform((v) => v === "1");
const int = (min: number, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max);

function parseOrigins(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const Env = z.object({
  PORT: int(0, 65535).default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_DIR: z.string().min(1).default("./logs"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  STATIC_DIR: z.string().min(1).default("../client/dist"),
  APP_VERSION: z.string().min(1).default("v1.0.0"),
  DEBUG_ROUTES: flag.default(false),
  SEED_ROOMS: flag.default(true),
  SNAPSHOT_CODEC: z.enum(["binary", "json"]).default("binary"),
  ALLOWED_ORIGINS: z.string().optional(),
  MAX_CONNECTIONS_PER_IP: int(1).default(16),
  MAX_ROOMS: int(1).default(20),
  MAX_PLAYERS: int(1).default(4),
  MAX_BOTS: int(0, 128).default(16),
  TICK_STATS_WINDOW: int(30, 100_000).default(300),
  MSG_PER_SEC: int(1).default(10),
  MSG_BURST: int(1).default(20),
  BIN_PER_SEC: int(1).default(60),
  BIN_BURST: int(1).default(120),
  MAX_PAYLOAD: int(64).default(2048),
  BUFFER_LIMIT: int(1024).default(64 * 1024),
  HEARTBEAT_MS: int(50).default(15000),
  JOIN_TIMEOUT_MS: int(50).default(5000),
  SHUTDOWN_TIMEOUT_MS: int(500).default(9000),
});

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly logDir: string;
  readonly logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  readonly staticDir: string;
  readonly appVersion: string;
  readonly debugRoutes: boolean;
  readonly seedRooms: boolean;
  readonly snapshotCodec: "binary" | "json";
  readonly allowedOrigins: readonly string[];
  readonly maxConnectionsPerIp: number;
  readonly maxRooms: number;
  readonly maxPlayersPerRoom: number;
  readonly maxBotsPerRoom: number;
  readonly tickStatsWindow: number;
  readonly msgPerSec: number;
  readonly msgBurst: number;
  readonly binPerSec: number;
  readonly binBurst: number;
  readonly maxPayload: number;
  readonly bufferLimit: number;
  readonly heartbeatMs: number;
  readonly joinTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
}

export type EnvVars = Readonly<Record<string, string | undefined>>;

export function loadConfig(overrides: EnvVars = {}): ServerConfig {
  const merged = { ...process.env, ...overrides };
  const env = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined && value !== ""));
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    host: e.HOST,
    logDir: path.resolve(e.LOG_DIR),
    logLevel: e.LOG_LEVEL,
    staticDir: path.resolve(e.STATIC_DIR),
    appVersion: e.APP_VERSION,
    debugRoutes: e.DEBUG_ROUTES,
    seedRooms: e.SEED_ROOMS,
    snapshotCodec: e.SNAPSHOT_CODEC,
    allowedOrigins: parseOrigins(e.ALLOWED_ORIGINS),
    maxConnectionsPerIp: e.MAX_CONNECTIONS_PER_IP,
    maxRooms: e.MAX_ROOMS,
    maxPlayersPerRoom: e.MAX_PLAYERS,
    maxBotsPerRoom: e.MAX_BOTS,
    tickStatsWindow: e.TICK_STATS_WINDOW,
    msgPerSec: e.MSG_PER_SEC,
    msgBurst: e.MSG_BURST,
    binPerSec: e.BIN_PER_SEC,
    binBurst: e.BIN_BURST,
    maxPayload: e.MAX_PAYLOAD,
    bufferLimit: e.BUFFER_LIMIT,
    heartbeatMs: e.HEARTBEAT_MS,
    joinTimeoutMs: e.JOIN_TIMEOUT_MS,
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
  };
}

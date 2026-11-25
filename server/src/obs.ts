import process from "node:process";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export interface LogFields {
  readonly roomId?: string;
  readonly playerId?: string;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  fatal(msg: string, fields?: LogFields): void;
}

export function createLogger(minLevel: LogLevel = "info", service = "dogfight-server"): Logger {
  const threshold = LEVEL_RANK[minLevel];
  function emit(level: LogLevel, msg: string, fields: LogFields = {}): void {
    if (LEVEL_RANK[level] < threshold) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      service,
      msg,
      ...fields,
    });
    if (level === "error" || level === "fatal") process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }
  return {
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    fatal: (msg, fields) => emit("fatal", msg, fields),
  };
}

export interface RejectionsCounter {
  origin: number;
  ipLimit: number;
  rateLimit: number;
  roomFull: number;
  badMessage: number;
}

export interface Observability {
  readonly rejections: RejectionsCounter;
  recordRejection(reason: keyof RejectionsCounter): void;
  formatPrometheus(params: {
    readonly version: string;
    readonly connections: number;
    readonly rooms: number;
    readonly bytesInPerSec: number;
    readonly bytesOutPerSec: number;
    readonly framesInPerSec: number;
    readonly framesOutPerSec: number;
    readonly tickP99Ms: number;
    readonly elu: number;
  }): string;
}

export function createObservability(): Observability {
  const rejections: RejectionsCounter = {
    origin: 0,
    ipLimit: 0,
    rateLimit: 0,
    roomFull: 0,
    badMessage: 0,
  };
  return {
    rejections,
    recordRejection(reason) {
      rejections[reason] += 1;
    },
    formatPrometheus(p) {
      const mem = process.memoryUsage();
      return [
        `# HELP dogfight_connections_active Active WebSocket connections`,
        `# TYPE dogfight_connections_active gauge`,
        `dogfight_connections_active{version="${p.version}"} ${p.connections}`,
        `# HELP dogfight_rooms_active Active rooms`,
        `# TYPE dogfight_rooms_active gauge`,
        `dogfight_rooms_active ${p.rooms}`,
        `# HELP dogfight_bytes_in_per_sec Incoming bytes per second`,
        `# TYPE dogfight_bytes_in_per_sec gauge`,
        `dogfight_bytes_in_per_sec ${p.bytesInPerSec.toFixed(2)}`,
        `# HELP dogfight_bytes_out_per_sec Outgoing bytes per second`,
        `# TYPE dogfight_bytes_out_per_sec gauge`,
        `dogfight_bytes_out_per_sec ${p.bytesOutPerSec.toFixed(2)}`,
        `# HELP dogfight_frames_in_per_sec Incoming frames per second`,
        `# TYPE dogfight_frames_in_per_sec gauge`,
        `dogfight_frames_in_per_sec ${p.framesInPerSec.toFixed(2)}`,
        `# HELP dogfight_frames_out_per_sec Outgoing frames per second`,
        `# TYPE dogfight_frames_out_per_sec gauge`,
        `dogfight_frames_out_per_sec ${p.framesOutPerSec.toFixed(2)}`,
        `# HELP dogfight_tick_p99_ms Simulation tick p99 in milliseconds`,
        `# TYPE dogfight_tick_p99_ms gauge`,
        `dogfight_tick_p99_ms ${p.tickP99Ms.toFixed(3)}`,
        `# HELP dogfight_event_loop_utilization Event loop utilization ratio`,
        `# TYPE dogfight_event_loop_utilization gauge`,
        `dogfight_event_loop_utilization ${p.elu.toFixed(4)}`,
        `# HELP dogfight_process_rss_bytes Resident set size in bytes`,
        `# TYPE dogfight_process_rss_bytes gauge`,
        `dogfight_process_rss_bytes ${mem.rss}`,
        `# HELP dogfight_rejections_total Rejected WebSocket connections/messages by reason`,
        `# TYPE dogfight_rejections_total counter`,
        `dogfight_rejections_total{reason="origin"} ${rejections.origin}`,
        `dogfight_rejections_total{reason="ip_limit"} ${rejections.ipLimit}`,
        `dogfight_rejections_total{reason="rate_limit"} ${rejections.rateLimit}`,
        `dogfight_rejections_total{reason="room_full"} ${rejections.roomFull}`,
        `dogfight_rejections_total{reason="bad_message"} ${rejections.badMessage}`,
        "",
      ].join("\n");
    },
  };
}

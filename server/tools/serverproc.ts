// Starts the real server in a CHILD process for measurements: the load generator / browser driver must not share the
// server's event loop, or the numbers would measure both. Used by loadtest.ts, profile-match.ts and ../../tools/*.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ServerProc {
  readonly base: string;
  readonly child: ChildProcess;
  stop(): Promise<void>;
}

export interface StartOptions {
  readonly port: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly nodeArgs?: readonly string[]; // e.g. ["--cpu-prof", "--cpu-prof-dir=../perf"]
  readonly quiet?: boolean;
}

export async function startServer({ port, env = {}, nodeArgs = [], quiet = true }: StartOptions): Promise<ServerProc> {
  const child = spawn(process.execPath, [...nodeArgs, "--import", "tsx", "src/index.ts"], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", SEED_ROOMS: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const keep = (chunk: Buffer): void => {
    log += chunk.toString();
    if (!quiet) process.stderr.write(chunk);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  return {
    base,
    child,
    async stop() {
      if (child.exitCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGINT"); // graceful: the server flushes logs and (with --cpu-prof) writes the profile on exit
      await exited;
    },
  };
}

export async function postJson(base: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: unknown = await res.json();
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const CreatedRoom = z.object({ room: z.object({ id: z.string() }) });

export async function createRoom(base: string, name: string, arena: object): Promise<string> {
  return CreatedRoom.parse(await postJson(base, "/api/rooms", { name, arena })).room.id;
}

export const MatchStats = z.object({
  room: z.string(),
  players: z.number(),
  ticks: z.number(),
  overruns: z.number(),
  avgMs: z.number(),
  p50Ms: z.number(),
  p95Ms: z.number(),
  p99Ms: z.number(),
  maxMs: z.number(),
  intervalMs: z.number(),
  jitterMs: z.number(),
});
export const ServerStats = z.object({
  rss: z.number(),
  heapUsed: z.number(),
  elu: z.number(),
  traffic: z.object({ bytesOut: z.number(), bytesIn: z.number(), framesOut: z.number(), framesIn: z.number() }),
  connections: z.number(),
  matches: z.array(MatchStats),
});
export type ServerStats = z.infer<typeof ServerStats>;

export async function getStats(base: string): Promise<ServerStats> {
  return ServerStats.parse(await (await fetch(`${base}/api/stats`)).json());
}

export function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

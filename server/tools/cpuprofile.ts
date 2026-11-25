// Reads V8 .cpuprofile files (node --cpu-prof, or Chrome's Profiler.stop) into "top self time" tables.
// Self time = time the function itself was on top of the stack (Bottom-Up view in DevTools, sorted by Self Time).
import { z } from "zod";

const CallFrame = z.object({ functionName: z.string(), url: z.string(), lineNumber: z.number() });
export type CallFrame = z.infer<typeof CallFrame>;
export const CpuProfile = z.object({
  nodes: z.array(z.object({ id: z.number(), callFrame: CallFrame })),
  samples: z.array(z.number()).optional(),
  timeDeltas: z.array(z.number()).optional(),
  startTime: z.number(),
  endTime: z.number(),
});
export type CpuProfile = z.infer<typeof CpuProfile>;

export const where = (cf: CallFrame): string => {
  const file = cf.url ? cf.url.split("/").pop()?.split("?")[0] : "";
  return `${cf.functionName || "(anonymous)"}${file ? ` ${file}:${cf.lineNumber + 1}` : ""}`;
};

// Start-up work (tsx compiling TypeScript, Node's module loader) is not the game: it is reported as "(startup)".
const STARTUP_URL = /\/tsx\/|node:internal\/(modules|deps\/cjs-module-lexer|bootstrap)/;

export function selfTimes(p: CpuProfile): { total: number; byFn: Map<string, number> } {
  const nodeKey = new Map<number, string>(
    p.nodes.map((n) => [n.id, STARTUP_URL.test(n.callFrame.url) ? "(startup)" : where(n.callFrame)]),
  );
  const byFn = new Map<string, number>();
  const samples = p.samples ?? [];
  const deltas = p.timeDeltas ?? [];
  let total = 0;
  for (let i = 0; i < samples.length; i++) {
    const dt = (deltas[i + 1] ?? 0) / 1000; // ms attributed to sample i
    const key = nodeKey.get(samples[i] ?? -1) ?? "?";
    byFn.set(key, (byFn.get(key) ?? 0) + dt);
    total += dt;
  }
  return { total, byFn };
}

export const topN = (m: ReadonlyMap<string, number>, n: number): [string, number][] =>
  [...m].sort((a, b) => b[1] - a[1]).slice(0, n);

const SKIP = new Set(["(idle)", "(program)", "(root)", "(startup)"]);

// Busy time excludes idle; the table excludes the runtime's bookkeeping entries but KEEPS "(garbage collector)".
export function hotFunctions(
  p: CpuProfile,
  n = 10,
): { busyMs: number; gcMs: number; rows: { fn: string; ms: number; share: number }[] } {
  const { byFn } = selfTimes(p);
  const busyMs = [...byFn].filter(([k]) => k !== "(idle)" && k !== "(startup)").reduce((s, [, v]) => s + v, 0);
  const rows = topN(new Map([...byFn].filter(([k]) => !SKIP.has(k))), n).map(([fn, ms]) => ({
    fn,
    ms: Math.round(ms * 10) / 10,
    share: busyMs ? ms / busyMs : 0,
  }));
  return { busyMs, gcMs: byFn.get("(garbage collector)") ?? 0, rows };
}

// Counters behind the netgraph. Pure data: no DOM.
const HISTORY = 120;

export interface NetStatsData {
  rtt: number;
  rttJitter: number;
  inRate: number;
  outRate: number;
  corrLast: number;
  corrMax: number;
  snapshots: number;
  readonly rttHistory: number[];
  readonly corrHistory: number[];
  readonly simSettings: { latency: number; jitter: number; drop: number };
}
export interface NetStats {
  readonly data: NetStatsData;
  bytesIn(n: number): void;
  bytesOut(n: number): void;
  rtt(ms: number): void;
  snapshot(): void;
  correction(mag: number): void;
  setSim(settings: { latency: number; jitter: number; drop: number }): void;
  frame(nowMs: number): void; // call every frame: turns the byte counters into per-second rates
}

export function createNetStats(): NetStats {
  const s: NetStatsData = {
    rtt: 0,
    rttJitter: 0,
    inRate: 0,
    outRate: 0,
    corrLast: 0,
    corrMax: 0,
    snapshots: 0,
    rttHistory: [],
    corrHistory: [],
    simSettings: { latency: 0, jitter: 0, drop: 0 },
  };
  let inBytes = 0;
  let outBytes = 0;
  let windowStart = 0;
  let corrWindowMax = 0;
  const push = (arr: number[], x: number): void => {
    arr.push(x);
    if (arr.length > HISTORY) arr.shift();
  };

  return {
    data: s,
    bytesIn(n) {
      inBytes += n;
    },
    bytesOut(n) {
      outBytes += n;
    },
    rtt(ms) {
      s.rttJitter += (Math.abs(ms - s.rtt) - s.rttJitter) * 0.2;
      s.rtt = s.rtt === 0 ? ms : s.rtt + (ms - s.rtt) * 0.2;
      push(s.rttHistory, ms);
    },
    snapshot() {
      s.snapshots++;
    },
    correction(mag) {
      s.corrLast = mag;
      corrWindowMax = Math.max(corrWindowMax, mag);
      push(s.corrHistory, mag);
    },
    setSim(settings) {
      Object.assign(s.simSettings, settings);
    },
    frame(nowMs) {
      if (!windowStart) windowStart = nowMs;
      const dt = nowMs - windowStart;
      if (dt < 1000) return;
      s.inRate = (inBytes * 1000) / dt;
      s.outRate = (outBytes * 1000) / dt;
      s.corrMax = corrWindowMax;
      inBytes = outBytes = corrWindowMax = 0;
      windowStart = nowMs;
    },
  };
}

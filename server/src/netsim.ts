import type { NetsimSettings } from "@dogfight/shared/protocol/messages";

// Latency injector. On localhost everything feels perfect, so we make the network worse ON PURPOSE.
//   latency = target ROUND-TRIP time (ms): each direction gets half of it
//   jitter  = random extra delay per message (ms, per direction)
//   drop    = probability of losing a droppable message (inputs and snapshots; control messages are never dropped)
// Delivery stays IN ORDER (like TCP): a message is never delivered before the one sent earlier.
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : 0));

export function parseNetsim(params: URLSearchParams): NetsimSettings {
  return {
    latency: clamp(Number(params.get("lat")), 0, 1000),
    jitter: clamp(Number(params.get("jitter")), 0, 500),
    drop: clamp(Number(params.get("drop")), 0, 0.5),
  };
}

export type Lane = (fn: () => void, opts?: { droppable?: boolean }) => void;
export interface Netsim {
  readonly settings: NetsimSettings;
  set(next: NetsimSettings): void;
  readonly in: Lane; // client -> server
  readonly out: Lane; // server -> client
}

export function createNetsim(initial: Partial<NetsimSettings> = {}, random: () => number = Math.random): Netsim {
  const settings: { -readonly [K in keyof NetsimSettings]: NetsimSettings[K] } = {
    latency: 0,
    jitter: 0,
    drop: 0,
    ...initial,
  };
  const lane = (): Lane => {
    let lastAt = 0;
    return (fn, { droppable = false } = {}) => {
      if (droppable && random() < settings.drop) return;
      const now = performance.now();
      const at = Math.max(lastAt, now + settings.latency / 2 + random() * settings.jitter);
      lastAt = at;
      if (at - now < 1) fn();
      else setTimeout(fn, at - now);
    };
  };
  return {
    settings,
    set(next) {
      Object.assign(settings, next);
    },
    in: lane(),
    out: lane(),
  };
}

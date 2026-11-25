// Dead-peer detection, extracted from ws.ts in Lab 7 so it can be tested with fake timers (no sockets, no waiting).
// Every `intervalMs` each peer is pinged; a peer that missed `maxMissed` pongs in a row is terminated.

export interface HeartbeatPeer {
  ping(): void;
  terminate(): void;
  on(event: "pong", listener: () => void): unknown;
}

export interface Heartbeat<P extends HeartbeatPeer> {
  track(peer: P): void; // call once per new connection
  missed(peer: P): number;
  stop(): void;
}

export function createHeartbeat<P extends HeartbeatPeer>(
  peers: () => Iterable<P>,
  intervalMs: number,
  maxMissed = 2,
): Heartbeat<P> {
  const missed = new WeakMap<P, number>(); // no ad-hoc property on a foreign object; entries die with the socket
  const timer = setInterval(() => {
    for (const peer of peers()) {
      const n = missed.get(peer) ?? 0;
      if (n >= maxMissed) {
        peer.terminate(); // two pongs missed: dead peer (a TCP connection can stay "open" forever without this)
        continue;
      }
      missed.set(peer, n + 1);
      peer.ping();
    }
  }, intervalMs);
  timer.unref?.(); // never keeps the process alive on its own

  return {
    track(peer) {
      missed.set(peer, 0);
      peer.on("pong", () => missed.set(peer, 0));
    },
    missed: (peer) => missed.get(peer) ?? 0,
    stop: () => clearInterval(timer),
  };
}

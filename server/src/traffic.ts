// Server-wide byte/frame counters (what /api/stats and the load test turn into bytes per second).
export interface Traffic {
  bytesOut: number;
  bytesIn: number;
  framesOut: number;
  framesIn: number;
}
export const createTraffic = (): Traffic => ({ bytesOut: 0, bytesIn: 0, framesOut: 0, framesIn: 0 });

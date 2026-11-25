// A read-only window into the running game for automated tests and perf runs (Playwright reads it with
// page.evaluate). Installed only with ?e2e or ?perf in the URL.
import type { PerfReport } from "./perf.ts";

export interface DebugShip {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly me: boolean;
}

export interface DebugApi {
  you(): number | null; // my ship's entity id (from "welcome")
  status(): string; // connection status
  ships(): DebugShip[]; // every ship as currently drawn (remote ones interpolated, mine predicted)
  perfReport(): PerfReport | null; // set when a ?perf=<seconds> recording has finished
  perfMarkdown(): string | null;
}

declare global {
  interface Window {
    __dogfight?: DebugApi;
  }
}

export function installDebugApi(api: DebugApi): void {
  window.__dogfight = api;
}

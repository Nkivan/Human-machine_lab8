import { defineProject } from "vitest/config";

// Client tests cover the PURE modules (netcode, loop, particles, perf stats): no DOM needed, so plain Node.
// The real browser is exercised by Playwright (../e2e).
export default defineProject({
  test: {
    name: "client",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});

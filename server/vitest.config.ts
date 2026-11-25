import { defineProject } from "vitest/config";

// Integration tests start real servers (port 0) and measure tick cadence, so files run one at a time:
// two files competing for the CPU would make the timing assertions flaky.
export default defineProject({
  test: {
    name: "server",
    include: ["test/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});

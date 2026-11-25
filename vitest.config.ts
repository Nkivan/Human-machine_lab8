import { defineConfig } from "vitest/config";

// `npm test` at the root runs every package (Vitest "projects"); `npm test -w shared` runs one.
// Coverage is configured here because it is collected across all projects in one run.
export default defineConfig({
  test: {
    projects: ["shared", "client", "server"],
    coverage: {
      provider: "v8",
      include: ["shared/src/**/*.ts", "client/src/**/*.ts", "server/src/**/*.ts"],
      reporter: ["text-summary", "text", "html", "json-summary"],
      reportsDirectory: "coverage",
      // The lab's bar: the platform-free simulation + protocol package is the part we must be able to trust.
      thresholds: {
        "shared/src/**": { lines: 85, statements: 85, functions: 85, branches: 80 },
      },
    },
  },
});

import { defineConfig, devices } from "@playwright/test";

// End-to-end: the real client (built by Vite), the real server, real browsers.
// Locally you can point Playwright at an installed Chrome: PW_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome
const PORT = 3210;
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    launchOptions: process.env["PW_CHROMIUM_EXECUTABLE"]
      ? { executablePath: process.env["PW_CHROMIUM_EXECUTABLE"] }
      : {},
  },
  webServer: {
    command: "npm run build && npm start",
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
    env: { PORT: String(PORT), HOST: "127.0.0.1", SEED_ROOMS: "1", LOG_DIR: "../perf/e2e-logs" },
  },
});

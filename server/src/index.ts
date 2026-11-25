import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const app = createApp(config);
const { address, port } = await app.listen();
app.logger.info("server.started", { address, port, version: config.appVersion, logDir: config.logDir });

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.logger.info("server.shutting_down", { signal });
  const force = setTimeout(() => {
    app.logger.error("server.shutdown_timeout", { signal });
    process.exit(1);
  }, config.shutdownTimeoutMs);
  force.unref();
  await app.close();
  app.logger.info("server.stopped", { signal });
  process.exit(0);
}

process.on("uncaughtException", (err) => {
  app.logger.fatal("process.uncaught_exception", { err: err.message, stack: err.stack });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  app.logger.fatal("process.unhandled_rejection", {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
  process.exit(1);
});

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

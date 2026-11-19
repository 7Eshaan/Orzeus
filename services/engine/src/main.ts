#!/usr/bin/env node
import { createHandlers } from "./handlers.js";
import { createJsonLogger, describeError } from "./logger.js";
import { serveStdio } from "./stdio.js";
import { ENGINE_VERSION } from "./version.js";

const logger = createJsonLogger((line) => process.stderr.write(line));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    logger.log("info", "shutting down", { signal });
    process.exit(0);
  });
}

process.on("uncaughtException", (error) => {
  logger.log("error", "uncaught exception", describeError(error));
  process.exit(1);
});

logger.log("info", "engine starting", { version: ENGINE_VERSION, pid: process.pid });

await serveStdio({
  input: process.stdin,
  output: process.stdout,
  handlers: createHandlers({
    startedAt: Date.now(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  }),
  logger,
});

logger.log("info", "stdin closed, exiting");

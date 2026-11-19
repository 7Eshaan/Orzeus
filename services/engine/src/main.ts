#!/usr/bin/env node
import { encodeLine } from "@orzeus/protocol";
import { createJsonLogger, describeError } from "./logger.js";
import { defaultDataDir } from "./paths.js";
import { EngineService } from "./service.js";
import { serveStdio } from "./stdio.js";
import { ENGINE_VERSION } from "./version.js";

/**
 * orzeusd: the engine sidecar. JSON-RPC over stdio (responses and notifications on stdout,
 * structured logs on stderr). Configuration comes from the environment the desktop shell sets:
 * ORZEUS_DATA_DIR, ORZEUS_OLLAMA_URL, ORZEUS_ENABLE_CODEX, ORZEUS_PLANNER, ORZEUS_WORKER, and API
 * keys read from the macOS Keychain (ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY).
 */
const logger = createJsonLogger((line) => process.stderr.write(line));
const env = process.env;

const service = new EngineService({
  dataDir: env["ORZEUS_DATA_DIR"] ?? defaultDataDir(),
  logger,
  env,
  info: {
    startedAt: Date.now(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  notify: (method, params) => process.stdout.write(encodeLine({ jsonrpc: "2.0", method, params })),
  enableCodex: env["ORZEUS_ENABLE_CODEX"] === "1",
  ...(env["ORZEUS_OLLAMA_URL"] ? { ollamaUrl: env["ORZEUS_OLLAMA_URL"] } : {}),
  ...(env["ORZEUS_PLANNER"] ? { planner: env["ORZEUS_PLANNER"] } : {}),
  ...(env["ORZEUS_WORKER"] ? { worker: env["ORZEUS_WORKER"] } : {}),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    logger.log("info", "shutting down", { signal });
    service.close();
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
  handlers: service.handlers(),
  logger,
});
service.close();
logger.log("info", "stdin closed, exiting");

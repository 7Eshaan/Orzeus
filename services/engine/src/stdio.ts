import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { handleRpcLine, type RpcHandlers } from "@orzeus/protocol";
import { describeError, type Logger } from "./logger.js";

export interface StdioServerOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly handlers: RpcHandlers;
  readonly logger: Logger;
}

/**
 * Serves JSON-RPC over line-delimited streams. Requests are handled concurrently; each response
 * is written as one line. Resolves when the input ends and all in-flight requests finish.
 */
export async function serveStdio(options: StdioServerOptions): Promise<void> {
  const { input, output, handlers, logger } = options;
  const inFlight = new Set<Promise<void>>();
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const line of lines) {
    const task = handleRpcLine(handlers, line, {
      onInternalError: (method, error) =>
        logger.log("error", "handler failed", { method, ...describeError(error) }),
    }).then((reply) => {
      if (reply !== null) output.write(reply);
    });
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  }

  await Promise.all(inFlight);
}

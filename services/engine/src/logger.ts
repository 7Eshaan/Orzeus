export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  log(level: LogLevel, message: string, fields?: Readonly<Record<string, unknown>>): void;
}

/**
 * Structured JSON logs, one object per line. Written to stderr because stdout carries the RPC
 * stream and must never contain anything else.
 */
export function createJsonLogger(
  write: (line: string) => void,
  now: () => number = Date.now,
): Logger {
  return {
    log(level, message, fields = {}) {
      write(`${JSON.stringify({ ts: now(), level, msg: message, ...fields })}\n`);
    },
  };
}

export function describeError(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { error: error.message, errorName: error.name, stack: error.stack }
    : { error: String(error) };
}

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
  redact: (text: string) => string = (t) => t,
): Logger {
  return {
    log(level, message, fields = {}) {
      write(`${redact(JSON.stringify({ ts: now(), level, msg: message, ...fields }))}\n`);
    },
  };
}

/** Environment variables that hold secrets Orzeus knows about (API keys, MCP server secrets). */
export function secretValues(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(env)
    .filter(
      ([key]) =>
        /_API_KEY$/.test(key) || key.startsWith("ORZEUS_MCP_SECRET_") || /_TOKEN$/.test(key),
    )
    .flatMap(([, value]) => (value ? [value] : []));
}

export function describeError(error: unknown): Record<string, unknown> {
  return error instanceof Error
    ? { error: error.message, errorName: error.name, stack: error.stack }
    : { error: String(error) };
}

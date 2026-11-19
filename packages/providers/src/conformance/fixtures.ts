import { appendFileSync, readFileSync } from "node:fs";

/** One recorded HTTP exchange. */
export interface HttpExchange {
  readonly method: string;
  readonly path: string;
  readonly requestBody: unknown;
  readonly status: number;
  readonly responseBody: unknown;
  /** Headers worth replaying (rate limits); recordings keep only those. */
  readonly responseHeaders?: Readonly<Record<string, string>>;
}

/** Wraps fetch to append every exchange to a JSONL fixture file. */
export function recordingFetch(real: typeof fetch, file: string): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const response = await real(input, init);
    const text = await response.text();
    const exchange: HttpExchange = {
      method: init?.method ?? "GET",
      path: url.pathname.replace(/^\/v1/, ""),
      requestBody: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      status: response.status,
      responseBody: text === "" ? null : JSON.parse(text),
    };
    appendFileSync(file, `${JSON.stringify(exchange)}\n`);
    return new Response(text, { status: response.status, headers: response.headers });
  };
}

export function readJsonl<T>(file: string): T[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

/**
 * Replays recorded exchanges in order, checking that each request matches what was recorded.
 * With `hang`, requests never answer until aborted (for cancellation tests).
 */
export function replayFetch(
  exchanges: readonly HttpExchange[],
  options: { readonly hang?: boolean } = {},
): typeof fetch {
  let index = 0;
  return async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (options.hang) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    }
    const path = url.pathname.replace(/^\/v1/, "");
    const method = init?.method ?? "GET";
    const exchange = exchanges.slice(index).find((e) => e.method === method && e.path === path);
    if (exchange === undefined) throw new Error(`no recorded exchange left for ${method} ${path}`);
    index = exchanges.indexOf(exchange) + 1;
    return new Response(
      exchange.responseBody === null ? "" : JSON.stringify(exchange.responseBody),
      {
        status: exchange.status,
        headers: { "content-type": "application/json", ...exchange.responseHeaders },
      },
    );
  };
}

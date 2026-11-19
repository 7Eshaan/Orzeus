import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AccountContext } from "../../adapter.js";
import { type HttpExchange, readJsonl, replayFetch } from "../../conformance/fixtures.js";
import { helloRequest } from "../../conformance/request.js";
import { describeConformance, drain } from "../../conformance/suite.js";
import { costOf, OPENAI_PRICES, pricesFor } from "../../pricing.js";
import { parseResetDuration, quotaFromOpenAiHeaders } from "../../quota.js";
import { OpenAiApiAdapter } from "./adapter.js";

const ACCOUNT: AccountContext = {
  accountId: "openai" as never,
  label: "OpenAI API",
  auth: { kind: "api_key", secretName: "openai", envVar: "OPENAI_API_KEY" },
  getSecret: async () => "sk-test",
};

/**
 * The OpenAI API speaks the same Chat Completions protocol as the local endpoint, so the session
 * replays the local recording (only method and path are matched), with rate-limit headers added
 * in the documented format.
 */
const HEADERS = {
  "x-ratelimit-limit-requests": "500",
  "x-ratelimit-remaining-requests": "499",
  "x-ratelimit-reset-requests": "120ms",
  "x-ratelimit-limit-tokens": "200000",
  "x-ratelimit-remaining-tokens": "30000",
  "x-ratelimit-reset-tokens": "6m0s",
};
const exchanges = () =>
  readJsonl<HttpExchange>(
    new URL("../../../fixtures/openai-compatible/greet.jsonl", import.meta.url).pathname,
  ).map((e) => ({ ...e, responseHeaders: HEADERS }));

describeConformance("openai-api", new URL(".", import.meta.url).pathname, async () => ({
  adapter: new OpenAiApiAdapter({ fetch: replayFetch(exchanges()) }),
  account: ACCOUNT,
  request: async () => helloRequest("gpt-6-luna", { prompt: "Create src/greet.js" }),
  hanging: async () => ({
    adapter: new OpenAiApiAdapter({ fetch: replayFetch([], { hang: true }) }),
    request: helloRequest("gpt-6-luna"),
    account: ACCOUNT,
  }),
}));

describe("openai-api", () => {
  it("costs every call, reports quota from headers, and never sends a temperature", async () => {
    const seen: Record<string, unknown>[] = [];
    const replay = replayFetch(exchanges());
    const adapter = new OpenAiApiAdapter({
      fetch: async (input, init) => {
        if (init?.body) seen.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-test");
        return replay(input, init);
      },
    });
    const request = helloRequest("gpt-6-luna");
    const { events, outcome } = await drain(adapter, request, ACCOUNT);
    expect(existsSync(join(request.worktree.path, "src/greet.js"))).toBe(true);
    expect(seen.every((b) => !("temperature" in b))).toBe(true);
    const quota = events.find((e) => e.type === "quota");
    expect(quota).toMatchObject({
      windows: [
        { window: "tokens/min", usedPercent: 85, status: "warning", source: "response_headers" },
        { window: "requests/min", usedPercent: 0.2, status: "ok" },
      ],
    });
    const expected = events
      .filter((e) => e.type === "usage")
      .reduce((sum, e) => sum + (e.type === "usage" ? (e.costMicroUsd ?? 0) : 0), 0);
    expect(expected).toBeGreaterThan(0);
    expect(outcome.costMicroUsd).toBe(expected);
  });

  it("uses max_completion_tokens for structured output", async () => {
    let body: Record<string, unknown> = {};
    const adapter = new OpenAiApiAdapter({
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: '{"ok":true}' } }],
            usage: { prompt_tokens: 1000, completion_tokens: 10 },
          }),
          { status: 200, headers: HEADERS },
        );
      },
    });
    const Ok = z.object({ ok: z.boolean() });
    const result = await adapter.generate(
      {
        model: "gpt-6.1-sol",
        system: "s",
        prompt: "p",
        maxOutputTokens: 500,
        output: { name: "ok", jsonSchema: z.toJSONSchema(Ok), parse: (v) => Ok.parse(v) },
      },
      ACCOUNT,
      AbortSignal.timeout(5_000),
    );
    expect(body["max_completion_tokens"]).toBe(500);
    expect(body).not.toHaveProperty("max_tokens");
    expect(result.costMicroUsd).toBe(2_100); // 1000 × $2 + 10 × $10 per million
    expect(result.quota).toHaveLength(2);
  });
});

describe("prices and rate-limit parsing", () => {
  it("reads OpenAI reset durations", () => {
    expect(parseResetDuration("6m0s")).toBe(360_000);
    expect(parseResetDuration("1h2m3.5s")).toBe(3_723_500);
    expect(parseResetDuration("120ms")).toBe(120);
    expect(parseResetDuration("2")).toBe(2_000);
    expect(parseResetDuration("soon")).toBeNull();
  });

  it("ignores missing headers and finds dated snapshots", () => {
    expect(quotaFromOpenAiHeaders("a" as never, new Headers(), 0)).toEqual([]);
    expect(pricesFor(OPENAI_PRICES, "gpt-6-luna-2026-09-01")).toEqual(OPENAI_PRICES["gpt-6-luna"]);
    expect(pricesFor(OPENAI_PRICES, "unknown-model")).toBeNull();
    expect(
      costOf(OPENAI_PRICES["gpt-6-luna"] ?? null, {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      }),
    ).toBe(610_000);
  });
});

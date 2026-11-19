import { PlanDraft } from "@orzeus/schema";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AccountContext } from "../adapter.js";
import { describeManifestChecks } from "../conformance/suite.js";
import { type OutputSchema, StructuredOutputError, toStrictJsonSchema } from "../structured.js";
import { AnthropicApiAdapter } from "./anthropic-api/adapter.js";
import { GeminiApiAdapter } from "./gemini-api/adapter.js";
import { OpenAiCompatibleAdapter } from "./openai-compatible/adapter.js";

const Answer = z.object({ answer: z.string().min(1), confidence: z.number().min(0).max(1) });
const output: OutputSchema<z.infer<typeof Answer>> = {
  name: "answer",
  jsonSchema: z.toJSONSchema(Answer) as Record<string, unknown>,
  parse: (v) => Answer.parse(v),
};
const keyed = (secretName: string): AccountContext => ({
  accountId: "test" as never,
  label: "test",
  auth: { kind: "api_key", secretName, envVar: "X" },
  getSecret: async () => "sk-test",
});

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fetch that answers every call with `respond` and records requests. Responses mirror the providers' documented shapes. */
function fakeFetch(
  respond: (url: string) => { status: number; body: unknown; headers?: Record<string, string> },
  seen: Captured[] = [],
): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    seen.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    const r = respond(url);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json", ...r.headers },
    });
  };
}

const request = {
  model: "m",
  system: "Be precise.",
  prompt: "Answer.",
  output,
  maxOutputTokens: 512,
};

describe("toStrictJsonSchema", () => {
  it("removes keywords strict modes reject and closes every object", () => {
    const strict = JSON.stringify(toStrictJsonSchema(z.toJSONSchema(PlanDraft)));
    for (const keyword of [
      "minimum",
      "maxLength",
      "minItems",
      "pattern",
      '"not"',
      "$schema",
      "oneOf",
    ])
      expect(strict).not.toContain(keyword);
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (record["type"] === "object") expect(record["additionalProperties"]).toBe(false);
      for (const value of Object.values(record)) walk(value);
    };
    walk(JSON.parse(strict));
  });
});

describe("anthropic-api generate (fixtures authored from the Messages API docs)", () => {
  describeManifestChecks(
    async () => new AnthropicApiAdapter(),
    new URL("./anthropic-api/", import.meta.url).pathname,
  );

  it("sends output_config.format with a strict schema and parses the text block", async () => {
    const seen: Captured[] = [];
    const adapter = new AnthropicApiAdapter({
      fetch: fakeFetch(
        () => ({
          status: 200,
          headers: {
            "anthropic-ratelimit-tokens-limit": "100000",
            "anthropic-ratelimit-tokens-remaining": "15000",
            "anthropic-ratelimit-tokens-reset": "2026-11-19T10:00:00Z",
          },
          body: {
            content: [{ type: "text", text: '{"answer":"42","confidence":0.9}' }],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 120,
              output_tokens: 15,
              cache_read_input_tokens: 30,
              cache_creation_input_tokens: 0,
            },
          },
        }),
        seen,
      ),
    });
    const result = await adapter.generate(request, keyed("anthropic"), AbortSignal.timeout(5_000));
    expect(result.value).toEqual({ answer: "42", confidence: 0.9 });
    expect(result.usage).toMatchObject({ inputTokens: 120, outputTokens: 15, cacheReadTokens: 30 });
    expect(result.quota[0]).toMatchObject({
      window: "tokens/min",
      usedPercent: 85,
      status: "warning",
      source: "response_headers",
    });
    expect(seen[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen[0]?.headers).toMatchObject({
      "x-api-key": "sk-test",
      "anthropic-version": "2026-10-21",
      "user-agent": "orzeus/0.0.0",
    });
    expect(seen[0]?.body).toMatchObject({
      system: "Be precise.",
      output_config: { format: { type: "json_schema" } },
    });
  });

  it("reports truncated or invalid output as a structured-output error", async () => {
    const truncated = new AnthropicApiAdapter({
      fetch: fakeFetch(() => ({
        status: 200,
        body: { content: [{ type: "text", text: '{"answer":' }], stop_reason: "max_tokens" },
      })),
    });
    await expect(
      truncated.generate(request, keyed("anthropic"), AbortSignal.timeout(5_000)),
    ).rejects.toThrow(StructuredOutputError);
    const wrong = new AnthropicApiAdapter({
      fetch: fakeFetch(() => ({
        status: 200,
        body: { content: [{ type: "text", text: '{"answer":"","confidence":3}' }] },
      })),
    });
    await expect(
      wrong.generate(request, keyed("anthropic"), AbortSignal.timeout(5_000)),
    ).rejects.toThrow(StructuredOutputError);
  });

  it("probes with the key and distinguishes a rejected key", async () => {
    const adapter = new AnthropicApiAdapter({
      fetch: fakeFetch(() => ({ status: 401, body: { error: "bad key" } })),
    });
    expect(await adapter.probe(keyed("anthropic"), AbortSignal.timeout(5_000))).toMatchObject({
      ok: false,
      reason: "unauthenticated",
    });
  });
});

describe("gemini-api generate (fixtures authored from the generateContent docs)", () => {
  describeManifestChecks(
    async () => new GeminiApiAdapter(),
    new URL("./gemini-api/", import.meta.url).pathname,
  );

  it("sends responseJsonSchema and skips thought parts", async () => {
    const seen: Captured[] = [];
    const adapter = new GeminiApiAdapter({
      fetch: fakeFetch(
        () => ({
          status: 200,
          body: {
            candidates: [
              {
                content: {
                  parts: [
                    { text: "thinking…", thought: true },
                    { text: '{"answer":"yes","confidence":0.5}' },
                  ],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: {
              promptTokenCount: 200,
              candidatesTokenCount: 20,
              cachedContentTokenCount: 50,
              thoughtsTokenCount: 7,
            },
          },
        }),
        seen,
      ),
    });
    const result = await adapter.generate(
      { ...request, model: "gemini-pro" },
      keyed("gemini"),
      AbortSignal.timeout(5_000),
    );
    expect(result.value).toEqual({ answer: "yes", confidence: 0.5 });
    expect(result.usage).toEqual({
      inputTokens: 150,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
      reasoningTokens: 7,
    });
    expect(seen[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
    );
    expect(seen[0]?.headers["x-goog-api-key"]).toBe("sk-test");
    expect(seen[0]?.body).toMatchObject({
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 512 },
    });
  });
});

describe("openai-compatible generate", () => {
  it("uses response_format json_schema and parses fenced JSON too", async () => {
    const seen: Captured[] = [];
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: "http://local.invalid/v1",
      fetch: fakeFetch(
        () => ({
          status: 200,
          body: {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: '```json\n{"answer":"ok","confidence":1}\n```',
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          },
        }),
        seen,
      ),
    });
    const result = await adapter.generate(
      request,
      { accountId: "l" as never, label: "l", auth: { kind: "none" }, getSecret: async () => "" },
      AbortSignal.timeout(5_000),
    );
    expect(result.value.answer).toBe("ok");
    expect(seen[0]?.body).toMatchObject({
      response_format: { type: "json_schema", json_schema: { name: "answer", strict: true } },
      temperature: 0,
    });
  });
});

describe("openai-compatible generate fallback", () => {
  it("falls back to a forced tool call when the runtime cannot constrain output", async () => {
    const seen: Captured[] = [];
    let call = 0;
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: "http://local.invalid/v1",
      fetch: fakeFetch(() => {
        call++;
        if (call === 1)
          return { status: 501, body: { error: { message: "structured output is unavailable" } } };
        return {
          status: 200,
          body: {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "c1",
                      type: "function",
                      function: {
                        name: "submit_answer",
                        arguments: '{"answer":"via tool","confidence":0.4}',
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 8 },
          },
        };
      }, seen),
    });
    const result = await adapter.generate(
      request,
      { accountId: "l" as never, label: "l", auth: { kind: "none" }, getSecret: async () => "" },
      AbortSignal.timeout(5_000),
    );
    expect(result.value).toEqual({ answer: "via tool", confidence: 0.4 });
    expect(seen[1]?.body).toMatchObject({
      tool_choice: { type: "function", function: { name: "submit_answer" } },
    });
  });
});

describe("lenient parsing", () => {
  it("strips comments and trailing commas but not inside strings", async () => {
    const { stripJsonNoise } = await import("../structured.js");
    expect(JSON.parse(stripJsonNoise('{"a": "x // y", // note\n "b": [1, 2,], /* c */ }'))).toEqual(
      { a: "x // y", b: [1, 2] },
    );
  });

  it("wraps lone objects in arrays and fills missing nullable fields, then still validates", async () => {
    const { coerceToSchema, parseJsonOutput } = await import("../structured.js");
    const Shape = z.object({
      items: z.array(z.object({ name: z.string(), note: z.string().nullable() })),
    });
    const out = {
      name: "shape",
      jsonSchema: z.toJSONSchema(Shape) as Record<string, unknown>,
      parse: (v: unknown) => Shape.parse(v),
    };
    expect(coerceToSchema({ items: { name: "a" } }, out.jsonSchema)).toEqual({
      items: [{ name: "a", note: null }],
    });
    expect(parseJsonOutput('{"items": {"name": "a"}} ', out)).toEqual({
      items: [{ name: "a", note: null }],
    });
    expect(() => parseJsonOutput('{"items": {"note": "no name"}}', out)).toThrow(
      StructuredOutputError,
    );
  });
});

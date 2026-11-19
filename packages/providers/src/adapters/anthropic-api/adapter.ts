import type { AccountId, QuotaWindow, TokenUsage } from "@orzeus/schema";
import type {
  AccountContext,
  AdapterManifest,
  ModelInfo,
  ProbeResult,
  ProviderAdapter,
} from "../../adapter.js";
import { apiKeyOf, HttpStatusError, readJson, USER_AGENT } from "../../http.js";
import {
  type GenerateRequest,
  type GenerateResult,
  parseJsonOutput,
  StructuredOutputError,
  toStrictJsonSchema,
} from "../../structured.js";

export interface AnthropicApiConfig {
  readonly baseUrl?: string;
  /** anthropic-version header; the structured-outputs docs use 2026-10-21. */
  readonly apiVersion?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export const ANTHROPIC_API_MANIFEST: AdapterManifest = {
  id: "anthropic-api",
  provider: "anthropic",
  displayName: "Anthropic API",
  transport: "http_api",
  auth: [{ kind: "api_key", secretName: "anthropic", envVar: "ANTHROPIC_API_KEY" }],
  capabilities: {
    structuredOutput: true,
    agentSession: false,
    mcpClient: false,
    resume: false,
    steerMidTurn: false,
    approvalCallbacks: false,
    reportsUsage: "exact",
    reportsQuota: false,
  },
  compliance: {
    officialInterface: "https://platform.claude.com/docs/en/build-with-claude/structured-outputs",
    readsForeignCredentials: false,
    rotatesAccounts: false,
    spoofsClient: false,
    notes:
      "API key only. Used for planning, steering and review; worker sessions arrive in Phase 6.",
  },
};

interface MessagesResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** Rate-limit response headers → quota windows (per-minute token budget). */
export function quotaFromHeaders(
  accountId: AccountId,
  headers: Headers,
  now: number,
): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  for (const bucket of ["tokens", "requests"]) {
    const limit = Number(headers.get(`anthropic-ratelimit-${bucket}-limit`));
    const remaining = Number(headers.get(`anthropic-ratelimit-${bucket}-remaining`));
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) continue;
    const used = Math.min(100, Math.max(0, ((limit - remaining) / limit) * 100));
    const reset = headers.get(`anthropic-ratelimit-${bucket}-reset`);
    windows.push({
      accountId,
      window: `${bucket}/min`,
      usedPercent: Math.round(used * 10) / 10,
      resetsAt: reset === null ? null : Date.parse(reset) || null,
      status: used >= 100 ? "limited" : used >= 80 ? "warning" : "ok",
      source: "response_headers",
      observedAt: now,
    });
  }
  return windows;
}

/** Planner/reviewer adapter over the Messages API with JSON-schema structured outputs. */
export class AnthropicApiAdapter implements ProviderAdapter {
  readonly manifest: AdapterManifest = ANTHROPIC_API_MANIFEST;
  readonly #config: AnthropicApiConfig;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(config: AnthropicApiConfig = {}) {
    this.#config = config;
    this.#fetch = config.fetch ?? fetch;
    this.#now = config.now ?? Date.now;
  }

  async #call(
    method: string,
    path: string,
    account: AccountContext,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<Response> {
    const key = await apiKeyOf(account);
    if (key === null) throw new Error("the Anthropic API needs an API key account");
    return this.#fetch(`${this.#config.baseUrl ?? "https://api.anthropic.com"}${path}`, {
      method,
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": this.#config.apiVersion ?? "2026-10-21",
        "user-agent": USER_AGENT,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async probe(account: AccountContext, signal: AbortSignal): Promise<ProbeResult> {
    try {
      const response = await this.#call("GET", "/v1/models", account, signal);
      if (response.status === 401 || response.status === 403)
        return { ok: false, reason: "unauthenticated", detail: `HTTP ${response.status}` };
      if (!response.ok)
        return { ok: false, reason: "unreachable", detail: `HTTP ${response.status}` };
      return { ok: true, version: "messages-api", detail: "API key accepted" };
    } catch (error) {
      return {
        ok: false,
        reason: "unreachable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listModels(account: AccountContext, signal: AbortSignal): Promise<readonly ModelInfo[]> {
    const body = (await readJson(await this.#call("GET", "/v1/models", account, signal))) as {
      data?: { id: string }[];
    };
    return (body.data ?? []).map((m) => ({
      model: m.id,
      suggestedTier: "frontier",
      contextWindow: null,
      pricing: null,
    }));
  }

  async generate<T>(
    request: GenerateRequest<T>,
    account: AccountContext,
    signal: AbortSignal,
  ): Promise<GenerateResult<T>> {
    const started = this.#now();
    const response = await this.#call("POST", "/v1/messages", account, signal, {
      model: request.model,
      max_tokens: request.maxOutputTokens,
      system: request.system,
      messages: [{ role: "user", content: request.prompt }],
      output_config: {
        format: { type: "json_schema", schema: toStrictJsonSchema(request.output.jsonSchema) },
      },
    });
    const body = (await readJson(response)) as MessagesResponse;
    if (!response.ok) throw new HttpStatusError(response.status, body);
    const text = (body.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    if (body.stop_reason === "max_tokens")
      throw new StructuredOutputError(`${request.output.name}: output hit max_tokens`, text);
    const u = body.usage ?? {};
    const usage: TokenUsage = {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      reasoningTokens: 0,
    };
    return {
      value: parseJsonOutput(text, request.output),
      usage,
      costMicroUsd: null,
      quota: quotaFromHeaders(account.accountId, response.headers, this.#now()),
      latencyMs: this.#now() - started,
    };
  }
}

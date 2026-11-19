import type { TokenUsage } from "@orzeus/schema";
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

export interface GeminiApiConfig {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export const GEMINI_API_MANIFEST: AdapterManifest = {
  id: "gemini-api",
  provider: "google",
  displayName: "Gemini API (AI Studio key)",
  transport: "http_api",
  auth: [{ kind: "api_key", secretName: "gemini", envVar: "GEMINI_API_KEY" }],
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
    officialInterface: "https://ai.google.dev/gemini-api/docs/structured-output",
    readsForeignCredentials: false,
    rotatesAccounts: false,
    spoofsClient: false,
    notes: "API key only. Never wraps Gemini CLI or Antigravity personal OAuth (Google ToS).",
  },
};

interface GenerateContentResponse {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

/** Planner/reviewer adapter over generateContent with responseJsonSchema. */
export class GeminiApiAdapter implements ProviderAdapter {
  readonly manifest: AdapterManifest = GEMINI_API_MANIFEST;
  readonly #config: GeminiApiConfig;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(config: GeminiApiConfig = {}) {
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
    if (key === null) throw new Error("the Gemini API needs an API key account");
    return this.#fetch(
      `${this.#config.baseUrl ?? "https://generativelanguage.googleapis.com"}${path}`,
      {
        method,
        signal,
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": key,
          "user-agent": USER_AGENT,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
  }

  async probe(account: AccountContext, signal: AbortSignal): Promise<ProbeResult> {
    try {
      const response = await this.#call("GET", "/v1beta/models", account, signal);
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        return { ok: false, reason: "unauthenticated", detail: `HTTP ${response.status}` };
      }
      if (!response.ok)
        return { ok: false, reason: "unreachable", detail: `HTTP ${response.status}` };
      return { ok: true, version: "v1beta", detail: "API key accepted" };
    } catch (error) {
      return {
        ok: false,
        reason: "unreachable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listModels(account: AccountContext, signal: AbortSignal): Promise<readonly ModelInfo[]> {
    const body = (await readJson(await this.#call("GET", "/v1beta/models", account, signal))) as {
      models?: { name: string }[];
    };
    return (body.models ?? []).map((m) => ({
      model: m.name.replace(/^models\//, ""),
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
    const response = await this.#call(
      "POST",
      `/v1beta/models/${encodeURIComponent(request.model)}:generateContent`,
      account,
      signal,
      {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: "user", parts: [{ text: request.prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: toStrictJsonSchema(request.output.jsonSchema),
          maxOutputTokens: request.maxOutputTokens,
        },
      },
    );
    const body = (await readJson(response)) as GenerateContentResponse;
    if (!response.ok) throw new HttpStatusError(response.status, body);
    const candidate = body.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => p.thought !== true)
      .map((p) => p.text ?? "")
      .join("");
    if (candidate?.finishReason === "MAX_TOKENS")
      throw new StructuredOutputError(`${request.output.name}: output hit maxOutputTokens`, text);
    const u = body.usageMetadata ?? {};
    const cached = u.cachedContentTokenCount ?? 0;
    const usage: TokenUsage = {
      inputTokens: Math.max(0, (u.promptTokenCount ?? 0) - cached),
      outputTokens: u.candidatesTokenCount ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
      reasoningTokens: u.thoughtsTokenCount ?? 0,
    };
    return {
      value: parseJsonOutput(text, request.output),
      usage,
      costMicroUsd: null,
      quota: [],
      latencyMs: this.#now() - started,
    };
  }
}

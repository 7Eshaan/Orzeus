import type { AdapterManifest } from "../../adapter.js";
import { OPENAI_PRICES } from "../../pricing.js";
import { quotaFromOpenAiHeaders } from "../../quota.js";
import { OpenAiCompatibleAdapter } from "../openai-compatible/adapter.js";

export const OPENAI_API_MANIFEST: AdapterManifest = {
  id: "openai-api",
  provider: "openai",
  displayName: "OpenAI API",
  transport: "http_api",
  auth: [{ kind: "api_key", secretName: "openai", envVar: "OPENAI_API_KEY" }],
  capabilities: {
    structuredOutput: true,
    agentSession: true,
    mcpClient: true,
    resume: false,
    steerMidTurn: true,
    approvalCallbacks: true,
    reportsUsage: "exact",
    reportsQuota: false,
  },
  compliance: {
    officialInterface: "https://developers.openai.com/api/reference/chat/create",
    readsForeignCredentials: false,
    rotatesAccounts: false,
    spoofsClient: false,
    notes:
      "Your own OpenAI API key. Orzeus runs its own tool loop over Chat Completions; every write is an approval request. Rate-limit headers become quota windows and calls are costed from the published prices.",
  },
};

export interface OpenAiApiConfig {
  /** Default https://api.openai.com/v1. */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly requestTimeoutMs?: number;
  readonly reasoningEffort?: "none" | "low" | "medium" | "high";
}

/**
 * The hosted OpenAI API: the same Chat Completions loop as local endpoints, plus pricing, quota
 * from `x-ratelimit-*` headers, and the parameters current reasoning models expect.
 */
export class OpenAiApiAdapter extends OpenAiCompatibleAdapter {
  constructor(config: OpenAiApiConfig = {}) {
    super({
      baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
      ...(config.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: config.requestTimeoutMs }),
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
      manifest: OPENAI_API_MANIFEST,
      prices: OPENAI_PRICES,
      quotaFromHeaders: quotaFromOpenAiHeaders,
      sendTemperature: false,
      maxTokensField: "max_completion_tokens",
      suggestedTier: "worker",
    });
  }
}

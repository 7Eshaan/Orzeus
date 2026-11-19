/**
 * @orzeus/providers
 *
 * The ProviderAdapter contract and official-interface adapters. See
 * docs/architecture/04-providers.md for the compliance rules every adapter follows.
 */
export type * from "./adapter.js";
export {
  AcpAdapter,
  type AcpConfig,
  acpAction,
  acpManifest,
} from "./adapters/acp/adapter.js";
export {
  ANTHROPIC_API_MANIFEST,
  AnthropicApiAdapter,
  type AnthropicApiConfig,
  quotaFromHeaders,
} from "./adapters/anthropic-api/adapter.js";
export {
  actionFor as claudeToolAction,
  CLAUDE_AGENT_SDK_MANIFEST,
  ClaudeAgentSdkAdapter,
  type ClaudeAgentSdkConfig,
} from "./adapters/claude-agent-sdk/adapter.js";
export {
  CODEX_APP_SERVER_MANIFEST,
  CodexAppServerAdapter,
  type CodexAppServerConfig,
  toQuotaWindows,
} from "./adapters/codex-app-server/adapter.js";
export {
  CODEX_EXEC_MANIFEST,
  CodexExecAdapter,
  type CodexExecConfig,
} from "./adapters/codex-exec/adapter.js";
export {
  CURSOR_CLI_MANIFEST,
  CursorCliAdapter,
  type CursorCliConfig,
} from "./adapters/cursor-cli/adapter.js";
export {
  GEMINI_API_MANIFEST,
  GeminiApiAdapter,
  type GeminiApiConfig,
} from "./adapters/gemini-api/adapter.js";
export {
  OPENAI_API_MANIFEST,
  OpenAiApiAdapter,
  type OpenAiApiConfig,
} from "./adapters/openai-api/adapter.js";
export {
  OPENAI_COMPATIBLE_MANIFEST,
  OpenAiCompatibleAdapter,
  type OpenAiCompatibleConfig,
  SYSTEM_PROMPT,
} from "./adapters/openai-compatible/adapter.js";
export { costOf, OPENAI_PRICES, pricesFor, type TokenPrices } from "./pricing.js";
export {
  type ClaudeRateLimitInfo,
  estimateTokens,
  parseResetDuration,
  quotaFromClaudeRateLimit,
  quotaFromOpenAiHeaders,
} from "./quota.js";
export { AdapterRegistry, type RegisteredAdapter } from "./registry.js";
export { addUsage, EventQueue, SessionController } from "./session.js";
export { shellWords } from "./shell-words.js";
export {
  type GenerateRequest,
  type GenerateResult,
  type OutputSchema,
  parseJsonOutput,
  StructuredOutputError,
  toStrictJsonSchema,
} from "./structured.js";

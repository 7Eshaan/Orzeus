/**
 * @orzeus/providers
 *
 * The ProviderAdapter contract and official-interface adapters. See
 * docs/architecture/04-providers.md for the compliance rules every adapter follows.
 */
export type * from "./adapter.js";
export {
  ANTHROPIC_API_MANIFEST,
  AnthropicApiAdapter,
  type AnthropicApiConfig,
  quotaFromHeaders,
} from "./adapters/anthropic-api/adapter.js";
export {
  CODEX_APP_SERVER_MANIFEST,
  CodexAppServerAdapter,
  type CodexAppServerConfig,
  toQuotaWindows,
} from "./adapters/codex-app-server/adapter.js";
export {
  GEMINI_API_MANIFEST,
  GeminiApiAdapter,
  type GeminiApiConfig,
} from "./adapters/gemini-api/adapter.js";
export {
  OPENAI_COMPATIBLE_MANIFEST,
  OpenAiCompatibleAdapter,
  type OpenAiCompatibleConfig,
  SYSTEM_PROMPT,
} from "./adapters/openai-compatible/adapter.js";
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

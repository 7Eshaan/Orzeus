# Verified versions and specs (checked 2026-11-19)

Everything below was checked online or against the npm registry on 2026-11-19, not
from memory. Re-check before each phase; these move fast.

## Toolchain

| Thing                           | Current                                                  | Notes                                                                                                                                                                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TypeScript                      | **7.0.2** (`typescript@latest`), 7.1 in beta             | Native Go port, shipped stable 2026-07-08. Ships as the normal `typescript` package with the `tsc` entry point (the `tsgo` / `@typescript/native-preview` names were preview-only). Tools that depended on the old JS compiler API may lag, which matters for lint choices (see ADR 0005). |
| Tauri                           | **2.12.6** (crate), CLI 2.12.6, `@tauri-apps/api` 2.12.5 | 2.12.0 shipped 2026-09-26. MSRV is now Rust 1.90.                                                                                                                                                                                                                                          |
| `@tauri-apps/plugin-sql`        | 2.6.0                                                    |                                                                                                                                                                                                                                                                                            |
| `@tauri-apps/plugin-shell`      | 2.6.0                                                    |                                                                                                                                                                                                                                                                                            |
| `@tauri-apps/plugin-stronghold` | 2.4.0                                                    | Tauri maintainers have said Stronghold is no longer recommended and will be removed in v3 (see ADR 0003).                                                                                                                                                                                  |
| Node.js (on Ryu's Mac)          | 26.13.0                                                  | Node 26 is the active LTS line. `node:sqlite` is "1.2 Release candidate" stability.                                                                                                                                                                                                        |
| pnpm                            | 12.21.0 on npm                                           | **Not installed** on the Mac yet.                                                                                                                                                                                                                                                          |
| Rust / cargo                    | n/a                                                      | **Not installed** on the Mac yet; Tauri needs it.                                                                                                                                                                                                                                          |
| Vite / React / Vitest           | 8.3.8 / 19.3.1 / 5.1.1                                   |                                                                                                                                                                                                                                                                                            |
| `@xyflow/react`                 | 13.0.2                                                   | DAG graph view.                                                                                                                                                                                                                                                                            |
| Biome                           | 2.6.8                                                    | Format + lint without depending on the TS compiler API.                                                                                                                                                                                                                                    |
| Zod                             | 4.6.7                                                    | Runtime schemas, JSON Schema export for structured output.                                                                                                                                                                                                                                 |

## Protocols

### MCP, revision 2026-07-28 (current)

Source: <https://modelcontextprotocol.io/specification/2026-07-28/changelog>

What changed that shapes Orzeus:

- **Stateless.** No `initialize` handshake and no `Mcp-Session-Id`. Every request carries
  protocol version and client capabilities in `_meta`
  (`io.modelcontextprotocol/protocolVersion`, `.../clientCapabilities`, `.../clientInfo`).
  Cross-call state must be explicit server-minted handles passed as tool arguments.
- **`server/discover`** is mandatory for servers; clients may call it first to pick a version.
- **`subscriptions/listen`** replaces the HTTP GET stream and `resources/subscribe`.
- **Multi Round-Trip Requests (MRTR):** servers return `resultType: "input_required"` with
  `inputRequests`; the client retries with `inputResponses`. This replaces server-initiated
  `sampling/createMessage`, `elicitation/create`, `roots/list`. Every result has `resultType`.
- **Tasks** moved to the `io.modelcontextprotocol/tasks` extension (poll `tasks/get`).
- **Caching:** list/read results carry `ttlMs` and `cacheScope`; servers SHOULD return tools in
  deterministic order (good for prompt-cache hit rates, which matters to us).
- **OTel:** `traceparent` / `tracestate` / `baggage` in `_meta` are now documented conventions.
- **Streamable HTTP:** `Mcp-Method` and `Mcp-Name` headers required on POST; no SSE resumability
  (a broken stream means re-issuing the request).
- **Auth:** Client ID Metadata Documents preferred; Dynamic Client Registration deprecated;
  clients MUST validate `iss` (RFC 9207) and key stored credentials by issuer.
- **Deprecated:** Roots, Sampling, Logging, HTTP+SSE transport.

TypeScript SDK: **v2** split packages `@modelcontextprotocol/client` and
`@modelcontextprotocol/server` (2.4.0) implement 2026-07-28. The old single
`@modelcontextprotocol/sdk` (1.32.x) is the v1 line; do not use it.

### ACP (Agent Client Protocol)

Sources: <https://agentclientprotocol.com/protocol/v1/overview>,
<https://agentclientprotocol.com/protocol/v2/migration>

- **v1 is the stable target.** JSON-RPC 2.0, agent runs as a subprocess of the client.
  Agent methods: `initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`,
  `session/set_mode`, `logout`; notification `session/cancel`.
  Client methods the agent calls: `session/request_permission`, `fs/read_text_file`,
  `fs/write_text_file`, `terminal/*`, `elicitation/create`; notification `session/update`.
  Because file writes and terminals go through the **client**, Orzeus can enforce its policy
  engine on ACP agents directly.
- **v2 is still draft** (removes client fs/terminal, `session/resume` replaces `session/load`).
  We build on v1 and keep v2 behind an experimental flag.
- SDK: `@agentclientprotocol/sdk` 2.8.0 (v2 router under `.../experimental/v2`).

## Providers (official interfaces only)

### Anthropic

- `@anthropic-ai/claude-agent-sdk` 0.3.328. The docs say "Unless previously approved, Anthropic
  does not allow third party developers to offer claude.ai login or rate limits for their
  products", including agents built on the Agent SDK, and direct you to API key auth.
  Source: <https://code.claude.com/docs/en/agent-sdk/overview>.
  **Consequence:** the Agent SDK adapter is API-key only.
- `claude -p --output-format stream-json` is the documented headless mode. Stream emits a
  `rate_limit_event` whose exact fields vary by CLI version (community reports), so we parse it
  defensively. Not installed on Ryu's Mac right now.
- API: standard `anthropic-ratelimit-*` response headers.

### OpenAI / Codex

- `codex-cli` **0.169.0** is installed on the Mac.
- `codex app-server`: JSON-RPC over newline-delimited stdio (the `"jsonrpc"` field is omitted on
  the wire). Lifecycle `initialize` → `initialized` → `thread/start` | `thread/resume` |
  `thread/fork` → `turn/start`, `turn/steer`, `turn/interrupt`, streamed `item/*`,
  `turn/completed`. Server requests for approvals, e.g. `item/permissions/requestApproval`,
  with decisions `accept`, `acceptForSession`, `decline`, `cancel`.
  **Usage:** `account/rateLimits/read` and the `account/rateLimits/updated` notification give
  `usedPercent`, `windowDurationMins`, `resetsAt` (unix seconds) per bucket. This is the best
  official quota signal of any provider.
  Login supports `apiKey` and ChatGPT. Docs describe app-server as the interface for deep
  integration in your own product. Exact types: `codex app-server generate-ts`.
  Source: <https://learn.chatgpt.com/docs/app-server>.
- `codex exec` (JSONL) for simple one-shot runs.

### Cursor

- Headless print mode: `cursor-agent -p` (some installs alias `agent`), `--output-format
  stream-json`, `--stream-partial-output`, `--force` to apply edits, `--model`.
  Source: <https://cursor.com/docs/cli/headless>. No official quota API found, so Cursor uses
  local accounting plus user soft caps. Not installed on the Mac.

### Google

- Gemini API (AI Studio keys) via `@google/genai` 3.6.1, and Vertex AI / Gemini Enterprise with
  service credentials.
- **Do not** drive Antigravity CLI or Gemini CLI personal OAuth from Orzeus. Google's
  Antigravity terms reportedly name third-party tools using its OAuth as a breach, and there are
  many 2026 reports of account suspensions. Orzeus will not ship such an adapter.

### Local / generic

- Ollama 0.40.14 is installed on the Mac (OpenAI-compatible endpoint).
- Any ACP v1 agent.

## Added in Phase 3 (checked 2026-11-19)

- MCP TypeScript SDK v2 (`@modelcontextprotocol/server` and `client` 2.4.0): `createMcpHandler`
  gives a fetch-style handler (`handler.fetch(request, { authInfo })`) that builds a fresh
  `McpServer` per request; `fromJsonSchema` wraps raw JSON Schemas for `registerTool`;
  `serveStdio` serves stdio servers. The `@modelcontextprotocol/node` adapter (2.1.2) pulls in
  Hono, so Orzeus bridges `node:http` itself.
- Anthropic structured outputs: `output_config.format = { type: "json_schema", schema }`, no beta
  header, `anthropic-version: 2026-10-21` in the docs example; strict schemas reject value
  constraints such as `minimum`, `maxLength` and `oneOf`, and need `additionalProperties: false`.
  Source: <https://platform.claude.com/docs/en/build-with-claude/structured-outputs>.
- Gemini: docs moved to aistudio.google.com and now feature an Interactions API; Orzeus uses
  `models/{model}:generateContent` with `generationConfig.responseJsonSchema` and the
  `x-goog-api-key` header (not yet verified live).
- Codex app-server `turn/start` accepts `outputSchema`; `thread/start` accepts `ephemeral`,
  `sandbox: "read-only"`, `approvalPolicy: "never"` and `developerInstructions`.
- tree-sitter: `web-tree-sitter` 0.27.2 cannot load the old `tree-sitter-wasms` 0.1.x grammars
  (ABI mismatch); the grammar packages' own `.wasm` files work (`tree-sitter-typescript`
  0.23.2, `tree-sitter-javascript` 0.25.0, `tree-sitter-python` 0.25.0). Their native build
  scripts are denied via `allowBuilds` in `pnpm-workspace.yaml`.
- Ollama 0.40 with the MLX runner (lfm3) rejects JSON-schema constrained output (HTTP 501) but
  supports tool calls and `reasoning_effort`.

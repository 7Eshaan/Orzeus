# Providers, compliance and quota telemetry

## Compliance rules (non-negotiable, enforced in code)

1. **Official interfaces only.** Each adapter's manifest links the provider documentation for
   the exact interface it uses (`compliance.officialInterface`).
2. **Never touch another tool's credentials.** Orzeus does not read, copy, refresh or proxy the
   OAuth tokens of `claude`, `codex`, `cursor-agent` or any other CLI. `own_cli_login` means "run
   the user's own signed-in CLI as a subprocess", nothing more. The type
   `readsForeignCredentials: false` and a conformance test (no reads under `~/.claude`,
   `~/.codex`, `~/.cursor` etc. during a recorded session) back this up.
3. **No account rotation.** One enabled CLI login per adapter (a unique index in SQLite). The
   router never switches accounts to dodge a limit; when a window is exhausted it waits, falls
   back to a different tier or provider the user enabled, or asks.
4. **No client spoofing.** Adapters identify honestly (`clientInfo` in MCP is `orzeus`, HTTP
   User-Agent is `orzeus/<version>`), and never forge another product's headers.
5. **Subscription use stays personal.** The `own_cli_login` adapters exist for you running
   your own subscription on your own machine. If Orzeus is ever distributed to other people,
   these adapters ship disabled by default with a clear notice, because Anthropic's Agent SDK
   docs say third-party products may not offer claude.ai login or rate limits without approval.
   (This is a product-safety reading, not legal advice.)

## Adapter matrix

| Adapter id          | Provider                | Auth                                    | Use                                            | Session / steer / approvals                                                      | Usage            | Quota signal                                                                  |
| ------------------- | ----------------------- | --------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------- |
| `anthropic-api`     | Anthropic               | API key                                 | planner, reviewer, worker (built-in tool loop) | n/a                                                                              | exact            | `anthropic-ratelimit-*` headers                                               |
| `claude-agent-sdk`  | Anthropic               | **API key only**                        | worker                                         | resume, `canUseTool` callback, MCP config                                        | exact            | headers via SDK messages                                                      |
| `claude-cli`        | Anthropic               | own CLI login                           | worker, planner                                | `--resume`, stream-json, `--mcp-config`, permission prompt tool routed to Orzeus | exact            | `rate_limit_event` in stream-json (shape varies by version, parsed leniently) |
| `codex-app-server`  | OpenAI                  | API key or own ChatGPT login            | worker, planner                                | `thread/resume`, `turn/steer`, approval server-requests                          | exact            | `account/rateLimits/read` + `account/rateLimits/updated`                      |
| `codex-exec`        | OpenAI                  | same                                    | simple one-shot worker                         | JSONL, no steer                                                                  | exact            | via app-server probe                                                          |
| `openai-api`        | OpenAI                  | API key                                 | planner, reviewer, worker                      | n/a                                                                              | exact            | `x-ratelimit-*` headers                                                       |
| `cursor-cli`        | Cursor                  | own CLI login or Cursor API key         | worker                                         | `-p --output-format stream-json --force`, `--model`                              | estimated        | none known; soft caps                                                         |
| `gemini-api`        | Google                  | AI Studio key or Vertex service account | planner, worker                                | n/a                                                                              | exact            | soft caps + 429 handling                                                      |
| `openai-compatible` | Ollama, LM Studio, vLLM | none / key                              | local worker                                   | n/a                                                                              | exact tokens, $0 | n/a                                                                           |
| `acp`               | any ACP v1 agent        | per agent                               | worker                                         | `session/load`, `session/request_permission`, client-side fs/terminal            | if reported      | if reported                                                                   |

Deliberately absent: any adapter for Antigravity CLI or Gemini CLI personal OAuth.

Note on `claude-cli` and `codex-app-server` approvals: both are launched with their own
sandbox/permission mode set to the strictest useful level for the node (e.g. Codex
`sandbox: "workspace-write"` scoped to the worktree), and every action they want beyond that is
routed back to Orzeus's policy engine, which auto-allows, denies, or queues it for you.

## How work is routed

For a node with tier `T` and ordered `candidates`, the router picks the first candidate whose:

1. adapter is enabled and `probe()` passed recently,
2. account has headroom: latest `QuotaWindow.status` is not `limited`, `usedPercent` is under
   the user's soft cap for that window, and the run/node budget allows the estimated cost,
3. capabilities fit (e.g. `agentSession` for worker nodes, `structuredOutput` for the planner).

If none fits, the node waits in `ready` with a visible reason ("Claude 5h window at 92%, resets
in 41 min"), unless the plan allows a fallback tier.

## Quota and usage telemetry

- **Windows:** each account shows its latest observation per window (`5h`, `7d`, or the
  provider's bucket ids) with used percent, status and a reset countdown. Sources ranked:
  official API (Codex) > CLI event (Claude stream-json) > response headers (APIs) > local
  estimate. The UI labels estimates as estimates.
- **Soft caps:** per account per window, e.g. "stop scheduling new Claude work above 85% of the
  5h window". Crossing one is a `budget.tripped` event; crossing a run-level threshold is a
  human approval gate.
- **Spend:** API usage is costed from `ModelInfo.pricing`; subscription usage records tokens
  with `cost_micro_usd = NULL`.
- **Frontier Quota Saved (estimate):** for every worker `model.call`, Orzeus computes what the
  same tokens would have cost on the run's planner model, `frontier_equiv_micro_usd`. The metric
  shown is
  `saved = Σ frontier_equiv(worker calls) − Σ actual(worker calls)`,
  also shown as a percentage of `Σ frontier_equiv(all calls)`. It is labelled as an
  estimate because a frontier model would not have used identical tokens. For subscription
  plans it is also expressed in window percent, using the frontier account's observed
  tokens-per-percent ratio when there is enough data.

## Adapter conformance suite

Every adapter must pass the shared suite in `packages/providers/src/conformance` against
recorded fixtures (real stream captures from the installed CLI versions, scrubbed):

- maps every event type it claims to support into `AdapterEvent`, with no unknown-event crashes
  (unknown events become `log` events),
- honours `AbortSignal` and `cancel()` within 2 seconds and leaves no child processes,
- reports usage on completion,
- never reads credential directories of other tools,
- surfaces approval requests instead of auto-approving them,
- version gating: `probe()` reports `incompatible_version` outside the tested range.

Fixtures are re-recorded whenever a CLI's minor version changes; the tested version range lives
in each adapter's manifest.

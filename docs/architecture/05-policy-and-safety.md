# Policy, approvals, budgets and the MCP gateway

## Policy engine

A pure function in `core`: `evaluate(policy, action, context) → allow | deny | ask`. Policies
are versioned JSON documents (stored in `policies`), global with per-project overrides.

Defaults:

| Action                                                                                  | Default                                         |
| --------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Read files inside the node's worktree                                                   | allow                                           |
| Edit files inside `writeScope`                                                          | allow                                           |
| Edit files outside `writeScope`                                                         | deny (and the scope guard check fails the node) |
| Delete files                                                                            | ask                                             |
| Shell argv matching the packet's `argvPrefixes` or the check commands                   | allow                                           |
| Any other shell command                                                                 | ask                                             |
| MCP tool with `access: "read"` on an allowlisted server                                 | allow                                           |
| MCP tool with `access: "write"`, or any tool on an external server not marked read-only | ask                                             |
| Network outside the packet's allowlist                                                  | deny                                            |
| Merge into your branch, checkpoint rollback, plan approval                              | ask (always, not configurable)                  |
| Spend crossing a run threshold or an account soft cap                                   | ask                                             |

Every decision is a traced event (`tool.call` with its `decision`, `approval.requested`, `approval.resolved`), and an
`ask` pauses only the affected node; the rest of the DAG keeps running.

An approval in the queue shows: who wants it (node, model), the exact action (argv, path, tool
and arguments), why (the packet objective), and for file changes a side-by-side diff. Options:
Approve once, Approve for this node, Reject (with a reason the worker sees), Steer (free text
sent to the worker or, for escalations, to the frontier model).

## Budgets and circuit breakers

Checked by `core` on every `usage` and `model.call` event:

- **Node:** input/output tokens, cost, wall time, turns. Tripping cancels the session, records
  `budget.tripped`, and escalates (one steer may raise the budget once, with your approval if
  it exceeds the run's per-node ceiling).
- **Run:** total cost, frontier tokens. Thresholds (e.g. 50%, 80%) open approval gates; 100%
  pauses the run.
- **Account:** soft caps on quota windows, see [04-providers.md](04-providers.md).
- **Retry breaker:** the same `errorClass` three times across nodes on one adapter in 10
  minutes opens a breaker for that adapter (half-open after a cool-down), so a provider outage
  doesn't burn every node's retries.

## MCP gateway

Workers never connect to upstream MCP servers directly. Each run gets one loopback
Streamable HTTP MCP server (2026-07-28, stateless), and each node gets its own bearer token.
The token identifies `(run, node, attempt)`, so the gateway knows which packet applies.

The gateway:

- lists only the node's **eager** tools, in deterministic order (better prompt caching), plus
  two meta-tools when the node has lazy grants: `find_tools(query)` and
  `call_tool(server, tool, args)`, both restricted to the allowlist;
- serves packet context as resources (`orzeus://run/.../file/...`, `.../symbol/...`,
  `memory://...`), reading from the node's worktree, so workers fetch pinpointed ranges instead
  of whole files;
- proxies allowed calls to upstream servers using the MCP v2 client SDK, attaching
  `_meta.traceparent` so upstream spans join the run trace;
- handles MRTR `input_required` results from upstream servers by turning them into approval
  items when they need you, never by auto-answering;
- runs every call through the policy engine and records a `tool.call` event with argument and
  result hashes (bodies go to the blob store with secrets redacted).

Each worker adapter is configured to use only this gateway: `--mcp-config` for `claude-cli`,
`mcpServers` for the Agent SDK, `mcp_servers` config for Codex, the `mcpServers` field on ACP
`session/new`, and Orzeus's own tool loop for raw model APIs.

## Git worktree isolation

- Worktrees live outside the repo, under the app data dir:
  `<data>/worktrees/<project>/<run>/<node>`, on branches `orzeus/<run>/<node>`.
- Created from `TaskDAG.repo.baseCommit` (or the integration branch for nodes downstream of
  merged work). Orzeus never touches your checked-out working tree.
- Worker commits are made by Orzeus in the worktree after verification, with trailers
  `Orzeus-Run`, `Orzeus-Node`, `Orzeus-Trace-Hash`.
- Cleanup of finished worktrees is automatic for succeeded runs after integration and manual
  (with confirmation) for failed ones, so you can inspect them.
- All git calls go through `@orzeus/git` with argv arrays and an explicit `cwd`; nothing is
  passed through a shell.

## Secrets hygiene

- Secrets only in the OS keychain; fetched just in time; passed to child processes via env vars
  set on that process only.
- The logger and trace writer run a redaction pass for known secret values and common key
  formats before anything is persisted or exported.
- Child processes get a minimal environment (allowlisted variables), not the app's full env.

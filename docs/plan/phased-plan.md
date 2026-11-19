# Phased implementation plan

Each phase ends with working, tested software and a **commit point**. Claude never runs
`git add`, `git commit` or `git push`; at each commit point Claude tells Ryu what changed and
that it is safe to commit, with a suggested Conventional Commit message.

The order is deliberate: the risky, invisible parts (state, recovery, provider integration) are
built and proven headless before any UI, so the UI is a view over something already correct.

## Stage 1: Architecture proposal (this deliverable)

Docs only: layout, schemas, SQLite schema, providers, policy, ADRs, this plan.
Schemas typechecked with TS 7.0.2; SQL loaded into SQLite 3.54 with the guard triggers tested.

**Commit point 1:** `docs: add Orzeus architecture proposal`.

## Phase 0: Foundations (about 2 to 3 days)

Status: **done** (2026-11-19). `pnpm check` green; the desktop window shows a live
`engine.ping` round trip, and the Rust supervisor restarts the engine if it dies.

Needs Ryu's OK first: install the Rust toolchain (rustup) and pnpm.

- Root workspace: `pnpm-workspace.yaml`, `package.json` scripts, `tooling/tsconfig/*`, Biome,
  Vitest, `.editorconfig`, `.gitignore`, `.nvmrc` (Node 26).
- Empty packages with READMEs and project references in the shape of
  [01-monorepo-layout.md](../architecture/01-monorepo-layout.md); `check-deps` script.
- `apps/desktop`: Tauri 2.12 app with a blank calm window, the Rust sidecar supervisor and the
  stdio relay; `services/engine` answers `engine.ping`.
- GitHub Actions workflow running `pnpm check` on macOS (added, not pushed).

Exit: `pnpm check` green; `pnpm dev` opens the window and shows the engine's version from a
round-trip RPC.

**Commit point 2:** `chore: scaffold monorepo, tooling and Tauri shell`.

## Phase 1: Domain core and event store (about 1 week)

Status: **done** (2026-11-19). 85 TypeScript tests. A scripted 10-node run (with a transient
error, a failed check and a steered escalation) completes through SQLite; a restarted store
replays to the identical state, rebuilt projections are row-for-row identical, and a one-word
edit to a stored event is caught by chain verification.

- `@orzeus/schema`: Zod schemas for everything in
  [02-core-schemas.md](../architecture/02-core-schemas.md), with type-equality tests.
- `@orzeus/core`: DAG validation, run/node reducers, scheduler decisions (pure: given state,
  return which nodes to lease), retry backoff, budget math, policy evaluation.
- `@orzeus/trace`: JCS canonicalization, hashing, chain verifier.
- `@orzeus/store`: migrations runner, event append (event + projections in one transaction),
  blob store, replay, checkpoints.
- Property tests: random valid DAGs never deadlock the scheduler; replay of any event sequence
  equals live state; chain verification catches any single-byte tamper.

Exit: a scripted fake run (no LLM) drives a 10-node DAG to completion through the store, and
replaying it from scratch yields identical projections.

**Commit point 3:** `feat(core,store): event-sourced run state machine`.

## Phase 2: One worker, end to end, headless (about 1 week)

Status: **done** (2026-11-19). Exit check (`ORZEUS_E2E=ollama`): the calc plan ran through the
`orzeus` CLI with a real local model (lfm3 on Ollama); the process was killed with SIGKILL while
two nodes were mid-attempt; `orzeus resume` retried them, ran the dependent node, integrated
the result and the chain verified. Both adapters pass the conformance suite against recorded
fixtures. See "Phase 2 notes" below for what changed from the plan.

- `@orzeus/git`: worktree create/reset/diff/commit/cleanup.
- `@orzeus/checks`: argv runner with timeouts, output capture and truncation.
- First adapters: `codex-app-server` (installed on the Mac, best quota signal) and
  `openai-compatible` against local Ollama (free, for cheap repeatable tests).
- Hand-written plan JSON + packets; `orzeus run plan.json` executes nodes sequentially, verifies,
  captures diffs.
- Adapter conformance suite with recorded fixtures.

Exit: on a fixture repo, a 3-node hand-written plan runs to green checks with real worker
models; killing the engine mid-node and restarting resumes correctly.

**Commit point 4:** `feat(engine): headless single-worker execution`.

### Phase 2 notes

- Worker sessions run concurrently (the scheduler already supported it), not sequentially.
- A simple integration step landed early: when every node succeeds, results are merged onto
  the plan's integration branch with `git merge-tree`, so `run.completed` has a real commit.
  Global checks, review and the merge gate stay in Phase 4.
- Escalations have no frontier model yet, so they become `node.failed`
  (`escalation.unavailable`); hand plans default to `maxSteers: 0`.
- No leases yet: one engine process per database (Phase 4).

## Phase 3: Planner, context packets, MCP gateway, memory (about 1.5 weeks)

Status: **done** (2026-11-19). Exit check (`ORZEUS_E2E_PLANNER=codex-app-server:gpt-6-luna`):
`orzeus run --goal` on the calc-plus fixture planned with Codex, built with the local lfm3 worker
through the MCP gateway, passed its check, integrated, and the exported trace shows the planning
call, the issued packet and the gateway tool calls. The local 1.7B model cannot plan (see
"Phase 3 notes").

- Planner prompt + `PlannerOutput` structured output via `generate`, validation, plan approval
  gate (CLI prompt for now).
- Packet renderer and repo map (tree-sitter symbol index).
- `@orzeus/mcp-gateway` on the MCP v2 SDK: per-node tokens, allowlisted eager/lazy tools,
  packet resources, policy hook, tracing.
- `services/memory-server` with FTS search; planner reads it, `memory_propose` is gated.
- Adapters: `anthropic-api`, `claude-cli` (if installed), `gemini-api`.

Exit: `orzeus run --goal "..."` plans, executes and verifies a small real change on a fixture
repo; the trace shows every packet and tool call.

**Commit point 5:** `feat: planner, context packets and MCP gateway`.

### Phase 3 notes

- New package `@orzeus/context` (tree-sitter repo map, symbol index, pointer resolution).
- Structured output: `generate()` on `openai-compatible` (JSON-schema constrained decoding,
  falling back to a forced tool call when the runtime cannot constrain, as Ollama's MLX runner
  cannot), `codex-app-server` (ephemeral read-only thread with `outputSchema`), `anthropic-api`
  (`output_config.format`) and `gemini-api` (`responseJsonSchema`). Parsing tolerates comments,
  trailing commas and near-miss shapes, then always validates.
- The planner emits a compact `PlanDraft`; Orzeus fills ids, routing, budgets and tool grants,
  validates, and gives the planner one repair round with the problems listed.
- `--local-reasoning none` keeps small "thinking" local models from spending their whole budget
  on hidden reasoning.
- `anthropic-api` and `gemini-api` are planners only for now (no API keys here to test live
  worker loops); `claude-cli` waits until the CLI is installed.
- Codex workers do not yet get the gateway (their MCP config path is unverified live).
- Plans are checked against the real repository before approval: a check that needs a missing
  package.json script or an uninstalled tool goes back to the planner's repair round (the first
  live Codex plan assumed `npm test` in a repo without a test script). The planner prompt also
  describes the repo's build and test tooling.

## Phase 4: Parallelism, recovery, escalation, approvals (about 1.5 weeks)

Status: **done** (2026-11-19). Exit checks: the chaos test (`ORZEUS_CHAOS_RUNS=50`) kills a
6-node, 3-way-parallel run with SIGKILL at random moments and restarts it until it completes;
50 runs, 354 SIGKILLs, every run completed with a verified chain, projections equal to a
rebuild, and the identical integrated tree. A 7-node plan runs with exactly 3 workers at a time.

- Concurrent scheduler with write-scope serialization and leases with heartbeats.
- Retries with backoff, adapter circuit breakers, budget breakers.
- Escalation to the frontier model with packet + diff + failing output; steer and subtree
  re-plan.
- Integration branch, global checks, frontier review, merge approval.
- Checkpoints and rollback.
- Chaos test: `kill -9` the engine at random points across 50 runs; every run resumes to the
  same final state.

Exit: chaos test green; a 6+ node plan runs with 3 workers in parallel.

**Commit point 6:** `feat(engine): parallel execution, recovery and escalation`.

### Phase 4 notes

- One engine per run: a run lock in SQLite (migration 0002) with heartbeats. A crashed
  engine's lock expires and `orzeus resume` takes over; a live engine's run is refused.
  This replaced per-node leases, which a single owner per run makes unnecessary.
- The scheduler counts attempts that are still preparing their worktree as occupying a slot.
  Without that, a third worker could briefly start under a limit of two (found by the breaker test).
- Escalation goes to the frontier model with the packet, the last diff and the failing check
  output. It answers retry_with_guidance (the note goes into the next packet), rewrite_task (a new
  packet is issued for the node) or give_up. Re-planning a whole subtree (adding or removing
  nodes mid-run) is not implemented; it needs DAG revisions while executing.
- Integration re-runs every node's checks on the merged result, then (when the plan asks) the
  frontier model reviews the integrated diff, then the merge gate offers a fast-forward of the
  user's branch. That needs a clean checkout, and the branch must not have moved since the run started.
- Budget gates: crossing a cost threshold asks a human; refusing, or reaching 100% or the
  frontier token cap, pauses the run (`orzeus resume` continues it).
- Checkpoints are taken at plan approval and after every node succeeds; `orzeus rollback`
  restores one (also from a failed run) and `orzeus resume` continues from there.
- Live steering and review with a real frontier model were not exercised, to save the Codex quota.
  They are covered with a fake frontier model in tests.

## Phase 5: Desktop UI (about 2 weeks)

Status: **done** (2026-11-19). Exit check: from the UI (in the browser through the dev bridge,
then in the real Tauri window), the calc hand plan was loaded, reviewed and approved; local
`lfm3` workers built three nodes in parallel; the merge gate showed the diff and was approved
from the keyboard; the branch fast-forwarded with 3/3 tests passing; "Verify chain" reported
58 events OK. A WCAG contrast test covers every text/background token pair. No Codex quota used.

Light, calm, airy: one neutral palette, generous spacing, one accent colour for "needs you".

- Mission Control: prompt bar, live DAG (`@xyflow/react`) coloured by status, worker pills.
- Approval and Steer queue: side-by-side diff, proposed actions, Approve / Reject / Steer.
- Trace Inspector: filterable timeline, packet viewer, token breakdown, checkpoint replay,
  "verify chain" button, JSONL/OTLP export.
- Quota strip: per-account windows, reset countdowns, routing, Frontier Quota Saved.
- Settings: accounts (keychain), MCP servers (with `server/discover` and OAuth), policies.

Exit: full run from the UI; keyboard-navigable; accessibility check (contrast, focus order).

**Commit point 7:** `feat(desktop): mission control, approvals, trace and quota UI`.

### Phase 5 notes

- Protocol v2 (`@orzeus/protocol`): typed methods for runs, plans, approvals, blobs, quota,
  settings and memory, plus notifications (`run.updated`, `approvals.changed`, `progress`) the
  engine writes to stdout. The UI also polls slowly, so a missed notification only delays a view.
- `EngineService` (`services/engine/src/service.ts`) owns the engine inside the sidecar. Runs are
  planned and driven in the background; gates (risky actions, budget, merge) wait in an inbox
  until someone answers them in the Approval queue. Steer answers become guidance for the next
  attempt.
- A goal can be planned by the frontier model (Anthropic if a key is in the Keychain, else the
  local model) or started from a hand-written plan pasted into the goal bar.
- API keys live in the macOS Keychain (`keyring` crate, service `dev.orzeus.desktop`). The Rust
  shell injects them into the sidecar's environment and never returns them to the webview;
  saving a key restarts the sidecar.
- The dev bridge (`pnpm dev:web`) runs the UI in an ordinary browser for design and testing.
  It listens on 127.0.0.1 only and accepts requests only from the Vite origin.
- JSONL and OTLP (GenAI semantic conventions) export are both in the Trace Inspector.
- Plan editing (added after the exit check): "Edit plan" in plan review changes any node's task,
  done-when criteria, constraints, checks, write scope, dependencies, worker and MCP tools, and
  adds or removes nodes. Saving records a new `plan.proposed` revision with a human actor, and
  `plan.approved` records `edited: true`. Budgets, retry policy and context pointers are kept;
  new nodes get the hand-plan defaults. Edits are validated (graph, schema, check commands
  that exist in the repo, enabled worker adapters) and every problem is listed at once.
- MCP servers (added after the exit check): Settings adds, edits, tests, turns off and removes
  upstream servers (stdio command or Streamable HTTP URL), stored in `mcp_servers`. A test
  connects and lists the tools. Enabled servers join every run's gateway (one that fails to
  connect is skipped with a warning). Each server has a default grant for new plans (none,
  read-only tools, or all tools; anything that writes still asks you through policy). One secret
  per server lives in the Keychain as `mcp.<id>` and reaches the engine as
  `ORZEUS_MCP_SECRET_<ID>`: stdio servers get it under a variable you name, HTTP servers as a
  bearer token.
- Not done: OAuth sign-in for remote MCP servers (static bearer tokens work), and telling the
  planner which MCP tools exist (grants come from server defaults or the plan editor).
- Found while hardening the test suite: git child processes could crash the engine with EPIPE
  when git exited before reading stdin, and lock heartbeats could fire after the database
  closed. Both are fixed.

## Phase 6: Remaining adapters and telemetry polish (about 1 week)

Status: **done** (2026-11-19). All five adapters pass the shared conformance suite (compliant
manifest, no foreign credential paths, probe without tokens, a full session with usage and file
changes, a denial, cancellation within two seconds with no process left behind). Soft caps were
checked end to end: an account over its cap holds the node, records `budget.tripped`, and the
node starts once the window resets. No Codex quota and no paid API calls were used.

`claude-agent-sdk` (API key), `codex-exec`, `openai-api`, `cursor-cli`, `acp` (v1), quota
parsers for each source, soft caps UI.

**Commit point 8:** `feat(providers): cursor, ACP, Agent SDK and OpenAI adapters`.

### Phase 6 notes

- Verified 2026-11-19: `@anthropic-ai/claude-agent-sdk` 0.3.327 (0.3.328 is under a day old, so pnpm's release-age policy holds it back), `@agentclientprotocol/sdk`
  2.8.0 (ACP v1, protocol version 1), codex-cli 0.169/0.170 `exec --json` events
  (codex-rs/exec/src/exec_events.rs), Cursor's stream-json format, and OpenAI's published prices.
- None of the new adapters could be recorded live here (no Anthropic, OpenAI or Cursor keys, no
  cursor-agent install, and recording Codex spends quota), so they are tested against fakes
  written from the documented formats: a fake `query()` for the Agent SDK, fake CLIs for
  codex exec and cursor-agent, a small ACP agent built with the official SDK, and the local
  Chat Completions recording with OpenAI's rate-limit headers added. Re-record when keys exist.
- `claude-agent-sdk` is API key only. Claude Code runs with `settingSources: []`, its own
  `CLAUDE_CONFIG_DIR` under Orzeus's data folder and a replaced environment, so it never sees a
  claude.ai login or user settings. `canUseTool` turns edits, commands and fetches into Orzeus
  approvals; reads inside the worktree and the gateway's MCP tools are allowed; anything else is
  refused. Steering pushes a user message into the streaming input.
- `openai-api` reuses the Chat Completions tool loop (now configurable: identity, prices,
  rate-limit headers, `max_completion_tokens`, no temperature) and is also a planner.
- `codex-exec` and `cursor-cli` have no per-action approvals (exec runs with
  `approval_policy="never"` in the workspace-write sandbox; cursor-agent needs `--force` in
  print mode with its sandbox on). Writes stay confined by the CLI's sandbox and are checked by
  the scope guard afterwards. Cursor reports no tokens; usage is estimated (4 characters per
  token) and the adapter says so.
- `acp`: Orzeus is the client. It serves `fs/read_text_file` and `fs/write_text_file` inside the
  worktree only, offers no terminal, answers `session/request_permission` with its policy, and
  passes the gateway as an HTTP MCP server when the agent supports it. Configure agents with
  `--acp "acp-name=command args"` or `ORZEUS_ACP_AGENTS` (JSON) for the desktop sidecar.
- Turning adapters on: Codex (`--enable-codex`, now both app-server and exec on the same
  account), Cursor (`--enable-cursor` / `ORZEUS_ENABLE_CURSOR=1`, login or `CURSOR_API_KEY`),
  Agent SDK and OpenAI API whenever their key is in the Keychain.
- Quota and soft caps: every observation (official reads, Claude rate-limit events, OpenAI
  headers) is stored in `quota_observations` against a `provider_accounts` row; the latest
  window per account feeds `quotaHold` in core. A window that is limited, or at or above its
  soft cap, holds new work on that account until it resets (or a minute, if the reset is
  unknown). Soft caps live in `provider_accounts.soft_caps_json`; Settings → Usage limits sets
  them and the quota strip marks them. No migration was needed: the tables were in 0001.
- Not done: "Frontier Quota Saved" in window percent (still a token count), usage_samples
  projections, and per-account enable/disable in the UI (adapters are turned on by flags and keys).

## Phase 7: Hardening and packaging (about 1 week)

Sidecar as a single executable, code signing and notarization for macOS, auto-update decision,
security review (secrets, redaction, policy bypass attempts), performance pass, user docs.

**Commit point 9:** `chore: release packaging and hardening`.

### Phase 7 notes

Status: **done** (2026-11-19), except the first real single-executable build and anything that
needs Ryu's Apple account (see below).

- **Packaging.** `services/engine/src/sea.ts` is one entry for three roles (sidecar,
  `memory-server`, `cli`). `tooling/scripts/build-sidecar.ts` bundles it with esbuild 0.28.2
  into one ES module, embeds the tree-sitter wasm files as SEA assets (`setWasmSource` in
  `@orzeus/context`), and runs `node --build-sea` (Node 26, `mainFormat: "module"`). The engine
  starts the memory server by running itself. Release builds of the app run the bundled
  `orzeusd` sidecar (`tauri.bundle.conf.json`: externalBin, hardened runtime, JIT entitlements);
  debug builds keep running the repository's engine with Node. The bundle was smoke-tested
  under Node in all three roles. Homebrew's Node lacks the SEA fuse, so the script downloads the
  official build once (verified against SHASUMS256); Ryu approved that download, but this
  session's sandbox blocked it, so the first `pnpm build:sidecar` is Ryu's to run.
- **Left out of the packaged engine:** the Claude Agent SDK (160 MB native binary per platform).
- **Signing and notarization:** configuration and a step-by-step guide
  (docs/guide/release-macos.md); not run, since it needs Ryu's Developer ID and Apple account.
- **Updates:** ADR 0006 proposes no automatic updates in v1.
- **Security review, fixed:**
  - Secrets are redacted (known key values from the environment, common key formats, bearer
    tokens, private key blocks) in engine logs, progress lines, and free-text blobs (command
    output, diffs, tool-call bodies) before they are stored. Packets are not redacted: their
    hash is part of the trace and Orzeus writes them.
  - Symbolic links: worker file tools and the ACP client resolve real paths and refuse anything
    that leads outside the worktree; the repo map never follows links (a committed link to
    `~/.ssh/id_rsa` would otherwise have reached the planner); context reads refuse links out;
    and the scope guard fails any attempt that creates a symlink or submodule.
  - The dev bridge requires the Vite origin and a loopback Host on every request, which also
    stops DNS-rebinding pages (their same-origin requests carry no Origin).
  - Reviewed and unchanged: the webview has no shell or filesystem permissions (only the engine
    relay and Keychain commands), the CSP allows only the app itself, gateway tokens are
    192-bit and per node attempt on a loopback port, commands never go through a shell, and
    shell operators make a command an "ask" rather than an allowlist match.
- **Performance:** event reads are filtered in SQL. On a 10,000-event run
  (`node tooling/scripts/bench-store.ts`): reading the whole run 359 ms, reading the last 50
  events 1.8 ms (what the UI polls), one event type 0.8 ms, appending 0.08 ms per event, cached
  state 0 ms. The orchestrator's packet and steering lookups, plan-approval check and the UI's
  `runs.events` now use the filtered reads instead of parsing the whole run.
- **Found while repeating the test suite:** two nodes preparing worktrees at once could race
  (`git worktree prune` from one dropping the other's half-made `worktree add`); worktree
  changes are now serialized per repository. A node that failed before its first dispatch also
  recorded an invalid attempt number; fixed.
- **Docs:** the user guide (docs/guide/README.md) and the release guide.

## Open decisions for Ryu

1. **Engine as a Node sidecar** (ADR 0001). Recommended.
2. **Drop `tauri-plugin-sql` in v1**; engine owns SQLite (ADR 0002). Recommended.
3. **OS keychain instead of Stronghold** (ADR 0003), since Stronghold is slated for removal in
   Tauri v3. Recommended.
4. **Install Rust (rustup) and enable pnpm** on the Mac before Phase 0.
5. **Subscription CLIs** (`claude -p`, Codex with ChatGPT login, Cursor login) as personal-use
   adapters, disabled by default if Orzeus is ever distributed. Recommended.

## Risks

| Risk                                       | Mitigation                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| CLI stream formats change between versions | Version-gated adapters, recorded fixtures, lenient parsing with unknown events logged                |
| `node:sqlite` is still RC                  | `Db` port; `better-sqlite3` as a drop-in                                                             |
| Planner produces poor DAGs                 | Strict validation, plan approval gate, write-scope serialization, re-plan on escalation              |
| Merge conflicts between parallel nodes     | Write scopes, serialization of overlaps, integration in topological order, frontier help on conflict |
| Provider ToS shifts                        | Compliance profile per adapter, conservative defaults, easy kill switch per adapter                  |
| Quota numbers are approximate              | Show source and "estimate" labels; soft caps act before hard limits                                  |

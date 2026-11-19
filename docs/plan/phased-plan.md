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

Light, calm, airy: one neutral palette, generous spacing, one accent colour for "needs you".

- Mission Control: prompt bar, live DAG (`@xyflow/react`) coloured by status, worker pills.
- Approval and Steer queue: side-by-side diff, proposed actions, Approve / Reject / Steer.
- Trace Inspector: filterable timeline, packet viewer, token breakdown, checkpoint replay,
  "verify chain" button, JSONL/OTLP export.
- Quota strip: per-account windows, reset countdowns, routing, Frontier Quota Saved.
- Settings: accounts (keychain), MCP servers (with `server/discover` and OAuth), policies.

Exit: full run from the UI; keyboard-navigable; accessibility check (contrast, focus order).

**Commit point 7:** `feat(desktop): mission control, approvals, trace and quota UI`.

## Phase 6: Remaining adapters and telemetry polish (about 1 week)

`claude-agent-sdk` (API key), `codex-exec`, `openai-api`, `cursor-cli`, `acp` (v1), quota
parsers for each source, soft caps UI.

**Commit point 8:** `feat(providers): cursor, ACP, Agent SDK and OpenAI adapters`.

## Phase 7: Hardening and packaging (about 1 week)

Sidecar as a single executable, code signing and notarization for macOS, auto-update decision,
security review (secrets, redaction, policy bypass attempts), performance pass, user docs.

**Commit point 9:** `chore: release packaging and hardening`.

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

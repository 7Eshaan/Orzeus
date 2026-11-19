# Orzeus architecture overview

Status: **proposal, stage 1**. Nothing here is implemented yet.

Orzeus is a local-first desktop orchestrator. A frontier model plans a goal into a task DAG.
Cheap worker models execute the nodes in parallel, each in its own git worktree, each with a
small self-contained Context Packet instead of a chat history. Only failures, ambiguity and the
final integrated diff go back to the frontier model.

## Goals, in priority order

1. **Correct and recoverable.** A crash, a quit or a reboot never loses a run or corrupts the
   repo. Every state change is an event in SQLite; state is rebuilt by replay.
2. **Safe by default.** Nothing destructive happens without a human: file deletes, shell
   commands outside the allowlist, external MCP writes, merges into your branch, budget crossings.
3. **Frugal with frontier quota.** The frontier model sees packets, summaries and diffs, never
   raw worker transcripts.
4. **Honest and auditable.** A hash-chained trace records every packet, model call, tool call,
   diff and check result, and can be verified and exported.
5. **ToS-compliant.** Only official provider interfaces. No credential scraping, no proxy
   spoofing, no multi-account rotation (see [04-providers.md](04-providers.md)).
6. **Maintainable.** Pure domain logic separated from IO, small packages with one-way
   dependencies, every boundary validated at runtime.

## Process model

```
┌──────────────────────── Orzeus.app (Tauri 2.12) ───────────────────────┐
│                                                                        │
│  WebView UI (React 19)           Rust core (src-tauri)                 │
│  Mission Control, Quota strip,   window, tray, keychain secrets,       │
│  Approval queue, Trace view  ◀──▶ sidecar lifecycle, RPC relay         │
│        ▲  Tauri events/commands         │ stdio (JSON-RPC, NDJSON)     │
└────────┼────────────────────────────────┼──────────────────────────────┘
         │                                ▼
         │                ┌──────── orzeusd (Node 26, TS 7) ─────────┐
         └── projections ─│ Engine: scheduler, state machine, policy │
                          │ Event store + projections (SQLite, WAL)  │
                          │ Provider adapters   Git worktree manager │
                          │ MCP gateway (per-task allowlist)         │
                          └───┬───────────┬──────────────┬───────────┘
                              │           │              │
               provider CLIs / APIs   upstream MCP    orzeus-memory
               (claude, codex,        servers (stdio, (MCP server, stdio)
               cursor-agent, ACP,     Streamable HTTP)
               Anthropic/OpenAI/
               Gemini/Ollama HTTP)
```

### Why a Node sidecar engine (ADR 0001)

The orchestration engine runs as a long-lived Node process, `orzeusd`, launched and supervised
by the Rust core, not inside the webview.

- Runs must keep going when the window is closed, reloaded or throttled by the OS.
- `@anthropic-ai/claude-agent-sdk`, the MCP v2 SDK and the ACP SDK are Node libraries.
- It makes the whole engine runnable headless (`orzeus run plan.json`), which is how we test it
  end to end without a UI.

The UI talks to the engine only through a typed JSON-RPC contract (`@orzeus/protocol`), relayed
by Rust over the sidecar's stdio. No network port is opened.

### Why the engine owns SQLite (ADR 0002)

One writer: `orzeusd`. It opens the database with `node:sqlite` behind a small `Db` port, so we
can swap to `better-sqlite3` if the RC module misbehaves. The UI never queries tables directly;
it receives projections over RPC. That keeps the schema private to one package and avoids two
processes racing on writes. `tauri-plugin-sql` is therefore **not needed** in v1 (this deviates
from the original brief; see the open decisions in the plan).

### Secrets (ADR 0003)

API keys live in the macOS Keychain (Windows Credential Manager / Secret Service elsewhere)
through the Rust `keyring` crate, behind two Tauri commands. The engine asks Rust for a secret
at the moment it needs it and never writes it to SQLite or logs. Stronghold is avoided because
the Tauri team has said it will be removed in v3.

## The run lifecycle

1. **Plan.** You enter a goal. The planner (frontier tier) gets a repo map, relevant memory and
   the goal, and returns a `PlannerOutput`: a `TaskDAG` plus one `ContextPacket` per node. The
   output is validated (schema, acyclic, write-scope overlaps, tool grants within policy).
   You approve or edit the plan.
2. **Schedule.** Nodes whose dependencies succeeded become `ready`. The scheduler leases ready
   nodes up to the concurrency limit, never running two nodes with overlapping `writeScope`
   at the same time.
3. **Execute.** Each node gets a fresh worktree on branch `orzeus/<run>/<node>` from its base
   commit, a worker model chosen by the router (tier, quota headroom, account caps), and an MCP
   endpoint on the gateway that exposes only its allowlisted tools and packet resources.
4. **Verify.** When the worker stops, Orzeus runs the node's checks itself (argv commands, no
   shell), captures the diff, and rejects any change outside `writeScope`.
5. **Retry, steer or escalate.** Transient errors retry with exponential backoff and jitter.
   Check failures retry once on the worker with the failure output, then escalate to the
   frontier model with only the packet, the diff and the failing output. The frontier model
   returns a steer (revised packet or hint), a re-plan of that subtree, or a request for a human.
6. **Integrate and review.** Node branches are merged in topological order into
   `orzeus/<run>/integration`, global checks run, and the frontier model reviews the integrated
   diff. Merging into your real branch is always a human approval.

## Package boundaries (summary)

See [01-monorepo-layout.md](01-monorepo-layout.md). The rule: `schema` and `core` are pure
(no IO, no Node APIs), everything with side effects sits behind a port interface defined in
`core`, and only `services/engine` wires concrete implementations together.

## Document map

- [01-monorepo-layout.md](01-monorepo-layout.md): folders, packages, tooling, quality gates
- [02-core-schemas.md](02-core-schemas.md): `TaskDAG`, `ContextPacket`, `ProviderAdapter`, `TraceEvent`
- [03-sqlite-schema.md](03-sqlite-schema.md): event store, projections, migrations
- [04-providers.md](04-providers.md): adapters, compliance rules, quota telemetry
- [05-policy-and-safety.md](05-policy-and-safety.md): approval gates, budgets, MCP gateway
- [../plan/phased-plan.md](../plan/phased-plan.md): phases, exit criteria, commit points
- [../decisions/](../decisions/): architecture decision records
- [../research/verified-versions-2026-11.md](../research/verified-versions-2026-11.md): what was verified and where

# @orzeus/engine (orzeusd)

The orchestration engine. It runs as a sidecar process supervised by the desktop app's Rust core
(see [ADR 0001](../../docs/decisions/0001-engine-as-node-sidecar.md)) and can also run on its own.

- **stdin/stdout:** JSON-RPC 2.0, one message per line ([`@orzeus/protocol`](../../packages/protocol)).
  Nothing else is ever written to stdout.
- **stderr:** structured JSON logs, one object per line.
- Exits cleanly when stdin closes or on SIGTERM/SIGINT.

This is the composition root: the only place where concrete adapters (SQLite, git, providers)
are wired into `@orzeus/core` ports.

## Headless CLI (Phase 2)

```bash
pnpm build
node services/engine/dist/cli.js run services/engine/fixtures/calc/plan.json --repo <a git repo> --approve-plan
node services/engine/dist/cli.js resume <runId>     # after a crash or Ctrl-C
node services/engine/dist/cli.js verify <runId>     # re-check the hash chain and blobs
node services/engine/dist/cli.js export <runId>     # canonical JSONL trace
node services/engine/dist/cli.js status <runId>     # nodes and checkpoints
node services/engine/dist/cli.js rollback <runId> <checkpointId>   # then resume
```

Plans are hand-written for now (see `src/plan-file.ts` and `fixtures/calc/plan.json`); the
frontier planner replaces them in Phase 3. Local models are the default worker; Codex is
opt-in with `--enable-codex` because it spends your own quota. Headless runs have no human, so
actions the policy would ask about are denied unless you pass `--approve-asks`.

The calc fixture (`fixtures/calc/repo`) is a tiny repo with tests but no implementations.

## Try the sidecar protocol

```bash
pnpm build
echo '{"jsonrpc":"2.0","id":1,"method":"engine.ping","params":{}}' | node services/engine/dist/main.js
```

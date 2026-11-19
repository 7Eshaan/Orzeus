# @orzeus/engine (orzeusd)

The orchestration engine. It runs as a sidecar process supervised by the desktop app's Rust core
(see [ADR 0001](../../docs/decisions/0001-engine-as-node-sidecar.md)) and can also run on its own.

- **stdin/stdout:** JSON-RPC 2.0, one message per line ([`@orzeus/protocol`](../../packages/protocol)).
  Nothing else is ever written to stdout.
- **stderr:** structured JSON logs, one object per line.
- Exits cleanly when stdin closes or on SIGTERM/SIGINT.

This is the composition root: the only place where concrete adapters (SQLite, git, providers)
are wired into `@orzeus/core` ports.

## Try it

```bash
pnpm build
echo '{"jsonrpc":"2.0","id":1,"method":"engine.ping","params":{}}' | node services/engine/dist/main.js
```

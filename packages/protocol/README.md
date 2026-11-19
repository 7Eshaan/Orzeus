# @orzeus/protocol

The typed contract between the `orzeusd` engine and the desktop UI.

- **Wire format:** JSON-RPC 2.0, one message per line (NDJSON) on the engine's stdin/stdout.
  The Rust shell relays lines without parsing them.
- **Methods** are declared once in [`src/methods.ts`](src/methods.ts) with Zod schemas for
  params and results. Both sides validate everything they receive.
- `RpcClient` (used by the UI) and `handleRpcLine` (used by the engine) are pure: no Node or DOM
  APIs, so they run and are tested anywhere.

## Adding a method

1. Add an entry to `methods` in `src/methods.ts`.
2. Implement the handler in `services/engine`; the `RpcHandlers` type makes a missing handler a
   compile error.
3. Bump `PROTOCOL_VERSION` only for breaking changes.

## Rules

Pure. Depends only on zod. No `@orzeus/*` dependencies except `@orzeus/schema` (later).

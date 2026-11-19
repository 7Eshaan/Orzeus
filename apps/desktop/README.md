# @orzeus/desktop

The Orzeus desktop app.

- `src-tauri/`: the Rust shell. Owns the window, supervises the `orzeusd` engine sidecar, and
  relays JSON-RPC lines between the engine's stdio and the webview. It never parses messages.
- `src/`: the React UI. It talks to the engine only through `@orzeus/protocol`.
  - `app/`: bootstrapping and the engine connection.
  - `features/`: one folder per screen area (Mission Control first; Approvals, Trace and the
    Quota strip arrive in Phase 5).
  - `ui/`: design tokens and shared primitives. Light, calm, generous whitespace.

## Run

From the repository root:

```bash
pnpm dev
```

This builds the TypeScript packages (including the engine), starts Vite on port 1420 and opens
the Tauri window. The Rust shell launches `node services/engine/dist/main.js`; override with
`ORZEUS_NODE` and `ORZEUS_ENGINE_ENTRY` if needed.

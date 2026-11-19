# @orzeus/desktop

The Orzeus desktop app.

- `src-tauri/`: the Rust shell. Owns the window, supervises the `orzeusd` engine sidecar, and
  relays JSON-RPC lines between the engine's stdio and the webview. It never parses messages.
- `src/`: the React UI. It talks to the engine only through `@orzeus/protocol`.
  - `app/`: bootstrapping, the transport (Tauri relay or dev bridge), the typed engine client
    and `useLive` (load, then refresh on engine notifications).
  - `features/`: one folder per screen area: `shell` (sidebar, quota strip), `mission-control`
    (goal bar, plan review, DAG), `approvals`, `trace`, `settings`.
  - `lib/`: pure helpers (formatting, DAG layout, side-by-side diff, trace grouping), unit tested.
  - `ui/`: design tokens and shared primitives. Light, calm, generous whitespace.
    `contrast.test.ts` keeps every text/background pair at WCAG AA.

Keyboard: ⌘1 to ⌘4 switch views; in the Approval queue, `a` approves and `r` rejects (steer needs a note, so it has no key).

## Run

From the repository root:

```bash
pnpm dev
```

This builds the TypeScript packages (including the engine), starts Vite on port 1420 and opens
the Tauri window. The Rust shell launches `node services/engine/dist/main.js`; override with
`ORZEUS_NODE` and `ORZEUS_ENGINE_ENTRY` if needed.

API keys entered in Settings go to the macOS Keychain; the shell passes them to the engine as
environment variables and restarts it.

## Run in a browser

```bash
pnpm dev:web
```

Then open http://localhost:1420/?bridge=http://127.0.0.1:1421. The dev bridge
(`tooling/scripts/dev-bridge.ts`) spawns the built engine and relays its stdio over loopback HTTP;
pass `--data-dir <dir>` to it to use a separate database. It is for development only.

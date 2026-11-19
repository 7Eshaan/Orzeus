# Monorepo layout

pnpm workspaces + TypeScript 7 project references (`tsc -b` builds referenced projects in
parallel) + one Cargo crate for the Tauri shell.

```
orzeus/
├─ apps/
│  └─ desktop/                  Tauri 2 app
│     ├─ src/                   React 19 UI (Vite 8)
│     │  ├─ app/                routing, providers, RPC client bootstrap
│     │  ├─ features/
│     │  │  ├─ mission-control/ prompt bar, DAG graph (@xyflow/react), worker pills
│     │  │  ├─ quota-strip/     usage bars, reset timers, routing, quota saved
│     │  │  ├─ approvals/       queue, side-by-side diff, approve / reject / steer
│     │  │  └─ trace/           timeline, filters, packet + token inspector, checkpoints
│     │  └─ ui/                 design tokens (CSS custom properties) and primitives
│     └─ src-tauri/             Rust: window, tray, keychain commands, sidecar supervisor,
│                               stdio <-> Tauri event relay. Deliberately thin.
├─ services/
│  ├─ engine/                   orzeusd: composition root. Wires ports to adapters,
│  │                            exposes @orzeus/protocol over stdio, plus `orzeus` headless CLI
│  └─ memory-server/            orzeus-memory: standalone MCP server (stdio) for repo decisions
├─ packages/
│  ├─ schema/                   Zod 4 schemas + inferred types. TaskDAG, ContextPacket,
│  │                            TraceEvent, PlannerOutput, PolicyRule. Depends only on zod.
│  ├─ core/                     Pure domain. DAG validation, run/node state machines (reducers
│  │                            over events), scheduler decisions, router, policy evaluation,
│  │                            budget math, retry backoff. Defines the ports (interfaces) for
│  │                            everything with side effects. No Node APIs, no IO.
│  ├─ protocol/                 Engine <-> UI JSON-RPC contract (methods, notifications,
│  │                            projections), versioned. Used by engine and UI.
│  ├─ store/                    SQLite: migrations, event store, projections, blob store,
│  │                            checkpoints. Implements core's EventStore / BlobStore ports.
│  ├─ trace/                    Canonical JSON (RFC 8785), hash chain, verifier, JSONL and
│  │                            OTLP exporters.
│  ├─ context/                  Repo map and symbol index (tree-sitter WASM grammars),
│  │                            resolution of packet pointers to exact code.
│  ├─ git/                      Worktree manager over the git CLI (argv only, no shell).
│  ├─ checks/                   Deterministic check runner (typecheck, lint, test commands),
│  │                            output capture and truncation.
│  ├─ mcp-gateway/              Loopback MCP server per run. Exposes per-node allowlisted
│  │                            tools (proxied to upstream servers) and packet resources.
│  │                            Every call goes through policy and is traced.
│  └─ providers/                ProviderAdapter + one folder per adapter:
│     ├─ src/adapter.ts         the interface (re-exported from schema types)
│     ├─ src/conformance/       shared test suite every adapter must pass
│     └─ src/adapters/          anthropic-api, claude-agent-sdk, claude-cli, codex-app-server,
│                               codex-exec, cursor-cli, gemini-api, openai-compatible, acp
├─ tooling/
│  ├─ tsconfig/                 base.json, node.json, dom.json, test.json
│  └─ scripts/                  repo scripts (check-deps, verify-trace, release)
├─ fixtures/                    sample repos, recorded provider streams for replay tests
├─ docs/                        this documentation
├─ biome.json
├─ pnpm-workspace.yaml
├─ tsconfig.json                solution file: references every project, builds nothing itself
├─ Cargo.toml                   workspace with apps/desktop/src-tauri
└─ package.json                 scripts: check, build, test, dev
```

## Dependency rules

```
schema  ◀── trace
schema  ◀── git
schema  ◀── core ◀── store (+ trace), checks, mcp-gateway, providers ◀── services/engine
schema  ◀── protocol ◀── apps/desktop (UI)        services/engine ──▶ protocol
```

- `schema` and `core` never import Node or DOM APIs. They are unit-tested without IO.
- Adapters depend on `core` ports, never on each other.
- The exact allowed edges live in `tooling/scripts/dependency-rules.json`.
- The UI depends only on `protocol` and `schema`. It cannot import engine code.
- Enforced two ways: TypeScript project references (a package can only import what it
  references) and a `tooling/scripts/check-deps` step in `pnpm check`.

## TypeScript configuration

`tooling/tsconfig/base.json`, roughly:

```jsonc
{
  "compilerOptions": {
    "target": "es2024",
    "module": "nodenext", // packages and engine; UI uses "preserve" + "bundler"
    "moduleResolution": "nodenext",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "verbatimModuleSyntax": true,
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true
  }
}
```

Packages are ESM only, publish `exports` maps, and point `types` at built `.d.ts` so project
references stay fast.

## Quality gates

One command, `pnpm check`, runs locally and in CI:

| Step                  | Tool                                                          | Why this tool                                                                        |
| --------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Format + lint         | Biome 2.6                                                     | Fast, single config, does not depend on the old TypeScript JS API that TS 7 dropped  |
| Types                 | `tsc -b` (TS 7)                                               | Whole repo in parallel                                                               |
| Unit + property tests | Vitest 5, fast-check                                          | Pure `core` logic gets property tests (DAG validation, reducers, replay determinism) |
| Adapter conformance   | Vitest + recorded fixtures                                    | Every adapter replays recorded CLI/API streams; no network in CI                     |
| Dependency rules      | `check-deps` script                                           | Keeps the layering honest                                                            |
| Rust                  | `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` |                                                                                      |
| Chaos test (Phase 4+) | headless engine + `kill -9` loop                              | Proves crash-safe resume                                                             |

Conventions:

- Biome's `useLiteralKeys` is off because it conflicts with TypeScript's
  `noPropertyAccessFromIndexSignature` (records keyed by id are read as `nodes["a"]`).
- Conventional Commit messages (Ryu commits; Claude never runs `git add/commit/push`).
- Every package has a short README stating its purpose and its public API.
- Errors are typed (`Result`-style returns inside `core`, exceptions only at IO edges) and every
  error that reaches the trace has a stable `errorClass` string.
- No `any`; `unknown` plus Zod parsing at every boundary (RPC, provider streams, planner output,
  MCP results, DB rows of JSON).
- Logging is structured JSON to stderr from the engine; never logs secrets (a redaction layer
  sits in the logger and the trace writer).

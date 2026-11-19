# Orzeus

A local-first multi-agent orchestrator desktop app: frontier models plan, cheap worker models
build in parallel git worktrees, and only failures and final diffs go back to the frontier.

Status: Phase 2 done: headless runs with real local or Codex workers. Design docs start at [docs/README.md](docs/README.md).

## Requirements

- Node.js 26 (`.nvmrc`)
- pnpm 12 (`npm i -g pnpm@12.21.0`)
- Rust stable via rustup (Tauri 2.12 needs 1.90+)
- macOS: Xcode Command Line Tools

## Commands

```bash
pnpm install        # install workspace dependencies
pnpm dev            # build packages, then open the desktop app with the engine sidecar
pnpm check          # everything CI runs: Biome, dependency rules, tsc -b, Vitest, fmt/clippy/cargo test
pnpm test           # TypeScript tests only
pnpm format         # apply Biome formatting
node services/engine/dist/cli.js --help   # headless orzeus CLI (after pnpm build)
```

## Layout

| Path                     | What it is                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `apps/desktop`           | Tauri 2 shell (`src-tauri`) and React UI (`src`)                                                       |
| `services/engine`        | `orzeusd`, the orchestration engine sidecar                                                            |
| `services/memory-server` | `orzeus-memory`, a standalone MCP server                                                               |
| `packages/*`             | Libraries: `schema`, `core`, `protocol`, `trace`, `store`, `git`, `checks`, `mcp-gateway`, `providers` |
| `tooling`                | Shared tsconfigs and repo scripts                                                                      |
| `docs`                   | Architecture, decisions (ADRs), phased plan                                                            |

Package boundaries are enforced by `pnpm check:deps`; see
[docs/architecture/01-monorepo-layout.md](docs/architecture/01-monorepo-layout.md).

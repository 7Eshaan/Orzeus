# 0005. Tooling: pnpm, TS 7 project references, Biome, Vitest

Status: Accepted (2026-11-19, approved by Ryu)

## Context

TypeScript 7 (native Go compiler) is stable and fast, especially with project references built
in parallel. It no longer ships the old JavaScript compiler API, so tools that relied on that
API, including type-aware ESLint setups, may lag behind.

## Decision

- **pnpm workspaces** with a strict `node-linker` (no phantom dependencies), pinned via
  `packageManager` in `package.json` (Corepack is no longer bundled with Node 25+, so pnpm is
  installed with `npm i -g pnpm@<version>`).
- **TypeScript 7** with a root solution `tsconfig.json` and per-package `composite` projects.
  `isolatedDeclarations` stays off: it would force hand-written types on every exported Zod
  schema, which is where most of our public API lives.
- **Biome** for formatting and linting (no dependency on the TS compiler API).
- **Vitest** with `fast-check` for property tests, `expectTypeOf` for type-level tests.
- **Rust:** `rustfmt`, `clippy -D warnings`.
- A single `pnpm check` gate (format, lint, types, tests, dependency rules, Rust checks) runs
  locally and in CI (GitHub Actions on macOS).

## Consequences

- Fast feedback: full typecheck of the monorepo in seconds.
- If we need type-aware lint rules later, we revisit once typescript-eslint supports the TS 7 API.

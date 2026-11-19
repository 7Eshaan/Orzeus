# @orzeus/core

Pure domain logic: DAG validation, run and node reducers, scheduler decisions, router, policy evaluation, budget math, retry backoff. Defines the ports (interfaces) for everything with side effects.

## Rules

Pure. No IO, no Node or DOM APIs. Deterministic: no clocks or randomness inside reducers.

## Status

Implemented in Phase 1.

Main entry points: `validatePlan`, `applyEvent` / `replay` (the state machine), `decideNext` (scheduler), `decideAfterFailure` / `backoffDelayMs`, `nodeBudgetTrips`, `evaluatePolicy`. Ports for side effects are in `src/ports.ts`. Test helpers (`buildDag`, `InMemoryRunLog`, `simulateRun`) are exported from `@orzeus/core/testing`.

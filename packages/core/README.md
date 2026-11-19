# @orzeus/core

Pure domain logic: DAG validation, run and node reducers, scheduler decisions, router, policy evaluation, budget math, retry backoff. Defines the ports (interfaces) for everything with side effects.

## Rules

Pure. No IO, no Node or DOM APIs. Deterministic: no clocks or randomness inside reducers.

## Status

Skeleton (Phase 0). See [docs/plan/phased-plan.md](../../docs/plan/phased-plan.md) for when it gets built.

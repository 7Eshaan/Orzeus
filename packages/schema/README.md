# @orzeus/schema

Zod schemas and inferred types for TaskDAG, ContextPacket, TraceEvent, PlannerOutput and policies. The single source of truth for data shapes.

## Rules

Pure. Depends only on zod. No IO, no Node or DOM APIs.

## Status

Implemented in Phase 1.

Entry points: everything is exported from `src/index.ts`. Parse untrusted input with the schemas (e.g. `TaskDAG.safeParse`) or with `parseEventDraft` / `parseTraceEvent` for events.

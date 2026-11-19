# 0004. One hash-chained event log is both the state store and the audit trace

Status: Accepted (2026-11-19, approved by Ryu)

## Context

The brief asks for an event-sourced DAG state machine and, separately, an immutable hash-chained
audit trace. Keeping two logs invites drift: the audit trail could say one thing while the
state says another.

## Decision

A single append-only `events` table per run, hash-chained with SHA-256 over RFC 8785 canonical
JSON, with large content in a content-addressed blob table. All run state (nodes, approvals,
usage, checkpoints) is a projection produced by pure reducers in `@orzeus/core`, used both live
and for replay. SQLite triggers reject updates, deletes, sequence gaps and broken links.

## Consequences

- Verifying the trace also verifies the state history. Crash recovery is replay.
- Rollback is a new event, never a deletion.
- Reducers must be deterministic (no clocks or randomness inside; timestamps come from events).
  Property tests check that replay equals live state.
- Event payload changes need versioned upcasters; `v` on the envelope supports this.

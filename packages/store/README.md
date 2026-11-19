# @orzeus/store

SQLite persistence: migrations, append-only event store, projections, content-addressed blobs, checkpoints. Implements core's EventStore and BlobStore ports.

## Rules

The only package that talks to SQLite. Opens the database through a small Db port over node:sqlite.

## Status

Skeleton (Phase 0). See [docs/plan/phased-plan.md](../../docs/plan/phased-plan.md) for when it gets built.

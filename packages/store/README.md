# @orzeus/store

SQLite persistence: migrations, append-only event store, projections, content-addressed blobs, checkpoints. Implements core's EventStore and BlobStore ports.

## Rules

The only package that talks to SQLite. Opens the database through a small Db port over node:sqlite.

## Status

Implemented in Phase 1.

Entry points: `openStore(path)` (open + migrate), `SqliteRunStore` (append, load, events, verify, rebuildProjections), `BlobStore`. Migrations live in `src/migrations/` and must match `docs/architecture/03-sqlite-schema.md` (a test enforces it).

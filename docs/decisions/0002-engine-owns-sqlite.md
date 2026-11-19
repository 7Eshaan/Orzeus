# 0002. The engine is the single SQLite writer

Status: Accepted (2026-11-19, approved by Ryu)

## Context

The brief lists `tauri-plugin-sql`. That plugin gives the webview SQL access. With the engine
in a sidecar (ADR 0001), two processes would share one database, and the UI would be coupled to
table layouts that are meant to be private, rebuildable projections.

## Decision

The engine opens `orzeus.db` with `node:sqlite` (Node 26, stability "release candidate") behind
a small `Db` port in `@orzeus/store`, so `better-sqlite3` can replace it without touching
callers. WAL mode, `synchronous = FULL`. The UI receives typed projections and live updates
through `@orzeus/protocol`. `tauri-plugin-sql` is not used in v1.

## Consequences

- One writer, no cross-process locking surprises, schema changes stay inside one package.
- The UI cannot run ad-hoc SQL. The Trace Inspector gets a filter/query RPC instead.
- If we later want read-only SQL in the UI (e.g. a power-user console), `tauri-plugin-sql` can
  open the file read-only alongside; WAL allows concurrent readers.

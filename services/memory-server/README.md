# @orzeus/memory-server

orzeus-memory: a standalone MCP server (stdio) for persistent repo decisions, constraints and conventions, backed by its own memory.db.

## Rules

Standalone: usable without the rest of Orzeus.

## Status

Implemented in Phase 3. `orzeus-memory --db <memory.db> --repo <root>` serves one repository's
memory over MCP stdio: `memory_search` and `memory_get` (annotated read-only), `memory_propose`
and `memory_supersede` (writes, so the gateway's policy asks a human), and `memory://{id}`
resources. Search is SQLite FTS5 with user text always quoted, never passed as FTS syntax. The
engine also reads the same `MemoryStore` directly when planning, and `orzeus memory add` seeds it.

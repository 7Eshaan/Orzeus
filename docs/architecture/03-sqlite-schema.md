# SQLite schema

One database file per installation, `orzeus.db` in the app data directory, owned by the engine
(single writer, see ADR 0002). The memory MCP server keeps its own file, `memory.db`, so it
stays usable on its own.

## Principles

- **Event sourced.** `events` is the source of truth and is append-only (enforced by triggers).
  Every other run table is a **projection** that can be dropped and rebuilt by replaying events
  through the same reducers `core` uses live.
- **Projection writes happen in the same transaction as the event append**, so a crash leaves
  either both or neither.
- `STRICT` tables, integer unix-ms timestamps, integer micro-USD, JSON stored as `TEXT`
  validated by Zod on the way in and out (plus `json_valid` checks where cheap).
- Large content goes to the content-addressed `blobs` table; events hold hashes.
- Forward-only numbered migrations in `packages/store/src/migrations/NNNN_name.ts` (SQL kept
  as TypeScript string modules so they ship inside the engine bundle), each applied in its own
  transaction and recorded in `schema_migrations` with a checksum, so an edited migration is
  detected. The runner creates `schema_migrations` itself.
- Usage and quota tables exist from migration 1, but their projections arrive with telemetry in
  Phase 6.

## Connection settings

```sql
PRAGMA journal_mode = WAL;        -- readers never block the writer
PRAGMA synchronous = FULL;        -- audit log: survive power loss, write rate is low anyway
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
PRAGMA wal_autocheckpoint = 1000;
```

`PRAGMA integrity_check` runs on startup after an unclean shutdown, and `orzeus trace verify`
runs on any run being resumed.

## Migration 0001 (init)

```sql
-- ───────────── Configuration ─────────────

CREATE TABLE projects (
  id             TEXT    PRIMARY KEY,               -- ULID
  name           TEXT    NOT NULL,
  repo_root      TEXT    NOT NULL UNIQUE,
  default_branch TEXT    NOT NULL,
  settings_json  TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  created_at     INTEGER NOT NULL
) STRICT;

-- One row per connected account. Secrets are NOT here: secret_ref names a keychain item.
CREATE TABLE provider_accounts (
  id            TEXT    PRIMARY KEY,
  provider      TEXT    NOT NULL,                   -- ProviderId
  adapter       TEXT    NOT NULL,                   -- adapter id
  label         TEXT    NOT NULL,
  auth_kind     TEXT    NOT NULL CHECK (auth_kind IN ('api_key','own_cli_login','service_account','none')),
  secret_ref    TEXT,                               -- keychain item name, never the secret
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  soft_caps_json TEXT   NOT NULL DEFAULT '{}' CHECK (json_valid(soft_caps_json)),
  created_at    INTEGER NOT NULL,
  -- No automated multi-account rotation: at most one enabled subscription login per adapter.
  CHECK (auth_kind <> 'api_key' OR secret_ref IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX one_cli_login_per_adapter
  ON provider_accounts (adapter) WHERE auth_kind = 'own_cli_login' AND enabled = 1;

-- Versioned policy documents (approval rules, tool allowlists, budget defaults).
CREATE TABLE policies (
  id          TEXT    PRIMARY KEY,
  project_id  TEXT    REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = global
  version     INTEGER NOT NULL,
  body_json   TEXT    NOT NULL CHECK (json_valid(body_json)),
  active      INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  created_at  INTEGER NOT NULL,
  UNIQUE (project_id, version)
) STRICT;

-- Upstream MCP servers the user has configured.
CREATE TABLE mcp_servers (
  id            TEXT    PRIMARY KEY,
  project_id    TEXT    REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  transport     TEXT    NOT NULL CHECK (transport IN ('stdio','streamable_http')),
  config_json   TEXT    NOT NULL CHECK (json_valid(config_json)),   -- command/args or url
  oauth_issuer  TEXT,                                -- credentials keyed by issuer (MCP spec)
  secret_ref    TEXT,
  discovered_json TEXT CHECK (discovered_json IS NULL OR json_valid(discovered_json)), -- server/discover result
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  UNIQUE (project_id, name)
) STRICT;

-- ───────────── Event store (source of truth) ─────────────

CREATE TABLE runs (
  id            TEXT    PRIMARY KEY,                -- RunId (ULID)
  project_id    TEXT    NOT NULL REFERENCES projects(id),
  goal          TEXT    NOT NULL,
  -- projection fields, rebuilt from events:
  status        TEXT    NOT NULL,
  dag_revision  INTEGER NOT NULL DEFAULT 0,
  head_seq      INTEGER NOT NULL DEFAULT 0,
  head_hash     TEXT,
  cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  frontier_tokens INTEGER NOT NULL DEFAULT 0,
  worker_tokens   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;

CREATE INDEX runs_by_project ON runs (project_id, created_at DESC);

CREATE TABLE events (
  run_id       TEXT    NOT NULL REFERENCES runs(id),
  seq          INTEGER NOT NULL CHECK (seq >= 1),
  ts           INTEGER NOT NULL,
  type         TEXT    NOT NULL,
  node_id      TEXT,
  attempt      INTEGER,
  actor_json   TEXT    NOT NULL CHECK (json_valid(actor_json)),
  payload_json TEXT    NOT NULL CHECK (json_valid(payload_json)),
  blobs_json   TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(blobs_json)),
  otel_trace_id TEXT   NOT NULL,
  otel_span_id  TEXT   NOT NULL,
  otel_parent_span_id TEXT,
  prev_hash    TEXT,
  hash         TEXT    NOT NULL UNIQUE,
  PRIMARY KEY (run_id, seq),
  CHECK ((seq = 1) = (prev_hash IS NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX events_by_node ON events (run_id, node_id, seq);
CREATE INDEX events_by_type ON events (run_id, type, seq);

-- Append-only, gap-free.
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TRIGGER events_gap_free BEFORE INSERT ON events
WHEN NEW.seq <> COALESCE((SELECT MAX(seq) FROM events WHERE run_id = NEW.run_id), 0) + 1
BEGIN SELECT RAISE(ABORT, 'event seq must be contiguous'); END;

CREATE TRIGGER events_chain_link BEFORE INSERT ON events
WHEN NEW.seq > 1 AND NEW.prev_hash IS NOT
     (SELECT hash FROM events WHERE run_id = NEW.run_id AND seq = NEW.seq - 1)
BEGIN SELECT RAISE(ABORT, 'prev_hash does not match previous event'); END;

-- Content-addressed storage for packets, diffs, prompts, check output.
CREATE TABLE blobs (
  hash         TEXT    PRIMARY KEY,                 -- sha256 of uncompressed bytes
  media_type   TEXT    NOT NULL,
  size         INTEGER NOT NULL,
  encoding     TEXT    NOT NULL CHECK (encoding IN ('identity','zstd')),
  bytes        BLOB    NOT NULL,
  created_at   INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TRIGGER blobs_no_update BEFORE UPDATE ON blobs
BEGIN SELECT RAISE(ABORT, 'blobs are immutable'); END;

-- ───────────── Projections (rebuildable) ─────────────

CREATE TABLE nodes (
  run_id        TEXT    NOT NULL REFERENCES runs(id),
  node_id       TEXT    NOT NULL,
  title         TEXT    NOT NULL,
  kind          TEXT    NOT NULL,
  tier          TEXT    NOT NULL CHECK (tier IN ('frontier','worker','local')),
  status        TEXT    NOT NULL,
  attempt       INTEGER NOT NULL DEFAULT 0,
  steers        INTEGER NOT NULL DEFAULT 0,
  packet_hash   TEXT,
  account_id    TEXT,
  model         TEXT,
  worktree_path TEXT,
  branch        TEXT,
  base_commit   TEXT,
  head_commit   TEXT,
  lease_owner   TEXT,                                -- engine instance id
  lease_expires_at INTEGER,                          -- heartbeat; stale lease = crashed worker
  retry_at      INTEGER,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  last_error_class   TEXT,
  last_error_message TEXT,
  summary       TEXT,
  updated_seq   INTEGER NOT NULL,
  PRIMARY KEY (run_id, node_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX nodes_by_status ON nodes (status, retry_at);

CREATE TABLE node_deps (
  run_id     TEXT NOT NULL,
  node_id    TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (run_id, node_id, depends_on),
  FOREIGN KEY (run_id, node_id)    REFERENCES nodes(run_id, node_id),
  FOREIGN KEY (run_id, depends_on) REFERENCES nodes(run_id, node_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE attempts (
  run_id        TEXT    NOT NULL,
  node_id       TEXT    NOT NULL,
  attempt       INTEGER NOT NULL,
  account_id    TEXT,
  model         TEXT,
  started_seq   INTEGER NOT NULL,
  ended_seq     INTEGER,
  outcome       TEXT,                                -- SessionOutcome.status
  error_class   TEXT,
  resume_token  TEXT,                                -- provider session/thread id
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, node_id, attempt),
  FOREIGN KEY (run_id, node_id) REFERENCES nodes(run_id, node_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE approvals (
  id            TEXT    PRIMARY KEY,                 -- ApprovalId
  run_id        TEXT    NOT NULL REFERENCES runs(id),
  node_id       TEXT,
  kind          TEXT    NOT NULL,                    -- shell | file_delete | mcp_call | merge | budget_threshold | ...
  status        TEXT    NOT NULL CHECK (status IN ('pending','approved','denied','steered','expired')),
  action_json   TEXT    NOT NULL CHECK (json_valid(action_json)),
  decision_json TEXT    CHECK (decision_json IS NULL OR json_valid(decision_json)),
  requested_seq INTEGER NOT NULL,
  resolved_seq  INTEGER,
  requested_at  INTEGER NOT NULL,
  resolved_at   INTEGER
) STRICT;

CREATE INDEX approvals_pending ON approvals (status, requested_at) WHERE status = 'pending';

CREATE TABLE checkpoints (
  id            TEXT    PRIMARY KEY,
  run_id        TEXT    NOT NULL REFERENCES runs(id),
  at_seq        INTEGER NOT NULL,
  label         TEXT    NOT NULL,
  -- git refs per worktree at this point, so rollback can restore code and state together
  refs_json     TEXT    NOT NULL CHECK (json_valid(refs_json)),
  snapshot_blob TEXT    REFERENCES blobs(hash),      -- optional projection snapshot for fast replay
  created_at    INTEGER NOT NULL
) STRICT;

-- Episodic memory: one compact summary per finished node, fed to dependents and the reviewer.
CREATE TABLE node_summaries (
  run_id     TEXT    NOT NULL,
  node_id    TEXT    NOT NULL,
  attempt    INTEGER NOT NULL,
  summary    TEXT    NOT NULL,
  created_seq INTEGER NOT NULL,
  PRIMARY KEY (run_id, node_id, attempt)
) STRICT, WITHOUT ROWID;

-- ───────────── Usage and quota telemetry ─────────────

CREATE TABLE usage_samples (
  id             INTEGER PRIMARY KEY,
  account_id     TEXT    NOT NULL REFERENCES provider_accounts(id),
  model          TEXT    NOT NULL,
  tier           TEXT    NOT NULL,
  purpose        TEXT    NOT NULL CHECK (purpose IN ('plan','work','steer','review')),
  run_id         TEXT,
  node_id        TEXT,
  ts             INTEGER NOT NULL,
  input_tokens   INTEGER NOT NULL,
  output_tokens  INTEGER NOT NULL,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd INTEGER,                            -- NULL for subscription usage
  -- estimated cost had the frontier model done this work (for "Frontier Quota Saved")
  frontier_equiv_micro_usd INTEGER,
  source         TEXT    NOT NULL CHECK (source IN ('exact','estimated'))
) STRICT;

CREATE INDEX usage_by_account_time ON usage_samples (account_id, ts);

CREATE TABLE quota_observations (
  id            INTEGER PRIMARY KEY,
  account_id    TEXT    NOT NULL REFERENCES provider_accounts(id),
  window        TEXT    NOT NULL,                    -- '5h', '7d', bucket id
  used_percent  REAL,
  resets_at     INTEGER,
  status        TEXT    NOT NULL CHECK (status IN ('ok','warning','limited')),
  source        TEXT    NOT NULL CHECK (source IN ('official_api','cli_event','response_headers','local_estimate')),
  observed_at   INTEGER NOT NULL
) STRICT;

CREATE INDEX quota_latest ON quota_observations (account_id, window, observed_at DESC);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json))
) STRICT, WITHOUT ROWID;
```

`mcp_servers` in practice (Phase 5): rows are global for now (`project_id` NULL).
`config_json` holds `{config, defaultGrant}`, `secret_ref` names the Keychain entry
`mcp.<id>`, and `discovered_json` is the last connection test (its tools, or the error).

## Migration 0002 (run locks)

```sql
CREATE TABLE run_locks (
  run_id       TEXT    PRIMARY KEY REFERENCES runs(id),
  owner        TEXT    NOT NULL,
  pid          INTEGER NOT NULL,
  acquired_at  INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
```

Operational state, not history: which engine process owns a run. Engines heartbeat their lock;
an expired lock belongs to a crashed engine and may be taken over by `orzeus resume`.

## memory.db (orzeus-memory MCP server)

```sql
CREATE TABLE memories (
  id          TEXT    PRIMARY KEY,
  repo_root   TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('decision','constraint','convention','gotcha')),
  title       TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  paths_json  TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(paths_json)), -- globs it applies to
  source_run  TEXT,
  superseded_by TEXT  REFERENCES memories(id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE VIRTUAL TABLE memories_fts USING fts5(title, body, content='memories', content_rowid='rowid');

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO memories_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
```

Tools it exposes: `memory_search`, `memory_get`, `memory_propose` (write, so gated by policy),
`memory_supersede`. Resources: `memory://<id>`. Planner reads constraints from here and
distills them into packets; workers only see what their packet references.

## Recovery and rollback

- **Resume after crash:** load runs not in a terminal state, replay events into projections
  (or start from the latest checkpoint snapshot), verify the hash chain, then for each node in
  `running`/`verifying` with an expired lease append `node.retry_scheduled` (reason
  `interrupted`) and reset its worktree to the last recorded commit. Provider sessions resume
  via `attempts.resume_token` when the adapter supports it.
- **Rollback:** never deletes events. It appends `run.rolled_back`, resets worktrees to the
  checkpoint's refs (a destructive git operation, so it goes through an approval gate), and the
  reducer treats everything between the checkpoint and the rollback event as superseded.
- **Retention:** a run's events and blobs are kept until you delete the run; deletion is an
  explicit, confirmed export-then-delete that runs with the append-only triggers temporarily
  dropped inside one transaction.

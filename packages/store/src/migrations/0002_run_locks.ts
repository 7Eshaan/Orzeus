/**
 * Run locks: which engine process owns a run right now. Operational state, not history, so it
 * lives outside the event log. A lock whose heartbeat has expired belongs to a crashed engine
 * and may be taken over. Mirrors docs/architecture/03-sqlite-schema.md.
 */
export const sql = `
CREATE TABLE run_locks (
  run_id       TEXT    PRIMARY KEY REFERENCES runs(id),
  owner        TEXT    NOT NULL,
  pid          INTEGER NOT NULL,
  acquired_at  INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
`;

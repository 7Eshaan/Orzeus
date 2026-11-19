import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const MEMORY_KINDS = ["decision", "constraint", "convention", "gotcha"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface Memory {
  readonly id: string;
  readonly repoRoot: string;
  readonly kind: MemoryKind;
  readonly title: string;
  readonly body: string;
  /** Globs the memory applies to; empty means the whole repository. */
  readonly paths: readonly string[];
  readonly sourceRun: string | null;
  readonly supersededBy: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Mirrors docs/architecture/03-sqlite-schema.md (memory.db). */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id          TEXT    PRIMARY KEY,
  repo_root   TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('decision','constraint','convention','gotcha')),
  title       TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  paths_json  TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(paths_json)),
  source_run  TEXT,
  superseded_by TEXT  REFERENCES memories(id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(title, body, content='memories', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO memories_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
`;

interface Row {
  id: string;
  repo_root: string;
  kind: MemoryKind;
  title: string;
  body: string;
  paths_json: string;
  source_run: string | null;
  superseded_by: string | null;
  created_at: number;
  updated_at: number;
}

const toMemory = (r: Row): Memory => ({
  id: r.id,
  repoRoot: r.repo_root,
  kind: r.kind,
  title: r.title,
  body: r.body,
  paths: JSON.parse(r.paths_json) as string[],
  sourceRun: r.source_run,
  supersededBy: r.superseded_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Turns free text into a safe FTS5 query: every word quoted, OR-ed, so user input is never syntax. */
export function ftsQuery(text: string): string | null {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const unique = [...new Set(words.filter((w) => w.length > 1))].slice(0, 16);
  return unique.length === 0 ? null : unique.map((w) => `"${w}"`).join(" OR ");
}

/** The memory database. Superseded memories stay for history but are excluded from search. */
export class MemoryStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    this.#db.exec(SCHEMA);
    this.#now = now;
  }

  add(input: {
    repoRoot: string;
    kind: MemoryKind;
    title: string;
    body: string;
    paths?: readonly string[];
    sourceRun?: string | null;
  }): Memory {
    const id = `mem-${randomBytes(6).toString("hex")}`;
    const now = this.#now();
    this.#db
      .prepare(
        "INSERT INTO memories (id, repo_root, kind, title, body, paths_json, source_run, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.repoRoot,
        input.kind,
        input.title,
        input.body,
        JSON.stringify(input.paths ?? []),
        input.sourceRun ?? null,
        now,
        now,
      );
    return this.get(id) as Memory;
  }

  get(id: string): Memory | undefined {
    const row = this.#db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : toMemory(row);
  }

  search(repoRoot: string, text: string, limit = 5): Memory[] {
    const query = ftsQuery(text);
    if (query === null) return this.list(repoRoot).slice(0, limit);
    const rows = this.#db
      .prepare(
        `SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH ? AND m.repo_root = ? AND m.superseded_by IS NULL
         ORDER BY bm25(memories_fts) LIMIT ?`,
      )
      .all(query, repoRoot, limit) as unknown as Row[];
    return rows.map(toMemory);
  }

  list(repoRoot: string): Memory[] {
    const rows = this.#db
      .prepare(
        "SELECT * FROM memories WHERE repo_root = ? AND superseded_by IS NULL ORDER BY created_at",
      )
      .all(repoRoot) as unknown as Row[];
    return rows.map(toMemory);
  }

  supersede(id: string, by: string): void {
    if (this.get(id) === undefined || this.get(by) === undefined)
      throw new Error("both memories must exist");
    this.#db
      .prepare("UPDATE memories SET superseded_by = ?, updated_at = ? WHERE id = ?")
      .run(by, this.#now(), id);
  }

  close(): void {
    this.#db.close();
  }
}

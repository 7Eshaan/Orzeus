import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type SqlValue = SQLInputValue;

/**
 * The small database surface the store needs. Kept narrow so node:sqlite (release candidate in
 * Node 26) can be swapped for better-sqlite3 without touching callers (ADR 0002).
 */
export interface Db {
  exec(sql: string): void;
  run(sql: string, params?: readonly SqlValue[]): void;
  get<T>(sql: string, params?: readonly SqlValue[]): T | undefined;
  all<T>(sql: string, params?: readonly SqlValue[]): T[];
  /** Runs fn in an IMMEDIATE transaction; rolls back if it throws. Not reentrant. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface OpenOptions {
  /** File path, or ":memory:" for tests. */
  readonly path: string;
}

const PRAGMAS = [
  "PRAGMA journal_mode = WAL", // readers never block the writer
  "PRAGMA synchronous = FULL", // audit log: survive power loss; our write rate is low
  "PRAGMA foreign_keys = ON",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA temp_store = MEMORY",
];

export function openDatabase(options: OpenOptions): Db {
  const db = new DatabaseSync(options.path);
  for (const pragma of PRAGMAS) db.exec(pragma);
  let inTransaction = false;

  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => {
      db.prepare(sql).run(...params);
    },
    get: <T>(sql: string, params: readonly SqlValue[] = []) =>
      db.prepare(sql).get(...params) as T | undefined,
    all: <T>(sql: string, params: readonly SqlValue[] = []) =>
      db.prepare(sql).all(...params) as T[],
    transaction<T>(fn: () => T): T {
      if (inTransaction) throw new Error("nested transactions are not supported");
      inTransaction = true;
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    close: () => db.close(),
  };
}

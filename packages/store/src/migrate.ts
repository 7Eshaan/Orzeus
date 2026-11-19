import type { Db } from "./db.js";
import { sha256Text } from "./hash.js";
import { MIGRATIONS, type Migration } from "./migrations/index.js";

export class MigrationError extends Error {
  override readonly name = "MigrationError";
}

/**
 * Applies pending migrations, each in its own transaction, and verifies that already-applied
 * migrations have not been edited since (by checksum). Returns the versions applied now.
 */
export function migrate(
  db: Db,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => number = Date.now,
): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    checksum   TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
  ) STRICT`);

  const applied = new Map(
    db
      .all<{ version: number; checksum: string }>("SELECT version, checksum FROM schema_migrations")
      .map((row) => [row.version, row.checksum]),
  );

  const known = new Set(migrations.map((m) => m.version));
  for (const version of applied.keys()) {
    if (!known.has(version)) {
      throw new MigrationError(
        `database has migration ${version}, which this version of Orzeus does not know`,
      );
    }
  }

  const newlyApplied: number[] = [];
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    const checksum = sha256Text(migration.sql);
    const existing = applied.get(migration.version);
    if (existing !== undefined) {
      if (existing !== checksum) {
        throw new MigrationError(
          `migration ${migration.version} (${migration.name}) was edited after it was applied`,
        );
      }
      continue;
    }
    db.transaction(() => {
      db.exec(migration.sql);
      db.run(
        "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        [migration.version, migration.name, checksum, now()],
      );
    });
    newlyApplied.push(migration.version);
  }
  return newlyApplied;
}

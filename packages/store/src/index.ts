/**
 * @orzeus/store
 *
 * SQLite persistence for Orzeus: migrations, the append-only event store with its projections,
 * content-addressed blobs, chain verification and projection rebuilds. The only package that
 * talks to SQLite.
 */
export { BlobStore, type StoredBlob } from "./blobs.js";
export { type Db, type OpenOptions, openDatabase, type SqlValue } from "./db.js";
export { sha256Bytes, sha256Text } from "./hash.js";
export { type McpServerRecord, McpServers } from "./mcp-servers.js";
export { MigrationError, migrate } from "./migrate.js";
export { MIGRATIONS, type Migration } from "./migrations/index.js";
export { type AcquireResult, type LockHolder, RunLocks } from "./run-locks.js";
export {
  CorruptEventError,
  InvalidDraftError,
  type ProjectRecord,
  type RunVerification,
  SqliteRunStore,
  TransitionRejectedError,
} from "./run-store.js";
export { type AccountRecord, Telemetry } from "./telemetry.js";

import { type Db, openDatabase } from "./db.js";
import { migrate } from "./migrate.js";

/** Opens (creating if needed) and migrates an Orzeus database. */
export function openStore(path: string): Db {
  const db = openDatabase({ path });
  migrate(db);
  return db;
}

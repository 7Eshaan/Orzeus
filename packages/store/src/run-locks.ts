import type { RunId } from "@orzeus/schema";
import type { Db } from "./db.js";

export interface LockHolder {
  readonly owner: string;
  readonly pid: number;
  readonly expiresAt: number;
}

export type AcquireResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly heldBy: LockHolder };

/**
 * One engine per run. A lock is taken atomically, kept alive by heartbeats, and released at the
 * end; if the owner crashes, the lock simply expires and another engine may take over.
 */
export class RunLocks {
  readonly #db: Db;
  readonly #now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  acquire(runId: RunId, owner: string, pid: number, ttlMs: number): AcquireResult {
    return this.#db.transaction(() => {
      const now = this.#now();
      const current = this.#db.get<{ owner: string; pid: number; expires_at: number }>(
        "SELECT owner, pid, expires_at FROM run_locks WHERE run_id = ?",
        [runId],
      );
      if (current !== undefined && current.owner !== owner && current.expires_at > now) {
        return {
          ok: false as const,
          heldBy: { owner: current.owner, pid: current.pid, expiresAt: current.expires_at },
        };
      }
      this.#db.run(
        `INSERT INTO run_locks (run_id, owner, pid, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET owner = excluded.owner, pid = excluded.pid, acquired_at = excluded.acquired_at,
           heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at`,
        [runId, owner, pid, now, now, now + ttlMs],
      );
      return { ok: true as const };
    });
  }

  /** Extends the lock; false if it was lost (expired and taken by someone else). */
  heartbeat(runId: RunId, owner: string, ttlMs: number): boolean {
    const now = this.#now();
    this.#db.run(
      "UPDATE run_locks SET heartbeat_at = ?, expires_at = ? WHERE run_id = ? AND owner = ?",
      [now, now + ttlMs, runId, owner],
    );
    return (
      this.#db.get("SELECT 1 AS held FROM run_locks WHERE run_id = ? AND owner = ?", [
        runId,
        owner,
      ]) !== undefined
    );
  }

  release(runId: RunId, owner: string): void {
    this.#db.run("DELETE FROM run_locks WHERE run_id = ? AND owner = ?", [runId, owner]);
  }

  holder(runId: RunId): LockHolder | null {
    const row = this.#db.get<{ owner: string; pid: number; expires_at: number }>(
      "SELECT owner, pid, expires_at FROM run_locks WHERE run_id = ?",
      [runId],
    );
    return row === undefined ? null : { owner: row.owner, pid: row.pid, expiresAt: row.expires_at };
  }
}

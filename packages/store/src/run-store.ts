import {
  applyEvent,
  type RunEventStore,
  type RunState,
  replay,
  type TransitionError,
} from "@orzeus/core";
import {
  type EventDraft,
  parseEventDraft,
  parseTraceEvent,
  type RunId,
  type Sha256,
  type TraceEvent,
} from "@orzeus/schema";
import { type ChainVerification, type HashFn, sealEvent, verifyChain } from "@orzeus/trace";
import { BlobStore } from "./blobs.js";
import type { Db } from "./db.js";
import { sha256Text } from "./hash.js";
import { clearProjections, projectEvent } from "./projections.js";

export class InvalidDraftError extends Error {
  override readonly name = "InvalidDraftError";
}

/** The reducer refused an event; nothing from that append was written. */
export class TransitionRejectedError extends Error {
  override readonly name = "TransitionRejectedError";
  readonly detail: TransitionError;

  constructor(detail: TransitionError) {
    super(`${detail.type} (seq ${detail.seq}) rejected: ${detail.message}`);
    this.detail = detail;
  }
}

/** A stored event failed validation: the database was edited outside Orzeus or is corrupt. */
export class CorruptEventError extends Error {
  override readonly name = "CorruptEventError";
}

export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly repoRoot: string;
  readonly defaultBranch: string;
  readonly createdAt: number;
}

export type RunVerification =
  | ChainVerification
  | { readonly ok: false; readonly seq: number; readonly reason: string; readonly blob: Sha256 };

interface EventRow {
  run_id: string;
  seq: number;
  ts: number;
  type: string;
  node_id: string | null;
  attempt: number | null;
  actor_json: string;
  payload_json: string;
  blobs_json: string;
  otel_trace_id: string;
  otel_span_id: string;
  otel_parent_span_id: string | null;
  prev_hash: string | null;
  hash: string;
}

/**
 * SQLite implementation of the RunEventStore port. The single writer of orzeus.db (ADR 0002).
 *
 * Every append validates each draft, seals it into the hash chain, applies the core reducer,
 * inserts the event and updates projections, all in one IMMEDIATE transaction.
 */
export class SqliteRunStore implements RunEventStore {
  readonly blobs: BlobStore;
  readonly #db: Db;
  readonly #hash: HashFn;
  readonly #states = new Map<RunId, RunState>();

  readonly #listeners = new Set<(runId: RunId, state: RunState) => void>();

  constructor(db: Db, options: { readonly hash?: HashFn } = {}) {
    this.#db = db;
    this.#hash = options.hash ?? sha256Text;
    this.blobs = new BlobStore(db);
  }

  /** Called after every committed append (for live UI updates). Returns an unsubscribe function. */
  onAppend(listener: (runId: RunId, state: RunState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Every run, newest first. */
  runIds(): RunId[] {
    return this.#db
      .all<{ id: RunId }>("SELECT id FROM runs ORDER BY created_at DESC")
      .map((r) => r.id);
  }

  ensureProject(project: ProjectRecord): void {
    this.#db.run(
      "INSERT INTO projects (id, name, repo_root, default_branch, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
      [project.id, project.name, project.repoRoot, project.defaultBranch, project.createdAt],
    );
  }

  append(runId: RunId, drafts: readonly EventDraft[]): RunState {
    if (drafts.length === 0) throw new InvalidDraftError("append needs at least one draft");
    const parsed = drafts.map((draft, index) => {
      const result = parseEventDraft(draft);
      if (!result.ok)
        throw new InvalidDraftError(`draft ${index} (${draft.type}): ${result.error}`);
      return result.value;
    });

    const final = this.#db.transaction(() => {
      let state = this.load(runId);
      for (const draft of parsed) {
        const head = state === null ? null : { seq: state.headSeq, hash: state.headHash };
        const event = sealEvent(runId, draft, head, this.#hash);
        const next = applyEvent(state, event);
        if (!next.ok) throw new TransitionRejectedError(next.error);
        // Projections first: the runs row must exist before its first event (foreign key).
        projectEvent(this.#db, event, state, next.value);
        this.#insertEvent(event);
        state = next.value;
      }
      return state as RunState;
    });
    this.#states.set(runId, final);
    for (const listener of this.#listeners) {
      try {
        listener(runId, final);
      } catch {
        // listeners must not break appends
      }
    }
    return final;
  }

  load(runId: RunId): RunState | null {
    const cached = this.#states.get(runId);
    if (cached !== undefined) return cached;
    const result = replay(this.events(runId));
    if (!result.ok)
      throw new CorruptEventError(`run ${runId} does not replay: ${result.error.message}`);
    if (result.value !== null) this.#states.set(runId, result.value);
    return result.value;
  }

  events(runId: RunId): TraceEvent[] {
    return this.#db
      .all<EventRow>("SELECT * FROM events WHERE run_id = ? ORDER BY seq", [runId])
      .map((row) => {
        const parsed = parseTraceEvent({
          v: 1,
          runId: row.run_id,
          seq: row.seq,
          ts: row.ts,
          type: row.type,
          nodeId: row.node_id,
          attempt: row.attempt,
          actor: JSON.parse(row.actor_json) as unknown,
          payload: JSON.parse(row.payload_json) as unknown,
          blobs: JSON.parse(row.blobs_json) as unknown,
          otel: {
            traceId: row.otel_trace_id,
            spanId: row.otel_span_id,
            parentSpanId: row.otel_parent_span_id,
          },
          prevHash: row.prev_hash,
          hash: row.hash,
        });
        if (!parsed.ok) throw new CorruptEventError(`run ${runId} seq ${row.seq}: ${parsed.error}`);
        return parsed.value;
      });
  }

  /** Verifies the hash chain and every blob the events reference. */
  verify(runId: RunId): RunVerification {
    const events = this.events(runId);
    const chain = verifyChain(events, this.#hash);
    if (!chain.ok) return chain;
    for (const event of events) {
      for (const blob of event.blobs) {
        if (!this.blobs.verify(blob))
          return { ok: false, seq: event.seq, reason: "missing or corrupt blob", blob };
      }
    }
    return chain;
  }

  /** Drops and rebuilds a run's projections from its events. */
  rebuildProjections(runId: RunId): RunState | null {
    const events = this.events(runId);
    const state = this.#db.transaction(() => {
      clearProjections(this.#db, runId);
      let current: RunState | null = null;
      for (const event of events) {
        const next = applyEvent(current, event);
        if (!next.ok)
          throw new CorruptEventError(`run ${runId} does not replay: ${next.error.message}`);
        projectEvent(this.#db, event, current, next.value);
        current = next.value;
      }
      return current;
    });
    if (state === null) this.#states.delete(runId);
    else this.#states.set(runId, state);
    return state;
  }

  /** Forgets cached state, e.g. to simulate a restart in tests. */
  clearCache(): void {
    this.#states.clear();
  }

  #insertEvent(event: TraceEvent): void {
    this.#db.run(
      `INSERT INTO events (run_id, seq, ts, type, node_id, attempt, actor_json, payload_json, blobs_json,
                           otel_trace_id, otel_span_id, otel_parent_span_id, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.runId,
        event.seq,
        event.ts,
        event.type,
        event.nodeId,
        event.attempt,
        JSON.stringify(event.actor),
        JSON.stringify(event.payload),
        JSON.stringify(event.blobs),
        event.otel.traceId,
        event.otel.spanId,
        event.otel.parentSpanId,
        event.prevHash,
        event.hash,
      ],
    );
  }
}

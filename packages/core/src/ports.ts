import type { EventDraft, RunId, TraceEvent, UnixMs } from "@orzeus/schema";
import type { RunState } from "./state.js";

/**
 * Durable, append-only storage for run events plus the projections derived from them.
 * Implemented by @orzeus/store. Appends are atomic: every draft in a call is validated with
 * the reducer, sealed into the hash chain and persisted together with its projections, or
 * nothing is written.
 */
export interface RunEventStore {
  /** Appends drafts to a run (the first draft of a new run must be run.created). */
  append(runId: RunId, drafts: readonly EventDraft[]): RunState;
  /** Current state from projections, or null if the run does not exist. */
  load(runId: RunId): RunState | null;
  /** All events of a run in order. */
  events(runId: RunId): TraceEvent[];
}

export interface Clock {
  now(): UnixMs;
}

/** Uniform random number in [0, 1). Injected so scheduling decisions are reproducible in tests. */
export type Random = () => number;

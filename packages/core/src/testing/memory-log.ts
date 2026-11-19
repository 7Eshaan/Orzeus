import type { EventDraft, RunId, Sha256, TraceEvent } from "@orzeus/schema";
import type { RunEventStore } from "../ports.js";
import { applyEvent } from "../reducer.js";
import type { RunState } from "../state.js";

/**
 * In-memory RunEventStore for core tests. Uses a fake but well-formed hash (the reducer checks
 * links, not content); @orzeus/store is tested with real hashing.
 */
export class InMemoryRunLog implements RunEventStore {
  readonly #events = new Map<RunId, TraceEvent[]>();
  readonly #states = new Map<RunId, RunState>();
  #counter = 0;

  append(runId: RunId, drafts: readonly EventDraft[]): RunState {
    const events = this.#events.get(runId) ?? [];
    let state = this.#states.get(runId) ?? null;
    const sealed: TraceEvent[] = [];
    for (const d of drafts) {
      const prev = sealed.at(-1) ?? events.at(-1);
      this.#counter++;
      const event = {
        v: 1,
        runId,
        seq: (prev?.seq ?? 0) + 1,
        prevHash: prev?.hash ?? null,
        ...d,
        hash: this.#counter.toString(16).padStart(64, "0") as Sha256,
      } as TraceEvent;
      const next = applyEvent(state, event);
      if (!next.ok)
        throw new Error(`rejected ${event.type} (seq ${event.seq}): ${next.error.message}`);
      state = next.value;
      sealed.push(event);
    }
    if (state === null) throw new Error("append needs at least one draft");
    this.#events.set(runId, [...events, ...sealed]);
    this.#states.set(runId, state);
    return state;
  }

  load(runId: RunId): RunState | null {
    return this.#states.get(runId) ?? null;
  }

  events(runId: RunId): TraceEvent[] {
    return [...(this.#events.get(runId) ?? [])];
  }
}

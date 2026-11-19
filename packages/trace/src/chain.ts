import type { EventDraft, RunId, Sha256, TraceEvent } from "@orzeus/schema";
import { canonicalize } from "./canonical-json.js";

/**
 * SHA-256 of the UTF-8 encoding of `text`, as lowercase hex. Injected so this package stays
 * free of platform APIs; @orzeus/store provides the node:crypto implementation.
 */
export type HashFn = (text: string) => Sha256;

/** Hash of a value's canonical JSON. Used for packets, tool arguments and results. */
export function contentHash(value: unknown, hash: HashFn): Sha256 {
  return hash(canonicalize(value));
}

export interface ChainHead {
  readonly seq: number;
  readonly hash: Sha256;
}

/**
 * Turns a draft into a sealed event that extends the chain after `head` (null for the first
 * event of a run). The hash covers every field except itself, including prevHash.
 */
export function sealEvent(
  runId: RunId,
  draft: EventDraft,
  head: ChainHead | null,
  hash: HashFn,
): TraceEvent {
  const unsealed = {
    v: 1 as const,
    runId,
    seq: head === null ? 1 : head.seq + 1,
    prevHash: head === null ? null : head.hash,
    ...draft,
  };
  return { ...unsealed, hash: hash(canonicalize(unsealed)) } as TraceEvent;
}

/** Recomputes an event's hash from its contents. */
export function computeEventHash(event: TraceEvent, hash: HashFn): Sha256 {
  const { hash: _ignored, ...unsealed } = event;
  return hash(canonicalize(unsealed));
}

export type ChainVerification =
  | { readonly ok: true; readonly head: ChainHead | null }
  | { readonly ok: false; readonly seq: number; readonly reason: string };

/**
 * Verifies a run's events in order: contiguous seq from 1, each prevHash links to the previous
 * hash, every hash matches the content, and every event belongs to the same run.
 */
export function verifyChain(events: readonly TraceEvent[], hash: HashFn): ChainVerification {
  let head: ChainHead | null = null;
  const runId = events[0]?.runId;
  for (const event of events) {
    const expectedSeq: number = head === null ? 1 : head.seq + 1;
    if (event.runId !== runId)
      return { ok: false, seq: event.seq, reason: "event belongs to another run" };
    if (event.seq !== expectedSeq) {
      return { ok: false, seq: event.seq, reason: `expected seq ${expectedSeq}` };
    }
    const expectedPrev: Sha256 | null = head === null ? null : head.hash;
    if (event.prevHash !== expectedPrev)
      return { ok: false, seq: event.seq, reason: "broken prevHash link" };
    if (computeEventHash(event, hash) !== event.hash) {
      return { ok: false, seq: event.seq, reason: "hash does not match content" };
    }
    head = { seq: event.seq, hash: event.hash };
  }
  return { ok: true, head };
}

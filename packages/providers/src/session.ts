import { type ApprovalDecision, type TokenUsage, ZERO_USAGE } from "@orzeus/schema";
import type { AdapterEvent, AgentSession, SessionOutcome } from "./adapter.js";

/** Single-consumer async queue that ends when closed. */
export class EventQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #waiting: ((result: IteratorResult<T>) => void) | null = null;
  #closed = false;

  push(item: T): void {
    if (this.#closed) return;
    if (this.#waiting !== null) {
      const resolve = this.#waiting;
      this.#waiting = null;
      resolve({ value: item, done: false });
    } else {
      this.#items.push(item);
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#waiting !== null) {
      const resolve = this.#waiting;
      this.#waiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
    };
  }
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

export interface SessionHooks {
  readonly onSteer: (message: string) => Promise<void>;
  readonly onCancel: (reason: string) => Promise<void>;
}

/**
 * Shared plumbing for adapters: the event queue, pending approvals, usage totals and a
 * once-only outcome. Adapters push events and call `finish`.
 */
export class SessionController {
  readonly events: EventQueue<AdapterEvent> = new EventQueue<AdapterEvent>();
  readonly outcome: Promise<SessionOutcome>;
  #resolve!: (outcome: SessionOutcome) => void;
  #usage: TokenUsage = ZERO_USAGE;
  #finished = false;
  readonly #pending = new Map<string, (decision: ApprovalDecision) => void>();

  constructor() {
    this.outcome = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  get usage(): TokenUsage {
    return this.#usage;
  }

  get finished(): boolean {
    return this.#finished;
  }

  emit(event: AdapterEvent): void {
    if (event.type === "usage") this.#usage = addUsage(this.#usage, event.usage);
    this.events.push(event);
  }

  /** Emits an approval_request and waits for the engine's decision. */
  requestApproval(
    requestId: string,
    action: Extract<AdapterEvent, { type: "approval_request" }>["action"],
  ): Promise<ApprovalDecision> {
    const decision = new Promise<ApprovalDecision>((resolve) =>
      this.#pending.set(requestId, resolve),
    );
    this.emit({ type: "approval_request", requestId, action });
    return decision;
  }

  respond(requestId: string, decision: ApprovalDecision): void {
    const resolve = this.#pending.get(requestId);
    if (resolve === undefined) throw new Error(`no pending approval ${requestId}`);
    this.#pending.delete(requestId);
    resolve(decision);
  }

  finish(outcome: Omit<SessionOutcome, "usage"> & { readonly usage?: TokenUsage }): void {
    if (this.#finished) return;
    this.#finished = true;
    for (const resolve of this.#pending.values())
      resolve({ kind: "deny", reason: "session ended" });
    this.#pending.clear();
    this.events.close();
    this.#resolve({ ...outcome, usage: outcome.usage ?? this.#usage });
  }

  session(hooks: SessionHooks): AgentSession {
    return {
      events: this.events,
      outcome: this.outcome,
      steer: hooks.onSteer,
      cancel: hooks.onCancel,
      respond: async (requestId, decision) => this.respond(requestId, decision),
    };
  }
}

export interface BreakerOptions {
  /** Failures with the same error class within windowMs that open the breaker. */
  readonly threshold: number;
  readonly windowMs: number;
  /** How long an open breaker refuses work before letting one trial through (half-open). */
  readonly cooldownMs: number;
}

export const DEFAULT_BREAKER: BreakerOptions = {
  threshold: 3,
  windowMs: 600_000,
  cooldownMs: 60_000,
};

interface State {
  failures: { errorClass: string; at: number }[];
  openUntil: number | null;
  halfOpen: boolean;
}

/**
 * Per-adapter circuit breakers (docs/architecture/05-policy-and-safety.md): the same error class
 * three times in ten minutes means the provider is unwell, so stop burning every node's retries
 * on it. After the cool-down one trial attempt is allowed; success closes the breaker, failure
 * reopens it. Time is passed in, so behaviour is deterministic in tests.
 */
export class CircuitBreakers {
  readonly #options: BreakerOptions;
  readonly #states = new Map<string, State>();

  constructor(options: BreakerOptions = DEFAULT_BREAKER) {
    this.#options = options;
  }

  #state(key: string): State {
    let state = this.#states.get(key);
    if (state === undefined) {
      state = { failures: [], openUntil: null, halfOpen: false };
      this.#states.set(key, state);
    }
    return state;
  }

  /** Whether work may be sent to `key` now. A half-open breaker admits exactly one trial. */
  allows(key: string, now: number): boolean {
    const state = this.#state(key);
    if (state.openUntil === null) return true;
    if (now < state.openUntil) return false;
    if (state.halfOpen) return false;
    state.halfOpen = true;
    return true;
  }

  /** When an open breaker will next admit a trial, or null when closed. */
  retryAt(key: string): number | null {
    return this.#states.get(key)?.openUntil ?? null;
  }

  recordSuccess(key: string): void {
    this.#states.set(key, { failures: [], openUntil: null, halfOpen: false });
  }

  recordFailure(key: string, errorClass: string, now: number): void {
    const state = this.#state(key);
    if (state.halfOpen) {
      state.openUntil = now + this.#options.cooldownMs;
      state.halfOpen = false;
      return;
    }
    state.failures = [
      ...state.failures.filter((f) => now - f.at < this.#options.windowMs),
      { errorClass, at: now },
    ];
    const same = state.failures.filter((f) => f.errorClass === errorClass).length;
    if (same >= this.#options.threshold) {
      state.openUntil = now + this.#options.cooldownMs;
      state.failures = [];
    }
  }
}

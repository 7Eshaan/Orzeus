import type { EscalationPolicy, RetryPolicy } from "@orzeus/schema";
import type { NodeState } from "./state.js";

/**
 * Exponential backoff with full jitter: a uniform delay in [0, min(maxDelay, base * 2^(n-1))].
 * `random01` must be in [0, 1); it is injected so callers (and tests) control randomness.
 */
export function backoffDelayMs(policy: RetryPolicy, attempt: number, random01: number): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 30);
  const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  const r = Math.min(Math.max(random01, 0), 1 - Number.EPSILON);
  return Math.floor(r * (cap + 1));
}

export type FailureKind =
  /** Provider or process hiccup: timeouts, 5xx, crashed CLI. */
  | "transient"
  /** The worker finished but checks failed. */
  | "checks_failed"
  /** The worker flagged the task as ambiguous. */
  | "ambiguity"
  /** A node budget tripped. */
  | "budget"
  /** Not worth retrying: invalid packet, missing tool, policy denial. */
  | "fatal";

export type FailureDecision =
  | { readonly kind: "retry"; readonly nextAttempt: number; readonly delayMs: number }
  | {
      readonly kind: "escalate";
      readonly reason: "checks_failed" | "ambiguity" | "budget" | "worker_error";
    }
  | { readonly kind: "ask_human" }
  | { readonly kind: "fail" };

/**
 * What to do after an attempt fails. Retries are counted per steering round, so a steer gives
 * the worker a fresh set of attempts; steers are bounded by escalation.maxSteers.
 */
export function decideAfterFailure(
  node: Pick<NodeState, "attempt" | "attemptsThisRound" | "steers">,
  retry: RetryPolicy,
  escalation: EscalationPolicy,
  kind: FailureKind,
  random01: number,
): FailureDecision {
  const canSteer = node.steers < escalation.maxSteers;
  const retryNow = (delayMs: number): FailureDecision => ({
    kind: "retry",
    nextAttempt: node.attempt + 1,
    delayMs,
  });

  switch (kind) {
    case "fatal":
      return { kind: "fail" };
    case "transient":
      if (node.attemptsThisRound < retry.maxAttempts) {
        return retryNow(backoffDelayMs(retry, node.attemptsThisRound, random01));
      }
      return canSteer ? { kind: "escalate", reason: "worker_error" } : { kind: "fail" };
    case "checks_failed":
      if (
        node.attemptsThisRound <= escalation.workerRetriesOnCheckFailure &&
        node.attemptsThisRound < retry.maxAttempts
      ) {
        return retryNow(0);
      }
      return canSteer ? { kind: "escalate", reason: "checks_failed" } : { kind: "fail" };
    case "ambiguity":
      if (escalation.onAmbiguity === "ask_human") return { kind: "ask_human" };
      return canSteer ? { kind: "escalate", reason: "ambiguity" } : { kind: "ask_human" };
    case "budget":
      return canSteer ? { kind: "escalate", reason: "budget" } : { kind: "fail" };
  }
}

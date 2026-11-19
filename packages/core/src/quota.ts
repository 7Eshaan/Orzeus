import type { QuotaWindow } from "@orzeus/schema";

/** Why an account should get no new work right now, and when to look again. */
export interface QuotaHold {
  readonly window: string;
  readonly usedPercent: number | null;
  /** The soft cap that was crossed, or null when the provider itself reports "limited". */
  readonly cap: number | null;
  /** When to look again: the window's reset, or a minute from now when it is unknown. */
  readonly until: number;
  readonly reason: string;
}

const RECHECK_MS = 60_000;

/**
 * Decides whether an account is held by its quota (docs/architecture/04-providers.md, "How work is
 * routed"): a window the provider reports as limited, or one whose usage reached the user's soft
 * cap. Observations of windows that have already reset no longer count. Returns the hold that
 * lasts longest, so the scheduler does not wake up early.
 */
export function quotaHold(
  windows: readonly QuotaWindow[],
  caps: Readonly<Record<string, number>>,
  now: number,
): QuotaHold | null {
  let longest: QuotaHold | null = null;
  for (const w of windows) {
    if (w.resetsAt !== null && w.resetsAt <= now) continue;
    const cap = caps[w.window];
    const overCap = cap !== undefined && w.usedPercent !== null && w.usedPercent >= cap;
    if (w.status !== "limited" && !overCap) continue;
    const until = w.resetsAt ?? now + RECHECK_MS;
    const reason =
      w.status === "limited"
        ? `the ${w.window} window is exhausted`
        : `the ${w.window} window is at ${w.usedPercent}% (your limit is ${cap}%)`;
    const hold = {
      window: w.window,
      usedPercent: w.usedPercent,
      cap: overCap ? (cap ?? null) : null,
      until,
      reason,
    };
    if (longest === null || hold.until > longest.until) longest = hold;
  }
  return longest;
}

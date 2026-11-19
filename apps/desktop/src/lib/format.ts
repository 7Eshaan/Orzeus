/** Compact, human-friendly number and time formatting. Pure, so it is unit-tested. */
export function tokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function usd(micro: number): string {
  return micro === 0 ? "$0" : `$${(micro / 1_000_000).toFixed(micro < 10_000_000 ? 2 : 0)}`;
}

export function countdown(untilMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((untilMs - nowMs) / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function ago(atMs: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (s < 60) return "just now";
  if (s < 3_600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3_600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function clock(atMs: number): string {
  return new Date(atMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  awaiting_plan_approval: "Plan ready",
  awaiting_merge_approval: "Ready to merge",
  awaiting_approval: "Needs you",
  retry_wait: "Retrying",
};

export function statusLabel(status: string): string {
  return (
    STATUS_LABELS[status] ?? status.charAt(0).toUpperCase() + status.slice(1).replaceAll("_", " ")
  );
}

/** Tone used for colour: calm by default, accent for "needs you", red only for failure. */
export function statusTone(status: string): "neutral" | "active" | "ok" | "attention" | "bad" {
  if (["succeeded", "completed"].includes(status)) return "ok";
  if (["failed"].includes(status)) return "bad";
  if (
    [
      "awaiting_plan_approval",
      "awaiting_merge_approval",
      "awaiting_approval",
      "escalated",
      "paused",
    ].includes(status)
  )
    return "attention";
  if (
    [
      "running",
      "verifying",
      "planning",
      "integrating",
      "reviewing",
      "executing",
      "ready",
      "retry_wait",
    ].includes(status)
  )
    return "active";
  return "neutral";
}

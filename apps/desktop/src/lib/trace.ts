import type { TraceEvent } from "@orzeus/schema";

export type EventGroup =
  | "run"
  | "plan"
  | "node"
  | "model"
  | "tool"
  | "check"
  | "approval"
  | "budget";

export function groupOf(type: string): EventGroup {
  if (type.startsWith("plan.") || type === "packet.issued") return "plan";
  if (type === "model.call") return "model";
  if (type === "tool.call") return "tool";
  if (
    type === "check.completed" ||
    type === "diff.captured" ||
    type.startsWith("integration.") ||
    type === "review.completed"
  )
    return "check";
  if (type.startsWith("approval.")) return "approval";
  if (type === "budget.tripped" || type === "quota.observed") return "budget";
  if (type.startsWith("node.")) return "node";
  return "run";
}

/** One-line description of an event for the timeline. */
export function describe(e: TraceEvent): string {
  switch (e.type) {
    case "run.created":
      return `Run created: ${e.payload.goal}`;
    case "plan.proposed":
      return `Plan proposed (${e.payload.dag.nodes.length} nodes)`;
    case "packet.issued":
      return `Packet issued for ${e.nodeId ?? "?"}`;
    case "node.dispatched":
      return `Started on ${e.payload.model.adapter}/${e.payload.model.model}`;
    case "model.call":
      return `${e.payload.purpose} call · ${e.payload.model.model} · ${e.payload.usage.inputTokens + e.payload.usage.cacheReadTokens} in / ${e.payload.usage.outputTokens} out`;
    case "tool.call":
      return `${e.payload.server}/${e.payload.tool} · ${e.payload.decision}${e.payload.isError ? " · error" : ""}`;
    case "diff.captured":
      return `Diff: ${e.payload.files} files, +${e.payload.insertions} −${e.payload.deletions}`;
    case "check.completed":
      return `Check ${e.payload.checkId}: ${e.payload.passed ? "passed" : "failed"}`;
    case "node.succeeded":
      return `Succeeded: ${e.payload.summary}`;
    case "node.failed":
    case "run.failed":
      return `Failed (${e.payload.errorClass}): ${e.payload.message}`;
    case "node.retry_scheduled":
      return `Retry ${e.payload.nextAttempt} in ${Math.round(e.payload.delayMs / 1000)}s (${e.payload.reason})`;
    case "node.escalated":
      return `Escalated: ${e.payload.reason}`;
    case "node.steered":
      return `Steered: ${e.payload.note}`;
    case "approval.requested":
      return `Approval requested: ${e.payload.action.kind}`;
    case "approval.resolved":
      return `Approval ${e.payload.decision.kind}`;
    case "integration.checked":
      return `Integration checks ${e.payload.passed ? "passed" : "failed"}`;
    case "review.completed":
      return `Review: ${e.payload.verdict}`;
    case "checkpoint.created":
      return `Checkpoint: ${e.payload.label}`;
    case "run.completed":
      return `Completed${e.payload.mergedInto ? ` and merged into ${e.payload.mergedInto}` : ""}`;
    case "run.paused":
      return `Paused: ${e.payload.reason}`;
    default:
      return e.type;
  }
}

export interface TokenBreakdown {
  readonly purpose: string;
  readonly tier: string;
  readonly model: string;
  readonly calls: number;
  readonly input: number;
  readonly output: number;
  readonly cached: number;
}

/** Tokens by purpose, tier and model, from model.call events. */
export function tokenBreakdown(events: readonly TraceEvent[]): TokenBreakdown[] {
  const rows = new Map<string, TokenBreakdown>();
  for (const e of events) {
    if (e.type !== "model.call") continue;
    const key = `${e.payload.purpose}|${e.payload.tier}|${e.payload.model.model}`;
    const row = rows.get(key) ?? {
      purpose: e.payload.purpose,
      tier: e.payload.tier,
      model: e.payload.model.model,
      calls: 0,
      input: 0,
      output: 0,
      cached: 0,
    };
    rows.set(key, {
      ...row,
      calls: row.calls + 1,
      input: row.input + e.payload.usage.inputTokens,
      output: row.output + e.payload.usage.outputTokens + e.payload.usage.reasoningTokens,
      cached: row.cached + e.payload.usage.cacheReadTokens,
    });
  }
  return [...rows.values()];
}

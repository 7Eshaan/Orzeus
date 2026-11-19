import type { NodeBudget, RunBudget } from "@orzeus/schema";
import type { NodeState, RunTotals } from "./state.js";

export interface BudgetTrip {
  readonly limit: "input_tokens" | "output_tokens" | "cost" | "wall_time" | "turns";
  readonly limitValue: number;
  readonly observed: number;
}

/** Node limits that the current attempt has crossed. */
export function nodeBudgetTrips(
  node: Pick<NodeState, "usage" | "costMicroUsd">,
  budget: NodeBudget,
  observed: { readonly wallMs: number; readonly turns: number },
): BudgetTrip[] {
  const trips: BudgetTrip[] = [];
  const check = (limit: BudgetTrip["limit"], limitValue: number, value: number) => {
    if (value > limitValue) trips.push({ limit, limitValue, observed: value });
  };
  check("input_tokens", budget.maxInputTokens, node.usage.inputTokens + node.usage.cacheReadTokens);
  check(
    "output_tokens",
    budget.maxOutputTokens,
    node.usage.outputTokens + node.usage.reasoningTokens,
  );
  check("cost", budget.maxCostMicroUsd, node.costMicroUsd);
  check("wall_time", budget.maxWallMs, observed.wallMs);
  check("turns", budget.maxTurns, observed.turns);
  return trips;
}

/**
 * Approval thresholds (fractions of the run's cost budget) crossed by moving from `before` to
 * `after`. Each threshold opens a human gate once.
 */
export function crossedCostThresholds(
  budget: RunBudget,
  before: RunTotals,
  after: RunTotals,
): number[] {
  const fractions = [...budget.approvalThresholds, 1].sort((a, b) => a - b);
  return fractions.filter((fraction) => {
    const line = budget.maxCostMicroUsd * fraction;
    return before.costMicroUsd < line && after.costMicroUsd >= line;
  });
}

export function frontierTokensExceeded(budget: RunBudget, totals: RunTotals): boolean {
  return totals.frontierTokens > budget.maxFrontierTokens;
}

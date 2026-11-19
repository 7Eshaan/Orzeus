/**
 * @orzeus/core
 *
 * Pure domain logic: plan validation, the run/node state machine, scheduling, retries,
 * budgets and policy. No IO and no platform APIs; side effects live behind the ports in
 * ports.ts. Test helpers are exported separately from "@orzeus/core/testing".
 */
export {
  type BudgetTrip,
  crossedCostThresholds,
  frontierTokensExceeded,
  nodeBudgetTrips,
} from "./budget.js";
export { globToRegExp, matchesAny, normalizeRelativePath, scopesMayOverlap } from "./glob.js";
export { type PlanIssue, type PlanValidation, validatePlan } from "./plan-validation.js";
export { evaluatePolicy, type PolicyContext, type PolicyVerdict } from "./policy.js";
export type { Clock, Random, RunEventStore } from "./ports.js";
export { renderPacketPrompt } from "./prompt.js";
export { applyEvent, replay, type TransitionError } from "./reducer.js";
export { err, ok, type Result } from "./result.js";
export {
  backoffDelayMs,
  decideAfterFailure,
  type FailureDecision,
  type FailureKind,
} from "./retry.js";
export { decideNext, nextWakeAt, type SchedulerAction } from "./scheduler.js";
export {
  type ApprovalState,
  type CheckpointState,
  type NodeState,
  nodeList,
  type RunState,
  type RunTotals,
} from "./state.js";
export { ancestors, type GraphNode, topologicalOrder } from "./topology.js";

import type { NodeId, UnixMs } from "@orzeus/schema";
import { scopesMayOverlap } from "./glob.js";
import { type NodeState, nodeList, type RunState } from "./state.js";

export type SchedulerAction =
  | { readonly kind: "mark_ready"; readonly nodeId: NodeId }
  | { readonly kind: "skip"; readonly nodeId: NodeId; readonly because: NodeId }
  | { readonly kind: "dispatch"; readonly nodeId: NodeId }
  | { readonly kind: "settled"; readonly allSucceeded: boolean };

/** Statuses that hold a concurrency slot and their write scope. */
const OCCUPYING = new Set(["running", "verifying", "awaiting_approval"]);
const FAILED_LIKE = new Set(["failed", "cancelled", "skipped"]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "skipped"]);

/**
 * Decides what should happen next for a run. Pure: the engine turns each action into events
 * (and, for dispatch, picks the model and worktree), appends them, and asks again.
 *
 * Guarantees, covered by property tests:
 * - never more than maxConcurrency nodes occupying slots,
 * - never two occupying nodes with overlapping write scopes,
 * - a node is dispatched only after all its dependencies succeeded,
 * - nodes downstream of a failure are skipped, so every run settles.
 */
export function decideNext(state: RunState, now: UnixMs): SchedulerAction[] {
  if (state.status !== "executing" || state.dag === null) return [];
  const nodes = nodeList(state);
  const actions: SchedulerAction[] = [];

  if (nodes.every((n) => TERMINAL.has(n.status))) {
    return [{ kind: "settled", allSucceeded: nodes.every((n) => n.status === "succeeded") }];
  }

  const candidates: NodeState[] = [];
  for (const node of nodes) {
    if (node.status === "pending") {
      const failedDep = node.dependsOn.find((dep) =>
        FAILED_LIKE.has(state.nodes[dep]?.status ?? ""),
      );
      if (failedDep !== undefined) {
        actions.push({ kind: "skip", nodeId: node.id, because: failedDep });
      } else if (node.dependsOn.every((dep) => state.nodes[dep]?.status === "succeeded")) {
        actions.push({ kind: "mark_ready", nodeId: node.id });
        candidates.push(node);
      }
    } else if (node.status === "retry_wait" && node.retryAt !== null && node.retryAt <= now) {
      actions.push({ kind: "mark_ready", nodeId: node.id });
      candidates.push(node);
    } else if (node.status === "ready") {
      candidates.push(node);
    }
  }

  const occupying = nodes.filter((n) => OCCUPYING.has(n.status));
  let free = state.dag.budget.maxConcurrency - occupying.length;
  const busyScopes = occupying.map((n) => n.writeScope);
  // Candidates keep topological order, so earlier work is preferred.
  const order = new Map(state.nodeOrder.map((id, i) => [id, i]));
  candidates.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  for (const node of candidates) {
    if (free <= 0) break;
    if (busyScopes.some((scope) => scopesMayOverlap(scope, node.writeScope))) continue;
    actions.push({ kind: "dispatch", nodeId: node.id });
    busyScopes.push(node.writeScope);
    free--;
  }
  return actions;
}

/** Earliest time a waiting node becomes ready again, for the engine's timer. */
export function nextWakeAt(state: RunState): UnixMs | null {
  let earliest: UnixMs | null = null;
  for (const node of nodeList(state)) {
    if (
      node.status === "retry_wait" &&
      node.retryAt !== null &&
      (earliest === null || node.retryAt < earliest)
    ) {
      earliest = node.retryAt;
    }
  }
  return earliest;
}

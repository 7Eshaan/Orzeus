import type { NodeId } from "@orzeus/schema";
import { err, ok, type Result } from "./result.js";

export interface GraphNode {
  readonly id: NodeId;
  readonly dependsOn: readonly NodeId[];
}

/**
 * Kahn's algorithm, stable: among nodes that are ready at the same time, the one listed first
 * in the input comes first. Returns the cycle's members when the graph is not a DAG.
 * Unknown dependencies are ignored here; validatePlan reports them.
 */
export function topologicalOrder(
  nodes: readonly GraphNode[],
): Result<NodeId[], { cycle: NodeId[] }> {
  const known = new Set(nodes.map((n) => n.id));
  const indegree = new Map<NodeId, number>();
  const dependents = new Map<NodeId, NodeId[]>();
  for (const node of nodes) {
    const deps = [...new Set(node.dependsOn)].filter((d) => known.has(d));
    indegree.set(node.id, deps.length);
    for (const dep of deps) dependents.set(dep, [...(dependents.get(dep) ?? []), node.id]);
  }

  const position = new Map(nodes.map((n, i) => [n.id, i]));
  const ready = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: NodeId[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
    const next = ready.shift() as NodeId;
    order.push(next);
    for (const dependent of dependents.get(next) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }

  if (order.length === nodes.length) return ok(order);
  const placed = new Set(order);
  return err({ cycle: nodes.filter((n) => !placed.has(n.id)).map((n) => n.id) });
}

/** All transitive dependencies of each node. */
export function ancestors(nodes: readonly GraphNode[]): Map<NodeId, Set<NodeId>> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map<NodeId, Set<NodeId>>();
  const visit = (id: NodeId, stack: Set<NodeId>): Set<NodeId> => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const result = new Set<NodeId>();
    if (stack.has(id)) return result; // cycles are reported elsewhere
    stack.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      result.add(dep);
      for (const transitive of visit(dep, stack)) result.add(transitive);
    }
    stack.delete(id);
    memo.set(id, result);
    return result;
  };
  for (const node of nodes) visit(node.id, new Set());
  return memo;
}

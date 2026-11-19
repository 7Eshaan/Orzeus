import type { ContextPacketBody, NodeId, TaskDAG } from "@orzeus/schema";
import { scopesMayOverlap } from "./glob.js";
import { ancestors, topologicalOrder } from "./topology.js";

export interface PlanIssue {
  readonly code:
    | "duplicate_node_id"
    | "unknown_dependency"
    | "self_dependency"
    | "cycle"
    | "duplicate_check_id"
    | "missing_packet"
    | "packet_mismatch"
    | "unknown_acceptance_check"
    | "node_budget_exceeds_run"
    | "write_scope_overlap";
  readonly nodeId: NodeId | null;
  readonly message: string;
}

export interface PlanValidation {
  /** Errors block the plan. */
  readonly errors: readonly PlanIssue[];
  /** Warnings are shown in the plan view; e.g. overlapping write scopes, which get serialized. */
  readonly warnings: readonly PlanIssue[];
  /** Stable topological order, present when the graph is a DAG. */
  readonly order: readonly NodeId[] | null;
}

/**
 * Graph and cross-reference rules the Zod schema cannot express. Reports every problem at
 * once so the planner (or a human) can fix them in one pass. Packets are checked when given.
 */
export function validatePlan(dag: TaskDAG, packets?: readonly ContextPacketBody[]): PlanValidation {
  const errors: PlanIssue[] = [];
  const warnings: PlanIssue[] = [];
  const ids = new Set<NodeId>();

  for (const node of dag.nodes) {
    if (ids.has(node.id)) {
      errors.push({
        code: "duplicate_node_id",
        nodeId: node.id,
        message: `Node id "${node.id}" is used more than once.`,
      });
    }
    ids.add(node.id);
  }

  for (const node of dag.nodes) {
    for (const dep of node.dependsOn) {
      if (dep === node.id) {
        errors.push({
          code: "self_dependency",
          nodeId: node.id,
          message: `Node "${node.id}" depends on itself.`,
        });
      } else if (!ids.has(dep)) {
        errors.push({
          code: "unknown_dependency",
          nodeId: node.id,
          message: `Node "${node.id}" depends on unknown node "${dep}".`,
        });
      }
    }

    const checkIds = new Set<string>();
    for (const check of node.checks) {
      if (checkIds.has(check.id)) {
        errors.push({
          code: "duplicate_check_id",
          nodeId: node.id,
          message: `Check id "${check.id}" repeats in node "${node.id}".`,
        });
      }
      checkIds.add(check.id);
    }

    if (node.budget.maxCostMicroUsd > dag.budget.maxCostMicroUsd) {
      errors.push({
        code: "node_budget_exceeds_run",
        nodeId: node.id,
        message: `Node "${node.id}" may spend more than the whole run's budget.`,
      });
    }

    if (packets !== undefined) {
      const packet = packets.find((p) => p.id === node.packetId);
      if (packet === undefined) {
        errors.push({
          code: "missing_packet",
          nodeId: node.id,
          message: `No packet "${node.packetId}" for node "${node.id}".`,
        });
      } else {
        if (packet.nodeId !== node.id || packet.runId !== dag.runId) {
          errors.push({
            code: "packet_mismatch",
            nodeId: node.id,
            message: `Packet "${packet.id}" belongs to another node or run.`,
          });
        }
        for (const criterion of packet.acceptance) {
          if (criterion.checkId !== null && !checkIds.has(criterion.checkId)) {
            errors.push({
              code: "unknown_acceptance_check",
              nodeId: node.id,
              message: `Acceptance "${criterion.id}" points at unknown check "${criterion.checkId}".`,
            });
          }
        }
      }
    }
  }

  const sorted = topologicalOrder(dag.nodes);
  if (!sorted.ok) {
    errors.push({
      code: "cycle",
      nodeId: null,
      message: `Dependency cycle among: ${sorted.error.cycle.join(", ")}.`,
    });
  } else {
    const deps = ancestors(dag.nodes);
    const nodes = dag.nodes;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        if (a === undefined || b === undefined) continue;
        const related = deps.get(a.id)?.has(b.id) === true || deps.get(b.id)?.has(a.id) === true;
        if (!related && scopesMayOverlap(a.writeScope, b.writeScope)) {
          warnings.push({
            code: "write_scope_overlap",
            nodeId: a.id,
            message: `"${a.id}" and "${b.id}" may write the same files; they will not run at the same time.`,
          });
        }
      }
    }
  }

  return { errors, warnings, order: sorted.ok ? sorted.value : null };
}

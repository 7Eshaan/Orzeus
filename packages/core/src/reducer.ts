import {
  type NodeId,
  type NodeStatus,
  type RunStatus,
  TERMINAL_NODE_STATUSES,
  TERMINAL_RUN_STATUSES,
  type TokenUsage,
  type TraceEvent,
  type TraceEventType,
  ZERO_USAGE,
} from "@orzeus/schema";
import { err, ok, type Result } from "./result.js";
import type { ApprovalState, NodeState, RunState } from "./state.js";
import { topologicalOrder } from "./topology.js";

export interface TransitionError {
  readonly seq: number;
  readonly type: TraceEventType;
  readonly nodeId: NodeId | null;
  readonly message: string;
}

type Step = Result<RunState, string>;
type EventOf<K extends TraceEventType> = Extract<TraceEvent, { type: K }>;

/** Node events are accepted while the run is executing or paused (in-flight work may finish). */
const NODE_EVENT_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["executing", "paused"]);

/**
 * The single state machine for runs and nodes. Pure and deterministic: the same events always
 * produce the same state, so live execution and crash replay cannot drift apart (ADR 0004).
 * Illegal transitions are rejected, so they can never be recorded.
 */
export function applyEvent(
  state: RunState | null,
  event: TraceEvent,
): Result<RunState, TransitionError> {
  const fail = (message: string): Result<RunState, TransitionError> =>
    err({ seq: event.seq, type: event.type, nodeId: event.nodeId, message });

  if (state === null) {
    if (event.type !== "run.created") return fail("the first event of a run must be run.created");
    if (event.seq !== 1 || event.prevHash !== null)
      return fail("run.created must be seq 1 with no prevHash");
    return ok({
      runId: event.runId,
      projectId: event.payload.projectId,
      goal: event.payload.goal,
      repo: event.payload.repo,
      status: "planning",
      statusBeforePause: null,
      dag: null,
      proposedDag: null,
      nodes: {},
      nodeOrder: [],
      approvals: {},
      checkpoints: {},
      totals: { frontierTokens: 0, workerTokens: 0, costMicroUsd: 0 },
      budgetTrips: 0,
      headSeq: 1,
      headHash: event.hash,
      createdAt: event.ts,
      updatedAt: event.ts,
    });
  }

  if (event.runId !== state.runId) return fail("event belongs to another run");
  if (event.seq !== state.headSeq + 1) return fail(`expected seq ${state.headSeq + 1}`);
  if (event.prevHash !== state.headHash) return fail("prevHash does not link to the current head");
  if (TERMINAL_RUN_STATUSES.has(state.status)) return fail(`run is already ${state.status}`);

  const step = transition(state, event);
  if (!step.ok) return fail(step.error);
  return ok({ ...step.value, headSeq: event.seq, headHash: event.hash, updatedAt: event.ts });
}

/** Replays a run's events from scratch. */
export function replay(events: readonly TraceEvent[]): Result<RunState | null, TransitionError> {
  let state: RunState | null = null;
  for (const event of events) {
    const next = applyEvent(state, event);
    if (!next.ok) return next;
    state = next.value;
  }
  return ok(state);
}

function transition(state: RunState, event: TraceEvent): Step {
  switch (event.type) {
    case "run.created":
      return err("run already exists");
    case "plan.proposed":
      return planProposed(state, event);
    case "plan.approved":
      return planApproved(state, event);
    case "run.paused":
      if (state.status !== "executing") return err(`cannot pause a run that is ${state.status}`);
      return ok({ ...state, status: "paused", statusBeforePause: state.status });
    case "run.resumed":
      if (state.status === "paused") {
        return ok({
          ...state,
          status: state.statusBeforePause ?? "executing",
          statusBeforePause: null,
        });
      }
      return event.payload.afterCrash ? ok(state) : err("run is not paused");
    case "run.completed":
      if (
        !["executing", "integrating", "reviewing", "awaiting_merge_approval"].includes(state.status)
      ) {
        return err(`cannot complete a run that is ${state.status}`);
      }
      if (nodesOf(state).some((n) => n.status !== "succeeded"))
        return err("not every node has succeeded");
      return ok({ ...state, status: "completed" });
    case "run.failed":
      return ok({ ...state, status: "failed" });
    case "run.cancelled":
      return ok({ ...state, status: "cancelled" });
    case "checkpoint.created": {
      if (state.checkpoints[event.payload.checkpointId] !== undefined)
        return err("checkpoint id already used");
      const { checkpoints, ...snapshot } = state;
      const { checkpointId: id, label, refs } = event.payload;
      const checkpoint = { id, label, refs, atSeq: event.seq, snapshot };
      return ok({ ...state, checkpoints: { ...checkpoints, [checkpoint.id]: checkpoint } });
    }
    case "run.rolled_back": {
      const checkpoint = state.checkpoints[event.payload.toCheckpoint];
      if (checkpoint === undefined) return err("unknown checkpoint");
      return ok({ ...checkpoint.snapshot, checkpoints: state.checkpoints });
    }
    case "model.call":
      return modelCall(state, event);
    case "budget.tripped":
      return ok({ ...state, budgetTrips: state.budgetTrips + 1 });
    case "approval.requested":
      return approvalRequested(state, event);
    case "approval.resolved":
      return approvalResolved(state, event);
    case "packet.issued":
    case "tool.call":
    case "quota.observed":
      return ok(state);
    default:
      return nodeTransition(state, event);
  }
}

function planProposed(state: RunState, event: EventOf<"plan.proposed">): Step {
  if (state.status !== "planning" && state.status !== "awaiting_plan_approval") {
    return err(`cannot propose a plan while the run is ${state.status}`);
  }
  const { dag, revision } = event.payload;
  if (dag.runId !== state.runId) return err("plan belongs to another run");
  if (dag.revision !== revision) return err("payload revision does not match the plan");
  const current = state.proposedDag?.revision ?? state.dag?.revision ?? 0;
  if (revision <= current) return err(`plan revision must be greater than ${current}`);
  return ok({ ...state, status: "awaiting_plan_approval", proposedDag: dag });
}

function planApproved(state: RunState, event: EventOf<"plan.approved">): Step {
  const dag = state.proposedDag;
  if (state.status !== "awaiting_plan_approval" || dag === null)
    return err("no plan is awaiting approval");
  if (dag.revision !== event.payload.revision)
    return err("approved revision does not match the proposed plan");
  const order = topologicalOrder(dag.nodes);
  if (!order.ok) return err(`plan has a dependency cycle: ${order.error.cycle.join(", ")}`);

  const nodes: Record<string, NodeState> = {};
  for (const node of dag.nodes) {
    nodes[node.id] = {
      id: node.id,
      title: node.title,
      kind: node.kind,
      tier: node.tier,
      dependsOn: node.dependsOn,
      writeScope: node.writeScope,
      status: "pending",
      attempt: 0,
      attemptsThisRound: 0,
      steers: 0,
      packetHash: null,
      accountId: null,
      model: null,
      worktree: null,
      branch: null,
      baseCommit: null,
      headCommit: null,
      retryAt: null,
      checks: {},
      usage: ZERO_USAGE,
      costMicroUsd: 0,
      lastError: null,
      statusBeforeApproval: null,
      summary: null,
      updatedSeq: event.seq,
    };
  }
  return ok({
    ...state,
    status: "executing",
    dag,
    proposedDag: null,
    nodes,
    nodeOrder: order.value,
  });
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

function modelCall(state: RunState, event: EventOf<"model.call">): Step {
  const { usage, tier } = event.payload;
  const cost = event.payload.costMicroUsd ?? 0;
  const tokens = usage.inputTokens + usage.outputTokens + usage.reasoningTokens;
  const totals = {
    frontierTokens: state.totals.frontierTokens + (tier === "frontier" ? tokens : 0),
    workerTokens: state.totals.workerTokens + (tier === "frontier" ? 0 : tokens),
    costMicroUsd: state.totals.costMicroUsd + cost,
  };
  let nodes = state.nodes;
  if (event.nodeId !== null) {
    const node = state.nodes[event.nodeId];
    if (node === undefined) return err("unknown node");
    nodes = {
      ...nodes,
      [node.id]: {
        ...node,
        usage: addUsage(node.usage, usage),
        costMicroUsd: node.costMicroUsd + cost,
        updatedSeq: event.seq,
      },
    };
  }
  return ok({ ...state, totals, nodes });
}

function approvalRequested(state: RunState, event: EventOf<"approval.requested">): Step {
  const { approvalId, action } = event.payload;
  if (state.approvals[approvalId] !== undefined) return err("approval id already used");
  const approval: ApprovalState = {
    id: approvalId,
    nodeId: event.nodeId,
    action,
    status: "pending",
    decision: null,
    requestedSeq: event.seq,
    resolvedSeq: null,
  };
  let nodes = state.nodes;
  if (event.nodeId !== null) {
    const node = state.nodes[event.nodeId];
    if (node === undefined) return err("unknown node");
    if (node.status !== "awaiting_approval") {
      if (node.status !== "running" && node.status !== "verifying") {
        return err(`node cannot wait for approval while ${node.status}`);
      }
      nodes = {
        ...nodes,
        [node.id]: {
          ...node,
          status: "awaiting_approval",
          statusBeforeApproval: node.status,
          updatedSeq: event.seq,
        },
      };
    }
  }
  return ok({ ...state, nodes, approvals: { ...state.approvals, [approvalId]: approval } });
}

function approvalResolved(state: RunState, event: EventOf<"approval.resolved">): Step {
  const approval = state.approvals[event.payload.approvalId];
  if (approval === undefined) return err("unknown approval");
  if (approval.status !== "pending") return err("approval is already resolved");
  const { decision } = event.payload;
  const status: ApprovalState["status"] =
    decision.kind === "deny" ? "denied" : decision.kind === "steer" ? "steered" : "approved";
  const approvals = {
    ...state.approvals,
    [approval.id]: { ...approval, status, decision, resolvedSeq: event.seq },
  };

  let nodes = state.nodes;
  const node = approval.nodeId === null ? undefined : state.nodes[approval.nodeId];
  if (node !== undefined && node.status === "awaiting_approval") {
    const stillPending = Object.values(approvals).some(
      (a) => a.nodeId === node.id && a.status === "pending",
    );
    if (!stillPending) {
      nodes = {
        ...nodes,
        [node.id]: {
          ...node,
          status: node.statusBeforeApproval ?? "running",
          statusBeforeApproval: null,
          updatedSeq: event.seq,
        },
      };
    }
  }
  return ok({ ...state, approvals, nodes });
}

function nodesOf(state: RunState): NodeState[] {
  return Object.values(state.nodes);
}

function nodeTransition(state: RunState, event: TraceEvent): Step {
  if (!NODE_EVENT_RUN_STATUSES.has(state.status)) {
    return err(`node events are not accepted while the run is ${state.status}`);
  }
  if (event.nodeId === null) return err("node event without nodeId");
  const node = state.nodes[event.nodeId];
  if (node === undefined) return err("unknown node");
  if (TERMINAL_NODE_STATUSES.has(node.status)) return err(`node is already ${node.status}`);

  const next = nodeStep(state, node, event);
  if (!next.ok) return next;
  return ok({
    ...state,
    nodes: { ...state.nodes, [node.id]: { ...next.value, updatedSeq: event.seq } },
  });
}

function requireStatus(
  node: NodeState,
  allowed: readonly NodeStatus[],
  type: string,
): string | null {
  return allowed.includes(node.status)
    ? null
    : `${type} is not allowed while the node is ${node.status}`;
}

function nodeStep(state: RunState, node: NodeState, event: TraceEvent): Result<NodeState, string> {
  const guard = (allowed: readonly NodeStatus[]): Result<NodeState, string> | null => {
    const problem = requireStatus(node, allowed, event.type);
    return problem === null ? null : err(problem);
  };

  switch (event.type) {
    case "node.ready": {
      const blocked = guard(["pending", "retry_wait"]);
      if (blocked) return blocked;
      if (node.status === "pending") {
        const unmet = node.dependsOn.filter((dep) => state.nodes[dep]?.status !== "succeeded");
        if (unmet.length > 0) return err(`dependencies not succeeded: ${unmet.join(", ")}`);
      }
      return ok({ ...node, status: "ready", retryAt: null });
    }
    case "node.dispatched": {
      const blocked = guard(["ready"]);
      if (blocked) return blocked;
      if (event.attempt !== node.attempt + 1) return err(`expected attempt ${node.attempt + 1}`);
      const p = event.payload;
      return ok({
        ...node,
        status: "running",
        attempt: event.attempt,
        attemptsThisRound: node.attemptsThisRound + 1,
        model: p.model,
        accountId: p.accountId,
        worktree: p.worktree,
        branch: p.branch,
        baseCommit: p.baseCommit,
        packetHash: p.packetHash,
        headCommit: null,
        checks: {},
        lastError: null,
      });
    }
    case "diff.captured": {
      const blocked = guard(["running", "verifying"]);
      if (blocked) return blocked;
      return ok({ ...node, headCommit: event.payload.headCommit });
    }
    case "node.verifying": {
      const blocked = guard(["running"]);
      return blocked ?? ok({ ...node, status: "verifying" });
    }
    case "check.completed": {
      const blocked = guard(["verifying"]);
      if (blocked) return blocked;
      return ok({
        ...node,
        checks: { ...node.checks, [event.payload.checkId]: event.payload.passed },
      });
    }
    case "node.succeeded": {
      const blocked = guard(["verifying"]);
      if (blocked) return blocked;
      if (Object.values(node.checks).some((passed) => !passed))
        return err("a check failed in this attempt");
      return ok({
        ...node,
        status: "succeeded",
        headCommit: event.payload.headCommit,
        summary: event.payload.summary,
      });
    }
    case "node.retry_scheduled": {
      const blocked = guard(["running", "verifying"]);
      if (blocked) return blocked;
      if (event.payload.nextAttempt !== node.attempt + 1)
        return err(`next attempt must be ${node.attempt + 1}`);
      return ok({ ...node, status: "retry_wait", retryAt: event.ts + event.payload.delayMs });
    }
    case "node.escalated": {
      const blocked = guard(["running", "verifying"]);
      return blocked ?? ok({ ...node, status: "escalated" });
    }
    case "node.steered": {
      const blocked = guard(["escalated"]);
      return (
        blocked ?? ok({ ...node, status: "ready", steers: node.steers + 1, attemptsThisRound: 0 })
      );
    }
    case "node.failed":
      return ok({
        ...node,
        status: "failed",
        retryAt: null,
        lastError: { errorClass: event.payload.errorClass, message: event.payload.message },
      });
    case "node.cancelled":
      return ok({ ...node, status: "cancelled", retryAt: null });
    case "node.skipped": {
      const blocked = guard(["pending"]);
      if (blocked) return blocked;
      const because = state.nodes[event.payload.because];
      if (because === undefined || !node.dependsOn.includes(because.id))
        return err("skip reason is not a dependency");
      if (!["failed", "cancelled", "skipped"].includes(because.status))
        return err("dependency has not failed");
      return ok({ ...node, status: "skipped" });
    }
    default:
      return err(`unhandled event type ${event.type}`);
  }
}

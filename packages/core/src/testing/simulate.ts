import type {
  ApprovalId,
  CheckpointId,
  EventDraft,
  NodeId,
  RunId,
  TaskDAG,
  TaskNode,
  TraceEvent,
} from "@orzeus/schema";
import type { Random, RunEventStore } from "../ports.js";
import { decideAfterFailure, type FailureKind } from "../retry.js";
import { decideNext, nextWakeAt } from "../scheduler.js";
import { nodeList, type RunState } from "../state.js";
import {
  draft,
  TEST_ACCOUNT,
  TEST_COMMIT,
  TEST_HASH,
  TEST_PROJECT,
  WORKER_MODEL,
} from "./fixtures.js";

export type AttemptOutcome = "success" | FailureKind;

export interface SimulationOptions {
  readonly dag: TaskDAG;
  /** Outcome of each attempt of each node. */
  readonly outcome: (nodeId: NodeId, attempt: number) => AttemptOutcome;
  readonly random: Random;
  /** Insert a checkpoint after this many scheduler steps (to exercise checkpoint events). */
  readonly checkpointAfterSteps?: number;
  readonly startAt?: number;
  readonly maxSteps?: number;
  /** Called after every append with the new state; property tests assert invariants here. */
  readonly onAppend?: (state: RunState, drafts: readonly EventDraft[]) => void;
}

export class SimulationStuckError extends Error {
  override readonly name = "SimulationStuckError";
}

/**
 * Drives a whole run through a RunEventStore the way the engine will: ask the scheduler,
 * turn actions into events, simulate worker attempts with scripted outcomes, steer escalations.
 * Throws SimulationStuckError if the run cannot make progress (a deadlock).
 */
export function simulateRun(store: RunEventStore, options: SimulationOptions): RunState {
  const { dag } = options;
  const runId: RunId = dag.runId;
  let now = options.startAt ?? 1_700_000_000_000;
  let approvals = 0;

  const append = (drafts: EventDraft[]): RunState => {
    const state = store.append(runId, drafts);
    options.onAppend?.(state, drafts);
    return state;
  };

  append([
    draft("run.created", { projectId: TEST_PROJECT, goal: dag.goal, repo: dag.repo }, { ts: now }),
  ]);
  append([draft("plan.proposed", { revision: dag.revision, dag }, { ts: now })]);
  let state = append([
    draft("plan.approved", { revision: dag.revision, edited: false }, { ts: now }),
  ]);

  const taskNode = (id: NodeId): TaskNode => {
    const node = dag.nodes.find((n) => n.id === id);
    if (node === undefined) throw new Error(`unknown node ${id}`);
    return node;
  };

  const maxSteps = options.maxSteps ?? 10_000;
  for (let step = 0; step < maxSteps; step++) {
    now += 1_000;

    if (options.checkpointAfterSteps === step) {
      state = append([
        draft(
          "checkpoint.created",
          { checkpointId: `cp-${step}` as CheckpointId, label: `after step ${step}`, refs: {} },
          { ts: now },
        ),
      ]);
    }

    const actions = decideNext(state, now);
    const settled = actions.find((a) => a.kind === "settled");
    if (settled !== undefined) {
      return append([
        settled.allSucceeded
          ? draft("run.completed", { integrationCommit: TEST_COMMIT }, { ts: now })
          : draft(
              "run.failed",
              { errorClass: "run.nodes_failed", message: "Some nodes failed." },
              { ts: now },
            ),
      ]);
    }

    if (actions.length > 0) {
      const drafts: EventDraft[] = [];
      for (const action of actions) {
        if (action.kind === "mark_ready") {
          drafts.push(draft("node.ready", {}, { ts: now, nodeId: action.nodeId }));
        } else if (action.kind === "skip") {
          drafts.push(
            draft("node.skipped", { because: action.because }, { ts: now, nodeId: action.nodeId }),
          );
        } else if (action.kind === "dispatch") {
          const attempt = (state.nodes[action.nodeId]?.attempt ?? 0) + 1;
          drafts.push(
            draft(
              "node.dispatched",
              {
                model: WORKER_MODEL,
                accountId: TEST_ACCOUNT,
                worktree: `/worktrees/${runId}/${action.nodeId}`,
                branch: `orzeus/${runId}/${action.nodeId}`,
                baseCommit: TEST_COMMIT,
                packetHash: TEST_HASH,
              },
              { ts: now, nodeId: action.nodeId, attempt },
            ),
          );
        }
      }
      state = append(drafts);
      continue;
    }

    const nodes = nodeList(state);
    const running = nodes.find((n) => n.status === "running");
    if (running !== undefined) {
      state = append(finishAttempt(state, running.id, taskNode(running.id), now));
      continue;
    }

    const escalated = nodes.find((n) => n.status === "escalated");
    if (escalated !== undefined) {
      state = append([
        draft(
          "node.steered",
          { note: "Try a smaller change.", replan: false },
          { ts: now, nodeId: escalated.id },
        ),
      ]);
      continue;
    }

    const wake = nextWakeAt(state);
    if (wake !== null) {
      now = Math.max(now, wake);
      continue;
    }

    throw new SimulationStuckError(`run ${runId} cannot make progress at step ${step}`);
  }
  throw new SimulationStuckError(`run ${runId} did not settle within ${maxSteps} steps`);

  function finishAttempt(
    current: RunState,
    nodeId: NodeId,
    task: TaskNode,
    ts: number,
  ): EventDraft[] {
    const node = current.nodes[nodeId];
    if (node === undefined) throw new Error(`unknown node ${nodeId}`);
    const attempt = node.attempt;
    const at = { ts, nodeId, attempt };
    const outcome = options.outcome(nodeId, attempt);
    const drafts: EventDraft[] = [
      draft(
        "model.call",
        {
          model: WORKER_MODEL,
          tier: "worker",
          purpose: "work",
          usage: {
            inputTokens: 1_000,
            outputTokens: 200,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
          costMicroUsd: 1_500,
          latencyMs: 900,
        },
        at,
      ),
    ];

    if (outcome === "success" || outcome === "checks_failed") {
      const passed = outcome === "success";
      drafts.push(
        draft(
          "diff.captured",
          {
            baseCommit: TEST_COMMIT,
            headCommit: TEST_COMMIT,
            diffBlob: TEST_HASH,
            files: 2,
            insertions: 10,
            deletions: 3,
            outOfScope: [],
          },
          at,
        ),
        draft("node.verifying", {}, at),
        draft(
          "check.completed",
          {
            checkId: "test",
            passed,
            exitCode: passed ? 0 : 1,
            outputBlob: TEST_HASH,
            durationMs: 1_200,
          },
          at,
        ),
      );
      if (passed) {
        drafts.push(
          draft("node.succeeded", { headCommit: TEST_COMMIT, summary: `Finished ${nodeId}.` }, at),
        );
        return drafts;
      }
    }

    const decision = decideAfterFailure(
      node,
      task.retry,
      task.escalation,
      outcome,
      options.random(),
    );
    switch (decision.kind) {
      case "retry":
        drafts.push(
          draft(
            "node.retry_scheduled",
            { nextAttempt: decision.nextAttempt, delayMs: decision.delayMs, reason: outcome },
            at,
          ),
        );
        break;
      case "escalate":
        drafts.push(draft("node.escalated", { reason: decision.reason }, at));
        break;
      case "ask_human": {
        approvals++;
        const approvalId = `approval-${approvals}` as ApprovalId;
        drafts.push(
          draft(
            "approval.requested",
            { approvalId, action: { kind: "shell", argv: ["rm", "-rf", "build"], cwd: "." } },
            at,
          ),
          draft(
            "approval.resolved",
            { approvalId, decision: { kind: "deny", reason: "Not now." } },
            { ...at },
          ),
          draft(
            "node.failed",
            { errorClass: "node.needs_human", message: "A human declined to continue." },
            at,
          ),
        );
        break;
      }
      case "fail":
        drafts.push(
          draft(
            "node.failed",
            { errorClass: `node.${outcome}`, message: `Attempt ${attempt} failed: ${outcome}.` },
            at,
          ),
        );
        break;
    }
    return drafts;
  }
}

export function eventsOf(store: RunEventStore, runId: RunId): TraceEvent[] {
  return store.events(runId);
}

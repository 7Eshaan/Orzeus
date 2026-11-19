import type {
  ApprovalId,
  CheckpointId,
  EventDraft,
  NodeId,
  RunId,
  TraceEvent,
} from "@orzeus/schema";
import { describe, expect, it } from "vitest";
import { applyEvent, replay } from "./reducer.js";
import type { RunState } from "./state.js";
import {
  buildDag,
  draft,
  InMemoryRunLog,
  TEST_ACCOUNT,
  TEST_COMMIT,
  TEST_HASH,
  TEST_PROJECT,
  TEST_RUN_ID,
  WORKER_MODEL,
} from "./testing/index.js";

const ts = 1_700_000_000_000;
const dispatched = (nodeId: string, attempt: number): EventDraft =>
  draft(
    "node.dispatched",
    {
      model: WORKER_MODEL,
      accountId: TEST_ACCOUNT,
      worktree: "/w",
      branch: "b",
      baseCommit: TEST_COMMIT,
      packetHash: TEST_HASH,
    },
    { ts, nodeId, attempt },
  );

/** A run with nodes a → b, approved and executing. */
function executingRun(): { log: InMemoryRunLog; state: RunState } {
  const log = new InMemoryRunLog();
  const dag = buildDag([{ id: "a" }, { id: "b", dependsOn: ["a"] }]);
  log.append(TEST_RUN_ID, [
    draft("run.created", { projectId: TEST_PROJECT, goal: dag.goal, repo: dag.repo }, { ts }),
    draft("plan.proposed", { revision: 1, dag }, { ts }),
  ]);
  const state = log.append(TEST_RUN_ID, [
    draft("plan.approved", { revision: 1, edited: false }, { ts }),
  ]);
  return { log, state };
}

function rejects(log: InMemoryRunLog, drafts: EventDraft[], message: RegExp): void {
  expect(() => log.append(TEST_RUN_ID, drafts)).toThrow(message);
}

describe("run lifecycle", () => {
  it("initializes nodes as pending in topological order on approval", () => {
    const { state } = executingRun();
    expect(state.status).toBe("executing");
    expect(state.nodeOrder).toEqual(["a", "b"]);
    expect(Object.values(state.nodes).map((n) => n.status)).toEqual(["pending", "pending"]);
  });

  it("requires run.created first and rejects plans for other runs or stale revisions", () => {
    const log = new InMemoryRunLog();
    rejects(
      log,
      [draft("run.paused", { reason: "x" }, { ts })],
      /first event of a run must be run.created/,
    );
    const dag = buildDag([{ id: "a" }]);
    log.append(TEST_RUN_ID, [
      draft("run.created", { projectId: TEST_PROJECT, goal: dag.goal, repo: dag.repo }, { ts }),
    ]);
    const other = buildDag([{ id: "a" }], { runId: "01JD7Z5K3Q9V8X2M4N6P8R0T2X" as RunId });
    rejects(log, [draft("plan.proposed", { revision: 1, dag: other }, { ts })], /another run/);
    log.append(TEST_RUN_ID, [draft("plan.proposed", { revision: 1, dag }, { ts })]);
    rejects(
      log,
      [draft("plan.proposed", { revision: 1, dag }, { ts })],
      /revision must be greater/,
    );
    rejects(
      log,
      [draft("plan.approved", { revision: 2, edited: false }, { ts })],
      /does not match/,
    );
  });

  it("rejects events that break the chain", () => {
    const { log, state } = executingRun();
    const last = log.events(TEST_RUN_ID).at(-1) as TraceEvent;
    const base = { ...last, type: "run.paused", payload: { reason: "x" } } as TraceEvent;
    expect(applyEvent(state, { ...base, seq: last.seq + 2, prevHash: last.hash })).toMatchObject({
      ok: false,
    });
    expect(applyEvent(state, { ...base, seq: last.seq + 1, prevHash: TEST_HASH })).toMatchObject({
      ok: false,
    });
  });

  it("accepts nothing after the run is terminal", () => {
    const { log } = executingRun();
    log.append(TEST_RUN_ID, [draft("run.cancelled", { reason: "stop" }, { ts })]);
    rejects(log, [draft("run.paused", { reason: "x" }, { ts })], /already cancelled/);
  });

  it("pauses and resumes, still letting in-flight nodes report", () => {
    const { log } = executingRun();
    log.append(TEST_RUN_ID, [draft("node.ready", {}, { ts, nodeId: "a" }), dispatched("a", 1)]);
    let state = log.append(TEST_RUN_ID, [draft("run.paused", { reason: "lunch" }, { ts })]);
    expect(state.status).toBe("paused");
    state = log.append(TEST_RUN_ID, [draft("node.verifying", {}, { ts, nodeId: "a", attempt: 1 })]);
    expect(state.nodes["a"]?.status).toBe("verifying");
    state = log.append(TEST_RUN_ID, [draft("run.resumed", { afterCrash: false }, { ts })]);
    expect(state.status).toBe("executing");
  });

  it("only completes when every node succeeded", () => {
    const { log } = executingRun();
    rejects(
      log,
      [draft("run.completed", { integrationCommit: TEST_COMMIT }, { ts })],
      /not every node/,
    );
  });
});

describe("node transitions", () => {
  it("enforces dependency order and attempt numbering", () => {
    const { log } = executingRun();
    rejects(log, [draft("node.ready", {}, { ts, nodeId: "b" })], /dependencies not succeeded: a/);
    rejects(log, [dispatched("a", 1)], /not allowed while the node is pending/);
    log.append(TEST_RUN_ID, [draft("node.ready", {}, { ts, nodeId: "a" })]);
    rejects(log, [dispatched("a", 2)], /expected attempt 1/);
  });

  it("refuses success when a check failed in the attempt", () => {
    const { log } = executingRun();
    log.append(TEST_RUN_ID, [
      draft("node.ready", {}, { ts, nodeId: "a" }),
      dispatched("a", 1),
      draft("node.verifying", {}, { ts, nodeId: "a", attempt: 1 }),
      draft(
        "check.completed",
        { checkId: "test", passed: false, exitCode: 1, outputBlob: TEST_HASH, durationMs: 1 },
        { ts, nodeId: "a", attempt: 1 },
      ),
    ]);
    rejects(
      log,
      [
        draft(
          "node.succeeded",
          { headCommit: TEST_COMMIT, summary: "" },
          { ts, nodeId: "a", attempt: 1 },
        ),
      ],
      /a check failed/,
    );
  });

  it("schedules retries with a wake time and counts attempts per steering round", () => {
    const { log } = executingRun();
    let state = log.append(TEST_RUN_ID, [
      draft("node.ready", {}, { ts, nodeId: "a" }),
      dispatched("a", 1),
      draft(
        "node.retry_scheduled",
        { nextAttempt: 2, delayMs: 5_000, reason: "timeout" },
        { ts, nodeId: "a", attempt: 1 },
      ),
    ]);
    expect(state.nodes["a"]).toMatchObject({
      status: "retry_wait",
      retryAt: ts + 5_000,
      attemptsThisRound: 1,
    });
    state = log.append(TEST_RUN_ID, [
      draft("node.ready", {}, { ts, nodeId: "a" }),
      dispatched("a", 2),
      draft("node.escalated", { reason: "worker_error" }, { ts, nodeId: "a", attempt: 2 }),
      draft("node.steered", { note: "Narrow it down.", replan: false }, { ts, nodeId: "a" }),
    ]);
    expect(state.nodes["a"]).toMatchObject({
      status: "ready",
      steers: 1,
      attemptsThisRound: 0,
      attempt: 2,
    });
  });

  it("skips only dependents of failed nodes", () => {
    const { log } = executingRun();
    rejects(
      log,
      [draft("node.skipped", { because: "a" as NodeId }, { ts, nodeId: "b" })],
      /has not failed/,
    );
    log.append(TEST_RUN_ID, [
      draft("node.failed", { errorClass: "node.fatal", message: "no" }, { ts, nodeId: "a" }),
    ]);
    const state = log.append(TEST_RUN_ID, [
      draft("node.skipped", { because: "a" as NodeId }, { ts, nodeId: "b" }),
    ]);
    expect(state.nodes["b"]?.status).toBe("skipped");
  });

  it("parks a node on approval and restores it when all its approvals resolve", () => {
    const { log } = executingRun();
    log.append(TEST_RUN_ID, [draft("node.ready", {}, { ts, nodeId: "a" }), dispatched("a", 1)]);
    const request = (id: string) =>
      draft(
        "approval.requested",
        { approvalId: id as ApprovalId, action: { kind: "file_delete", path: "src/a/x.ts" } },
        { ts, nodeId: "a", attempt: 1 },
      );
    let state = log.append(TEST_RUN_ID, [request("ap-1"), request("ap-2")]);
    expect(state.nodes["a"]?.status).toBe("awaiting_approval");
    state = log.append(TEST_RUN_ID, [
      draft(
        "approval.resolved",
        { approvalId: "ap-1" as ApprovalId, decision: { kind: "allow_once" } },
        { ts },
      ),
    ]);
    expect(state.nodes["a"]?.status).toBe("awaiting_approval");
    state = log.append(TEST_RUN_ID, [
      draft(
        "approval.resolved",
        { approvalId: "ap-2" as ApprovalId, decision: { kind: "deny", reason: "no" } },
        { ts },
      ),
    ]);
    expect(state.nodes["a"]?.status).toBe("running");
    expect(state.approvals["ap-2"]?.status).toBe("denied");
    rejects(
      log,
      [
        draft(
          "approval.resolved",
          { approvalId: "ap-2" as ApprovalId, decision: { kind: "allow_once" } },
          { ts },
        ),
      ],
      /already resolved/,
    );
  });
});

describe("checkpoints and replay", () => {
  it("rolls back to a checkpoint without forgetting the checkpoint itself", () => {
    const { log } = executingRun();
    log.append(TEST_RUN_ID, [
      draft(
        "checkpoint.created",
        { checkpointId: "cp-1" as CheckpointId, label: "before a", refs: { a: TEST_COMMIT } },
        { ts },
      ),
    ]);
    let state = log.append(TEST_RUN_ID, [
      draft("node.ready", {}, { ts, nodeId: "a" }),
      dispatched("a", 1),
    ]);
    expect(state.nodes["a"]?.status).toBe("running");
    state = log.append(TEST_RUN_ID, [
      draft("run.rolled_back", { toCheckpoint: "cp-1" as CheckpointId }, { ts }),
    ]);
    expect(state.nodes["a"]?.status).toBe("pending");
    expect(Object.keys(state.checkpoints)).toEqual(["cp-1"]);
    expect(state.headSeq).toBe(log.events(TEST_RUN_ID).length);
  });

  it("replay of the log reproduces the live state exactly", () => {
    const { log } = executingRun();
    const live = log.append(TEST_RUN_ID, [
      draft("node.ready", {}, { ts, nodeId: "a" }),
      dispatched("a", 1),
    ]);
    const replayed = replay(log.events(TEST_RUN_ID));
    expect(replayed).toEqual({ ok: true, value: live });
  });
});

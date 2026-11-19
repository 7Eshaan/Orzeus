import type { RunState } from "@orzeus/core";
import type { TraceEvent } from "@orzeus/schema";
import type { Db } from "./db.js";

const json = (value: unknown): string => JSON.stringify(value);

/**
 * Updates the projection tables for one applied event. Runs inside the same transaction as the
 * event insert, so projections can never disagree with the log. Run, node, approval and
 * checkpoint rows follow the reducer's state (diffed by reference, which is cheap because state
 * is immutable); attempt history and summaries follow the events themselves.
 *
 * Everything here must be a pure function of (event, prev, next): rebuildProjections relies on
 * replay producing identical rows.
 */
export function projectEvent(
  db: Db,
  event: TraceEvent,
  prev: RunState | null,
  next: RunState,
): void {
  projectRun(db, next);
  projectNodes(db, prev, next);
  projectApprovals(db, event, prev, next);
  projectCheckpoints(db, event, prev, next);
  projectAttempts(db, event, next);
}

function projectRun(db: Db, s: RunState): void {
  db.run(
    `INSERT INTO runs (id, project_id, goal, status, dag_revision, head_seq, head_hash, cost_micro_usd,
                       frontier_tokens, worker_tokens, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       status = excluded.status, dag_revision = excluded.dag_revision, head_seq = excluded.head_seq,
       head_hash = excluded.head_hash, cost_micro_usd = excluded.cost_micro_usd,
       frontier_tokens = excluded.frontier_tokens, worker_tokens = excluded.worker_tokens,
       updated_at = excluded.updated_at`,
    [
      s.runId,
      s.projectId,
      s.goal,
      s.status,
      s.dag?.revision ?? 0,
      s.headSeq,
      s.headHash,
      s.totals.costMicroUsd,
      s.totals.frontierTokens,
      s.totals.workerTokens,
      s.createdAt,
      s.updatedAt,
    ],
  );
}

function projectNodes(db: Db, prev: RunState | null, next: RunState): void {
  if (prev !== null && prev.nodes === next.nodes && prev.dag === next.dag) return;
  const runId = next.runId;

  for (const id of Object.keys(prev?.nodes ?? {})) {
    if (next.nodes[id] === undefined) {
      db.run("DELETE FROM node_deps WHERE run_id = ? AND (node_id = ? OR depends_on = ?)", [
        runId,
        id,
        id,
      ]);
      db.run("DELETE FROM attempts WHERE run_id = ? AND node_id = ?", [runId, id]);
      db.run("DELETE FROM nodes WHERE run_id = ? AND node_id = ?", [runId, id]);
    }
  }

  for (const node of Object.values(next.nodes)) {
    if (prev?.nodes[node.id] === node) continue;
    db.run(
      `INSERT INTO nodes (run_id, node_id, title, kind, tier, status, attempt, steers, packet_hash, account_id,
                          model, worktree_path, branch, base_commit, head_commit, retry_at, input_tokens,
                          output_tokens, cost_micro_usd, last_error_class, last_error_message, summary, updated_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, node_id) DO UPDATE SET
         title = excluded.title, kind = excluded.kind, tier = excluded.tier, status = excluded.status,
         attempt = excluded.attempt, steers = excluded.steers, packet_hash = excluded.packet_hash,
         account_id = excluded.account_id, model = excluded.model, worktree_path = excluded.worktree_path,
         branch = excluded.branch, base_commit = excluded.base_commit, head_commit = excluded.head_commit,
         retry_at = excluded.retry_at, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
         cost_micro_usd = excluded.cost_micro_usd, last_error_class = excluded.last_error_class,
         last_error_message = excluded.last_error_message, summary = excluded.summary,
         updated_seq = excluded.updated_seq`,
      [
        runId,
        node.id,
        node.title,
        node.kind,
        node.tier,
        node.status,
        node.attempt,
        node.steers,
        node.packetHash,
        node.accountId,
        node.model === null ? null : json(node.model),
        node.worktree,
        node.branch,
        node.baseCommit,
        node.headCommit,
        node.retryAt,
        node.usage.inputTokens,
        node.usage.outputTokens,
        node.costMicroUsd,
        node.lastError?.errorClass ?? null,
        node.lastError?.message ?? null,
        node.summary,
        node.updatedSeq,
      ],
    );
  }

  if (prev?.dag !== next.dag) {
    db.run("DELETE FROM node_deps WHERE run_id = ?", [runId]);
    for (const node of Object.values(next.nodes)) {
      for (const dep of node.dependsOn) {
        db.run("INSERT INTO node_deps (run_id, node_id, depends_on) VALUES (?, ?, ?)", [
          runId,
          node.id,
          dep,
        ]);
      }
    }
  }
}

function projectApprovals(db: Db, event: TraceEvent, prev: RunState | null, next: RunState): void {
  if (prev?.approvals === next.approvals) return;
  for (const id of Object.keys(prev?.approvals ?? {})) {
    if (next.approvals[id] === undefined) db.run("DELETE FROM approvals WHERE id = ?", [id]);
  }
  for (const approval of Object.values(next.approvals)) {
    if (prev?.approvals[approval.id] === approval) continue;
    db.run(
      `INSERT INTO approvals (id, run_id, node_id, kind, status, action_json, decision_json, requested_seq,
                              resolved_seq, requested_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         status = excluded.status, decision_json = excluded.decision_json,
         resolved_seq = excluded.resolved_seq,
         resolved_at = CASE WHEN excluded.status = 'pending' THEN NULL ELSE excluded.resolved_at END`,
      [
        approval.id,
        next.runId,
        approval.nodeId,
        approval.action.kind,
        approval.status,
        json(approval.action),
        approval.decision === null ? null : json(approval.decision),
        approval.requestedSeq,
        approval.resolvedSeq,
        event.ts,
        approval.status === "pending" ? null : event.ts,
      ],
    );
  }
}

function projectCheckpoints(
  db: Db,
  event: TraceEvent,
  prev: RunState | null,
  next: RunState,
): void {
  if (prev?.checkpoints === next.checkpoints) return;
  for (const checkpoint of Object.values(next.checkpoints)) {
    if (prev?.checkpoints[checkpoint.id] !== undefined) continue;
    db.run(
      "INSERT INTO checkpoints (id, run_id, at_seq, label, refs_json, snapshot_blob, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)",
      [
        checkpoint.id,
        next.runId,
        checkpoint.atSeq,
        checkpoint.label,
        json(checkpoint.refs),
        event.ts,
      ],
    );
  }
}

const ATTEMPT_ENDING: Readonly<Record<string, string>> = {
  "node.succeeded": "completed",
  "node.failed": "failed",
  "node.retry_scheduled": "failed",
  "node.escalated": "failed",
  "node.cancelled": "cancelled",
};

function projectAttempts(db: Db, event: TraceEvent, next: RunState): void {
  const runId = next.runId;
  const nodeId = event.nodeId;
  if (nodeId === null) return;

  if (event.type === "node.dispatched") {
    db.run(
      `INSERT INTO attempts (run_id, node_id, attempt, account_id, model, started_seq, ended_seq, outcome, error_class)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
       ON CONFLICT (run_id, node_id, attempt) DO UPDATE SET
         account_id = excluded.account_id, model = excluded.model, started_seq = excluded.started_seq,
         ended_seq = NULL, outcome = NULL, error_class = NULL, input_tokens = 0, output_tokens = 0, cost_micro_usd = 0`,
      [
        runId,
        nodeId,
        event.attempt ?? 0,
        event.payload.accountId,
        json(event.payload.model),
        event.seq,
      ],
    );
    return;
  }

  const attempt = event.attempt ?? next.nodes[nodeId]?.attempt ?? 0;
  if (attempt === 0) return;

  if (event.type === "model.call") {
    db.run(
      `UPDATE attempts SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
         cost_micro_usd = cost_micro_usd + ? WHERE run_id = ? AND node_id = ? AND attempt = ?`,
      [
        event.payload.usage.inputTokens,
        event.payload.usage.outputTokens,
        event.payload.costMicroUsd ?? 0,
        runId,
        nodeId,
        attempt,
      ],
    );
    return;
  }

  const outcome = ATTEMPT_ENDING[event.type];
  if (outcome !== undefined) {
    const errorClass = event.type === "node.failed" ? event.payload.errorClass : null;
    db.run(
      "UPDATE attempts SET ended_seq = ?, outcome = ?, error_class = ? WHERE run_id = ? AND node_id = ? AND attempt = ? AND ended_seq IS NULL",
      [event.seq, outcome, errorClass, runId, nodeId, attempt],
    );
  }

  if (event.type === "node.succeeded") {
    db.run(
      `INSERT INTO node_summaries (run_id, node_id, attempt, summary, created_seq) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (run_id, node_id, attempt) DO UPDATE SET summary = excluded.summary, created_seq = excluded.created_seq`,
      [runId, nodeId, attempt, event.payload.summary, event.seq],
    );
  }
}

/** Removes every projection row of a run (events are untouched). */
export function clearProjections(db: Db, runId: string): void {
  for (const table of [
    "node_summaries",
    "attempts",
    "approvals",
    "checkpoints",
    "node_deps",
    "nodes",
  ]) {
    db.run(`DELETE FROM ${table} WHERE run_id = ?`, [runId]);
  }
}

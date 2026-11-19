import { z } from "zod";
import { GitOid, MicroUsd, ModelRef, NodeId, PacketId, RunId, Tier } from "./primitives.js";

export const RepoRef = z.object({
  root: z.string().min(1),
  /** Branch or ref the run starts from, e.g. "main". */
  baseRef: z.string().min(1),
  /** Commit pinned at plan time so every worktree starts from the same point. */
  baseCommit: GitOid,
});
export type RepoRef = z.infer<typeof RepoRef>;

export const NodeKind = z.enum(["implement", "test", "refactor", "investigate", "docs"]);
export type NodeKind = z.infer<typeof NodeKind>;

const checkId = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, "expected a check id slug");

export const CheckSpec = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command"),
    id: checkId,
    label: z.string().min(1),
    /** argv, executed without a shell. */
    argv: z.tuple([z.string().min(1)], z.string()),
    /** Relative to the worktree root. */
    cwd: z.string(),
    timeoutMs: z.int().positive(),
    expectExitCode: z.int(),
  }),
  z.object({
    kind: z.literal("json_schema"),
    id: checkId,
    label: z.string().min(1),
    /** File in the worktree that must validate against the schema. */
    path: z.string().min(1),
    schema: z.record(z.string(), z.unknown()),
  }),
  z.object({
    /** Built in: fails if the diff touches anything outside writeScope. */
    kind: z.literal("scope_guard"),
    id: checkId,
    label: z.string().min(1),
  }),
]);
export type CheckSpec = z.infer<typeof CheckSpec>;

export const NodeBudget = z.object({
  maxInputTokens: z.int().positive(),
  maxOutputTokens: z.int().positive(),
  maxCostMicroUsd: MicroUsd,
  maxWallMs: z.int().positive(),
  maxTurns: z.int().positive(),
});
export type NodeBudget = z.infer<typeof NodeBudget>;

export const RunBudget = z.object({
  maxCostMicroUsd: MicroUsd,
  /** Cap on frontier tokens across planning, steering and review. */
  maxFrontierTokens: z.int().positive(),
  maxConcurrency: z.int().min(1).max(64),
  /** Ask a human when spend crosses these fractions of maxCostMicroUsd, e.g. [0.5, 0.8]. */
  approvalThresholds: z.array(z.number().gt(0).lt(1)),
});
export type RunBudget = z.infer<typeof RunBudget>;

export const RetryPolicy = z.object({
  /** Includes the first attempt. */
  maxAttempts: z.int().min(1).max(10),
  baseDelayMs: z.int().nonnegative(),
  maxDelayMs: z.int().nonnegative(),
  /** delay = random(0, min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))) */
  jitter: z.literal("full"),
});
export type RetryPolicy = z.infer<typeof RetryPolicy>;

export const EscalationPolicy = z.object({
  /** Worker retries with check output this many times before the frontier model is asked. */
  workerRetriesOnCheckFailure: z.int().nonnegative(),
  onAmbiguity: z.enum(["escalate", "ask_human"]),
  /** Frontier steers allowed for this node before it fails and asks a human. */
  maxSteers: z.int().nonnegative(),
});
export type EscalationPolicy = z.infer<typeof EscalationPolicy>;

export const TaskNode = z.object({
  id: NodeId,
  title: z.string().min(1).max(200),
  kind: NodeKind,
  dependsOn: z.array(NodeId),
  tier: Tier,
  /** Ordered preferences; the router picks the first with an account and quota headroom. */
  candidates: z.array(ModelRef).min(1),
  packetId: PacketId,
  /**
   * Globs the node may change. Empty means read-only. The scheduler never runs two nodes with
   * overlapping write scopes at once, and verification rejects changes outside the scope.
   */
  writeScope: z.array(z.string().min(1)),
  checks: z.array(CheckSpec),
  budget: NodeBudget,
  retry: RetryPolicy,
  escalation: EscalationPolicy,
});
export type TaskNode = z.infer<typeof TaskNode>;

export const IntegrationSpec = z.object({
  strategy: z.literal("merge_topological"),
  branch: z.string().min(1),
  /** Run after all nodes merge, before frontier review. */
  globalChecks: z.array(CheckSpec),
  frontierReview: z.boolean(),
});
export type IntegrationSpec = z.infer<typeof IntegrationSpec>;

/**
 * The plan. Validated structurally here; graph rules (acyclic, known dependencies, unique ids)
 * live in @orzeus/core's validatePlan so they can report every problem at once.
 */
export const TaskDAG = z.object({
  schemaVersion: z.literal(1),
  runId: RunId,
  /** Increments on every re-plan of the run. */
  revision: z.int().min(1),
  /** The user's goal, verbatim. */
  goal: z.string().min(1),
  repo: RepoRef,
  plannedBy: ModelRef,
  nodes: z.array(TaskNode).min(1).max(200),
  integration: IntegrationSpec,
  budget: RunBudget,
});
export type TaskDAG = z.infer<typeof TaskDAG>;

export const RunStatus = z.enum([
  "planning",
  "awaiting_plan_approval",
  "executing",
  "paused",
  "integrating",
  "reviewing",
  "awaiting_merge_approval",
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const NodeStatus = z.enum([
  "pending", // waiting on dependencies
  "ready", // dependencies succeeded, waiting for a slot
  "running", // leased by a worker session
  "verifying", // Orzeus is running checks
  "awaiting_approval", // blocked on a human gate
  "retry_wait", // backoff timer
  "escalated", // waiting on a frontier steer
  "succeeded",
  "failed",
  "cancelled",
  "skipped", // an upstream node failed
]);
export type NodeStatus = z.infer<typeof NodeStatus>;

export const TERMINAL_NODE_STATUSES: ReadonlySet<NodeStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
]);

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

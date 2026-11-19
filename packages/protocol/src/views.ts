import {
  CheckpointId,
  GateAction,
  ModelRef,
  NodeId,
  NodeStatus,
  ProposedAction,
  QuotaWindow,
  RepoRef,
  RunId,
  RunStatus,
  TaskDAG,
  Tier,
  TokenUsage,
} from "@orzeus/schema";
import { z } from "zod";

/**
 * What the UI sees of the engine's state. These are deliberately smaller than the engine's
 * internal types, so the UI never depends on store tables or reducer internals (ADR 0002).
 */
export const RunTotalsView = z.object({
  frontierTokens: z.int(),
  workerTokens: z.int(),
  costMicroUsd: z.int(),
});

export const RunSummary = z.object({
  runId: RunId,
  goal: z.string(),
  status: RunStatus,
  createdAt: z.int(),
  updatedAt: z.int(),
  nodes: z.int(),
  succeeded: z.int(),
  failed: z.int(),
  totals: RunTotalsView,
});
export type RunSummary = z.infer<typeof RunSummary>;

export const NodeView = z.object({
  id: NodeId,
  title: z.string(),
  kind: z.string(),
  tier: Tier,
  dependsOn: z.array(NodeId),
  writeScope: z.array(z.string()),
  status: NodeStatus,
  attempt: z.int(),
  steers: z.int(),
  model: ModelRef.nullable(),
  headCommit: z.string().nullable(),
  summary: z.string().nullable(),
  lastError: z.object({ errorClass: z.string(), message: z.string() }).nullable(),
  usage: TokenUsage,
  costMicroUsd: z.int(),
});
export type NodeView = z.infer<typeof NodeView>;

export const RunDetail = RunSummary.extend({
  repo: RepoRef,
  /** The approved plan, or the proposed one while it awaits approval. */
  dag: TaskDAG.nullable(),
  awaitingPlanApproval: z.boolean(),
  nodeViews: z.array(NodeView),
  checkpoints: z.array(z.object({ id: CheckpointId, label: z.string(), atSeq: z.int() })),
  headSeq: z.int(),
  /** True while this engine is driving the run. */
  active: z.boolean(),
});
export type RunDetail = z.infer<typeof RunDetail>;

export const PendingGate = z.object({
  id: z.string(),
  runId: RunId,
  nodeId: NodeId.nullable(),
  action: z.union([ProposedAction, GateAction]),
  reason: z.string(),
  requestedAt: z.int(),
  /** For merge gates: the integrated diff, so it can be reviewed side by side. */
  diff: z.string().nullable(),
});
export type PendingGate = z.infer<typeof PendingGate>;

export const AccountQuota = z.object({
  accountId: z.string(),
  label: z.string(),
  adapter: z.string(),
  windows: z.array(QuotaWindow),
});

export const QuotaReport = z.object({
  accounts: z.array(AccountQuota),
  totals: z.object({
    frontierTokens: z.int(),
    workerTokens: z.int(),
    costMicroUsd: z.int(),
    /** Worker tokens: work that would otherwise have run on the frontier model (an estimate). */
    frontierTokensAvoided: z.int(),
  }),
  routing: z.object({ planner: z.string().nullable(), worker: z.string() }),
});
export type QuotaReport = z.infer<typeof QuotaReport>;

export const AdapterInfo = z.object({
  id: z.string(),
  displayName: z.string(),
  provider: z.string(),
  roles: z.array(z.enum(["worker", "planner"])),
});

export const SettingsView = z.object({
  dataDir: z.string(),
  adapters: z.array(AdapterInfo),
  defaults: z.object({ planner: z.string().nullable(), worker: z.string() }),
  /** Which API keys the engine received (never the keys themselves). */
  secrets: z.object({ anthropic: z.boolean(), gemini: z.boolean(), openai: z.boolean() }),
  codexEnabled: z.boolean(),
});
export type SettingsView = z.infer<typeof SettingsView>;

export const MemoryView = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
});

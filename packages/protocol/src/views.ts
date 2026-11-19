import {
  CheckpointId,
  CheckSpec,
  GateAction,
  McpToolGrant,
  ModelRef,
  NodeId,
  NodeKind,
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
  /** Latest observation of each window that has not reset yet, from any source. */
  windows: z.array(QuotaWindow),
  /** Window name → percent at which Orzeus stops starting new work on this account. */
  softCaps: z.record(z.string(), z.number()),
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
  secrets: z.object({
    anthropic: z.boolean(),
    gemini: z.boolean(),
    openai: z.boolean(),
    cursor: z.boolean(),
  }),
  codexEnabled: z.boolean(),
});
export type SettingsView = z.infer<typeof SettingsView>;

export const MemoryView = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
});

/**
 * The editable part of a proposed plan. Everything else (budgets, retry and escalation policy,
 * context pointers, integration) is kept from the plan being revised; new nodes get defaults.
 */
export const PlanEditNode = z.object({
  id: NodeId,
  title: z.string().min(1).max(200),
  kind: NodeKind,
  dependsOn: z.array(NodeId),
  /** Ordered preferences, first is used when it has quota. */
  candidates: z.array(ModelRef).min(1),
  writeScope: z.array(z.string().min(1)),
  checks: z.array(CheckSpec),
  objective: z.string().min(1).max(4000),
  acceptance: z.array(z.string().min(1)).min(1),
  constraints: z.array(z.string().min(1)),
  /** MCP tools the worker may use through the gateway. */
  mcp: z.array(McpToolGrant),
});
export type PlanEditNode = z.infer<typeof PlanEditNode>;

export const PlanEdit = z.object({
  revision: z.int().min(1),
  nodes: z.array(PlanEditNode).min(1),
  maxConcurrency: z.int().min(1).max(64),
});
export type PlanEdit = z.infer<typeof PlanEdit>;

/** A server id doubles as the tool namespace workers see (`<id>__<tool>`). */
export const McpServerId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "lowercase letters, digits and dashes");

export const McpServerConfig = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()),
    /** Plain (non-secret) environment for the server process. */
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()),
    /** The Keychain secret, if any, is given to the process under this variable. */
    secretEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .nullable(),
  }),
  z.object({
    transport: z.literal("streamable_http"),
    url: z.url({ protocol: /^https?$/ }),
    /** The Keychain secret, if any, is sent as `Authorization: Bearer <secret>`. */
  }),
]);
export type McpServerConfig = z.infer<typeof McpServerConfig>;

/** What workers get from this server in new plans, before anyone edits them. */
export const McpDefaultGrant = z.enum(["none", "read", "all"]);
export type McpDefaultGrant = z.infer<typeof McpDefaultGrant>;

export const McpToolInfo = z.object({
  name: z.string(),
  description: z.string(),
  readOnly: z.boolean(),
});
export type McpToolInfo = z.infer<typeof McpToolInfo>;

export const McpServerInput = z.object({
  id: McpServerId,
  name: z.string().min(1).max(100),
  enabled: z.boolean(),
  config: McpServerConfig,
  defaultGrant: McpDefaultGrant,
});
export type McpServerInput = z.infer<typeof McpServerInput>;

export const McpServerView = McpServerInput.extend({
  /** Whether the engine received this server's Keychain secret (never the secret itself). */
  secretSet: z.boolean(),
  /** The environment variable the desktop shell uses to hand the secret to the engine. */
  secretVar: z.string(),
  /** The last connection test, or null if it was never tested. */
  discovered: z
    .object({
      at: z.int(),
      ok: z.boolean(),
      error: z.string().nullable(),
      serverName: z.string().nullable(),
      serverVersion: z.string().nullable(),
      tools: z.array(McpToolInfo),
    })
    .nullable(),
});
export type McpServerView = z.infer<typeof McpServerView>;

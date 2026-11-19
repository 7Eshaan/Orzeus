import { validatePlan } from "@orzeus/core";
import {
  CheckSpec,
  type ContextPacketBody,
  ContextRef,
  EscalationPolicy,
  type McpToolGrant,
  ModelRef,
  NodeBudget,
  NodeId,
  NodeKind,
  type PacketId,
  type PlanDraft,
  PlannerOutput,
  type RepoRef,
  RetryPolicy,
  RunBudget,
  type RunId,
  type TaskDAG,
  Tier,
  ToolAllowlist,
} from "@orzeus/schema";
import { z } from "zod";

/** Tools every packet gets by default: read the repository memory; proposing memories needs approval. */
export const DEFAULT_MCP_GRANTS: readonly McpToolGrant[] = [
  { server: "memory", tool: "memory_search", access: "read", loading: "eager" },
  { server: "memory", tool: "memory_get", access: "read", loading: "eager" },
  { server: "memory", tool: "memory_propose", access: "write", loading: "lazy" },
];

/**
 * A hand-written plan: the planner's output shape with ids, repo and run details filled in by
 * Orzeus, and sensible defaults so a plan file stays short. Phase 3 replaces hand-written plans
 * with the frontier planner, which emits the full PlannerOutput directly.
 */
const HandPacket = z.object({
  objective: z.string().min(1),
  nonGoals: z.array(z.string().min(1)).default([]),
  acceptance: z
    .array(z.object({ statement: z.string().min(1), checkId: z.string().nullable().default(null) }))
    .min(1),
  context: z.array(ContextRef).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  tools: ToolAllowlist.default({
    mcp: [],
    builtin: [{ kind: "read_files" }, { kind: "edit_files" }],
    network: "none",
    networkAllowlist: [],
  }),
  maxContextTokens: z.int().positive().default(16_000),
});

const HandNode = z.object({
  id: NodeId,
  title: z.string().min(1),
  kind: NodeKind.default("implement"),
  dependsOn: z.array(NodeId).default([]),
  tier: Tier.default("worker"),
  candidates: z.array(ModelRef).min(1),
  writeScope: z.array(z.string().min(1)).default([]),
  checks: z.array(CheckSpec).default([]),
  budget: NodeBudget.partial().default({}),
  retry: RetryPolicy.partial().default({}),
  escalation: EscalationPolicy.partial().default({}),
  packet: HandPacket,
});

export const HandPlan = z.object({
  goal: z.string().min(1),
  nodes: z.array(HandNode).min(1),
  budget: RunBudget.partial().default({}),
  integrationBranch: z.string().min(1).optional(),
});
export type HandPlan = z.infer<typeof HandPlan>;

const NODE_BUDGET: NodeBudget = {
  maxInputTokens: 400_000,
  maxOutputTokens: 60_000,
  maxCostMicroUsd: 5_000_000,
  maxWallMs: 900_000,
  maxTurns: 30,
};
const RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
  jitter: "full",
};
/** No frontier steering until Phase 3, so escalations go to a human by default. */
const ESCALATION: EscalationPolicy = {
  workerRetriesOnCheckFailure: 1,
  onAmbiguity: "ask_human",
  maxSteers: 0,
};
const RUN_BUDGET: RunBudget = {
  maxCostMicroUsd: 20_000_000,
  maxFrontierTokens: 1_000_000,
  maxConcurrency: 2,
  approvalThresholds: [0.5, 0.8],
};

/** Fills in defaults, ignoring keys that are present but undefined. */
function withDefaults<T extends object>(
  defaults: T,
  partial: { readonly [K in keyof T]?: T[K] | undefined },
): T {
  const result = { ...defaults };
  for (const key of Object.keys(partial) as (keyof T)[]) {
    const value = partial[key];
    if (value !== undefined) result[key] = value as T[keyof T];
  }
  return result;
}

export class PlanFileError extends Error {
  override readonly name = "PlanFileError";
}

/** Expands a hand plan into a validated PlannerOutput for a concrete run and repository. */
export function expandHandPlan(input: unknown, runId: RunId, repo: RepoRef): PlannerOutput {
  const parsed = HandPlan.safeParse(input);
  if (!parsed.success)
    throw new PlanFileError(`Plan file is invalid:\n${z.prettifyError(parsed.error)}`);
  const plan = parsed.data;

  const dag: TaskDAG = {
    schemaVersion: 1,
    runId,
    revision: 1,
    goal: plan.goal,
    repo,
    plannedBy: { provider: "acp", adapter: "hand-written", model: "human" },
    nodes: plan.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      kind: n.kind,
      dependsOn: n.dependsOn,
      tier: n.tier,
      candidates: n.candidates,
      packetId: `packet-${n.id}` as PacketId,
      writeScope: n.writeScope,
      checks: n.checks,
      budget: withDefaults(NODE_BUDGET, n.budget),
      retry: withDefaults(RETRY, n.retry),
      escalation: withDefaults(ESCALATION, n.escalation),
    })),
    integration: {
      strategy: "merge_topological",
      branch: plan.integrationBranch ?? `orzeus/${runId}/integration`,
      globalChecks: [],
      frontierReview: false,
    },
    budget: withDefaults(RUN_BUDGET, plan.budget),
  };

  const packets: ContextPacketBody[] = plan.nodes.map((n) => ({
    schemaVersion: 1,
    id: `packet-${n.id}` as PacketId,
    runId,
    nodeId: n.id,
    objective: n.packet.objective,
    nonGoals: n.packet.nonGoals,
    acceptance: n.packet.acceptance.map((a, i) => ({
      id: `ac-${i + 1}`,
      statement: a.statement,
      checkId: a.checkId,
    })),
    context: n.packet.context,
    constraints: n.packet.constraints.map((text, i) => ({
      id: `c-${i + 1}`,
      text,
      source: "user" as const,
    })),
    tools: n.packet.tools,
    upstream: [],
    steering: [],
    limits: { maxContextTokens: n.packet.maxContextTokens },
  }));

  const output = PlannerOutput.parse({ dag, packets });
  const validation = validatePlan(output.dag, output.packets);
  if (validation.errors.length > 0) {
    throw new PlanFileError(
      `Plan has problems:\n${validation.errors.map((e) => `  - ${e.message}`).join("\n")}`,
    );
  }
  return output;
}

export function nodeIdOf(value: string): NodeId {
  return NodeId.parse(value);
}

export interface TierModels {
  readonly worker: readonly ModelRef[];
  readonly local: readonly ModelRef[];
}

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "task";

/**
 * Converts the planner's draft into a hand-plan shape (then expandHandPlan validates it).
 * Orzeus, not the model, chooses worker models (by tier), budgets and tool grants. Pointers
 * missing required fields are dropped and reported, rather than failing the plan.
 */
export function draftToHandPlan(
  draft: PlanDraft,
  goal: string,
  tiers: TierModels,
): { plan: unknown; dropped: string[] } {
  const dropped: string[] = [];
  const ids = new Map(draft.nodes.map((n) => [n.id, slug(n.id)]));
  const nodes = draft.nodes.map((n) => {
    const context = n.context.flatMap((ref): Record<string, unknown>[] => {
      if (ref.kind === "file_range" && ref.path && ref.startLine !== null && ref.endLine !== null) {
        return [
          {
            kind: "file_range",
            path: ref.path,
            startLine: Math.max(1, ref.startLine),
            endLine: Math.max(ref.startLine, ref.endLine),
            why: ref.why || "context",
          },
        ];
      }
      if (ref.kind === "symbol" && ref.path && ref.symbol) {
        return [
          {
            kind: "symbol",
            path: ref.path,
            symbol: ref.symbol,
            symbolKind: "function",
            why: ref.why || "context",
          },
        ];
      }
      if (ref.kind === "memory" && ref.memoryId)
        return [{ kind: "memory", memoryId: ref.memoryId, why: ref.why || "context" }];
      dropped.push(`${n.id}: dropped an incomplete ${ref.kind} pointer`);
      return [];
    });
    const checks = n.checks
      .filter((c) => c.argv.length > 0 && c.argv[0] !== "")
      .map((c) => ({
        kind: "command",
        id: slug(c.id),
        label: c.label || c.argv.join(" "),
        argv: c.argv,
        cwd: ".",
        timeoutMs: 120_000,
        expectExitCode: 0,
      }));
    const checkIds = new Set(checks.map((c) => c.id));
    return {
      id: ids.get(n.id),
      title: n.title,
      kind: n.kind,
      dependsOn: n.dependsOn.map((d) => ids.get(d) ?? slug(d)),
      tier: n.tier,
      candidates: n.tier === "local" && tiers.local.length > 0 ? tiers.local : tiers.worker,
      writeScope: n.writeScope,
      checks,
      packet: {
        objective: n.objective,
        nonGoals: n.nonGoals,
        acceptance: (n.acceptance.length > 0
          ? n.acceptance
          : [{ statement: n.objective, checkId: null }]
        ).map((a) => ({
          statement: a.statement,
          checkId: a.checkId !== null && checkIds.has(slug(a.checkId)) ? slug(a.checkId) : null,
        })),
        context,
        constraints: n.constraints,
        tools: {
          mcp: [...DEFAULT_MCP_GRANTS],
          builtin: [{ kind: "read_files" }, { kind: "edit_files" }],
          network: "none",
          networkAllowlist: [],
        },
      },
    };
  });
  return { plan: { goal, nodes }, dropped };
}

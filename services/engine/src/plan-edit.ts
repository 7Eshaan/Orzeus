import { validatePlan } from "@orzeus/core";
import type { PlanEdit, PlanEditNode } from "@orzeus/protocol";
import {
  type AcceptanceCriterion,
  type Constraint,
  type ContextPacketBody,
  type McpToolGrant,
  type PacketId,
  PlannerOutput,
  type TaskNode,
} from "@orzeus/schema";
import { ESCALATION, NODE_BUDGET, PlanFileError, RETRY } from "./plan-file.js";

const DEFAULT_CONTEXT_TOKENS = 16_000;

/** The proposed plan as the UI edits it. */
export function toPlanEdit(plan: PlannerOutput): PlanEdit {
  const packets = new Map(plan.packets.map((p) => [p.nodeId, p]));
  return {
    revision: plan.dag.revision,
    maxConcurrency: plan.dag.budget.maxConcurrency,
    nodes: plan.dag.nodes.map((node): PlanEditNode => {
      const packet = packets.get(node.id);
      return {
        id: node.id,
        title: node.title,
        kind: node.kind,
        dependsOn: [...node.dependsOn],
        candidates: [...node.candidates],
        writeScope: [...node.writeScope],
        checks: [...node.checks],
        objective: packet?.objective ?? node.title,
        acceptance: packet?.acceptance.map((a) => a.statement) ?? [node.title],
        constraints: packet?.constraints.map((c) => c.text) ?? [],
        mcp: [...(packet?.tools.mcp ?? [])],
      };
    }),
  };
}

/** Keeps a criterion's check link (and a constraint's source) when its text is unchanged. */
function acceptanceFor(
  statements: readonly string[],
  before: readonly AcceptanceCriterion[],
  checkIds: ReadonlySet<string>,
): AcceptanceCriterion[] {
  return statements.map((statement, i) => {
    const kept = before.find((a) => a.statement === statement);
    const checkId = kept?.checkId ?? null;
    return {
      id: `ac-${i + 1}`,
      statement,
      checkId: checkId !== null && checkIds.has(checkId) ? checkId : null,
    };
  });
}

function constraintsFor(texts: readonly string[], before: readonly Constraint[]): Constraint[] {
  return texts.map((text, i) => ({
    id: `c-${i + 1}`,
    text,
    source: before.find((c) => c.text === text)?.source ?? "user",
  }));
}

/**
 * Applies a human edit to the proposed plan and returns the next revision. Nodes keep what the
 * edit does not cover (budgets, retry and escalation policy, context pointers, network grants);
 * new nodes get the same defaults as a hand-written plan. Throws PlanFileError listing every
 * problem, so the UI can show them all at once.
 */
export function applyPlanEdit(current: PlannerOutput, edit: PlanEdit): PlannerOutput {
  if (edit.revision !== current.dag.revision) {
    throw new PlanFileError(
      `The plan changed while you were editing it (revision ${current.dag.revision}, you edited ${edit.revision}). Reload it and try again.`,
    );
  }
  const { runId } = current.dag;
  const tasks = new Map(current.dag.nodes.map((n) => [n.id, n]));
  const packets = new Map(current.packets.map((p) => [p.nodeId, p]));

  const nodes: TaskNode[] = [];
  const bodies: ContextPacketBody[] = [];
  for (const e of edit.nodes) {
    const task = tasks.get(e.id);
    const packet = packets.get(e.id);
    const packetId = task?.packetId ?? (`packet-${e.id}` as PacketId);
    nodes.push({
      id: e.id,
      title: e.title,
      kind: e.kind,
      dependsOn: e.dependsOn,
      tier: task?.tier ?? "worker",
      candidates: e.candidates,
      packetId,
      writeScope: e.writeScope,
      checks: e.checks,
      budget: task?.budget ?? NODE_BUDGET,
      retry: task?.retry ?? RETRY,
      escalation: task?.escalation ?? ESCALATION,
    });
    const tools = packet?.tools ?? {
      mcp: [],
      builtin: [{ kind: "read_files" as const }, { kind: "edit_files" as const }],
      network: "none" as const,
      networkAllowlist: [],
    };
    bodies.push({
      schemaVersion: 1,
      id: packetId,
      runId,
      nodeId: e.id,
      objective: e.objective,
      nonGoals: packet?.nonGoals ?? [],
      acceptance: acceptanceFor(
        e.acceptance,
        packet?.acceptance ?? [],
        new Set(e.checks.map((c) => c.id)),
      ),
      context: packet?.context ?? [],
      constraints: constraintsFor(e.constraints, packet?.constraints ?? []),
      tools: { ...tools, mcp: dedupeGrants(e.mcp) },
      upstream: [],
      steering: [],
      limits: packet?.limits ?? { maxContextTokens: DEFAULT_CONTEXT_TOKENS },
    });
  }

  const parsed = PlannerOutput.safeParse({
    dag: {
      ...current.dag,
      revision: current.dag.revision + 1,
      nodes,
      budget: { ...current.dag.budget, maxConcurrency: edit.maxConcurrency },
    },
    packets: bodies,
  });
  if (!parsed.success) {
    throw new PlanFileError(
      `Plan has problems:\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`,
    );
  }
  const validation = validatePlan(parsed.data.dag, parsed.data.packets);
  if (validation.errors.length > 0) {
    throw new PlanFileError(
      `Plan has problems:\n${validation.errors.map((e) => `  - ${e.message}`).join("\n")}`,
    );
  }
  return parsed.data;
}

/** One grant per server/tool; a write grant wins over a read grant for the same tool. */
export function dedupeGrants(grants: readonly McpToolGrant[]): McpToolGrant[] {
  const byKey = new Map<string, McpToolGrant>();
  for (const g of grants) {
    const key = `${g.server}\u0000${g.tool}`;
    const prior = byKey.get(key);
    byKey.set(key, prior === undefined || g.access === "write" ? g : prior);
  }
  return [...byKey.values()];
}

/** Adds grants to every packet of a plan (used for the configured MCP servers' defaults). */
export function withGrants(plan: PlannerOutput, grants: readonly McpToolGrant[]): PlannerOutput {
  if (grants.length === 0) return plan;
  return {
    ...plan,
    packets: plan.packets.map((p) => ({
      ...p,
      tools: { ...p.tools, mcp: dedupeGrants([...p.tools.mcp, ...grants]) },
    })),
  };
}

import { z } from "zod";
import { TaskDAG } from "./dag.js";
import { ContextPacketBody } from "./packet.js";

/** What the planner returns: the DAG plus one packet body per node (hashes are added on ingest). */
export const PlannerOutput = z.object({
  dag: TaskDAG,
  packets: z.array(ContextPacketBody).min(1),
});
export type PlannerOutput = z.infer<typeof PlannerOutput>;

/**
 * What the planner model is asked to produce. Deliberately smaller than PlannerOutput: ids,
 * routing, budgets and packet bookkeeping are filled in by Orzeus. Every field is required
 * (nullable where optional) so the same JSON Schema works with strict structured-output modes
 * across providers.
 */
export const PlanDraftCheck = z.object({
  id: z.string().describe("Short slug, unique within the node, e.g. test"),
  label: z.string(),
  argv: z
    .array(z.string())
    .describe('Command as an argv array, no shell. Example: ["node", "--test", "test/a.test.js"]'),
});

export const PlanDraftContextRef = z.object({
  kind: z.enum(["file_range", "symbol", "memory"]),
  path: z.string().nullable().describe("Repository-relative file path (file_range, symbol)"),
  startLine: z.int().nullable(),
  endLine: z.int().nullable(),
  symbol: z.string().nullable().describe("Symbol name for kind=symbol, e.g. AuthService.refresh"),
  memoryId: z.string().nullable().describe("Memory id for kind=memory"),
  why: z.string(),
});

export const PlanDraftNode = z.object({
  id: z.string().describe("Lowercase slug, unique in the plan, e.g. add-subtract"),
  title: z.string(),
  kind: z.enum(["implement", "test", "refactor", "investigate", "docs"]),
  dependsOn: z.array(z.string()).describe("Ids of nodes that must finish first"),
  tier: z
    .enum(["worker", "local"])
    .describe("worker for normal coding tasks, local for trivial ones"),
  writeScope: z.array(z.string()).describe("Files or globs this node may change; [] for read-only"),
  checks: z.array(PlanDraftCheck).describe("Deterministic commands that prove the node is done"),
  objective: z.string().describe("One focused paragraph for the worker"),
  nonGoals: z.array(z.string()),
  acceptance: z.array(z.object({ statement: z.string(), checkId: z.string().nullable() })),
  context: z
    .array(PlanDraftContextRef)
    .describe("Pointers to the exact code and memories the worker needs"),
  constraints: z.array(z.string()),
});

export const PlanDraft = z.object({
  summary: z.string().describe("One or two sentences on the approach"),
  nodes: z.array(PlanDraftNode),
});
export type PlanDraft = z.infer<typeof PlanDraft>;

/** The frontier model's answer when a node escalates. */
export const SteerDecision = z.object({
  action: z
    .enum(["retry_with_guidance", "rewrite_task", "give_up"])
    .describe(
      "retry_with_guidance: same task plus your note; rewrite_task: replace the objective/constraints; give_up: stop this node",
    ),
  note: z.string().describe("Specific guidance for the worker's next attempt, or why to give up"),
  revisedObjective: z
    .string()
    .nullable()
    .describe("New objective when action is rewrite_task, otherwise null"),
  revisedConstraints: z.array(z.string()).describe("Constraints to use from now on (may be empty)"),
});
export type SteerDecision = z.infer<typeof SteerDecision>;

/** The frontier model's review of the integrated diff. */
export const ReviewDecision = z.object({
  verdict: z.enum(["approve", "request_changes"]),
  summary: z.string().describe("Two or three sentences on what the change does"),
  concerns: z
    .array(z.string())
    .describe("Specific problems that must be fixed; empty when approving"),
});
export type ReviewDecision = z.infer<typeof ReviewDecision>;

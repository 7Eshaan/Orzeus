/**
 * Prompts for the frontier planner. Pure and deterministic, so identical inputs produce identical
 * prompts (good for provider prompt caches and for reproducing a plan from the trace).
 */
export const PLANNER_SYSTEM_PROMPT = [
  "You are the planner in Orzeus, a coding orchestrator. Cheaper worker models will carry out your plan,",
  "each node in its own git worktree, seeing only the packet you write for it. Plan carefully:",
  "",
  "- Use the fewest nodes that let independent work run in parallel. Small goals need one node.",
  "- Give every node an exact writeScope (file paths or narrow globs). Nodes that could run at the",
  "  same time must not share files; if they must, make one depend on the other.",
  "- Give every implement or test node at least one check: a command (argv array, no shell) using the",
  "  repository's existing tooling (see Build and test tooling; never invent scripts) that passes",
  "  only when the node is done.",
  "- Point workers at exact code: file_range pointers with line numbers or symbol pointers taken from",
  "  the repository map, and memory pointers by id when a recorded decision applies.",
  "- Write each objective as one focused paragraph a worker can act on without seeing this conversation.",
  "- Use lowercase slug ids; dependsOn may only name ids in this plan; no cycles.",
  "- Do not add work the goal did not ask for.",
].join("\n");

export interface PlannerMemory {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
}

export function renderPlannerPrompt(input: {
  readonly goal: string;
  readonly repoMap: string;
  readonly memories: readonly PlannerMemory[];
  /** How the repository builds and tests, so checks use commands that exist. */
  readonly tooling?: string;
}): string {
  const memories =
    input.memories.length === 0
      ? "(none recorded)"
      : input.memories.map((m) => `- [${m.id}] ${m.kind}: ${m.title}. ${m.body}`).join("\n");
  return `# Goal\n${input.goal}\n\n# Repository map\n${input.repoMap}\n\n# Build and test tooling\n${input.tooling ?? "Unknown."}\n\n# Recorded memories\n${memories}\n\nReturn the plan as JSON matching the schema.`;
}

/** Second chance after validation failed: the planner sees its own answer and every problem. */
export function renderRepairPrompt(
  original: string,
  previous: string,
  problems: readonly string[],
): string {
  return `${original}\n\n# Your previous answer\n${previous}\n\n# Problems to fix\n${problems.map((p) => `- ${p}`).join("\n")}\n\nReturn the corrected plan as JSON matching the schema.`;
}

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { buildRepoMap, describeTooling, renderRepoMap } from "@orzeus/context";
import type { PlannerOutput, ProjectId, RepoRef, RunId } from "@orzeus/schema";
import type { Engine } from "./compose.js";
import { ulid } from "./ids.js";
import { checkCommandsExist } from "./plan-checks.js";
import { PlanningError, planGoal } from "./planner.js";

export interface PreparedRepo {
  readonly repo: RepoRef;
  readonly projectId: ProjectId;
}

/** Resolves a repository path and base ref, and registers it as a project. */
export async function prepareRepo(
  engine: Engine,
  path: string,
  baseRef = "HEAD",
): Promise<PreparedRepo> {
  const root = await engine.git.topLevel(resolve(path));
  const baseCommit = await engine.git.revParse(root, baseRef);
  const projectId =
    `project-${createHash("sha256").update(root).digest("hex").slice(0, 16)}` as ProjectId;
  engine.store.ensureProject({
    id: projectId,
    name: root.split("/").at(-1) ?? root,
    repoRoot: root,
    defaultBranch: baseRef,
    createdAt: Date.now(),
  });
  return { repo: { root, baseRef, baseCommit }, projectId };
}

/**
 * Starts a run for a goal and has the frontier model plan it: records the run, the planning
 * calls, the packets and the proposed plan (or the planning failure). Used by the CLI and the
 * desktop app alike.
 */
export async function planRun(
  engine: Engine,
  input: {
    readonly goal: string;
    readonly prepared: PreparedRepo;
    readonly planner: string;
    readonly worker: string;
    readonly runId?: RunId;
  },
  say: (line: string) => void = () => undefined,
): Promise<{
  readonly runId: RunId;
  readonly plan: PlannerOutput | null;
  readonly summary: string;
}> {
  const { repo, projectId } = input.prepared;
  const runId = input.runId ?? (ulid() as RunId);
  const planner = engine.planner(input.planner);
  const worker = engine.workerModel(input.worker);
  engine.orchestrator.startRun(projectId, runId, input.goal, repo);
  say(`Run ${runId}: planning with ${input.planner}…`);
  try {
    const result = await planGoal({
      goal: input.goal,
      runId,
      repo,
      repoMap: renderRepoMap(await buildRepoMap(engine.git, repo.root)),
      tooling: describeTooling(repo.root),
      validate: (candidate) => checkCommandsExist(candidate, repo.root),
      memories: engine.memory.search(repo.root, input.goal, 8),
      planner,
      tiers: { worker: [worker], local: [worker] },
      signal: AbortSignal.timeout(600_000),
    });
    for (const warning of result.warnings) say(`  note: ${warning}`);
    engine.orchestrator.proposePlan(result.plan, result.calls);
    say(`Plan: ${result.summary}`);
    return { runId, plan: result.plan, summary: result.summary };
  } catch (error) {
    if (error instanceof PlanningError) {
      engine.orchestrator.failPlanning(runId, error.calls, error.message);
      return { runId, plan: null, summary: error.message };
    }
    throw error;
  }
}

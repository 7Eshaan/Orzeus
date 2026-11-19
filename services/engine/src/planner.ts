import {
  PLANNER_SYSTEM_PROMPT,
  type PlannerMemory,
  renderPlannerPrompt,
  renderRepairPrompt,
} from "@orzeus/core";
import type { AccountContext, OutputSchema, ProviderAdapter } from "@orzeus/providers";
import {
  type ModelRef,
  PlanDraft,
  type PlannerOutput,
  type RepoRef,
  type RunId,
  type TokenUsage,
} from "@orzeus/schema";
import { z } from "zod";
import { draftToHandPlan, expandHandPlan, PlanFileError, type TierModels } from "./plan-file.js";

export interface PlannerModel {
  readonly ref: ModelRef;
  readonly adapter: ProviderAdapter;
  readonly account: AccountContext;
}

export interface PlanningCall {
  readonly model: ModelRef;
  readonly usage: TokenUsage;
  readonly costMicroUsd: number | null;
  readonly latencyMs: number;
}

export interface PlanningResult {
  readonly plan: PlannerOutput;
  readonly summary: string;
  readonly calls: readonly PlanningCall[];
  readonly warnings: readonly string[];
}

export class PlanningError extends Error {
  override readonly name = "PlanningError";
  readonly calls: readonly PlanningCall[];

  constructor(message: string, calls: readonly PlanningCall[]) {
    super(message);
    this.calls = calls;
  }
}

const OUTPUT: OutputSchema<PlanDraft> = {
  name: "orzeus_plan",
  jsonSchema: z.toJSONSchema(PlanDraft) as Record<string, unknown>,
  parse: (value) => PlanDraft.parse(value),
};

/**
 * Asks the frontier model for a plan, turns it into a validated PlannerOutput, and gives the
 * model one chance to repair a plan that fails validation. Every model call is returned so the
 * caller can record it in the trace.
 */
export async function planGoal(input: {
  readonly goal: string;
  readonly runId: RunId;
  readonly repo: RepoRef;
  readonly repoMap: string;
  readonly tooling?: string;
  readonly memories: readonly PlannerMemory[];
  readonly planner: PlannerModel;
  readonly tiers: TierModels;
  readonly maxOutputTokens?: number;
  /** Extra checks against the real repository; any problem triggers the repair round. */
  readonly validate?: (plan: PlannerOutput) => readonly string[];
  readonly signal: AbortSignal;
}): Promise<PlanningResult> {
  const { planner } = input;
  if (planner.adapter.generate === undefined) {
    throw new PlanningError(`${planner.ref.adapter} cannot produce structured plans`, []);
  }
  const adapter = planner.adapter as Required<Pick<ProviderAdapter, "generate">>;

  const calls: PlanningCall[] = [];
  const prompt = renderPlannerPrompt({
    goal: input.goal,
    repoMap: input.repoMap,
    memories: input.memories,
  });
  let currentPrompt = prompt;
  let lastProblem = "";

  for (let round = 0; round < 2; round++) {
    let raw = "";
    try {
      const result = await adapter.generate<PlanDraft>(
        {
          model: planner.ref.model,
          system: PLANNER_SYSTEM_PROMPT,
          prompt: currentPrompt,
          output: OUTPUT,
          maxOutputTokens: input.maxOutputTokens ?? 8_000,
        },
        planner.account,
        input.signal,
      );
      calls.push({
        model: planner.ref,
        usage: result.usage,
        costMicroUsd: result.costMicroUsd,
        latencyMs: result.latencyMs,
      });
      raw = JSON.stringify(result.value);
      const { plan, dropped } = draftToHandPlan(result.value, input.goal, input.tiers);
      const expanded = expandHandPlan(plan, input.runId, input.repo);
      const problems = input.validate?.(expanded) ?? [];
      if (problems.length > 0) {
        throw new PlanFileError(
          `Plan has problems:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
        );
      }
      return { plan: expanded, summary: result.value.summary, calls, warnings: dropped };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !(error instanceof PlanFileError) &&
        !(error instanceof Error && error.name === "StructuredOutputError")
      ) {
        throw new PlanningError(message, calls);
      }
      lastProblem = message;
      const fromError = (error as { raw?: string }).raw;
      currentPrompt = renderRepairPrompt(
        prompt,
        raw || fromError || "(no valid JSON)",
        message.split("\n").filter((l) => l.trim() !== ""),
      );
    }
  }
  throw new PlanningError(`The planner could not produce a valid plan: ${lastProblem}`, calls);
}

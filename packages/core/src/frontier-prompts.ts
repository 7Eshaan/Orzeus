import type { ContextPacket } from "@orzeus/schema";

/**
 * Prompts for the two targeted frontier calls after planning: steering a failing node and
 * reviewing the integrated result. Both send only what the decision needs (the packet, the diff,
 * the failing output), never worker transcripts.
 */
export const STEER_SYSTEM_PROMPT = [
  "You supervise a cheaper worker model in Orzeus. A task you planned has failed or stalled.",
  "Decide the cheapest way forward:",
  "- retry_with_guidance: the task is right; the worker needs a specific hint (name files, functions, the actual bug).",
  "- rewrite_task: the task itself was wrong or unclear; give a corrected objective and constraints.",
  "- give_up: the task cannot succeed as planned; explain why for the human.",
  "Be concrete. The worker sees only your note and the task, not this conversation.",
].join("\n");

export function renderSteerPrompt(input: {
  readonly packet: ContextPacket;
  readonly reason: string;
  readonly attempt: number;
  readonly diff: string;
  readonly failures: string;
  readonly workerSummary: string;
}): string {
  const constraints = input.packet.constraints.map((c) => `- ${c.text}`).join("\n") || "(none)";
  const acceptance = input.packet.acceptance.map((a) => `- ${a.statement}`).join("\n");
  const notes =
    input.packet.steering.map((s) => `- attempt ${s.attempt}: ${s.note}`).join("\n") || "(none)";
  return [
    `# Task (node ${input.packet.nodeId})\n${input.packet.objective}`,
    `# Acceptance\n${acceptance}`,
    `# Constraints\n${constraints}`,
    `# Earlier guidance\n${notes}`,
    `# What happened (attempt ${input.attempt}, ${input.reason})\nWorker's summary: ${input.workerSummary || "(none)"}`,
    `# Failing checks\n${input.failures || "(no check output)"}`,
    `# Worker's diff\n${input.diff || "(no changes)"}`,
    "Return your decision as JSON matching the schema.",
  ].join("\n\n");
}

export const REVIEW_SYSTEM_PROMPT = [
  "You review the integrated result of a plan you made in Orzeus before it is offered for merge.",
  "All automated checks passed. Look for what checks miss: wrong behaviour, missing pieces of the",
  "goal, changes outside the goal, security problems. Approve unless there is a concrete problem.",
].join("\n");

export function renderReviewPrompt(input: {
  readonly goal: string;
  readonly diff: string;
  readonly summaries: readonly string[];
}): string {
  return [
    `# Goal\n${input.goal}`,
    `# What each task reported\n${input.summaries.map((s) => `- ${s}`).join("\n") || "(none)"}`,
    `# Integrated diff\n${input.diff || "(empty)"}`,
    "Return your review as JSON matching the schema.",
  ].join("\n\n");
}

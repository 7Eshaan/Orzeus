import { z } from "zod";
import { ApprovalDecision, GateAction, ProposedAction, QuotaWindow } from "./actions.js";
import { RepoRef, TaskDAG } from "./dag.js";
import {
  AccountId,
  ApprovalId,
  CheckpointId,
  GitOid,
  MicroUsd,
  ModelRef,
  NodeId,
  PacketId,
  ProjectId,
  RunId,
  Sha256,
  Tier,
  TokenUsage,
  UnixMs,
} from "./primitives.js";

const empty = z.strictObject({});
const errorClass = z
  .string()
  .regex(/^[a-z][a-z0-9_.]*$/, "expected a stable error class like provider.timeout");

/**
 * Payload schema for every event type. The trace and the event store are the same log: every
 * state transition and every observation is one of these. See ADR 0004.
 */
export const TraceEventPayloads = {
  "run.created": z.object({ projectId: ProjectId, goal: z.string().min(1), repo: RepoRef }),
  /** The DAG is inline: it is small, and reducers must not need the blob store. */
  "plan.proposed": z.object({ revision: z.int().min(1), dag: TaskDAG }),
  "plan.approved": z.object({ revision: z.int().min(1), edited: z.boolean() }),
  "packet.issued": z.object({ packetId: PacketId, contentHash: Sha256 }),
  "node.ready": empty,
  "node.dispatched": z.object({
    model: ModelRef,
    accountId: AccountId,
    worktree: z.string().min(1),
    branch: z.string().min(1),
    baseCommit: GitOid,
    packetHash: Sha256,
  }),
  "node.verifying": empty,
  "model.call": z.object({
    model: ModelRef,
    tier: Tier,
    purpose: z.enum(["plan", "work", "steer", "review"]),
    usage: TokenUsage,
    costMicroUsd: MicroUsd.nullable(),
    latencyMs: z.int().nonnegative(),
  }),
  "tool.call": z.object({
    server: z.string().min(1),
    tool: z.string().min(1),
    argsHash: Sha256,
    decision: z.enum(["auto_allowed", "approved", "denied"]),
    isError: z.boolean(),
    resultHash: Sha256.nullable(),
    durationMs: z.int().nonnegative(),
  }),
  "diff.captured": z.object({
    baseCommit: GitOid,
    headCommit: GitOid,
    diffBlob: Sha256,
    files: z.int().nonnegative(),
    insertions: z.int().nonnegative(),
    deletions: z.int().nonnegative(),
    outOfScope: z.array(z.string()),
  }),
  "check.completed": z.object({
    checkId: z.string().min(1),
    passed: z.boolean(),
    exitCode: z.int().nullable(),
    outputBlob: Sha256,
    durationMs: z.int().nonnegative(),
  }),
  "node.succeeded": z.object({ headCommit: GitOid, summary: z.string() }),
  "node.failed": z.object({ errorClass, message: z.string() }),
  "node.retry_scheduled": z.object({
    nextAttempt: z.int().min(2),
    delayMs: z.int().nonnegative(),
    reason: z.string().min(1),
  }),
  "node.escalated": z.object({
    reason: z.enum(["checks_failed", "ambiguity", "budget", "worker_error"]),
  }),
  "node.steered": z.object({ note: z.string().min(1), replan: z.boolean() }),
  "node.cancelled": z.object({ reason: z.string().min(1) }),
  "node.skipped": z.object({ because: NodeId }),
  "approval.requested": z.object({
    approvalId: ApprovalId,
    action: z.union([ProposedAction, GateAction]),
  }),
  "approval.resolved": z.object({ approvalId: ApprovalId, decision: ApprovalDecision }),
  "budget.tripped": z.object({
    scope: z.enum(["node", "run", "account"]),
    limit: z.string().min(1),
    limitValue: z.number(),
    observed: z.number(),
  }),
  "quota.observed": z.object({ windows: z.array(QuotaWindow) }),
  "checkpoint.created": z.object({
    checkpointId: CheckpointId,
    label: z.string().min(1),
    /** Commit per node worktree at this point, so a rollback restores code and state together. */
    refs: z.record(z.string(), GitOid),
  }),
  "run.rolled_back": z.object({ toCheckpoint: CheckpointId }),
  "run.paused": z.object({ reason: z.string().min(1) }),
  "run.resumed": z.object({ afterCrash: z.boolean() }),
  /** Every node succeeded; their results are being merged and re-verified together. */
  "integration.started": z.object({ baseCommit: GitOid, branch: z.string().min(1) }),
  /** All node checks re-run on the merged result (the integration worktree). */
  "integration.checked": z.object({
    commit: GitOid,
    passed: z.boolean(),
    checks: z.array(
      z.object({ checkId: z.string().min(1), passed: z.boolean(), outputBlob: Sha256 }),
    ),
  }),
  /** The frontier model's review of the integrated diff. */
  "review.completed": z.object({
    verdict: z.enum(["approve", "request_changes"]),
    summary: z.string(),
    concerns: z.array(z.string()),
  }),
  /** mergedInto is the user's branch when the merge gate was approved, null otherwise. */
  "run.completed": z.object({
    integrationCommit: GitOid,
    mergedInto: z.string().min(1).nullable(),
  }),
  "run.failed": z.object({ errorClass, message: z.string() }),
  "run.cancelled": z.object({ reason: z.string().min(1) }),
} as const satisfies Record<string, z.ZodType>;

export type TraceEventType = keyof typeof TraceEventPayloads;
export type TraceEventPayload<K extends TraceEventType> = z.infer<(typeof TraceEventPayloads)[K]>;
export const TRACE_EVENT_TYPES = Object.keys(TraceEventPayloads) as TraceEventType[];

export const Actor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("engine") }),
  z.object({ kind: z.literal("human") }),
  z.object({ kind: z.literal("model"), model: ModelRef, tier: Tier }),
  z.object({ kind: z.literal("policy"), ruleId: z.string().min(1) }),
]);
export type Actor = z.infer<typeof Actor>;

export const OtelIds = z.object({
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
  spanId: z.string().regex(/^[0-9a-f]{16}$/),
  parentSpanId: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .nullable(),
});
export type OtelIds = z.infer<typeof OtelIds>;

/** What a writer provides. Sealing (seq, prevHash, hash) is done by @orzeus/trace. */
const DraftBase = z.object({
  ts: UnixMs,
  type: z.enum(TRACE_EVENT_TYPES as [TraceEventType, ...TraceEventType[]]),
  nodeId: NodeId.nullable(),
  attempt: z.int().min(1).nullable(),
  actor: Actor,
  payload: z.unknown(),
  /** Large content (packets, diffs, check output, prompts) lives in the blob store. */
  blobs: z.array(Sha256),
  otel: OtelIds,
});

const EnvelopeBase = DraftBase.extend({
  v: z.literal(1),
  runId: RunId,
  /** Gap-free per run, starting at 1. */
  seq: z.int().min(1),
  /** null only for seq 1. */
  prevHash: Sha256.nullable(),
  /** sha256(JCS(envelope without `hash`)); the envelope includes prevHash, which chains it. */
  hash: Sha256,
});

type DraftFields = Omit<z.infer<typeof DraftBase>, "type" | "payload">;
type EnvelopeFields = Omit<z.infer<typeof EnvelopeBase>, "type" | "payload">;

export type EventDraft<K extends TraceEventType = TraceEventType> = {
  [T in K]: DraftFields & { type: T; payload: TraceEventPayload<T> };
}[K];

export type TraceEnvelope<K extends TraceEventType> = EnvelopeFields & {
  type: K;
  payload: TraceEventPayload<K>;
};

export type TraceEvent = { [K in TraceEventType]: TraceEnvelope<K> }[TraceEventType];

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseWithPayload<T>(base: z.ZodType, value: unknown): ParseResult<T> {
  const envelope = base.safeParse(value);
  if (!envelope.success) return { ok: false, error: z.prettifyError(envelope.error) };
  const data = envelope.data as { type: TraceEventType; payload: unknown };
  const payload = TraceEventPayloads[data.type].safeParse(data.payload);
  if (!payload.success) {
    return { ok: false, error: `payload of ${data.type}: ${z.prettifyError(payload.error)}` };
  }
  return { ok: true, value: { ...data, payload: payload.data } as T };
}

/** Validates an event draft, including its type-specific payload. */
export function parseEventDraft(value: unknown): ParseResult<EventDraft> {
  return parseWithPayload<EventDraft>(DraftBase.strict(), value);
}

/** Validates a sealed event, including its type-specific payload. */
export function parseTraceEvent(value: unknown): ParseResult<TraceEvent> {
  return parseWithPayload<TraceEvent>(EnvelopeBase.strict(), value);
}

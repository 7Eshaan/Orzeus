import { CheckpointId, RunId } from "@orzeus/schema";
import { z } from "zod";
import {
  McpServerId,
  McpServerInput,
  McpServerView,
  MemoryView,
  PendingGate,
  PlanEdit,
  QuotaReport,
  RunDetail,
  RunSummary,
  SettingsView,
} from "./views.js";

/**
 * Bumped only for breaking changes to the method set or payloads. The UI refuses to talk to an
 * engine with a different major protocol version.
 */
export const PROTOCOL_VERSION = 2;

export const EnginePingResult = z.object({
  engineVersion: z.string(),
  protocolVersion: z.int(),
  runtime: z.object({
    node: z.string(),
    platform: z.string(),
    arch: z.string(),
  }),
  /** Unix milliseconds when the engine process started. */
  startedAt: z.int(),
});
export type EnginePingResult = z.infer<typeof EnginePingResult>;

const empty = z.strictObject({});
const ok = z.object({ ok: z.literal(true) });
const byRun = z.strictObject({ runId: RunId });

/**
 * Every engine method, declared once. Params and results are validated on both sides of the
 * wire.
 */
export const methods = {
  "engine.ping": { params: empty, result: EnginePingResult },

  "runs.list": { params: empty, result: z.array(RunSummary) },
  "runs.get": { params: byRun, result: RunDetail },
  /** Sealed trace events, oldest first; parse each with @orzeus/schema's parseTraceEvent. */
  "runs.events": {
    params: z.strictObject({
      runId: RunId,
      afterSeq: z.int().min(0).optional(),
      limit: z.int().min(1).max(5_000).optional(),
    }),
    result: z.array(z.unknown()),
  },
  "runs.start": {
    params: z.strictObject({
      goal: z.string().min(1),
      repo: z.string().min(1),
      baseRef: z.string().min(1).optional(),
      planner: z.string().min(1).optional(),
      worker: z.string().min(1).optional(),
    }),
    result: z.object({ runId: RunId }),
  },
  /** Starts a run from a hand-written plan (see services/engine/src/plan-file.ts), awaiting approval. */
  "runs.startPlan": {
    params: z.strictObject({
      repo: z.string().min(1),
      baseRef: z.string().min(1).optional(),
      plan: z.unknown(),
    }),
    result: z.object({ runId: RunId }),
  },
  /** The proposed plan in its editable form; only while the run awaits plan approval. */
  "runs.plan": { params: byRun, result: PlanEdit },
  /**
   * Replaces the proposed plan with an edited one (a new revision, recorded as a human edit).
   * Rejected with every problem listed if the edit is invalid or `revision` is stale.
   */
  "runs.revisePlan": {
    params: z.strictObject({ runId: RunId, plan: PlanEdit }),
    result: z.object({ revision: z.int() }),
  },
  "runs.approvePlan": { params: byRun, result: ok },
  "runs.resume": { params: byRun, result: ok },
  "runs.rollback": {
    params: z.strictObject({ runId: RunId, checkpointId: CheckpointId }),
    result: ok,
  },
  "runs.verify": { params: byRun, result: z.object({ ok: z.boolean(), detail: z.string() }) },
  "runs.export": {
    params: z.strictObject({ runId: RunId, format: z.enum(["jsonl", "otlp"]) }),
    result: z.object({ filename: z.string(), mediaType: z.string(), content: z.string() }),
  },

  "blobs.read": {
    params: z.strictObject({
      hash: z.string().regex(/^[0-9a-f]{64}$/),
      maxChars: z.int().min(1).max(2_000_000).optional(),
    }),
    result: z.object({ mediaType: z.string(), text: z.string(), truncated: z.boolean() }),
  },

  "approvals.list": { params: empty, result: z.array(PendingGate) },
  "approvals.answer": {
    params: z.strictObject({
      id: z.string(),
      decision: z.enum(["approve", "reject", "steer"]),
      note: z.string().optional(),
    }),
    result: ok,
  },

  "quota.read": { params: empty, result: QuotaReport },
  /**
   * Sets the usage percent of one account window at which no new work starts on that account;
   * null clears it. Running work is not interrupted.
   */
  "quota.setSoftCap": {
    params: z.strictObject({
      accountId: z.string().min(1),
      window: z.string().min(1),
      percent: z.number().gt(0).max(100).nullable(),
    }),
    result: ok,
  },
  "settings.read": { params: empty, result: SettingsView },
  "mcp.list": { params: empty, result: z.array(McpServerView) },
  /** Creates or updates a server; changes apply to runs started afterwards. */
  "mcp.save": { params: z.strictObject({ server: McpServerInput }), result: McpServerView },
  "mcp.remove": { params: z.strictObject({ id: McpServerId }), result: ok },
  /** Connects, lists the server's tools and records the result. Starts stdio servers. */
  "mcp.test": { params: z.strictObject({ id: McpServerId }), result: McpServerView },
  "memory.list": {
    params: z.strictObject({ repo: z.string().min(1) }),
    result: z.array(MemoryView),
  },
  "memory.add": {
    params: z.strictObject({
      repo: z.string().min(1),
      kind: z.enum(["decision", "constraint", "convention", "gotcha"]),
      title: z.string().min(1),
      body: z.string().min(1),
    }),
    result: MemoryView,
  },
} as const satisfies Record<string, { params: z.ZodType; result: z.ZodType }>;

/** Notifications the engine pushes to the UI. */
export const notifications = {
  /** A run's state changed (new events were appended). */
  "run.updated": z.object({ runId: RunId, status: z.string(), headSeq: z.int() }),
  /** Soft caps or quota observations changed. */
  "quota.changed": z.object({}),
  /** The approvals inbox changed. */
  "approvals.changed": z.object({ pending: z.int() }),
  /** A human-readable progress line, as the CLI would print it. */
  progress: z.object({ line: z.string() }),
} as const satisfies Record<string, z.ZodType>;

export type Methods = typeof methods;
export type MethodName = keyof Methods;
export type MethodParams<M extends MethodName> = z.input<Methods[M]["params"]>;
export type MethodResult<M extends MethodName> = z.output<Methods[M]["result"]>;
export type NotificationName = keyof typeof notifications;
export type NotificationParams<N extends NotificationName> = z.output<(typeof notifications)[N]>;

export function isMethodName(name: string): name is MethodName {
  return Object.hasOwn(methods, name);
}

export function parseNotification(
  method: string,
  params: unknown,
):
  | { [N in NotificationName]: { method: N; params: NotificationParams<N> } }[NotificationName]
  | null {
  if (!Object.hasOwn(notifications, method)) return null;
  const schema = notifications[method as NotificationName];
  const parsed = schema.safeParse(params);
  return parsed.success ? ({ method, params: parsed.data } as never) : null;
}

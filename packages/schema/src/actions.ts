import { z } from "zod";
import { AccountId, CheckpointId, UnixMs } from "./primitives.js";

/** Something an agent wants to do that its permission mode does not already allow. */
export const ProposedAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shell"), argv: z.array(z.string()).min(1), cwd: z.string() }),
  z.object({ kind: z.literal("file_write"), path: z.string().min(1) }),
  z.object({ kind: z.literal("file_delete"), path: z.string().min(1) }),
  z.object({
    kind: z.literal("mcp_call"),
    server: z.string().min(1),
    tool: z.string().min(1),
    access: z.enum(["read", "write"]),
  }),
  z.object({ kind: z.literal("network"), host: z.string().min(1) }),
]);
export type ProposedAction = z.infer<typeof ProposedAction>;

/** Run-level human gates. These are always "ask" and cannot be configured away. */
export const GateAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan_approval"), revision: z.int().min(1) }),
  z.object({ kind: z.literal("merge"), from: z.string().min(1), into: z.string().min(1) }),
  z.object({ kind: z.literal("budget_threshold"), fraction: z.number().gt(0).lte(1) }),
  z.object({ kind: z.literal("rollback"), toCheckpoint: CheckpointId }),
]);
export type GateAction = z.infer<typeof GateAction>;

export const ApprovalDecision = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("allow_once") }),
  z.object({ kind: z.literal("allow_for_node") }),
  z.object({ kind: z.literal("deny"), reason: z.string().min(1) }),
  z.object({ kind: z.literal("steer"), message: z.string().min(1) }),
]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const QuotaWindow = z.object({
  accountId: AccountId,
  /** "5h", "7d", "monthly", or a provider bucket id. */
  window: z.string().min(1),
  /** 0..100, null when the provider only reports allowed/blocked. */
  usedPercent: z.number().min(0).max(100).nullable(),
  resetsAt: UnixMs.nullable(),
  status: z.enum(["ok", "warning", "limited"]),
  source: z.enum(["official_api", "cli_event", "response_headers", "local_estimate"]),
  observedAt: UnixMs,
});
export type QuotaWindow = z.infer<typeof QuotaWindow>;

import { z } from "zod";
import { GitOid, ModelRef, NodeId, PacketId, RunId, Sha256 } from "./primitives.js";

export const AcceptanceCriterion = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  /** Links to a CheckSpec id when the criterion is machine-checkable. */
  checkId: z.string().nullable(),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

const why = z.string().min(1).max(500);

export const ContextRef = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("file_range"),
      path: z.string().min(1),
      startLine: z.int().min(1),
      endLine: z.int().min(1),
      why,
    })
    .refine((r) => r.endLine >= r.startLine, { message: "endLine must be >= startLine" }),
  z.object({
    kind: z.literal("symbol"),
    path: z.string().min(1),
    /** e.g. "AuthService.refresh" */
    symbol: z.string().min(1),
    symbolKind: z.enum(["function", "method", "class", "interface", "type", "const"]),
    why,
  }),
  z.object({
    /** Any resource on an allowlisted upstream MCP server. */
    kind: z.literal("mcp_resource"),
    server: z.string().min(1),
    uri: z.string().min(1),
    why,
  }),
  z.object({
    kind: z.literal("memory"),
    memoryId: z.string().min(1),
    why,
  }),
]);
export type ContextRef = z.infer<typeof ContextRef>;

export const Constraint = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  source: z.enum(["memory", "planner", "user"]),
});
export type Constraint = z.infer<typeof Constraint>;

export const McpToolGrant = z.object({
  server: z.string().min(1),
  tool: z.string().min(1),
  access: z.enum(["read", "write"]),
  /**
   * eager: listed up front. lazy: hidden behind the gateway's `find_tools` meta-tool, so large
   * tool sets do not bloat the worker's context.
   */
  loading: z.enum(["eager", "lazy"]),
});
export type McpToolGrant = z.infer<typeof McpToolGrant>;

export const BuiltinGrant = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read_files") }),
  z.object({ kind: z.literal("edit_files") }),
  z.object({
    /** Allowed argv prefixes, e.g. ["pnpm", "test"]. Anything else is a gated action. */
    kind: z.literal("shell"),
    argvPrefixes: z.array(z.array(z.string().min(1)).min(1)),
  }),
]);
export type BuiltinGrant = z.infer<typeof BuiltinGrant>;

export const ToolAllowlist = z.object({
  mcp: z.array(McpToolGrant),
  /** Built-in agent capabilities, enforced through the adapter's permission mode. */
  builtin: z.array(BuiltinGrant),
  network: z.enum(["none", "package_registries", "allowlist"]),
  networkAllowlist: z.array(z.string().min(1)),
});
export type ToolAllowlist = z.infer<typeof ToolAllowlist>;

export const UpstreamResult = z.object({
  nodeId: NodeId,
  summary: z.string(),
  headCommit: GitOid,
  diffStat: z.object({
    files: z.int().nonnegative(),
    insertions: z.int().nonnegative(),
    deletions: z.int().nonnegative(),
  }),
});
export type UpstreamResult = z.infer<typeof UpstreamResult>;

export const SteerNote = z.object({
  attempt: z.int().min(1),
  from: ModelRef,
  note: z.string().min(1),
});
export type SteerNote = z.infer<typeof SteerNote>;

/** The packet body: everything except contentHash. */
export const ContextPacketBody = z.object({
  schemaVersion: z.literal(1),
  id: PacketId,
  runId: RunId,
  nodeId: NodeId,
  /** One focused paragraph. */
  objective: z.string().min(1).max(4000),
  nonGoals: z.array(z.string().min(1)),
  acceptance: z.array(AcceptanceCriterion).min(1),
  /** Pointers, not file dumps. Resolved lazily through the gateway's MCP resources. */
  context: z.array(ContextRef),
  constraints: z.array(Constraint),
  tools: ToolAllowlist,
  /** Compact results of dependency nodes, filled in when the node becomes ready. */
  upstream: z.array(UpstreamResult),
  /** Steering notes from the frontier model on earlier attempts, newest last. */
  steering: z.array(SteerNote),
  limits: z.object({ maxContextTokens: z.int().positive() }),
});
export type ContextPacketBody = z.infer<typeof ContextPacketBody>;

/**
 * Immutable and content-addressed: contentHash is SHA-256 over the canonical JSON (RFC 8785) of
 * the body. Compute it with @orzeus/trace's `contentHash`.
 */
export const ContextPacket = ContextPacketBody.extend({ contentHash: Sha256 });
export type ContextPacket = z.infer<typeof ContextPacket>;

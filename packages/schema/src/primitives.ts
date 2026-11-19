import { z } from "zod";

/** Crockford base32 ULID: 26 chars, time-sortable. */
export const RunId = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "expected a ULID")
  .brand<"RunId">();
export type RunId = z.infer<typeof RunId>;

/** Short planner-chosen slug, unique within a run, e.g. "api-auth-middleware". */
export const NodeId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "expected a lowercase slug (a-z, 0-9, -), max 64 chars")
  .brand<"NodeId">();
export type NodeId = z.infer<typeof NodeId>;

const opaqueId = (label: string) =>
  z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/, `expected a ${label} id`);

export const PacketId = opaqueId("packet").brand<"PacketId">();
export type PacketId = z.infer<typeof PacketId>;

export const AccountId = opaqueId("account").brand<"AccountId">();
export type AccountId = z.infer<typeof AccountId>;

export const ApprovalId = opaqueId("approval").brand<"ApprovalId">();
export type ApprovalId = z.infer<typeof ApprovalId>;

export const CheckpointId = opaqueId("checkpoint").brand<"CheckpointId">();
export type CheckpointId = z.infer<typeof CheckpointId>;

export const ProjectId = opaqueId("project").brand<"ProjectId">();
export type ProjectId = z.infer<typeof ProjectId>;

/** Lowercase hex SHA-256. Content address for blobs, packets and trace hashes. */
export const Sha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "expected lowercase hex SHA-256")
  .brand<"Sha256">();
export type Sha256 = z.infer<typeof Sha256>;

/** Git object id: SHA-1 (40 hex) or SHA-256 (64 hex) repositories. */
export const GitOid = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "expected a git object id")
  .brand<"GitOid">();
export type GitOid = z.infer<typeof GitOid>;

/** Unix milliseconds. */
export const UnixMs = z.int().nonnegative();
export type UnixMs = z.infer<typeof UnixMs>;

/** Integer micro-USD (1e-6 USD). No floats in accounting. */
export const MicroUsd = z.int().nonnegative();
export type MicroUsd = z.infer<typeof MicroUsd>;

export const Tier = z.enum(["frontier", "worker", "local"]);
export type Tier = z.infer<typeof Tier>;

export const ProviderId = z.enum([
  "anthropic",
  "openai",
  "cursor",
  "google",
  "acp",
  "openai_compatible",
]);
export type ProviderId = z.infer<typeof ProviderId>;

export const ModelRef = z.object({
  provider: ProviderId,
  /** Adapter id, e.g. "claude-cli", "codex-app-server", "gemini-api". */
  adapter: z.string().min(1),
  /** Provider's model name as the adapter expects it. */
  model: z.string().min(1),
});
export type ModelRef = z.infer<typeof ModelRef>;

const tokenCount = z.int().nonnegative();

export const TokenUsage = z.object({
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheReadTokens: tokenCount,
  cacheWriteTokens: tokenCount,
  reasoningTokens: tokenCount,
});
export type TokenUsage = z.infer<typeof TokenUsage>;

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

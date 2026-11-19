import { z } from "zod";

export const PolicyEffect = z.enum(["allow", "deny", "ask"]);
export type PolicyEffect = z.infer<typeof PolicyEffect>;

/**
 * Configurable parts of the approval policy. Rules that protect the user (plan approval, merges,
 * rollback, edits outside writeScope) are hard-coded in @orzeus/core and cannot be relaxed here.
 */
export const PolicyDocument = z.object({
  schemaVersion: z.literal(1),
  fileDelete: PolicyEffect,
  /** Shell commands not covered by the node's argv prefixes or check commands. */
  unlistedShell: PolicyEffect,
  mcpRead: PolicyEffect,
  mcpWrite: PolicyEffect,
  /** Network hosts outside the packet's allowlist. */
  unlistedNetwork: PolicyEffect,
});
export type PolicyDocument = z.infer<typeof PolicyDocument>;

export const DEFAULT_POLICY: PolicyDocument = {
  schemaVersion: 1,
  fileDelete: "ask",
  unlistedShell: "ask",
  mcpRead: "allow",
  mcpWrite: "ask",
  unlistedNetwork: "deny",
};

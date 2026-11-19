import type {
  GateAction,
  McpToolGrant,
  PolicyDocument,
  PolicyEffect,
  ProposedAction,
  ToolAllowlist,
} from "@orzeus/schema";
import { matchesAny, normalizeRelativePath } from "./glob.js";

export interface PolicyContext {
  readonly writeScope: readonly string[];
  readonly tools: ToolAllowlist;
  /** argv of the node's command checks; running them is always allowed. */
  readonly checkCommands: readonly (readonly string[])[];
}

export interface PolicyVerdict {
  readonly effect: PolicyEffect;
  /** Stable id recorded in the trace, e.g. "write_out_of_scope". */
  readonly ruleId: string;
  readonly reason: string;
}

const verdict = (effect: PolicyEffect, ruleId: string, reason: string): PolicyVerdict => ({
  effect,
  ruleId,
  reason,
});

function startsWith(argv: readonly string[], prefix: readonly string[]): boolean {
  return (
    prefix.length > 0 && prefix.length <= argv.length && prefix.every((part, i) => argv[i] === part)
  );
}

function isGate(action: ProposedAction | GateAction): action is GateAction {
  return ["plan_approval", "merge", "budget_threshold", "rollback"].includes(action.kind);
}

/**
 * Decides whether an action is allowed, denied, or needs a human. Hard rules come first and
 * cannot be configured away; the policy document only tunes the rest.
 */
export function evaluatePolicy(
  policy: PolicyDocument,
  action: ProposedAction | GateAction,
  context: PolicyContext,
): PolicyVerdict {
  if (isGate(action))
    return verdict("ask", `gate_${action.kind}`, "Run-level gates always need a human.");

  switch (action.kind) {
    case "file_write":
    case "file_delete": {
      const path = normalizeRelativePath(action.path);
      if (path === null)
        return verdict("deny", "path_escapes_worktree", `${action.path} is outside the worktree.`);
      if (!matchesAny(path, context.writeScope)) {
        return verdict("deny", "write_out_of_scope", `${path} is outside this node's write scope.`);
      }
      return action.kind === "file_write"
        ? verdict("allow", "write_in_scope", `${path} is inside the write scope.`)
        : verdict(policy.fileDelete, "file_delete", `Deleting ${path}.`);
    }
    case "shell": {
      const prefixes = context.tools.builtin.flatMap((g) =>
        g.kind === "shell" ? g.argvPrefixes : [],
      );
      if ([...prefixes, ...context.checkCommands].some((p) => startsWith(action.argv, p))) {
        return verdict("allow", "shell_allowlisted", "Command matches an allowed prefix.");
      }
      return verdict(
        policy.unlistedShell,
        "shell_unlisted",
        `"${action.argv.join(" ")}" is not on the allowlist.`,
      );
    }
    case "mcp_call": {
      const grant: McpToolGrant | undefined = context.tools.mcp.find(
        (g) => g.server === action.server && g.tool === action.tool,
      );
      if (grant === undefined)
        return verdict(
          "deny",
          "tool_not_granted",
          `${action.server}/${action.tool} is not granted.`,
        );
      const writes = grant.access === "write" || action.access === "write";
      return writes
        ? verdict(
            policy.mcpWrite,
            "mcp_write",
            `${action.server}/${action.tool} can change external state.`,
          )
        : verdict(policy.mcpRead, "mcp_read", `${action.server}/${action.tool} is read-only.`);
    }
    case "network": {
      if (context.tools.network === "none")
        return verdict("deny", "network_disabled", "Network is disabled for this node.");
      if (context.tools.networkAllowlist.includes(action.host)) {
        return verdict("allow", "network_allowlisted", `${action.host} is allowlisted.`);
      }
      return verdict(
        policy.unlistedNetwork,
        "network_unlisted",
        `${action.host} is not allowlisted.`,
      );
    }
  }
}

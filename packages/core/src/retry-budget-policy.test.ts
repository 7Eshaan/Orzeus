import {
  DEFAULT_POLICY,
  type EscalationPolicy,
  type RetryPolicy,
  ZERO_USAGE,
} from "@orzeus/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { crossedCostThresholds, nodeBudgetTrips } from "./budget.js";
import { evaluatePolicy, type PolicyContext } from "./policy.js";
import { backoffDelayMs, decideAfterFailure } from "./retry.js";
import { buildDag } from "./testing/index.js";

const retry: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
  jitter: "full",
};
const escalation: EscalationPolicy = {
  workerRetriesOnCheckFailure: 1,
  onAmbiguity: "escalate",
  maxSteers: 1,
};

describe("backoff", () => {
  it("stays within [0, min(max, base * 2^(n-1))]", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
        (attempt, r) => {
          const delay = backoffDelayMs(retry, attempt, r);
          expect(delay).toBeGreaterThanOrEqual(0);
          expect(delay).toBeLessThanOrEqual(Math.min(8_000, 1_000 * 2 ** (attempt - 1)));
          expect(Number.isInteger(delay)).toBe(true);
        },
      ),
    );
  });
});

describe("decideAfterFailure", () => {
  const node = (attemptsThisRound: number, steers = 0) => ({
    attempt: attemptsThisRound,
    attemptsThisRound,
    steers,
  });

  it("retries transient errors, then escalates, then fails", () => {
    expect(decideAfterFailure(node(1), retry, escalation, "transient", 0.5)).toMatchObject({
      kind: "retry",
      nextAttempt: 2,
    });
    expect(decideAfterFailure(node(3), retry, escalation, "transient", 0.5)).toEqual({
      kind: "escalate",
      reason: "worker_error",
    });
    expect(decideAfterFailure(node(3, 1), retry, escalation, "transient", 0.5)).toEqual({
      kind: "fail",
    });
  });

  it("gives the worker one retry on failed checks, without delay, then escalates", () => {
    expect(decideAfterFailure(node(1), retry, escalation, "checks_failed", 0.5)).toEqual({
      kind: "retry",
      nextAttempt: 2,
      delayMs: 0,
    });
    expect(decideAfterFailure(node(2), retry, escalation, "checks_failed", 0.5)).toEqual({
      kind: "escalate",
      reason: "checks_failed",
    });
  });

  it("handles ambiguity per policy and never retries fatal errors", () => {
    expect(
      decideAfterFailure(
        node(1),
        retry,
        { ...escalation, onAmbiguity: "ask_human" },
        "ambiguity",
        0,
      ),
    ).toEqual({ kind: "ask_human" });
    expect(decideAfterFailure(node(1, 1), retry, escalation, "ambiguity", 0)).toEqual({
      kind: "ask_human",
    });
    expect(decideAfterFailure(node(1), retry, escalation, "fatal", 0)).toEqual({ kind: "fail" });
  });
});

describe("budgets", () => {
  it("reports each crossed node limit", () => {
    const trips = nodeBudgetTrips(
      { usage: { ...ZERO_USAGE, inputTokens: 200, outputTokens: 10 }, costMicroUsd: 5 },
      {
        maxInputTokens: 100,
        maxOutputTokens: 100,
        maxCostMicroUsd: 10,
        maxWallMs: 1_000,
        maxTurns: 3,
      },
      { wallMs: 2_000, turns: 1 },
    );
    expect(trips.map((t) => t.limit)).toEqual(["input_tokens", "wall_time"]);
  });

  it("crosses each cost threshold exactly once", () => {
    const budget = buildDag([{ id: "a" }]).budget; // 50 USD, thresholds 0.5 and 0.8
    const totals = (cost: number) => ({ frontierTokens: 0, workerTokens: 0, costMicroUsd: cost });
    expect(crossedCostThresholds(budget, totals(0), totals(24_000_000))).toEqual([]);
    expect(crossedCostThresholds(budget, totals(24_000_000), totals(41_000_000))).toEqual([
      0.5, 0.8,
    ]);
    expect(crossedCostThresholds(budget, totals(41_000_000), totals(50_000_000))).toEqual([1]);
  });
});

describe("evaluatePolicy", () => {
  const context: PolicyContext = {
    writeScope: ["src/api/**"],
    tools: {
      mcp: [
        { server: "github", tool: "get_issue", access: "read", loading: "eager" },
        { server: "github", tool: "create_comment", access: "write", loading: "lazy" },
      ],
      builtin: [{ kind: "shell", argvPrefixes: [["pnpm", "test"]] }],
      network: "allowlist",
      networkAllowlist: ["registry.npmjs.org"],
    },
    checkCommands: [["pnpm", "typecheck"]],
  };
  const effect = (action: Parameters<typeof evaluatePolicy>[1]) =>
    evaluatePolicy(DEFAULT_POLICY, action, context);

  it("enforces write scope and the worktree boundary as hard rules", () => {
    expect(effect({ kind: "file_write", path: "src/api/x.ts" })).toMatchObject({ effect: "allow" });
    expect(effect({ kind: "file_write", path: "src/web/x.ts" })).toMatchObject({
      effect: "deny",
      ruleId: "write_out_of_scope",
    });
    expect(effect({ kind: "file_write", path: "../outside.ts" })).toMatchObject({
      effect: "deny",
      ruleId: "path_escapes_worktree",
    });
    expect(effect({ kind: "file_delete", path: "src/api/x.ts" })).toMatchObject({ effect: "ask" });
    const permissive = { ...DEFAULT_POLICY, fileDelete: "allow" as const };
    expect(
      evaluatePolicy(permissive, { kind: "file_delete", path: "src/web/x.ts" }, context).effect,
    ).toBe("deny");
  });

  it("allows allowlisted and check commands, asks for the rest", () => {
    expect(effect({ kind: "shell", argv: ["pnpm", "test", "--run"], cwd: "." }).effect).toBe(
      "allow",
    );
    expect(effect({ kind: "shell", argv: ["pnpm", "typecheck"], cwd: "." }).effect).toBe("allow");
    expect(effect({ kind: "shell", argv: ["pnpm"], cwd: "." }).effect).toBe("ask");
    expect(effect({ kind: "shell", argv: ["rm", "-rf", "/"], cwd: "." }).effect).toBe("ask");
  });

  it("separates MCP reads, writes and ungranted tools", () => {
    expect(
      effect({ kind: "mcp_call", server: "github", tool: "get_issue", access: "read" }).effect,
    ).toBe("allow");
    expect(
      effect({ kind: "mcp_call", server: "github", tool: "create_comment", access: "read" }).effect,
    ).toBe("ask");
    expect(
      effect({ kind: "mcp_call", server: "github", tool: "delete_repo", access: "write" }).effect,
    ).toBe("deny");
  });

  it("always asks for run gates and denies unlisted network", () => {
    expect(effect({ kind: "merge", from: "a", into: "main" })).toMatchObject({
      effect: "ask",
      ruleId: "gate_merge",
    });
    expect(effect({ kind: "network", host: "registry.npmjs.org" }).effect).toBe("allow");
    expect(effect({ kind: "network", host: "evil.example" }).effect).toBe("deny");
  });
});

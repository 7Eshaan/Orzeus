import type { ContextPacketBody, NodeId, PacketId } from "@orzeus/schema";
import { TaskDAG } from "@orzeus/schema";
import { describe, expect, it } from "vitest";
import { validatePlan } from "./plan-validation.js";
import { buildDag, TEST_RUN_ID } from "./testing/index.js";

const codes = (issues: readonly { code: string }[]) => issues.map((i) => i.code);

describe("validatePlan", () => {
  it("accepts a valid diamond and returns a stable topological order", () => {
    const dag = buildDag([
      { id: "a" },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["a"] },
      { id: "d", dependsOn: ["b", "c"] },
    ]);
    expect(TaskDAG.safeParse(dag).success).toBe(true);
    const result = validatePlan(dag);
    expect(result.errors).toEqual([]);
    expect(result.order).toEqual(["a", "b", "c", "d"]);
  });

  it("reports every structural problem at once", () => {
    const dag = buildDag([
      { id: "a", dependsOn: ["c"] },
      { id: "b", dependsOn: ["b", "ghost"] },
      { id: "c", dependsOn: ["a"] },
      { id: "c" },
    ]);
    const result = validatePlan(dag);
    expect(codes(result.errors)).toEqual(
      expect.arrayContaining([
        "duplicate_node_id",
        "self_dependency",
        "unknown_dependency",
        "cycle",
      ]),
    );
    expect(result.order).toBeNull();
  });

  it("warns about overlapping write scopes only between unrelated nodes", () => {
    const dag = buildDag([
      { id: "a", writeScope: ["src/**"] },
      { id: "b", writeScope: ["src/b/**"], dependsOn: ["a"] },
      { id: "c", writeScope: ["src/c.ts"] },
    ]);
    const warnings = validatePlan(dag).warnings;
    expect(warnings.map((w) => w.message)).toEqual([expect.stringContaining('"a" and "c"')]);
  });

  it("cross-checks packets and acceptance checks", () => {
    const dag = buildDag([{ id: "a" }, { id: "b" }]);
    const packet = (nodeId: string, checkId: string | null): ContextPacketBody => ({
      schemaVersion: 1,
      id: `packet-${nodeId}` as PacketId,
      runId: TEST_RUN_ID,
      nodeId: nodeId as NodeId,
      objective: "Do it.",
      nonGoals: [],
      acceptance: [{ id: "ac1", statement: "Tests pass", checkId }],
      context: [],
      constraints: [],
      tools: { mcp: [], builtin: [], network: "none", networkAllowlist: [] },
      upstream: [],
      steering: [],
      limits: { maxContextTokens: 8_000 },
    });
    expect(validatePlan(dag, [packet("a", "test"), packet("b", "test")]).errors).toEqual([]);
    const result = validatePlan(dag, [packet("a", "lint")]);
    expect(codes(result.errors)).toEqual(["unknown_acceptance_check", "missing_packet"]);
  });

  it("rejects node budgets larger than the run budget", () => {
    const dag = buildDag([{ id: "a" }]);
    const big = { ...dag, budget: { ...dag.budget, maxCostMicroUsd: 10 } };
    expect(codes(validatePlan(big).errors)).toEqual(["node_budget_exceeds_run"]);
  });
});

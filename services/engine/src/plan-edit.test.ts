import type { GitOid, RunId } from "@orzeus/schema";
import { describe, expect, it } from "vitest";
import { applyPlanEdit, dedupeGrants, toPlanEdit, withGrants } from "./plan-edit.js";
import { expandHandPlan } from "./plan-file.js";

const plan = expandHandPlan(
  {
    goal: "two files",
    nodes: ["a", "b"].map((id) => ({
      id,
      title: `Write ${id}`,
      candidates: [{ provider: "openai_compatible", adapter: "openai-compatible", model: "m" }],
      writeScope: [`${id}.txt`],
      checks: [
        {
          kind: "command",
          id: "exists",
          label: "exists",
          argv: ["test", "-f", `${id}.txt`],
          cwd: ".",
          timeoutMs: 1_000,
          expectExitCode: 0,
        },
      ],
      packet: {
        objective: `Create ${id}.txt`,
        acceptance: [{ statement: "the file exists", checkId: "exists" }],
        constraints: ["plain text"],
      },
    })),
  },
  "01JC0000000000000000000000" as RunId,
  { root: "/repo", baseRef: "main", baseCommit: "a".repeat(40) as GitOid },
);

describe("plan edits", () => {
  it("round-trips a plan without changing it", () => {
    const again = applyPlanEdit(plan, toPlanEdit(plan));
    expect(again.dag.revision).toBe(2);
    expect({ ...again.dag, revision: 1 }).toEqual(plan.dag);
    expect(again.packets).toEqual(plan.packets);
  });

  it("keeps check links and constraint sources for unchanged text", () => {
    const edit = toPlanEdit(plan);
    const [a] = edit.nodes;
    if (a === undefined) throw new Error("no node");
    const next = applyPlanEdit(plan, {
      ...edit,
      nodes: [{ ...a, acceptance: ["the file exists", "it is short"], constraints: ["no tabs"] }],
    });
    const packet = next.packets[0];
    expect(packet?.acceptance.map((c) => c.checkId)).toEqual(["exists", null]);
    expect(packet?.constraints).toEqual([{ id: "c-1", text: "no tabs", source: "user" }]);
    expect(next.dag.nodes.map((n) => n.id)).toEqual(["a"]);
  });

  it("rejects a stale revision and lists every problem", () => {
    const edit = toPlanEdit(plan);
    expect(() => applyPlanEdit(plan, { ...edit, revision: 5 })).toThrow(/changed/);
    const [a, b] = edit.nodes;
    if (a === undefined || b === undefined) throw new Error("no nodes");
    expect(() =>
      applyPlanEdit(plan, {
        ...edit,
        nodes: [
          { ...a, dependsOn: ["b" as never] },
          { ...b, dependsOn: ["a" as never] },
        ],
      }),
    ).toThrow(/cycle/);
  });

  it("merges grants, a write grant winning over a read grant", () => {
    const read = { server: "s", tool: "t", access: "read", loading: "eager" } as const;
    const write = { ...read, access: "write" } as const;
    expect(dedupeGrants([read, write, read])).toEqual([write]);
    const granted = withGrants(plan, [read]);
    expect(granted.packets.every((p) => p.tools.mcp.some((g) => g.server === "s"))).toBe(true);
    expect(withGrants(plan, [])).toBe(plan);
  });
});

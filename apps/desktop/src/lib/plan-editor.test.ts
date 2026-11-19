import type { PlanEdit } from "@orzeus/protocol";
import { describe, expect, it } from "vitest";
import {
  fromEditor,
  grantableTools,
  newNode,
  removeNode,
  renameNode,
  toEditor,
  toggleGrant,
} from "./plan-editor.js";

const plan = {
  revision: 3,
  maxConcurrency: 2,
  nodes: [
    {
      id: "add",
      title: "Add",
      kind: "implement",
      dependsOn: [],
      candidates: [{ provider: "openai_compatible", adapter: "openai-compatible", model: "lfm3" }],
      writeScope: ["src/add.js", "test/add.test.js"],
      checks: [
        {
          kind: "command",
          id: "tests",
          label: "tests",
          argv: ["node", "--test", "test/add test.js"],
          cwd: ".",
          timeoutMs: 1_000,
          expectExitCode: 0,
        },
        { kind: "scope_guard", id: "scope", label: "scope" },
      ],
      objective: "Write add",
      acceptance: ["adds"],
      constraints: [],
      mcp: [{ server: "memory", tool: "memory_search", access: "read", loading: "eager" }],
    },
    {
      id: "index",
      title: "Index",
      kind: "implement",
      dependsOn: ["add"],
      candidates: [{ provider: "openai_compatible", adapter: "openai-compatible", model: "lfm3" }],
      writeScope: ["index.js"],
      checks: [],
      objective: "Export it",
      acceptance: ["exports add"],
      constraints: ["no deps"],
      mcp: [],
    },
  ],
} as unknown as PlanEdit;

const providers = { "openai-compatible": "openai_compatible" };

describe("plan editor", () => {
  it("round-trips a plan unchanged", () => {
    expect(fromEditor(toEditor(plan), providers)).toEqual(plan);
  });

  it("adds command checks, keeps the others, and follows renames and removals", () => {
    let state = toEditor(plan);
    state = renameNode(state, "add", "sum");
    expect(state.nodes[1]?.dependsOn).toEqual(["sum"]);
    const node = state.nodes[1];
    if (node === undefined) throw new Error("no node");
    state = {
      ...state,
      nodes: [state.nodes[0] ?? node, { ...node, commands: "pnpm test\nnode -e 'x y'" }],
    };
    const edit = fromEditor(state, providers);
    expect(edit.nodes[1]?.checks.map((c) => [c.id, c.kind === "command" && c.argv])).toEqual([
      ["test", ["pnpm", "test"]],
      ["node", ["node", "-e", "x y"]],
    ]);
    expect(edit.nodes[0]?.checks.map((c) => c.id)).toEqual(["tests", "scope"]);
    expect(removeNode(state, "add").nodes.map((n) => [n.id, n.dependsOn])).toEqual([["index", []]]);
  });

  it("collects every problem a person can fix in the form", () => {
    const state = toEditor(plan);
    const blank = newNode(state, { worker: "nope:model", mcp: [] });
    expect(blank.id).toBe("task-3");
    expect(() => fromEditor({ ...state, nodes: [...state.nodes, blank] }, providers)).toThrow(
      /task-3: give it a title\ntask-3: describe the task\ntask-3: say how to tell it is done\ntask-3: no worker adapter called nope/,
    );
  });

  it("grants tools from tested servers and the memory", () => {
    const tools = grantableTools([
      {
        id: "gh",
        name: "GitHub",
        enabled: true,
        defaultGrant: "read",
        config: { transport: "streamable_http", url: "https://example.com/mcp" },
        secretSet: true,
        secretVar: "ORZEUS_MCP_SECRET_GH",
        discovered: {
          at: 0,
          ok: true,
          error: null,
          serverName: null,
          serverVersion: null,
          tools: [{ name: "create_issue", description: "", readOnly: false }],
        },
      },
    ]);
    const issue = tools.find((t) => t.tool === "create_issue");
    if (issue === undefined) throw new Error("missing tool");
    const granted = toggleGrant([], issue, true);
    expect(granted).toEqual([
      { server: "gh", tool: "create_issue", access: "write", loading: "eager" },
    ]);
    expect(toggleGrant(granted, issue, false)).toEqual([]);
    expect(tools.filter((t) => t.server === "memory")).toHaveLength(3);
  });
});

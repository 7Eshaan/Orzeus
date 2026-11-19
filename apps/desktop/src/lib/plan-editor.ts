import type { McpServerView, PlanEdit, PlanEditNode } from "@orzeus/protocol";
import type { CheckSpec, McpToolGrant, NodeKind, ProviderId } from "@orzeus/schema";
import { joinArgs, lines, slugify, splitArgs } from "./argv.js";

/** One node as the form edits it: free text where people type, structured where they pick. */
export interface EditorNode {
  /** Stable React key; ids can change while a new node is being named. */
  readonly key: string;
  readonly isNew: boolean;
  readonly id: string;
  readonly title: string;
  readonly kind: NodeKind;
  readonly objective: string;
  /** One criterion per line. */
  readonly acceptance: string;
  /** One constraint per line. */
  readonly constraints: string;
  readonly dependsOn: readonly string[];
  /** Comma- or line-separated globs. */
  readonly writeScope: string;
  /** One command per line. */
  readonly commands: string;
  /** The node's checks before editing (command checks keep their ids and timeouts). */
  readonly baseChecks: readonly CheckSpec[];
  /** "adapter:model" of the preferred worker. */
  readonly worker: string;
  readonly fallbackWorkers: PlanEditNode["candidates"];
  readonly mcp: readonly McpToolGrant[];
}

export interface EditorState {
  readonly revision: number;
  readonly maxConcurrency: number;
  readonly nodes: readonly EditorNode[];
}

const spec = (c: { adapter: string; model: string }) => `${c.adapter}:${c.model}`;

export function toEditor(plan: PlanEdit): EditorState {
  return {
    revision: plan.revision,
    maxConcurrency: plan.maxConcurrency,
    nodes: plan.nodes.map((n) => ({
      key: n.id,
      isNew: false,
      id: n.id,
      title: n.title,
      kind: n.kind,
      objective: n.objective,
      acceptance: n.acceptance.join("\n"),
      constraints: n.constraints.join("\n"),
      dependsOn: n.dependsOn,
      writeScope: n.writeScope.join(", "),
      commands: n.checks
        .flatMap((c) => (c.kind === "command" ? [joinArgs(c.argv)] : []))
        .join("\n"),
      baseChecks: n.checks,
      worker: n.candidates[0] === undefined ? "" : spec(n.candidates[0]),
      fallbackWorkers: n.candidates.slice(1),
      mcp: n.mcp,
    })),
  };
}

/** A fresh node, named so it does not clash with the others. */
export function newNode(
  state: EditorState,
  defaults: { worker: string; mcp: readonly McpToolGrant[] },
): EditorNode {
  const taken = new Set(state.nodes.map((n) => n.id));
  let i = state.nodes.length + 1;
  while (taken.has(`task-${i}`)) i++;
  return {
    key: `new-${Date.now()}-${i}`,
    isNew: true,
    id: `task-${i}`,
    title: "",
    kind: "implement",
    objective: "",
    acceptance: "",
    constraints: "",
    dependsOn: [],
    writeScope: "",
    commands: "",
    baseChecks: [],
    worker: defaults.worker,
    fallbackWorkers: [],
    mcp: defaults.mcp,
  };
}

/** Removes a node and every dependency on it. */
export function removeNode(state: EditorState, key: string): EditorState {
  const gone = state.nodes.find((n) => n.key === key);
  return {
    ...state,
    nodes: state.nodes
      .filter((n) => n.key !== key)
      .map((n) => ({ ...n, dependsOn: n.dependsOn.filter((d) => d !== gone?.id) })),
  };
}

/** Renames a node and follows the rename in the other nodes' dependencies. */
export function renameNode(state: EditorState, key: string, id: string): EditorState {
  const before = state.nodes.find((n) => n.key === key)?.id;
  return {
    ...state,
    nodes: state.nodes.map((n) =>
      n.key === key
        ? { ...n, id }
        : { ...n, dependsOn: n.dependsOn.map((d) => (d === before ? id : d)) },
    ),
  };
}

function checksFor(node: EditorNode, problems: string[]): CheckSpec[] {
  const kept = node.baseChecks.filter((c) => c.kind !== "command");
  const used = new Set(kept.map((c) => c.id));
  const commands = lines(node.commands).flatMap((line): CheckSpec[] => {
    let argv: string[];
    try {
      argv = splitArgs(line);
    } catch (error) {
      problems.push(`${node.id}: check "${line}": ${(error as Error).message}`);
      return [];
    }
    const [command, ...rest] = argv;
    if (command === undefined) return [];
    const same = node.baseChecks.find(
      (c) => c.kind === "command" && joinArgs(c.argv) === joinArgs(argv) && !used.has(c.id),
    );
    if (same !== undefined) {
      used.add(same.id);
      return [same];
    }
    let id = slugify(command === "pnpm" || command === "npm" ? (rest.at(-1) ?? command) : command);
    for (let i = 2; used.has(id); i++) id = `${slugify(command)}-${i}`;
    used.add(id);
    return [
      {
        kind: "command",
        id,
        label: line,
        argv: [command, ...rest],
        cwd: ".",
        timeoutMs: 300_000,
        expectExitCode: 0,
      },
    ];
  });
  return [...commands, ...kept];
}

/**
 * Turns the form back into a PlanEdit. Problems a person can fix in the form are collected and
 * thrown together; the engine then checks the graph and the repository.
 */
export function fromEditor(
  state: EditorState,
  providers: Readonly<Record<string, string>>,
): PlanEdit {
  const problems: string[] = [];
  const nodes = state.nodes.map((n): PlanEditNode => {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(n.id))
      problems.push(`"${n.id}": ids use lowercase letters, digits, - and _`);
    if (n.title.trim() === "") problems.push(`${n.id}: give it a title`);
    if (n.objective.trim() === "") problems.push(`${n.id}: describe the task`);
    const acceptance = lines(n.acceptance);
    if (acceptance.length === 0) problems.push(`${n.id}: say how to tell it is done`);
    const colon = n.worker.indexOf(":");
    const adapter = n.worker.slice(0, colon).trim();
    const model = n.worker.slice(colon + 1).trim();
    const provider = providers[adapter];
    if (colon <= 0 || model === "")
      problems.push(`${n.id}: the worker must look like adapter:model`);
    else if (provider === undefined)
      problems.push(`${n.id}: no worker adapter called ${adapter} is enabled`);
    return {
      id: n.id as PlanEditNode["id"],
      title: n.title.trim(),
      kind: n.kind,
      dependsOn: n.dependsOn as PlanEditNode["dependsOn"],
      candidates: [
        { provider: (provider ?? "openai_compatible") as ProviderId, adapter, model },
        ...n.fallbackWorkers,
      ],
      writeScope: n.writeScope
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter((s) => s !== ""),
      checks: checksFor(n, problems),
      objective: n.objective.trim(),
      acceptance: acceptance.length > 0 ? acceptance : [""],
      constraints: lines(n.constraints),
      mcp: [...n.mcp],
    };
  });
  if (nodes.length === 0) problems.push("A plan needs at least one node.");
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return { revision: state.revision, maxConcurrency: state.maxConcurrency, nodes };
}

/** A tool workers can be granted, from the memory server or a configured MCP server. */
export interface GrantableTool {
  readonly server: string;
  readonly serverName: string;
  readonly tool: string;
  readonly readOnly: boolean;
}

/** The repository memory is always there; other servers count once they have been tested. */
export function grantableTools(servers: readonly McpServerView[]): GrantableTool[] {
  const memory: GrantableTool[] = [
    { server: "memory", serverName: "Repository memory", tool: "memory_search", readOnly: true },
    { server: "memory", serverName: "Repository memory", tool: "memory_get", readOnly: true },
    { server: "memory", serverName: "Repository memory", tool: "memory_propose", readOnly: false },
  ];
  return [
    ...memory,
    ...servers
      .filter((s) => s.enabled && s.discovered?.ok)
      .flatMap((s) =>
        (s.discovered?.tools ?? []).map((t) => ({
          server: s.id,
          serverName: s.name,
          tool: t.name,
          readOnly: t.readOnly,
        })),
      ),
  ];
}

/** Grants or revokes one tool for a node. */
export function toggleGrant(
  grants: readonly McpToolGrant[],
  tool: GrantableTool,
  on: boolean,
): McpToolGrant[] {
  const rest = grants.filter((g) => !(g.server === tool.server && g.tool === tool.tool));
  if (!on) return rest;
  return [
    ...rest,
    {
      server: tool.server,
      tool: tool.tool,
      access: tool.readOnly ? "read" : "write",
      loading: "eager",
    },
  ];
}

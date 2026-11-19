#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { createRedactor, type RunState } from "@orzeus/core";
import { MEMORY_KINDS, type MemoryKind } from "@orzeus/memory-server";
import type { CheckpointId, PlannerOutput, RunId } from "@orzeus/schema";
import { exportJsonl } from "@orzeus/trace";
import { createEngine, type Engine, headlessGate, parseAcpAgents } from "./compose.js";
import { ulid } from "./ids.js";
import { createJsonLogger, secretValues } from "./logger.js";
import { defaultDataDir } from "./paths.js";
import { withGrants } from "./plan-edit.js";
import { expandHandPlan, PlanFileError } from "./plan-file.js";
import { planRun, prepareRepo } from "./plan-run.js";
import { ENGINE_VERSION } from "./version.js";

const DEFAULT_LOCAL_MODEL = "openai-compatible:lfm3:latest";

const USAGE = `orzeus ${ENGINE_VERSION}: headless Orzeus

Usage:
  orzeus run --goal "<what to build>" --repo <path> [--planner <adapter:model>] [--worker <adapter:model>]
  orzeus run <plan.json> --repo <path>                 (hand-written plan)
  orzeus resume <runId>                                 (after a crash, a pause, or a rollback)
  orzeus rollback <runId> <checkpointId>                (then: orzeus resume <runId>)
  orzeus status <runId> | verify <runId> | export <runId>
  orzeus memory add --repo <path> --kind <${MEMORY_KINDS.join("|")}> --title <t> --body <b> [--paths a,b]
  orzeus memory search --repo <path> <query> | memory list --repo <path>

Options:
  --approve-plan        Execute the plan without asking (otherwise you are asked in a terminal)
  --approve-asks        Allow actions the policy would ask a human about, and budget overruns (headless only)
  --approve-merge       Fast-forward your branch to the result without asking (headless only)
  --steerer <spec>      Frontier model for steering failed nodes and reviewing; default: the planner
  --planner <spec>      Default: anthropic-api:claude-opus-5-5 if ANTHROPIC_API_KEY is set, else ${DEFAULT_LOCAL_MODEL}
  --worker <spec>       Default: ${DEFAULT_LOCAL_MODEL}
  --base <ref>          Commit to start from (default HEAD)
  --data-dir <dir>      Database, memory and worktrees (default: ${defaultDataDir()})
  --ollama-url <url>    OpenAI-compatible endpoint for local models (default: http://localhost:11434/v1)
  --local-reasoning <none|low|medium|high>  reasoning_effort for local models (small thinking models need none)
  --enable-codex        Allow Codex workers: codex-app-server and codex-exec (your own login and quota)
  --enable-cursor       Allow Cursor CLI workers (your own cursor-agent login, or CURSOR_API_KEY)
  --acp <id=command>    Add an ACP v1 agent as a worker, e.g. --acp "acp-gemini=gemini --experimental-acp" (repeatable)
  --no-gateway          Do not start the MCP gateway
  --verbose             Structured engine logs on stderr
`;

const write = (line: string) => process.stdout.write(`${line}\n`);
const say = (line: string) => process.stderr.write(`${line}\n`);

class UsageError extends Error {}

function reasoningEffort(value: string): "none" | "low" | "medium" | "high" {
  if (value === "none" || value === "low" || value === "medium" || value === "high") return value;
  throw new UsageError(`--local-reasoning must be none, low, medium or high`);
}

function summary(state: RunState): string {
  const nodes = state.nodeOrder.map((id) => {
    const n = state.nodes[id];
    return n === undefined
      ? ""
      : `  ${n.status.padEnd(18)} ${n.id} (attempt ${n.attempt})${n.lastError ? `: ${n.lastError.errorClass}` : ""}`;
  });
  return [
    `Run ${state.runId}: ${state.status}`,
    ...nodes,
    `  tokens: ${state.totals.workerTokens} worker, ${state.totals.frontierTokens} frontier`,
  ].join("\n");
}

export function describePlan(plan: PlannerOutput): string {
  return plan.dag.nodes
    .map((n, i) => {
      const packet = plan.packets.find((p) => p.nodeId === n.id);
      const checks =
        n.checks.map((c) => (c.kind === "command" ? c.argv.join(" ") : c.label)).join("; ") ||
        "none";
      return [
        `${i + 1}. ${n.id}: ${n.title}`,
        `   writes: ${n.writeScope.join(", ") || "(read-only)"}    depends on: ${n.dependsOn.join(", ") || "-"}`,
        `   checks: ${checks}`,
        `   worker: ${n.candidates[0]?.adapter}/${n.candidates[0]?.model}    context pointers: ${packet?.context.length ?? 0}`,
        `   ${packet?.objective ?? ""}`,
      ].join("\n");
    })
    .join("\n");
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

async function repoOf(engine: Engine, path: string | undefined): Promise<string> {
  if (path === undefined) throw new UsageError("--repo is required");
  return engine.git.topLevel(resolve(path));
}

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      goal: { type: "string" },
      repo: { type: "string" },
      base: { type: "string", default: "HEAD" },
      planner: { type: "string" },
      worker: { type: "string", default: DEFAULT_LOCAL_MODEL },
      kind: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      paths: { type: "string" },
      "data-dir": { type: "string" },
      "ollama-url": { type: "string" },
      "local-reasoning": { type: "string" },
      "enable-codex": { type: "boolean", default: false },
      "enable-cursor": { type: "boolean", default: false },
      acp: { type: "string", multiple: true, default: [] },
      "approve-plan": { type: "boolean", default: false },
      "approve-asks": { type: "boolean", default: false },
      "approve-merge": { type: "boolean", default: false },
      steerer: { type: "string" },
      "no-gateway": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const [command, target, ...rest] = positionals;
  if (values.help || command === undefined) {
    write(USAGE);
    return values.help ? 0 : 2;
  }

  const interactive = process.stdin.isTTY === true && process.stderr.isTTY === true;
  const hasAnthropic = Boolean(process.env["ANTHROPIC_API_KEY"]);
  const plannerSpec =
    values.planner ?? (hasAnthropic ? "anthropic-api:claude-opus-5-5" : DEFAULT_LOCAL_MODEL);
  const frontierSpec =
    values.steerer ??
    (values.planner !== undefined || values.goal !== undefined || hasAnthropic
      ? plannerSpec
      : undefined);
  const redactLine = createRedactor(secretValues(process.env));
  const flags = { approveAsks: values["approve-asks"], approveMerge: values["approve-merge"] };
  const engine = createEngine({
    ...flags,
    ...(frontierSpec === undefined ? {} : { frontier: frontierSpec }),
    decideGate: async (gate) => {
      if (!interactive) return headlessGate(flags)(gate);
      const approved = await confirm(
        `${gate.nodeId ?? "Run"} needs your approval: ${gate.reason} Allow? [y/N] `,
      );
      return { approved, actor: { kind: "human" } };
    },
    dataDir: values["data-dir"] ?? defaultDataDir(),
    logger: createJsonLogger(
      (line) => {
        if (values.verbose) process.stderr.write(line);
      },
      Date.now,
      createRedactor(secretValues(process.env)),
    ),
    enableCodex: values["enable-codex"],
    enableCursor: values["enable-cursor"],
    acpAgents: parseAcpAgents(values.acp),
    gateway: !values["no-gateway"],
    ...(values["ollama-url"] === undefined ? {} : { openAiCompatibleUrl: values["ollama-url"] }),
    ...(values["local-reasoning"] === undefined
      ? {}
      : { localReasoningEffort: reasoningEffort(values["local-reasoning"]) }),
    progress: (line) => say(redactLine(line)),
  });

  try {
    switch (command) {
      case "run": {
        if (values.repo === undefined) throw new UsageError("--repo is required");
        const prepared = await prepareRepo(engine, values.repo, values.base);
        let runId: RunId;
        let plan: PlannerOutput;
        if (target !== undefined) {
          runId = ulid() as RunId;
          plan = withGrants(
            expandHandPlan(JSON.parse(readFileSync(target, "utf8")), runId, prepared.repo),
            engine.mcpServers.defaultGrants(),
          );
          engine.orchestrator.createRun(prepared.projectId, plan);
        } else {
          if (values.goal === undefined) throw new UsageError("give a plan file or --goal");
          const planned = await planRun(
            engine,
            { goal: values.goal, prepared, planner: plannerSpec, worker: values.worker },
            say,
          );
          if (planned.plan === null) return 1;
          runId = planned.runId;
          plan = planned.plan;
        }

        say(describePlan(plan));
        const approved =
          values["approve-plan"] || (await confirm("Approve this plan and start? [y/N] "));
        if (!approved) {
          say(
            process.stdin.isTTY
              ? "Not approved."
              : "Plan recorded but not approved. Re-run with --approve-plan to execute it.",
          );
          write(runId);
          return 2;
        }
        engine.orchestrator.approvePlan(runId);
        const final = await engine.orchestrator.execute(runId);
        write(summary(final));
        return final.status === "completed" ? 0 : 1;
      }
      case "resume": {
        if (target === undefined) throw new UsageError("resume needs a run id");
        const final = await engine.orchestrator.resume(target as RunId);
        write(summary(final));
        return final.status === "completed" ? 0 : 1;
      }
      case "status": {
        const state = target === undefined ? null : engine.store.load(target as RunId);
        if (state === null) throw new UsageError(`unknown run ${target ?? ""}`);
        write(summary(state));
        for (const cp of Object.values(state.checkpoints))
          write(`  checkpoint ${cp.id}: ${cp.label} (event ${cp.atSeq})`);
        return 0;
      }
      case "rollback": {
        const checkpoint = rest[0];
        if (target === undefined || checkpoint === undefined)
          throw new UsageError("rollback needs a run id and a checkpoint id");
        const state = await engine.orchestrator.rollback(
          target as RunId,
          checkpoint as CheckpointId,
        );
        write(summary(state));
        say(`Continue with: orzeus resume ${target}`);
        return 0;
      }
      case "verify": {
        if (target === undefined) throw new UsageError("verify needs a run id");
        const result = engine.store.verify(target as RunId);
        write(
          result.ok
            ? `Chain OK (${result.head?.seq ?? 0} events).`
            : `Chain BROKEN at seq ${result.seq}: ${result.reason}`,
        );
        return result.ok ? 0 : 1;
      }
      case "export":
        if (target === undefined) throw new UsageError("export needs a run id");
        process.stdout.write(exportJsonl(engine.store.events(target as RunId)));
        return 0;
      case "memory": {
        const root = await repoOf(engine, values.repo);
        if (target === "add") {
          const kind = values.kind as MemoryKind | undefined;
          if (kind === undefined || !MEMORY_KINDS.includes(kind) || !values.title || !values.body) {
            throw new UsageError("memory add needs --kind, --title and --body");
          }
          const memory = engine.memory.add({
            repoRoot: root,
            kind,
            title: values.title,
            body: values.body,
            paths: values.paths?.split(",").filter(Boolean) ?? [],
          });
          write(memory.id);
          return 0;
        }
        const found =
          target === "search"
            ? engine.memory.search(root, rest.join(" "), 20)
            : target === "list"
              ? engine.memory.list(root)
              : null;
        if (found === null) throw new UsageError("memory add | search | list");
        for (const m of found) write(`${m.id}  ${m.kind.padEnd(10)}  ${m.title}`);
        return 0;
      }
      default:
        throw new UsageError(`unknown command ${command}`);
    }
  } finally {
    engine.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    say(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof UsageError || error instanceof PlanFileError ? 2 : 1;
  },
);

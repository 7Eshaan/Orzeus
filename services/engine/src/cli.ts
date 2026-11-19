#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { RunState } from "@orzeus/core";
import type { ProjectId, RunId } from "@orzeus/schema";
import { exportJsonl } from "@orzeus/trace";
import { createEngine } from "./compose.js";
import { ulid } from "./ids.js";
import { createJsonLogger } from "./logger.js";
import { defaultDataDir } from "./paths.js";
import { expandHandPlan, PlanFileError } from "./plan-file.js";
import { ENGINE_VERSION } from "./version.js";

const USAGE = `orzeus ${ENGINE_VERSION}: headless Orzeus

Usage:
  orzeus run <plan.json> --repo <path> --approve-plan [--base <ref>] [--approve-asks] [--enable-codex]
  orzeus resume <runId> [--approve-asks] [--enable-codex]
  orzeus status <runId>
  orzeus verify <runId>
  orzeus export <runId>

Options:
  --data-dir <dir>      Database and worktrees (default: ${defaultDataDir()})
  --ollama-url <url>    OpenAI-compatible endpoint for local workers (default: http://localhost:11434/v1)
  --enable-codex        Allow Codex workers (uses your own Codex login and quota)
  --approve-asks        Allow actions the policy would ask a human about (headless only)
  --verbose             Structured engine logs on stderr
`;

const write = (line: string) => process.stdout.write(`${line}\n`);
const say = (line: string) => process.stderr.write(`${line}\n`);

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

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      base: { type: "string", default: "HEAD" },
      "data-dir": { type: "string" },
      "ollama-url": { type: "string" },
      "enable-codex": { type: "boolean", default: false },
      "approve-plan": { type: "boolean", default: false },
      "approve-asks": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const [command, target] = positionals;
  if (values.help || command === undefined || target === undefined) {
    write(USAGE);
    return command === undefined && !values.help ? 2 : 0;
  }

  const engine = createEngine({
    dataDir: values["data-dir"] ?? defaultDataDir(),
    logger: createJsonLogger((line) => {
      if (values.verbose) process.stderr.write(line);
    }),
    approveAsks: values["approve-asks"],
    enableCodex: values["enable-codex"],
    ...(values["ollama-url"] === undefined ? {} : { openAiCompatibleUrl: values["ollama-url"] }),
    progress: say,
  });

  try {
    switch (command) {
      case "run": {
        if (values.repo === undefined) throw new UsageError("--repo is required");
        const root = await engine.git.topLevel(resolve(values.repo));
        const baseCommit = await engine.git.revParse(root, values.base);
        const runId = ulid() as RunId;
        const plan = expandHandPlan(JSON.parse(readFileSync(target, "utf8")), runId, {
          root,
          baseRef: values.base,
          baseCommit,
        });
        const projectId =
          `project-${createHash("sha256").update(root).digest("hex").slice(0, 16)}` as ProjectId;
        engine.store.ensureProject({
          id: projectId,
          name: root.split("/").at(-1) ?? root,
          repoRoot: root,
          defaultBranch: values.base,
          createdAt: Date.now(),
        });
        engine.orchestrator.createRun(projectId, plan);
        if (!values["approve-plan"]) {
          say(`Plan recorded but not approved. Re-run with --approve-plan to execute it.`);
          write(runId);
          return 2;
        }
        engine.orchestrator.approvePlan(runId);
        const final = await engine.orchestrator.execute(runId);
        write(summary(final));
        return final.status === "completed" ? 0 : 1;
      }
      case "resume": {
        const final = await engine.orchestrator.resume(target as RunId);
        write(summary(final));
        return final.status === "completed" ? 0 : 1;
      }
      case "status": {
        const state = engine.store.load(target as RunId);
        if (state === null) throw new UsageError(`unknown run ${target}`);
        write(summary(state));
        return 0;
      }
      case "verify": {
        const result = engine.store.verify(target as RunId);
        write(
          result.ok
            ? `Chain OK (${result.head?.seq ?? 0} events).`
            : `Chain BROKEN at seq ${result.seq}: ${result.reason}`,
        );
        return result.ok ? 0 : 1;
      }
      case "export":
        process.stdout.write(exportJsonl(engine.store.events(target as RunId)));
        return 0;
      default:
        throw new UsageError(`unknown command ${command}`);
    }
  } finally {
    engine.close();
  }
}

class UsageError extends Error {}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    say(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof UsageError || error instanceof PlanFileError ? 2 : 1;
  },
);

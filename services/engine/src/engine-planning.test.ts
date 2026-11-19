import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { buildRepoMap, renderRepoMap } from "@orzeus/context";
import { createFixtureRepo } from "@orzeus/git/testing";
import {
  type AccountContext,
  AdapterRegistry,
  type AgentSession,
  type GenerateRequest,
  type GenerateResult,
  OPENAI_COMPATIBLE_MANIFEST,
  type ProviderAdapter,
  SessionController,
  type SessionRequest,
} from "@orzeus/providers";
import type { AccountId, PlanDraft, ProjectId, RunId } from "@orzeus/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "./compose.js";
import { ulid } from "./ids.js";
import { createJsonLogger } from "./logger.js";
import { PlanningError, planGoal } from "./planner.js";

const FIXTURE = new URL("../fixtures/calc-plus/repo/", import.meta.url).pathname;
const account: AccountContext = {
  accountId: "fake" as AccountId,
  label: "fake",
  auth: { kind: "none" },
  getSecret: async () => "",
};
const WORKER = {
  provider: "openai_compatible" as const,
  adapter: "openai-compatible",
  model: "fake-worker",
};

function draft(dependsOnSelf = false): PlanDraft {
  return {
    summary: "Add subtract and export it.",
    nodes: [
      {
        id: "Add Subtract",
        title: "Add subtract",
        kind: "implement",
        dependsOn: dependsOnSelf ? ["Add Subtract"] : [],
        tier: "worker",
        writeScope: ["src/subtract.js", "src/index.js"],
        checks: [
          { id: "test", label: "Subtract test", argv: ["node", "--test", "test/subtract.test.js"] },
        ],
        objective:
          "Create src/subtract.js exporting subtract(a, b) and re-export it from src/index.js.",
        nonGoals: ["Do not change add or multiply."],
        acceptance: [{ statement: "test/subtract.test.js passes", checkId: "test" }],
        context: [
          {
            kind: "file_range",
            path: "src/index.js",
            startLine: 1,
            endLine: 2,
            symbol: null,
            memoryId: null,
            why: "Where exports live",
          },
          {
            kind: "symbol",
            path: null,
            startLine: null,
            endLine: null,
            symbol: "add",
            memoryId: null,
            why: "incomplete pointer",
          },
        ],
        constraints: ["ES modules only."],
      },
    ],
  };
}

/** A planner that returns scripted drafts in order. */
class FakePlanner implements ProviderAdapter {
  readonly manifest = {
    ...OPENAI_COMPATIBLE_MANIFEST,
    capabilities: { ...OPENAI_COMPATIBLE_MANIFEST.capabilities, structuredOutput: true },
  };
  readonly prompts: string[] = [];
  constructor(readonly answers: PlanDraft[]) {}
  async probe() {
    return { ok: true as const, version: "fake", detail: "" };
  }
  async listModels() {
    return [];
  }
  async generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
    this.prompts.push(request.prompt);
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error("no more answers");
    return {
      value: request.output.parse(answer),
      usage: {
        inputTokens: 900,
        outputTokens: 300,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      costMicroUsd: null,
      quota: [],
      latencyMs: 5,
    };
  }
}

/** A worker that uses the MCP gateway (context and memory) before writing its files. */
class GatewayWorker implements ProviderAdapter {
  readonly manifest = OPENAI_COMPATIBLE_MANIFEST;
  readonly seen: string[] = [];
  async probe() {
    return { ok: true as const, version: "fake", detail: "" };
  }
  async listModels() {
    return [];
  }
  startSession(request: SessionRequest): AgentSession {
    const controller = new SessionController();
    void (async () => {
      if (request.mcp === null) throw new Error("expected a gateway");
      const client = new Client({ name: "fake-worker", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(request.mcp.url), {
          requestInit: { headers: { authorization: `Bearer ${request.mcp.token}` } },
        }),
      );
      const { tools } = await client.listTools();
      this.seen.push(...tools.map((t) => t.name));
      const context = await client.callTool({
        name: "orzeus__read_context",
        arguments: { index: 0 },
      });
      this.seen.push(JSON.stringify(context.content));
      const memory = await client.callTool({
        name: "memory__memory_search",
        arguments: { query: "modules" },
      });
      this.seen.push(JSON.stringify(memory.content));
      await client.close();
      for (const [path, content] of Object.entries({
        "src/subtract.js": "export function subtract(a, b) {\n  return a - b;\n}\n",
        "src/index.js":
          'export { add } from "./add.js";\nexport { multiply } from "./multiply.js";\nexport { subtract } from "./subtract.js";\n',
      })) {
        const decision = await controller.requestApproval(path, { kind: "file_write", path });
        if (decision.kind !== "allow_once") continue;
        await mkdir(join(request.worktree.path, "src"), { recursive: true });
        await writeFile(join(request.worktree.path, path), content);
      }
      controller.emit({
        type: "usage",
        usage: {
          inputTokens: 400,
          outputTokens: 60,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        costMicroUsd: 0,
      });
      controller.finish({
        status: "completed",
        summary: "Added subtract.",
        costMicroUsd: 0,
        resume: null,
        errorClass: null,
      });
    })().catch((error: unknown) =>
      controller.finish({
        status: "failed",
        summary: String(error),
        costMicroUsd: 0,
        resume: null,
        errorClass: "test.error",
      }),
    );
    return controller.session({ onSteer: async () => undefined, onCancel: async () => undefined });
  }
}

let dir: string;
let repo: string;
let engine: Engine;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orzeus-planning-"));
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(FIXTURE, p)] = readFileSync(p, "utf8");
    }
  };
  walk(FIXTURE);
  repo = join(dir, "calc");
  await createFixtureRepo(repo, files);
});

afterEach(() => {
  engine?.close();
  rmSync(dir, { recursive: true, force: true });
});

async function plan(planner: FakePlanner) {
  const runId = ulid() as RunId;
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  const repoRef = { root: repo, baseRef: "HEAD", baseCommit: baseCommit as never };
  return {
    runId,
    repoRef,
    result: await planGoal({
      goal: "Add subtract",
      runId,
      repo: repoRef,
      repoMap: renderRepoMap(await buildRepoMap(engine.git, repo)),
      memories: engine.memory.search(repo, "subtract modules", 5),
      planner: {
        ref: { provider: "openai_compatible", adapter: "fake", model: "fake-planner" },
        adapter: planner,
        account,
      },
      tiers: { worker: [WORKER], local: [WORKER] },
      signal: AbortSignal.timeout(10_000),
    }),
  };
}

describe("planning", () => {
  it("turns a draft into a validated plan: slug ids, default tools, routed workers, dropped bad pointers", async () => {
    engine = createEngine({
      dataDir: join(dir, "data"),
      logger: createJsonLogger(() => undefined),
      gateway: false,
    });
    engine.memory.add({
      repoRoot: repo,
      kind: "convention",
      title: "ES modules",
      body: "Use ES modules and no dependencies.",
    });
    const planner = new FakePlanner([draft()]);
    const { result } = await plan(planner);
    const node = result.plan.dag.nodes[0];
    expect(node?.id).toBe("add-subtract");
    expect(node?.candidates).toEqual([WORKER]);
    expect(result.plan.packets[0]?.tools.mcp.map((g) => `${g.tool}:${g.loading}`)).toEqual([
      "memory_search:eager",
      "memory_get:eager",
      "memory_propose:lazy",
    ]);
    expect(result.plan.packets[0]?.context).toHaveLength(1);
    expect(result.warnings).toEqual(["Add Subtract: dropped an incomplete symbol pointer"]);
    expect(planner.prompts[0]).toContain("src/add.js");
    expect(planner.prompts[0]).toContain("ES modules");
  });

  it("gives the planner one repair round with the validation problems", async () => {
    engine = createEngine({
      dataDir: join(dir, "data"),
      logger: createJsonLogger(() => undefined),
      gateway: false,
    });
    const planner = new FakePlanner([draft(true), draft()]);
    const { result } = await plan(planner);
    expect(result.calls).toHaveLength(2);
    expect(planner.prompts[1]).toContain("depends on itself");
    const failing = new FakePlanner([draft(true), draft(true)]);
    await expect(plan(failing)).rejects.toBeInstanceOf(PlanningError);
  });
});

describe("planned run through the MCP gateway", () => {
  it("records planning, issues packets, and lets workers read context and memory through the gateway", async () => {
    const worker = new GatewayWorker();
    engine = createEngine({
      dataDir: join(dir, "data"),
      logger: createJsonLogger(() => undefined),
      adapters: new AdapterRegistry().register(worker, account),
    });
    engine.memory.add({
      repoRoot: repo,
      kind: "convention",
      title: "ES modules",
      body: "Use ES modules and no dependencies.",
    });
    const projectId = "project-calc" as ProjectId;
    engine.store.ensureProject({
      id: projectId,
      name: "calc",
      repoRoot: repo,
      defaultBranch: "HEAD",
      createdAt: 0,
    });
    const { runId, repoRef, result } = await plan(new FakePlanner([draft()]));
    engine.orchestrator.startRun(projectId, runId, "Add subtract", repoRef);
    engine.orchestrator.proposePlan(result.plan, result.calls);
    engine.orchestrator.approvePlan(runId);
    const final = await engine.orchestrator.execute(runId);

    expect(final.status).toBe("completed");
    expect(worker.seen).toEqual(
      expect.arrayContaining([
        "orzeus__read_context",
        "memory__memory_search",
        "memory__memory_get",
        "orzeus__find_tools",
        "orzeus__call_tool",
      ]),
    );
    expect(worker.seen.join("\n")).toContain("1  export { add }");
    expect(worker.seen.join("\n")).toContain("ES modules");

    const events = engine.store.events(runId);
    expect(events.find((e) => e.type === "model.call")?.payload).toMatchObject({
      purpose: "plan",
      tier: "frontier",
    });
    expect(events.filter((e) => e.type === "packet.issued")).toHaveLength(1);
    const toolCalls = events
      .filter((e) => e.type === "tool.call")
      .map((e) =>
        e.type === "tool.call" ? `${e.payload.server}/${e.payload.tool}:${e.payload.decision}` : "",
      );
    expect(toolCalls).toContain("memory/memory_search:auto_allowed");
    expect(engine.store.verify(runId).ok).toBe(true);
  });
});

/**
 * The Phase 3 exit check with real models. Opt-in, because it needs a capable planner:
 *   ORZEUS_E2E_PLANNER=openai-compatible:qwen3:8b ORZEUS_E2E_WORKER=openai-compatible:qwen3:8b \
 *     pnpm vitest run services/engine/src/engine-planning.test.ts
 * (Codex: ORZEUS_E2E_PLANNER=codex-app-server:gpt-6-luna plus ORZEUS_E2E_FLAGS=--enable-codex.)
 */
describe.runIf(process.env["ORZEUS_E2E_PLANNER"] !== undefined)(
  "exit check with a real planner",
  () => {
    it("plans with a real model, builds through the gateway, and the trace shows packets and tool calls", async () => {
      const cli = new URL("../dist/cli.js", import.meta.url).pathname;
      const dataDir = join(dir, "data");
      const flags = (process.env["ORZEUS_E2E_FLAGS"] ?? "").split(" ").filter(Boolean);
      const common = ["--data-dir", dataDir, ...flags];
      execFileSync(process.execPath, [
        cli,
        "memory",
        "add",
        "--repo",
        repo,
        "--kind",
        "convention",
        "--title",
        "ES modules, no dependencies",
        "--body",
        "Source files are ES modules under src/; src/index.js re-exports everything. Never add npm dependencies.",
        ...common,
      ]);
      const output = execFileSync(
        process.execPath,
        [
          cli,
          "run",
          "--goal",
          "Add a subtract(a, b) function in src/subtract.js and export it from src/index.js so test/subtract.test.js passes.",
          "--repo",
          repo,
          "--approve-plan",
          "--planner",
          process.env["ORZEUS_E2E_PLANNER"] ?? "",
          "--worker",
          process.env["ORZEUS_E2E_WORKER"] ?? "openai-compatible:lfm3:latest",
          "--local-reasoning",
          process.env["ORZEUS_E2E_REASONING"] ?? "none",
          ...common,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 1_500_000 },
      );
      process.stdout.write(`\n${output}\n`);
      const runId = /Run (\w{26}): completed/.exec(output)?.[1];
      expect(runId).toBeDefined();
      const trace = execFileSync(process.execPath, [cli, "export", runId ?? "", ...common], {
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
      expect(trace.filter((e) => e.type === "packet.issued").length).toBeGreaterThan(0);
      expect(trace.some((e) => e.type === "model.call" && e.payload["purpose"] === "plan")).toBe(
        true,
      );
      expect(trace.filter((e) => e.type === "tool.call").length).toBeGreaterThan(0);
    }, 1_800_000);
  },
);

describe("plan checks against the repository", () => {
  it("rejects checks that need missing scripts or tools, and the planner gets to repair them", async () => {
    engine = createEngine({
      dataDir: join(dir, "data"),
      logger: createJsonLogger(() => undefined),
      gateway: false,
    });
    const { checkCommandsExist } = await import("./plan-checks.js");
    const npmDraft = draft();
    const first = npmDraft.nodes[0];
    if (first === undefined) throw new Error("no node");
    npmDraft.nodes[0] = {
      ...first,
      checks: [
        { id: "test", label: "npm", argv: ["npm", "test"] },
        { id: "x", label: "x", argv: ["definitely-missing-tool"] },
      ],
    };
    const planner = new FakePlanner([npmDraft, draft()]);
    const runId = ulid() as RunId;
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const result = await planGoal({
      goal: "Add subtract",
      runId,
      repo: { root: repo, baseRef: "HEAD", baseCommit: baseCommit as never },
      repoMap: "",
      memories: [],
      planner: {
        ref: { provider: "openai_compatible", adapter: "fake", model: "fake" },
        adapter: planner,
        account,
      },
      tiers: { worker: [WORKER], local: [WORKER] },
      validate: (plan) => checkCommandsExist(plan, repo),
      signal: AbortSignal.timeout(10_000),
    });
    expect(result.calls).toHaveLength(2);
    expect(planner.prompts[1]).toContain('needs a package.json "test" script');
    expect(planner.prompts[1]).toContain("definitely-missing-tool, which is not installed");
  });
});

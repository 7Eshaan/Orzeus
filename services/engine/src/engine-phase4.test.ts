import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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
import type {
  AccountId,
  CheckpointId,
  ProjectId,
  ReviewDecision,
  RunId,
  SteerDecision,
} from "@orzeus/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, type Engine, type EngineConfig } from "./compose.js";
import { ulid } from "./ids.js";
import { createJsonLogger } from "./logger.js";
import { expandHandPlan } from "./plan-file.js";

const FIXTURE = new URL("../fixtures/calc/", import.meta.url).pathname;
const FILES: Record<string, Record<string, string>> = {
  add: { "src/add.js": "export function add(a, b) {\n  return a + b;\n}\n" },
  multiply: { "src/multiply.js": "export function multiply(a, b) {\n  return a * b;\n}\n" },
  index: {
    "src/index.js": 'export { add } from "./add.js";\nexport { multiply } from "./multiply.js";\n',
  },
};
const account: AccountContext = {
  accountId: "scripted" as AccountId,
  label: "Scripted",
  auth: { kind: "none" },
  getSecret: async () => "",
};

type Behavior = "correct" | "wrong" | "transient";

/** Scripted worker; records each session request and the peak number of concurrent sessions. */
class Worker implements ProviderAdapter {
  readonly manifest;
  readonly sessions: SessionRequest[] = [];
  running = 0;
  peak = 0;
  constructor(
    readonly behave: (nodeId: string, attempt: number, request: SessionRequest) => Behavior,
    id = "openai-compatible",
    readonly costMicroUsd = 0,
    readonly delayMs = 20,
  ) {
    this.manifest = { ...OPENAI_COMPATIBLE_MANIFEST, id };
  }
  async probe() {
    return { ok: true as const, version: "scripted", detail: "" };
  }
  async listModels() {
    return [];
  }
  startSession(request: SessionRequest): AgentSession {
    this.sessions.push(request);
    this.running++;
    this.peak = Math.max(this.peak, this.running);
    const controller = new SessionController();
    void (async () => {
      await new Promise((r) => setTimeout(r, this.delayMs));
      const behavior = this.behave(request.nodeId, request.attempt, request);
      controller.emit({
        type: "usage",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        costMicroUsd: this.costMicroUsd,
      });
      if (behavior === "transient") {
        this.running--;
        controller.finish({
          status: "failed",
          summary: "provider timeout",
          costMicroUsd: 0,
          resume: null,
          errorClass: "provider.timeout",
        });
        return;
      }
      const files = FILES[request.nodeId] ?? {
        [`out/${request.nodeId}.txt`]: `${request.nodeId}\n`,
      };
      for (const [path, content] of Object.entries(files)) {
        const decision = await controller.requestApproval(`w-${path}`, {
          kind: "file_write",
          path,
        });
        if (decision.kind !== "allow_once") continue;
        await mkdir(join(request.worktree.path, path, ".."), { recursive: true });
        await writeFile(
          join(request.worktree.path, path),
          behavior === "wrong" ? content.replace(/a [+*] b/, "a - b") : content,
        );
      }
      this.running--;
      controller.finish({
        status: "completed",
        summary: `Wrote ${Object.keys(files).join(", ")}.`,
        costMicroUsd: 0,
        resume: null,
        errorClass: null,
      });
    })();
    return controller.session({ onSteer: async () => undefined, onCancel: async () => undefined });
  }
}

/** A frontier model answering steering and review requests from scripts. */
class Frontier implements ProviderAdapter {
  readonly manifest = {
    ...OPENAI_COMPATIBLE_MANIFEST,
    id: "fake-frontier",
    capabilities: { ...OPENAI_COMPATIBLE_MANIFEST.capabilities, structuredOutput: true },
  };
  readonly prompts: string[] = [];
  constructor(
    readonly steer: () => SteerDecision = () => ({
      action: "retry_with_guidance",
      note: "Use a + b, not a - b.",
      revisedObjective: null,
      revisedConstraints: [],
    }),
    readonly review: () => ReviewDecision = () => ({
      verdict: "approve",
      summary: "Looks right.",
      concerns: [],
    }),
  ) {}
  async probe() {
    return { ok: true as const, version: "fake", detail: "" };
  }
  async listModels() {
    return [];
  }
  async generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
    this.prompts.push(request.prompt);
    const value = request.output.name === "orzeus_steer" ? this.steer() : this.review();
    return {
      value: request.output.parse(value),
      usage: {
        inputTokens: 500,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      costMicroUsd: null,
      quota: [],
      latencyMs: 1,
    };
  }
}

let dir: string;
let repo: string;
let engines: Engine[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orzeus-p4-"));
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(join(FIXTURE, "repo"), p)] = readFileSync(p, "utf8");
    }
  };
  walk(join(FIXTURE, "repo"));
  repo = join(dir, "calc");
  await createFixtureRepo(repo, files);
});

afterEach(() => {
  for (const e of engines) e.close();
  engines = [];
  rmSync(dir, { recursive: true, force: true });
});

function makeEngine(
  workers: readonly ProviderAdapter[],
  extra: Partial<EngineConfig> = {},
  lines: string[] = [],
): Engine {
  const registry = new AdapterRegistry();
  for (const w of workers) registry.register(w, account);
  const e = createEngine({
    dataDir: join(dir, "data"),
    logger: createJsonLogger(() => undefined),
    adapters: registry,
    gateway: false,
    lockTtlMs: 600,
    progress: (l) => lines.push(l),
    ...extra,
  });
  engines.push(e);
  return e;
}

/** Engine with a fake frontier wired in through the planner registry. */
function engineWithFrontier(
  workers: readonly ProviderAdapter[],
  frontier: Frontier,
  extra: Partial<EngineConfig> = {},
  lines: string[] = [],
): Engine {
  const registry = new AdapterRegistry();
  for (const w of workers) registry.register(w, account);
  const e = createEngine({
    dataDir: join(dir, "data"),
    logger: createJsonLogger(() => undefined),
    adapters: registry,
    gateway: false,
    lockTtlMs: 600,
    progress: (l) => lines.push(l),
    extraPlanners: [{ adapter: frontier, account }],
    frontier: "fake-frontier:fake",
    ...extra,
  });
  engines.push(e);
  return e;
}

function calcPlan(
  mutate: (plan: Record<string, unknown>) => void = () => undefined,
): Record<string, unknown> {
  const plan = JSON.parse(readFileSync(join(FIXTURE, "plan.json"), "utf8")) as Record<
    string,
    unknown
  >;
  mutate(plan);
  return plan;
}

function start(e: Engine, plan: Record<string, unknown>): RunId {
  const runId = ulid() as RunId;
  const base = execFileSync("git", ["rev-parse", "main"], { cwd: repo, encoding: "utf8" }).trim();
  const expanded = expandHandPlan(plan, runId, {
    root: repo,
    baseRef: "main",
    baseCommit: base as never,
  });
  e.store.ensureProject({
    id: "project-calc",
    name: "calc",
    repoRoot: repo,
    defaultBranch: "main",
    createdAt: 0,
  });
  e.orchestrator.createRun("project-calc" as ProjectId, expanded);
  e.orchestrator.approvePlan(runId);
  return runId;
}

const nodesOf = (plan: Record<string, unknown>) => plan["nodes"] as Record<string, unknown>[];

describe("escalation and steering", () => {
  it("asks the frontier model after a worker keeps failing, and the next attempt carries its guidance", async () => {
    const worker = new Worker((node, _attempt, req) =>
      node === "add" && req.packet.steering.length === 0 ? "wrong" : "correct",
    );
    const frontier = new Frontier();
    const e = engineWithFrontier([worker], frontier);
    const runId = start(
      e,
      calcPlan((p) => {
        for (const n of nodesOf(p))
          n["escalation"] = { maxSteers: 1, workerRetriesOnCheckFailure: 1 };
      }),
    );
    const final = await e.orchestrator.execute(runId);
    expect(final.status).toBe("completed");
    expect(final.nodes["add"]).toMatchObject({ steers: 1, attempt: 3 });
    const steered = worker.sessions.filter((s) => s.nodeId === "add").at(-1);
    expect(steered?.packet.steering.map((s) => s.note)).toEqual(["Use a + b, not a - b."]);
    expect(frontier.prompts[0]).toContain("a - b"); // the diff went to the frontier, not a transcript
    const calls = e.store
      .events(runId)
      .filter((ev) => ev.type === "model.call")
      .map((ev) => (ev.type === "model.call" ? ev.payload.purpose : ""));
    expect(calls).toContain("steer");
  });

  it("rewrites the task when the frontier says so, and fails the node when it gives up", async () => {
    const worker = new Worker((node, _a, req) =>
      node === "add" && !req.packet.objective.includes("REWRITTEN") ? "wrong" : "correct",
    );
    const frontier = new Frontier(() => ({
      action: "rewrite_task",
      note: "Clarified.",
      revisedObjective: "REWRITTEN: export add(a, b) returning a + b.",
      revisedConstraints: ["Keep it tiny."],
    }));
    const e = engineWithFrontier([worker], frontier);
    const runId = start(
      e,
      calcPlan((p) => {
        for (const n of nodesOf(p))
          n["escalation"] = { maxSteers: 1, workerRetriesOnCheckFailure: 0 };
      }),
    );
    expect((await e.orchestrator.execute(runId)).status).toBe("completed");
    expect(
      e.store.events(runId).filter((ev) => ev.type === "packet.issued" && ev.nodeId === "add"),
    ).toHaveLength(2);

    const quitter = new Frontier(() => ({
      action: "give_up",
      note: "The test is impossible.",
      revisedObjective: null,
      revisedConstraints: [],
    }));
    const e2 = engineWithFrontier(
      [new Worker((n) => (n === "add" ? "wrong" : "correct"))],
      quitter,
      { dataDir: join(dir, "data2") },
    );
    const run2 = start(
      e2,
      calcPlan((p) => {
        for (const n of nodesOf(p))
          n["escalation"] = { maxSteers: 1, workerRetriesOnCheckFailure: 0 };
      }),
    );
    const final2 = await e2.orchestrator.execute(run2);
    expect(final2.nodes["add"]?.lastError).toMatchObject({ errorClass: "steer.gave_up" });
    expect(final2.status).toBe("failed");
  });
});

describe("integration, review and merge", () => {
  it("re-runs every check on the merged result and fails when they conflict", async () => {
    const e = makeEngine([new Worker(() => "correct")]);
    const runId = start(
      e,
      calcPlan((p) => {
        const add = nodesOf(p)[0] as Record<string, unknown>;
        add["checks"] = [
          ...(add["checks"] as unknown[]),
          {
            kind: "command",
            id: "alone",
            label: "No multiply yet",
            argv: [
              "node",
              "-e",
              "process.exit(require('fs').existsSync('src/multiply.js') ? 1 : 0)",
            ],
            cwd: ".",
            timeoutMs: 20000,
            expectExitCode: 0,
          },
        ];
      }),
    );
    const final = await e.orchestrator.execute(runId);
    expect(final.status).toBe("failed");
    const checked = e.store.events(runId).find((ev) => ev.type === "integration.checked");
    expect(checked?.type === "integration.checked" && checked.payload.passed).toBe(false);
  });

  it("fails the run when the frontier review requests changes", async () => {
    const frontier = new Frontier(undefined, () => ({
      verdict: "request_changes",
      summary: "Missing docs.",
      concerns: ["Document the API."],
    }));
    const e = engineWithFrontier([new Worker(() => "correct")], frontier);
    const runId = start(
      e,
      calcPlan((p) => {
        p["integrationReview"] = true;
      }),
    );
    const final = await e.orchestrator.execute(runId);
    expect(final.status).toBe("failed");
    expect(e.store.events(runId).some((ev) => ev.type === "review.completed")).toBe(true);
  });

  it("fast-forwards your branch only when the merge gate is approved", async () => {
    const before = execFileSync("git", ["rev-parse", "main"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const e = makeEngine([new Worker(() => "correct")]);
    const final = await e.orchestrator.execute(start(e, calcPlan()));
    expect(final.status).toBe("completed");
    expect(execFileSync("git", ["rev-parse", "main"], { cwd: repo, encoding: "utf8" }).trim()).toBe(
      before,
    );

    const e2 = makeEngine([new Worker(() => "correct")], {
      dataDir: join(dir, "data2"),
      approveMerge: true,
    });
    const run2 = start(e2, calcPlan());
    const final2 = await e2.orchestrator.execute(run2);
    const completed = e2.store.events(run2).find((ev) => ev.type === "run.completed");
    expect(completed?.type === "run.completed" && completed.payload.mergedInto).toBe("main");
    expect(execFileSync("git", ["rev-parse", "main"], { cwd: repo, encoding: "utf8" }).trim()).toBe(
      final2.status === "completed" && completed?.type === "run.completed"
        ? completed.payload.integrationCommit
        : "",
    );
    expect(readFileSync(join(repo, "src/index.js"), "utf8")).toContain("multiply");
  });
});

describe("budgets, breakers and rollback", () => {
  it("pauses when spend crosses a threshold nobody approved, and resumes with approval", async () => {
    const plan = calcPlan((p) => {
      p["budget"] = { maxConcurrency: 1, maxCostMicroUsd: 50_000_000, approvalThresholds: [0.5] };
    });
    const e = makeEngine([new Worker(() => "correct", "openai-compatible", 10_000_000)]);
    const runId = start(e, plan);
    const paused = await e.orchestrator.execute(runId);
    expect(paused.status).toBe("paused");
    e.close();
    engines = engines.filter((x) => x !== e);
    const e2 = makeEngine([new Worker(() => "correct", "openai-compatible", 0)], {
      approveAsks: true,
    });
    const final = await e2.orchestrator.resume(runId);
    expect(final.status).toBe("completed");
    const gates = e2.store
      .events(runId)
      .filter((ev) => ev.type === "approval.requested")
      .map((ev) => (ev.type === "approval.requested" ? ev.payload.action.kind : ""));
    expect(gates).toContain("budget_threshold");
  });

  it("routes around an adapter whose circuit breaker opened", async () => {
    const flaky = new Worker(() => "transient", "flaky");
    const stable = new Worker(() => "correct", "stable");
    const lines: string[] = [];
    const e = makeEngine([flaky, stable], {}, lines);
    const runId = start(
      e,
      calcPlan((p) => {
        for (const n of nodesOf(p)) {
          n["candidates"] = [
            { provider: "openai_compatible", adapter: "flaky", model: "m" },
            { provider: "openai_compatible", adapter: "stable", model: "m" },
          ];
          n["retry"] = { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5 };
        }
        p["budget"] = { maxConcurrency: 1 };
      }),
    );
    const final = await e.orchestrator.execute(runId);
    expect(final.status).toBe("completed");
    expect(flaky.sessions).toHaveLength(3);
    expect(lines.filter((l) => / started on /.test(l)).length).toBe(6);
    expect(stable.sessions.length).toBeGreaterThanOrEqual(3);
  });

  it("rolls a failed run back to a checkpoint and finishes it", async () => {
    const e = makeEngine([new Worker((n) => (n === "add" ? "wrong" : "correct"))]);
    const runId = start(
      e,
      calcPlan((p) => {
        for (const n of nodesOf(p)) n["retry"] = { maxAttempts: 1 };
      }),
    );
    expect((await e.orchestrator.execute(runId)).status).toBe("failed");
    const checkpoints = Object.values(e.store.load(runId)?.checkpoints ?? {});
    expect(checkpoints.map((c) => c.label)).toEqual(["plan approved", "multiply succeeded"]);
    const planApproved = checkpoints[0]?.id as CheckpointId;
    e.close();
    engines = engines.filter((x) => x !== e);

    const e2 = makeEngine([new Worker(() => "correct")]);
    const rolled = await e2.orchestrator.rollback(runId, planApproved);
    expect(rolled.status).toBe("executing");
    expect(Object.values(rolled.nodes).map((n) => n.status)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(Object.keys(rolled.checkpoints)).toEqual(checkpoints.map((c) => c.id));
    const final = await e2.orchestrator.resume(runId);
    expect(final.status).toBe("completed");
    expect(e2.store.verify(runId).ok).toBe(true);
  });
});

describe("parallelism", () => {
  it("runs a 7-node plan with 3 workers at once and never more", async () => {
    const worker = new Worker(() => "correct", "openai-compatible", 0, 150);
    const e = makeEngine([worker]);
    const model = { provider: "openai_compatible", adapter: "openai-compatible", model: "m" };
    const node = (id: string, dependsOn: string[] = []) => ({
      id,
      title: id,
      dependsOn,
      candidates: [model],
      writeScope: [`out/${id}.txt`],
      checks: [
        {
          kind: "command",
          id: "exists",
          label: "exists",
          argv: ["node", "-e", `require('fs').accessSync('out/${id}.txt')`],
          cwd: ".",
          timeoutMs: 20000,
          expectExitCode: 0,
        },
      ],
      packet: { objective: `Write out/${id}.txt`, acceptance: [{ statement: "file exists" }] },
    });
    const plan = {
      goal: "Fan out",
      budget: { maxConcurrency: 3 },
      nodes: [
        node("a"),
        node("b"),
        node("c"),
        node("d"),
        node("e"),
        node("f", ["a", "b"]),
        node("g", ["c", "d", "e", "f"]),
      ],
    };
    const final = await e.orchestrator.execute(start(e, plan));
    expect(final.status).toBe("completed");
    expect(worker.peak).toBe(3);
    expect(worker.sessions).toHaveLength(7);
  });
});

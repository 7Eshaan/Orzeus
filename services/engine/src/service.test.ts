import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFixtureRepo } from "@orzeus/git/testing";
import type { PlanEdit, RpcHandlers } from "@orzeus/protocol";
import {
  type AccountContext,
  AdapterRegistry,
  type GenerateRequest,
  type GenerateResult,
  OPENAI_COMPATIBLE_MANIFEST,
  type ProviderAdapter,
  SessionController,
  type SessionRequest,
} from "@orzeus/providers";
import { type AccountId, type PlanDraft, parseTraceEvent, type RunId } from "@orzeus/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJsonLogger } from "./logger.js";
import { EngineService } from "./service.js";

const account: AccountContext = {
  accountId: "fake" as AccountId,
  label: "fake",
  auth: { kind: "none" },
  getSecret: async () => "",
};

const draft: PlanDraft = {
  summary: "Write two files.",
  nodes: ["one", "two"].map((id) => ({
    id,
    title: `Write ${id}`,
    kind: "implement" as const,
    dependsOn: [],
    tier: "worker" as const,
    writeScope: [`${id}.txt`],
    checks: [
      {
        id: "exists",
        label: "exists",
        argv: ["node", "-e", `require('fs').accessSync('${id}.txt')`],
      },
    ],
    objective: `Create ${id}.txt`,
    nonGoals: [],
    acceptance: [{ statement: "file exists", checkId: "exists" }],
    context: [],
    constraints: [],
  })),
};

const planner: ProviderAdapter = {
  manifest: { ...OPENAI_COMPATIBLE_MANIFEST, id: "fake-planner" },
  probe: async () => ({ ok: true, version: "fake", detail: "" }),
  listModels: async () => [],
  generate: async <T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> => ({
    value: request.output.parse(
      request.output.name === "orzeus_plan"
        ? draft
        : { verdict: "approve", summary: "fine", concerns: [] },
    ),
    usage: {
      inputTokens: 300,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    costMicroUsd: null,
    quota: [],
    latencyMs: 1,
  }),
};

const worker: ProviderAdapter = {
  manifest: OPENAI_COMPATIBLE_MANIFEST,
  probe: async () => ({ ok: true, version: "fake", detail: "" }),
  listModels: async () => [],
  startSession(request: SessionRequest) {
    const controller = new SessionController();
    void (async () => {
      const path = `${request.nodeId}.txt`;
      const decision = await controller.requestApproval(path, { kind: "file_write", path });
      if (decision.kind === "allow_once") {
        await mkdir(request.worktree.path, { recursive: true });
        await writeFile(join(request.worktree.path, path), "ok\n");
      }
      controller.emit({
        type: "usage",
        usage: {
          inputTokens: 50,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        costMicroUsd: 0,
      });
      controller.finish({
        status: "completed",
        summary: `wrote ${path}`,
        costMicroUsd: 0,
        resume: null,
        errorClass: null,
      });
    })();
    return controller.session({ onSteer: async () => undefined, onCancel: async () => undefined });
  },
};

const dir = mkdtempSync(join(tmpdir(), "orzeus-service-"));
const repo = join(dir, "repo");
const notes: { method: string; params: unknown }[] = [];
let service: EngineService;
let h: RpcHandlers;

beforeAll(async () => {
  await createFixtureRepo(repo, { "README.md": "hi\n" });
  service = new EngineService({
    dataDir: join(dir, "data"),
    logger: createJsonLogger(() => undefined),
    notify: (method, params) => notes.push({ method, params }),
    info: { startedAt: 0, nodeVersion: "v26", platform: "darwin", arch: "arm64" },
    env: {},
    planner: "fake-planner:m",
    worker: "openai-compatible:m",
    engineOverrides: {
      gateway: false,
      lockTtlMs: 600,
      adapters: new AdapterRegistry().register(worker, account),
      extraPlanners: [{ adapter: planner, account }],
    },
  });
  h = service.handlers();
});

afterAll(() => {
  service.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Handlers may throw synchronously; over the wire both become RPC errors. */
const call = <T>(fn: () => T | Promise<T>): Promise<T> => Promise.resolve().then(fn);

async function until<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  ms = 10_000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - started > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("EngineService", () => {
  it("plans, waits for plan approval, runs, asks for the merge, and completes", async () => {
    const { runId } = await h["runs.start"]({ goal: "Write two files", repo });
    const planned = await until(
      () => h["runs.get"]({ runId }),
      (d) => d.awaitingPlanApproval,
    );
    expect(planned.nodeViews.map((n) => n.id)).toEqual(["one", "two"]);
    expect(planned.dag?.integration.frontierReview).toBe(true);

    await h["runs.approvePlan"]({ runId });
    const gates = await until(
      () => h["approvals.list"]({}),
      (g) => g.length > 0,
    );
    expect(gates[0]).toMatchObject({
      runId,
      nodeId: null,
      action: { kind: "merge", into: "main" },
    });
    expect(gates[0]?.diff).toContain("+ok");
    await h["approvals.answer"]({ id: gates[0]?.id ?? "", decision: "approve" });

    const done = await until(
      () => h["runs.get"]({ runId }),
      (d) => d.status === "completed" && !d.active,
    );
    expect(done.succeeded).toBe(2);
    expect(execFileSync("git", ["show", "main:one.txt"], { cwd: repo, encoding: "utf8" })).toBe(
      "ok\n",
    );

    const events = await h["runs.events"]({ runId });
    expect(events.every((e) => parseTraceEvent(e).ok)).toBe(true);
    expect(await h["runs.verify"]({ runId })).toMatchObject({ ok: true });
    const packet = events
      .map((e) => parseTraceEvent(e))
      .find((r) => r.ok && r.value.type === "packet.issued");
    const blob = packet?.ok ? await h["blobs.read"]({ hash: packet.value.blobs[0] ?? "" }) : null;
    expect(blob?.text).toContain('"objective":"Create one.txt"');
    expect((await h["runs.export"]({ runId, format: "otlp" })).content).toContain("resourceSpans");
    expect((await h["runs.list"]({})).map((r) => r.runId)).toContain(runId as RunId);
    expect(notes.some((n) => n.method === "run.updated")).toBe(true);
    expect(notes.some((n) => n.method === "approvals.changed")).toBe(true);

    const quota = await h["quota.read"]({});
    expect(quota.totals.frontierTokens).toBeGreaterThan(0);
    expect(quota.totals.workerTokens).toBeGreaterThan(0);
    const settings = await h["settings.read"]({});
    expect(settings.adapters.map((a) => a.id)).toEqual(
      expect.arrayContaining(["fake-planner", "openai-compatible"]),
    );
    expect(settings.secrets).toEqual({
      anthropic: false,
      gemini: false,
      openai: false,
      cursor: false,
    });
  });

  it("lets a person edit the proposed plan, and runs the edited plan", async () => {
    const { runId } = await h["runs.start"]({ goal: "Write files", repo });
    await until(
      () => h["runs.get"]({ runId }),
      (d) => d.awaitingPlanApproval && !d.active,
    );
    const plan = await h["runs.plan"]({ runId });
    expect(plan.revision).toBe(1);
    const one = plan.nodes.find((n) => n.id === "one");
    if (one === undefined) throw new Error("no node one");

    const broken: PlanEdit = {
      ...plan,
      nodes: [{ ...one, dependsOn: ["missing" as never] }],
    };
    await expect(call(() => h["runs.revisePlan"]({ runId, plan: broken }))).rejects.toThrow(
      /missing/,
    );

    const edited: PlanEdit = {
      ...plan,
      maxConcurrency: 1,
      nodes: [
        { ...one, title: "Write the first file", constraints: ["Keep it short"] },
        {
          ...one,
          id: "three" as never,
          title: "Write three",
          dependsOn: ["one" as never],
          writeScope: ["three.txt"],
          checks: [
            {
              kind: "command",
              id: "exists",
              label: "exists",
              argv: ["node", "-e", "require('fs').accessSync('three.txt')"],
              cwd: ".",
              timeoutMs: 60_000,
              expectExitCode: 0,
            },
          ],
          objective: "Create three.txt",
          acceptance: ["three.txt exists"],
          constraints: [],
        },
      ],
    };
    expect(await h["runs.revisePlan"]({ runId, plan: edited })).toEqual({ revision: 2 });
    await expect(call(() => h["runs.revisePlan"]({ runId, plan: edited }))).rejects.toThrow(
      /changed/,
    );

    const revised = await h["runs.plan"]({ runId });
    expect(revised.nodes.map((n) => [n.id, n.title])).toEqual([
      ["one", "Write the first file"],
      ["three", "Write three"],
    ]);
    expect(revised.nodes[0]?.constraints).toEqual(["Keep it short"]);
    expect(revised.maxConcurrency).toBe(1);

    await h["runs.approvePlan"]({ runId });
    const gates = await until(
      () => h["approvals.list"]({}),
      (g) => g.some((x) => x.runId === runId),
    );
    const gate = gates.find((x) => x.runId === runId);
    await h["approvals.answer"]({ id: gate?.id ?? "", decision: "approve" });
    const done = await until(
      () => h["runs.get"]({ runId }),
      (d) => d.status === "completed" && !d.active,
    );
    expect(done.nodeViews.map((n) => n.id)).toEqual(["one", "three"]);
    expect(execFileSync("git", ["show", "main:three.txt"], { cwd: repo, encoding: "utf8" })).toBe(
      "ok\n",
    );
    const events = (await h["runs.events"]({ runId })).map((e) => parseTraceEvent(e));
    const approved = events.find((r) => r.ok && r.value.type === "plan.approved");
    expect(approved?.ok && approved.value.payload).toEqual({ revision: 2, edited: true });
    const proposals = events.filter((r) => r.ok && r.value.type === "plan.proposed");
    expect(proposals.map((r) => r.ok && r.value.actor.kind)).toEqual(["engine", "human"]);
  });

  it("manages MCP servers, tests them, and grants their tools to new plans", async () => {
    let memoryDir = dirname(createRequire(import.meta.url).resolve("@orzeus/memory-server"));
    while (!existsSync(join(memoryDir, "package.json"))) memoryDir = dirname(memoryDir);
    const saved = await h["mcp.save"]({
      server: {
        id: "notes",
        name: "Notes",
        enabled: true,
        defaultGrant: "read",
        config: {
          transport: "stdio",
          command: process.execPath,
          args: [join(memoryDir, "dist", "main.js"), "--db", join(dir, "notes.db"), "--repo", repo],
          env: {},
          secretEnv: null,
        },
      },
    });
    expect(saved).toMatchObject({
      id: "notes",
      secretSet: false,
      secretVar: "ORZEUS_MCP_SECRET_NOTES",
      discovered: null,
    });
    await expect(
      call(() => h["mcp.save"]({ server: { ...saved, id: "memory", name: "Other" } })),
    ).rejects.toThrow(/reserved/);
    await expect(
      call(() => h["mcp.save"]({ server: { ...saved, id: "notes-2" } })),
    ).rejects.toThrow(/already named/);

    const tested = await h["mcp.test"]({ id: "notes" });
    expect(tested.discovered?.ok).toBe(true);
    const tools = tested.discovered?.tools ?? [];
    expect(tools.map((t) => t.name)).toContain("memory_search");

    const broken = await h["mcp.save"]({
      server: {
        ...saved,
        id: "broken",
        name: "Broken",
        enabled: false,
        config: { ...saved.config, command: join(dir, "no-such-server"), args: [] },
      } as never,
    });
    const failed = await h["mcp.test"]({ id: broken.id });
    expect(failed.discovered).toMatchObject({ ok: false, tools: [] });
    expect(failed.discovered?.error).toBeTruthy();
    expect((await h["mcp.list"]({})).map((s) => s.id)).toEqual(["broken", "notes"]);

    const { runId } = await h["runs.start"]({ goal: "Use the notes", repo });
    await until(
      () => h["runs.get"]({ runId }),
      (d) => d.awaitingPlanApproval && !d.active,
    );
    const plan = await h["runs.plan"]({ runId });
    const grants = plan.nodes[0]?.mcp.filter((g) => g.server === "notes") ?? [];
    expect(grants.map((g) => g.tool).sort()).toEqual(
      tools
        .filter((t) => t.readOnly)
        .map((t) => t.name)
        .sort(),
    );
    expect(grants.every((g) => g.access === "read")).toBe(true);

    await h["mcp.remove"]({ id: "broken" });
    await h["mcp.remove"]({ id: "notes" });
    expect(await h["mcp.list"]({})).toEqual([]);
  });

  it("holds new work on an account over its soft cap until the window resets", async () => {
    const resetsAt = Date.now() + 1_500;
    service.engine.telemetry.recordQuota([
      {
        accountId: "fake" as never,
        window: "5h",
        usedPercent: 90,
        resetsAt,
        status: "warning",
        source: "official_api",
        observedAt: Date.now(),
      },
    ]);
    await h["quota.setSoftCap"]({ accountId: "fake", window: "5h", percent: 80 });
    const quota = await h["quota.read"]({});
    expect(quota.accounts.find((a) => a.accountId === "fake")).toMatchObject({
      softCaps: { "5h": 80 },
      windows: [{ window: "5h", usedPercent: 90 }],
    });
    expect(notes.some((n) => n.method === "quota.changed")).toBe(true);

    const { runId } = await h["runs.start"]({ goal: "Wait for quota", repo });
    await until(
      () => h["runs.get"]({ runId }),
      (d) => d.awaitingPlanApproval && !d.active,
    );
    await h["runs.approvePlan"]({ runId });
    const gate = await until(
      () => h["approvals.list"]({}),
      (g) => g.some((x) => x.runId === runId),
    );
    await h["approvals.answer"]({
      id: gate.find((x) => x.runId === runId)?.id ?? "",
      decision: "approve",
    });
    await until(
      () => h["runs.get"]({ runId }),
      (d) => d.status === "completed" && !d.active,
    );
    const events = (await h["runs.events"]({ runId })).map((e) => parseTraceEvent(e));
    const tripped = events.find((r) => r.ok && r.value.type === "budget.tripped");
    expect(tripped?.ok && tripped.value.payload).toEqual({
      scope: "account",
      limit: "fake 5h",
      limitValue: 80,
      observed: 90,
    });
    const dispatched = events.filter((r) => r.ok && r.value.type === "node.dispatched");
    expect(dispatched.every((r) => r.ok && r.value.ts >= resetsAt)).toBe(true);
    await h["quota.setSoftCap"]({ accountId: "fake", window: "5h", percent: null });
  });
});

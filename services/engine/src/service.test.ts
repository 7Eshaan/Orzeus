import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureRepo } from "@orzeus/git/testing";
import type { RpcHandlers } from "@orzeus/protocol";
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
    expect(settings.secrets).toEqual({ anthropic: false, gemini: false, openai: false });
  });
});

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createFixtureRepo } from "@orzeus/git/testing";
import {
  type AccountContext,
  AdapterRegistry,
  type AgentSession,
  OPENAI_COMPATIBLE_MANIFEST,
  type ProviderAdapter,
  SessionController,
  type SessionRequest,
} from "@orzeus/providers";
import type { AccountId, ProjectId, RunId } from "@orzeus/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "./compose.js";
import { ulid } from "./ids.js";
import { createJsonLogger } from "./logger.js";
import { expandHandPlan, PlanFileError } from "./plan-file.js";

const FIXTURE = new URL("../fixtures/calc/", import.meta.url).pathname;
const PLAN = JSON.parse(readFileSync(join(FIXTURE, "plan.json"), "utf8")) as {
  nodes: { retry: object }[];
};
const IMPLEMENTATIONS: Record<string, Record<string, string>> = {
  add: { "src/add.js": "export function add(a, b) {\n  return a + b;\n}\n" },
  multiply: { "src/multiply.js": "export function multiply(a, b) {\n  return a * b;\n}\n" },
  index: {
    "src/index.js": 'export { add } from "./add.js";\nexport { multiply } from "./multiply.js";\n',
  },
};

type Behavior = "correct" | "wrong" | "hang" | "out_of_scope";

/** A worker that writes scripted files through the same approval flow a real adapter uses. */
class ScriptedAdapter implements ProviderAdapter {
  readonly manifest = { ...OPENAI_COMPATIBLE_MANIFEST };
  readonly sessions: SessionRequest[] = [];
  constructor(readonly behavior: (nodeId: string, attempt: number) => Behavior) {}
  async probe() {
    return { ok: true as const, version: "scripted", detail: "" };
  }
  async listModels() {
    return [];
  }
  startSession(request: SessionRequest): AgentSession {
    this.sessions.push(request);
    const controller = new SessionController();
    const behavior = this.behavior(request.nodeId, request.attempt);
    void (async () => {
      if (behavior === "hang") return;
      const files =
        behavior === "out_of_scope"
          ? { "README.md": "changed\n" }
          : Object.fromEntries(
              Object.entries(IMPLEMENTATIONS[request.nodeId] ?? {}).map(([p, c]) => [
                p,
                behavior === "wrong" ? c.replace(/a [+*] b/, "a - b") : c,
              ]),
            );
      for (const [path, content] of Object.entries(files)) {
        const decision = await controller.requestApproval(`w-${path}`, {
          kind: "file_write",
          path,
        });
        if (decision.kind !== "allow_once" && decision.kind !== "allow_for_node") continue;
        await mkdir(join(request.worktree.path, path, ".."), { recursive: true });
        await writeFile(join(request.worktree.path, path), content);
        controller.emit({ type: "file_change", path, change: "add" });
      }
      controller.emit({
        type: "usage",
        usage: {
          inputTokens: 500,
          outputTokens: 80,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        costMicroUsd: 0,
      });
      controller.finish({
        status: "completed",
        summary: `Wrote ${Object.keys(files).join(", ")}.`,
        costMicroUsd: 0,
        resume: null,
        errorClass: null,
      });
    })();
    return controller.session({
      onSteer: async () => undefined,
      onCancel: async () =>
        controller.finish({
          status: "cancelled",
          summary: "",
          costMicroUsd: 0,
          resume: null,
          errorClass: null,
        }),
    });
  }
}

const account: AccountContext = {
  accountId: "scripted" as AccountId,
  label: "Scripted",
  auth: { kind: "none" },
  getSecret: async () => "",
};

let dir: string;
let repo: string;
let engines: Engine[] = [];

async function fixtureRepo(): Promise<string> {
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(join(FIXTURE, "repo"), p)] = readFileSync(p, "utf8");
    }
  };
  walk(join(FIXTURE, "repo"));
  const path = join(dir, "calc");
  await createFixtureRepo(path, files);
  return path;
}

function engine(adapter: ProviderAdapter, lines: string[] = []): Engine {
  const e = createEngine({
    dataDir: join(dir, "data"),
    logger: createJsonLogger(() => undefined),
    adapters: new AdapterRegistry().register(adapter, account),
    progress: (line) => lines.push(line),
    lockTtlMs: 600,
  });
  engines.push(e);
  return e;
}

function startRun(e: Engine, overrides: (plan: typeof PLAN) => unknown = (p) => p): RunId {
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const runId = ulid() as RunId;
  const plan = expandHandPlan(overrides(structuredClone(PLAN)), runId, {
    root: repo,
    baseRef: "main",
    baseCommit: git(["rev-parse", "main"]) as never,
  });
  e.store.ensureProject({
    id: "project-calc",
    name: "calc",
    repoRoot: repo,
    defaultBranch: "main",
    createdAt: 0,
  });
  e.orchestrator.createRun("project-calc" as ProjectId, plan);
  e.orchestrator.approvePlan(runId);
  return runId;
}

const filesAt = (ref: string) =>
  execFileSync("git", ["ls-tree", "-r", "--name-only", ref], { cwd: repo, encoding: "utf8" })
    .trim()
    .split("\n");

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orzeus-engine-"));
  repo = await fixtureRepo();
});

afterEach(() => {
  for (const e of engines) e.close();
  engines = [];
  rmSync(dir, { recursive: true, force: true });
});

describe("headless run", () => {
  it("runs the 3-node calc plan to completion with real checks and integrates the result", async () => {
    const adapter = new ScriptedAdapter(() => "correct");
    const e = engine(adapter);
    const runId = startRun(e);
    const final = await e.orchestrator.execute(runId);

    expect(final.status).toBe("completed");
    expect(final.nodeOrder.map((id) => final.nodes[id]?.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    const integration = final.dag?.integration.branch ?? "";
    expect(filesAt(integration)).toEqual(
      expect.arrayContaining(["src/add.js", "src/multiply.js", "src/index.js"]),
    );
    expect(execFileSync("git", ["rev-parse", "main"], { cwd: repo, encoding: "utf8" }).trim()).toBe(
      final.dag?.repo.baseCommit,
    );
    expect(e.store.verify(runId).ok).toBe(true);

    // The dependent node saw its dependencies' work and summaries.
    const indexSession = adapter.sessions.find((s) => s.nodeId === "index");
    expect(indexSession?.packet.upstream.map((u) => u.nodeId).sort()).toEqual(["add", "multiply"]);
    expect(existsSync(join(indexSession?.worktree.path ?? "", "src/add.js"))).toBe(true);
  });

  it("retries after failing checks and records each attempt", async () => {
    const adapter = new ScriptedAdapter((node, attempt) =>
      node === "add" && attempt === 1 ? "wrong" : "correct",
    );
    const e = engine(adapter);
    const runId = startRun(e);
    const final = await e.orchestrator.execute(runId);
    expect(final.status).toBe("completed");
    expect(final.nodes["add"]?.attempt).toBe(2);
    const checks = e.store
      .events(runId)
      .filter((ev) => ev.type === "check.completed" && ev.nodeId === "add");
    expect(
      checks.map((c) =>
        c.type === "check.completed" ? [c.payload.checkId, c.payload.passed] : null,
      ),
    ).toEqual([
      ["scope", true],
      ["test", false],
      ["scope", true],
      ["test", true],
    ]);
  });

  it("denies writes outside the write scope before they happen", async () => {
    const adapter = new ScriptedAdapter((node) =>
      node === "multiply" ? "out_of_scope" : "correct",
    );
    const e = engine(adapter);
    const runId = startRun(e, (plan) => {
      for (const n of plan.nodes) Object.assign(n.retry, { maxAttempts: 1 });
      return plan;
    });
    const final = await e.orchestrator.execute(runId);
    expect(final.status).toBe("failed");
    expect(final.nodes["multiply"]?.status).toBe("failed");
    expect(final.nodes["index"]?.status).toBe("skipped");
    const multiplyWorktree =
      adapter.sessions.find((s) => s.nodeId === "multiply")?.worktree.path ?? "";
    expect(readFileSync(join(multiplyWorktree, "README.md"), "utf8")).not.toBe("changed\n");
  });

  it("resumes after a crash mid-node and finishes the run", async () => {
    const first = engine(new ScriptedAdapter((node) => (node === "add" ? "hang" : "correct")));
    const runId = startRun(first);
    void first.orchestrator.execute(runId); // the "crashed" engine never finishes
    await waitFor(
      () =>
        first.store.load(runId)?.nodes["add"]?.status === "running" &&
        first.store.load(runId)?.nodes["multiply"]?.status === "succeeded",
    );

    // A live engine holds the run lock; resuming while it is alive is refused...
    const lines: string[] = [];
    const restarted = engine(new ScriptedAdapter(() => "correct"), lines);
    await expect(restarted.orchestrator.resume(runId)).rejects.toThrow(
      /being run by another engine/,
    );
    // ...until it "crashes": its lock disappears as if it had expired.
    first.db.run("DELETE FROM run_locks");
    const final = await restarted.orchestrator.resume(runId);
    expect(final.status).toBe("completed");
    expect(final.nodes["add"]?.attempt).toBe(2);
    expect(final.nodes["multiply"]?.attempt).toBe(1);
    expect(lines.some((l) => l.includes("add: attempt 1 was interrupted"))).toBe(true);
    expect(restarted.store.verify(runId).ok).toBe(true);
  });

  it("rejects an invalid plan file with a readable error", () => {
    expect(() =>
      expandHandPlan({ goal: "x", nodes: [] }, ulid() as RunId, {
        root: "/",
        baseRef: "main",
        baseCommit: "a".repeat(40) as never,
      }),
    ).toThrow(PlanFileError);
    const cyclic = structuredClone(PLAN) as { nodes: { dependsOn?: string[] }[] };
    (cyclic.nodes[0] as { dependsOn?: string[] }).dependsOn = ["index"];
    expect(() =>
      expandHandPlan(cyclic, ulid() as RunId, {
        root: "/",
        baseRef: "main",
        baseCommit: "a".repeat(40) as never,
      }),
    ).toThrow(/cycle/);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * The Phase 2 exit check, with a real local model. Opt-in because it needs Ollama:
 *   ORZEUS_E2E=ollama pnpm vitest run services/engine
 * Runs the CLI as a separate process, kills it with SIGKILL mid-node, then resumes.
 */
describe.runIf(process.env["ORZEUS_E2E"] === "ollama")("exit check with a real model", () => {
  it("completes the calc plan with Ollama, surviving a kill -9 mid-node", async () => {
    const cli = new URL("../dist/cli.js", import.meta.url).pathname;
    const dataDir = join(dir, "data");
    const args = ["--data-dir", dataDir];
    const child = spawn(
      process.execPath,
      [cli, "run", join(FIXTURE, "plan.json"), "--repo", repo, "--approve-plan", ...args],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (c: string) => {
      stderr += c;
    });
    await waitFor(() => /attempt 1 started/.test(stderr), 60_000);
    await new Promise((r) => setTimeout(r, 1_500));
    child.kill("SIGKILL");
    await new Promise((r) => child.on("close", r));
    const runId = /Run (\w{26})/.exec(stderr)?.[1] ?? "";
    expect(runId).toHaveLength(26);

    const resumed = execFileSync(process.execPath, [cli, "resume", runId, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 900_000,
    });
    process.stdout.write(`\n--- before kill ---\n${stderr}\n--- after resume ---\n${resumed}\n`);
    expect(resumed).toContain(`Run ${runId}: completed`);
    const verify = execFileSync(process.execPath, [cli, "verify", runId, ...args], {
      encoding: "utf8",
    });
    expect(verify).toContain("Chain OK");
  }, 1_200_000);
});

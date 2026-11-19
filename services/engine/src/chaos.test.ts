import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureRepo } from "@orzeus/git/testing";
import type { GitOid, ProjectId, RunId } from "@orzeus/schema";
import { afterAll, describe, expect, it } from "vitest";
import { createEngine } from "./compose.js";
import { ulid } from "./ids.js";
import { createJsonLogger } from "./logger.js";
import { expandHandPlan } from "./plan-file.js";

/**
 * Phase 4 exit check: start a 6-node, 3-way-parallel run in a separate engine process, kill it
 * with SIGKILL at random moments, restart it, and repeat until it completes. Every run must end
 * completed, with a verified chain, projections that equal a rebuild, and the same integrated
 * tree as every other run. ORZEUS_CHAOS_RUNS sets the number of runs (default 5; exit check 50).
 */
const RUNS = Number(process.env["ORZEUS_CHAOS_RUNS"] ?? 5);
const CHILD = new URL("../fixtures/chaos/child.mjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "orzeus-chaos-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function plan() {
  const model = { provider: "openai_compatible", adapter: "openai-compatible", model: "chaos" };
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
        timeoutMs: 20_000,
        expectExitCode: 0,
      },
    ],
    packet: { objective: `Write out/${id}.txt`, acceptance: [{ statement: "file exists" }] },
  });
  return {
    goal: "Chaos",
    budget: { maxConcurrency: 3 },
    nodes: [
      node("a"),
      node("b"),
      node("c"),
      node("d", ["a"]),
      node("e", ["b", "c"]),
      node("f", ["d", "e"]),
    ],
  };
}

function runChild(
  dataDir: string,
  runId: string,
  seed: number,
  killAfterMs: number | null,
): Promise<{ code: number | null; out: string; killed: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD, dataDir, runId, String(seed)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let killed = false;
    child.stdout.setEncoding("utf8").on("data", (c: string) => {
      out += c;
    });
    child.stderr.resume();
    const timer =
      killAfterMs === null
        ? null
        : setTimeout(() => {
            killed = true;
            child.kill("SIGKILL");
          }, killAfterMs);
    child.on("close", (code) => {
      if (timer !== null) clearTimeout(timer);
      resolve({ code, out, killed });
    });
  });
}

describe("chaos: kill -9 at random points", () => {
  it(`every one of ${RUNS} runs resumes to the same completed state`, async () => {
    const repo = join(dir, "repo");
    const base = await createFixtureRepo(repo, { "README.md": "chaos\n" });
    const dataDir = join(dir, "data");
    const trees = new Set<string>();
    let kills = 0;

    for (let i = 0; i < RUNS; i++) {
      const runId = ulid() as RunId;
      const setup = createEngine({
        dataDir,
        logger: createJsonLogger(() => undefined),
        gateway: false,
      });
      setup.store.ensureProject({
        id: "project-chaos",
        name: "chaos",
        repoRoot: repo,
        defaultBranch: "main",
        createdAt: 0,
      });
      setup.orchestrator.createRun(
        "project-chaos" as ProjectId,
        expandHandPlan(plan(), runId, { root: repo, baseRef: "main", baseCommit: base as GitOid }),
      );
      setup.orchestrator.approvePlan(runId);
      setup.close();

      let completed = false;
      for (let round = 0; round < 40 && !completed; round++) {
        const killAfter = round < 25 ? 80 + Math.floor(Math.random() * 1_200) : null;
        const result = await runChild(dataDir, runId, i * 1_000 + round, killAfter);
        if (result.killed) kills++;
        completed = !result.killed && result.out.includes('"status":"completed"');
        if (!result.killed && !completed)
          throw new Error(`engine exited (${result.code}) without completing: ${result.out}`);
      }
      expect(completed).toBe(true);

      const check = createEngine({
        dataDir,
        logger: createJsonLogger(() => undefined),
        gateway: false,
      });
      const state = check.store.load(runId);
      expect(state?.status).toBe("completed");
      expect(check.store.verify(runId).ok).toBe(true);
      expect(check.store.rebuildProjections(runId)).toEqual(state);
      const done = check.store.events(runId).find((e) => e.type === "run.completed");
      const commit = done?.type === "run.completed" ? done.payload.integrationCommit : "";
      trees.add(
        execFileSync("git", ["rev-parse", `${commit}^{tree}`], {
          cwd: repo,
          encoding: "utf8",
        }).trim(),
      );
      check.close();
    }

    expect(trees.size).toBe(1);
    expect(kills).toBeGreaterThan(0);
    process.stdout.write(
      `chaos: ${RUNS} runs, ${kills} SIGKILLs, all completed with the same tree\n`,
    );
  }, 1_800_000);
});

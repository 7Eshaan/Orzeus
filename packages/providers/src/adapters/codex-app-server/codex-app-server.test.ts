import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPacketPrompt } from "@orzeus/core";
import type { NodeId, RunId } from "@orzeus/schema";
import { describe, expect, it } from "vitest";
import type { SessionRequest } from "../../adapter.js";
import { describeConformance, drain, TEST_ACCOUNT, testPacket } from "../../conformance/suite.js";
import { CodexAppServerAdapter } from "./adapter.js";

const DIR = new URL("../../../fixtures/codex-app-server/", import.meta.url).pathname;
const SESSION = join(DIR, "hello-session.jsonl");
const PROBE = join(DIR, "probe.jsonl");
const FAKE = join(DIR, "fake-app-server.mjs");
const MODEL = process.env["ORZEUS_RECORD_MODEL"] ?? "gpt-5.6-luna";
const OBJECTIVE =
  "Create a file named hello.txt in the repository root containing exactly the text: hi";

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "orzeus-codex-"));
  execFileSync("git", ["init", "--quiet", dir]);
  return dir;
}

function request(worktree: string): SessionRequest {
  const packet = testPacket(OBJECTIVE);
  return {
    runId: "01JD7Z5K3Q9V8X2M4N6P8R0T2W" as RunId,
    nodeId: "conformance" as NodeId,
    attempt: 1,
    model: MODEL,
    packet,
    prompt: renderPacketPrompt(packet, [], ["hello.txt"]),
    worktree: { path: worktree, branch: "orzeus/test/conformance" },
    mcp: null,
    budget: {
      maxInputTokens: 100_000,
      maxOutputTokens: 10_000,
      maxCostMicroUsd: 0,
      maxWallMs: 300_000,
      maxTurns: 20,
    },
    resume: null,
  };
}

describe.runIf(process.env["ORZEUS_RECORD"] === "codex-app-server")("record codex fixture", () => {
  it("records one real, tiny session (uses the signed-in Codex account)", async () => {
    rmSync(SESSION, { force: true });
    rmSync(PROBE, { force: true });
    const proxy = join(DIR, "record-proxy.mjs");
    const probeAdapter = new CodexAppServerAdapter({
      clientVersion: "0.0.0",
      command: [process.execPath, proxy, PROBE],
    });
    expect(await probeAdapter.probe(TEST_ACCOUNT, AbortSignal.timeout(30_000))).toMatchObject({
      ok: true,
    });
    const adapter = new CodexAppServerAdapter({
      clientVersion: "0.0.0",
      command: [process.execPath, proxy, SESSION],
    });
    const repo = gitRepo();
    const { outcome } = await drain(adapter, request(repo), TEST_ACCOUNT);
    expect(outcome.status).toBe("completed");
    expect(readFileSync(join(repo, "hello.txt"), "utf8").trim()).toBe("hi");
  }, 600_000);
});

describe.skipIf(!existsSync(SESSION))("codex-app-server (recorded)", () => {
  describeConformance("codex-app-server", new URL(".", import.meta.url).pathname, async () => ({
    adapter: new CodexAppServerAdapter({
      clientVersion: "0.0.0",
      command: [process.execPath, FAKE, SESSION, PROBE],
    }),
    account: TEST_ACCOUNT,
    request: async () => request(gitRepo()),
    hanging: async () => {
      const adapter = new CodexAppServerAdapter({
        clientVersion: "0.0.0",
        command: [process.execPath, FAKE, "--hang", SESSION],
      });
      return { adapter, request: request(gitRepo()) };
    },
  }));

  it("identifies itself honestly and starts threads sandboxed to the worktree", () => {
    const lines = readFileSync(SESSION, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          JSON.parse(l) as {
            dir: string;
            msg: { method?: string; params?: Record<string, unknown> };
          },
      );
    const init = lines.find((l) => l.msg.method === "initialize")?.msg.params as {
      clientInfo: { name: string };
    };
    expect(init.clientInfo.name).toBe("orzeus");
    const start = lines.find((l) => l.msg.method === "thread/start")?.msg.params;
    expect(start).toMatchObject({ sandbox: "workspace-write", approvalPolicy: "on-request" });
  });
});

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPacketPrompt } from "@orzeus/core";
import type { NodeId, RunId } from "@orzeus/schema";
import { describe, expect, it } from "vitest";
import type { SessionRequest } from "../../adapter.js";
import {
  type HttpExchange,
  readJsonl,
  recordingFetch,
  replayFetch,
} from "../../conformance/fixtures.js";
import { describeConformance, drain, TEST_ACCOUNT, testPacket } from "../../conformance/suite.js";
import { OpenAiCompatibleAdapter } from "./adapter.js";
import { toWorktreePath } from "./workspace-tools.js";

const FIXTURE = new URL("../../../fixtures/openai-compatible/greet.jsonl", import.meta.url)
  .pathname;
const MODEL = process.env["ORZEUS_RECORD_MODEL"] ?? "lfm3:latest";
const OBJECTIVE =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the task text literally asks for a template string.
  "Create src/greet.js, an ES module that exports function greet(name) returning `Hello, ${name}!`.";

function request(worktree: string): SessionRequest {
  const packet = testPacket(OBJECTIVE);
  return {
    runId: "01JD7Z5K3Q9V8X2M4N6P8R0T2W" as RunId,
    nodeId: "conformance" as NodeId,
    attempt: 1,
    model: MODEL,
    packet,
    prompt: renderPacketPrompt(packet, [], ["src/**"]),
    worktree: { path: worktree, branch: "orzeus/test/conformance" },
    mcp: null,
    budget: {
      maxInputTokens: 100_000,
      maxOutputTokens: 10_000,
      maxCostMicroUsd: 0,
      maxWallMs: 120_000,
      maxTurns: 8,
    },
    resume: null,
  };
}

const tempDir = () => mkdtempSync(join(tmpdir(), "orzeus-oac-"));

describe.runIf(process.env["ORZEUS_RECORD"] === "openai-compatible")(
  "record openai-compatible fixture",
  () => {
    it("records a real session against the local endpoint", async () => {
      rmSync(FIXTURE, { force: true });
      const adapter = new OpenAiCompatibleAdapter({
        baseUrl: "http://localhost:11434/v1",
        fetch: recordingFetch(fetch, FIXTURE),
      });
      expect(await adapter.probe(TEST_ACCOUNT, AbortSignal.timeout(10_000))).toMatchObject({
        ok: true,
      });
      const dir = tempDir();
      const { outcome } = await drain(adapter, request(dir), TEST_ACCOUNT);
      expect(outcome.status).toBe("completed");
      expect(existsSync(join(dir, "src/greet.js"))).toBe(true);
    }, 300_000);
  },
);

describeConformance("openai-compatible", new URL(".", import.meta.url).pathname, async () => {
  const exchanges = readJsonl<HttpExchange>(FIXTURE);
  return {
    adapter: new OpenAiCompatibleAdapter({
      baseUrl: "http://fixture.invalid/v1",
      fetch: replayFetch(exchanges),
    }),
    account: TEST_ACCOUNT,
    request: async () => request(tempDir()),
    hanging: async () => ({
      adapter: new OpenAiCompatibleAdapter({
        baseUrl: "http://fixture.invalid/v1",
        fetch: replayFetch([], { hang: true }),
      }),
      request: request(tempDir()),
    }),
  };
});

describe("openai-compatible specifics", () => {
  it("writes files only after approval and reports the change", async () => {
    const dir = tempDir();
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: "http://fixture.invalid/v1",
      fetch: replayFetch(readJsonl(FIXTURE)),
    });
    const { events } = await drain(adapter, request(dir), TEST_ACCOUNT);
    const approvalIndex = events.findIndex((e) => e.type === "approval_request");
    const changeIndex = events.findIndex((e) => e.type === "file_change");
    expect(approvalIndex).toBeGreaterThanOrEqual(0);
    expect(changeIndex).toBeGreaterThan(approvalIndex);
    expect(existsSync(join(dir, "src/greet.js"))).toBe(true);
  });

  it("does not touch the filesystem when a write is denied", async () => {
    const dir = tempDir();
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: "http://fixture.invalid/v1",
      fetch: replayFetch(readJsonl(FIXTURE)),
    });
    await drain(adapter, request(dir), TEST_ACCOUNT, () => ({ kind: "deny", reason: "no" }));
    expect(existsSync(join(dir, "src/greet.js"))).toBe(false);
  });

  it("treats a leading slash as the repository root and refuses escapes", () => {
    expect(toWorktreePath("/src/a.ts")).toBe("src/a.ts");
    expect(toWorktreePath("./src/../a.ts")).toBe("a.ts");
    expect(toWorktreePath("../../etc/passwd")).toBeNull();
    expect(toWorktreePath(42)).toBeNull();
  });
});

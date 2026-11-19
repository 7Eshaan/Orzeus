import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { helloRequest } from "../../conformance/request.js";
import { describeConformance, drain, TEST_ACCOUNT } from "../../conformance/suite.js";
import { CodexExecAdapter } from "./adapter.js";

const FAKE = new URL("../../../fixtures/codex-exec/fake-codex.mjs", import.meta.url).pathname;
const command = [process.execPath, FAKE] as const;

describeConformance("codex-exec", new URL(".", import.meta.url).pathname, async () => ({
  adapter: new CodexExecAdapter({ command }),
  account: TEST_ACCOUNT,
  request: async () => helloRequest("gpt-6-luna"),
  hanging: async () => {
    let pid: number | undefined;
    const adapter = new CodexExecAdapter({ command, onSpawn: (p) => (pid = p) });
    return { adapter, request: helloRequest("hang"), pid: () => pid };
  },
}));

describe("codex-exec", () => {
  it("maps the exec event stream: usage, files, summary and the thread to resume", async () => {
    const request = helloRequest("gpt-6-luna");
    const { events, outcome } = await drain(
      new CodexExecAdapter({ command }),
      request,
      TEST_ACCOUNT,
    );
    expect(readFileSync(join(request.worktree.path, "hello.txt"), "utf8")).toBe("hi\n");
    expect(events.find((e) => e.type === "file_change")).toEqual({
      type: "file_change",
      path: "hello.txt",
      change: "add",
    });
    expect(outcome).toMatchObject({
      status: "completed",
      usage: { inputTokens: 1200, cacheReadTokens: 1200, outputTokens: 90, reasoningTokens: 40 },
      resume: { adapter: "codex-exec", value: "0199a213-81c0-7800-8aa1-bbab2a035a53" },
    });
    expect(outcome.summary).toMatch(/^Created hello.txt/);
  });

  it("resumes a thread with `exec resume`", async () => {
    const request = helloRequest("gpt-6-luna", {
      resume: { adapter: "codex-exec", value: "t-42" },
    });
    const { outcome } = await drain(new CodexExecAdapter({ command }), request, TEST_ACCOUNT);
    expect(outcome.resume).toEqual({ adapter: "codex-exec", value: "t-42" });
  });

  it("reports a missing CLI as not installed", async () => {
    const adapter = new CodexExecAdapter({ command: ["/nonexistent/codex"] });
    expect(await adapter.probe(TEST_ACCOUNT, AbortSignal.timeout(5_000))).toMatchObject({
      ok: false,
      reason: "not_installed",
    });
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { helloRequest } from "../../conformance/request.js";
import { describeConformance, drain, TEST_ACCOUNT } from "../../conformance/suite.js";
import { CursorCliAdapter } from "./adapter.js";

const FAKE = new URL("../../../fixtures/cursor-cli/fake-cursor-agent.mjs", import.meta.url)
  .pathname;
const command = [process.execPath, FAKE] as const;

describeConformance("cursor-cli", new URL(".", import.meta.url).pathname, async () => ({
  adapter: new CursorCliAdapter({ command }),
  account: TEST_ACCOUNT,
  request: async () => helloRequest("auto"),
  hanging: async () => {
    let pid: number | undefined;
    const adapter = new CursorCliAdapter({ command, onSpawn: (p) => (pid = p) });
    return { adapter, request: helloRequest("hang"), pid: () => pid };
  },
}));

describe("cursor-cli", () => {
  it("maps stream-json, estimates usage and keeps the chat id for resume", async () => {
    const request = helloRequest("auto");
    const { events, outcome } = await drain(
      new CursorCliAdapter({ command }),
      request,
      TEST_ACCOUNT,
    );
    expect(readFileSync(join(request.worktree.path, "hello.txt"), "utf8")).toBe("hi\n");
    expect(events.filter((e) => e.type === "file_change")).toEqual([
      { type: "file_change", path: "hello.txt", change: "add" },
    ]);
    expect(
      events.filter((e) => e.type === "tool_call").map((e) => e.type === "tool_call" && e.tool),
    ).toEqual(["write"]);
    expect(outcome.status).toBe("completed");
    expect(outcome.usage.inputTokens).toBeGreaterThan(0);
    expect(outcome.resume?.value).toBe("c6b62c6f-7ead-4fd6-9922-e952131177ff");
  });
});

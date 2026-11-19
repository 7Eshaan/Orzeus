import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { helloRequest } from "../../conformance/request.js";
import { describeConformance, drain, TEST_ACCOUNT } from "../../conformance/suite.js";
import { AcpAdapter, acpAction } from "./adapter.js";

const FAKE = new URL("../../../fixtures/acp/fake-agent.mjs", import.meta.url).pathname;
const config = { command: [process.execPath, FAKE] as const, clientVersion: "0.0.0" };

describeConformance("acp", new URL(".", import.meta.url).pathname, async () => ({
  adapter: new AcpAdapter(config),
  account: TEST_ACCOUNT,
  request: async () => helloRequest("default"),
  hanging: async () => {
    let pid: number | undefined;
    const adapter = new AcpAdapter({
      ...config,
      env: { FAKE_HANG: "1" },
      onSpawn: (p) => {
        pid = p;
      },
    });
    return { adapter, request: helloRequest("default"), pid: () => pid };
  },
}));

describe("acp", () => {
  it("asks Orzeus before an edit, writes through the client, and reports cost", async () => {
    const request = helloRequest("default");
    const { events, outcome } = await drain(new AcpAdapter(config), request, TEST_ACCOUNT);
    expect(events.filter((e) => e.type === "approval_request")).toHaveLength(1);
    expect(events.find((e) => e.type === "approval_request")).toMatchObject({
      action: { kind: "file_write", path: "hello.txt" },
    });
    expect(readFileSync(join(request.worktree.path, "hello.txt"), "utf8")).toBe("hi\n");
    expect(outcome).toMatchObject({
      status: "completed",
      summary: "Created hello.txt.",
      costMicroUsd: 2_100,
      resume: { adapter: "acp", value: "sess-1" },
    });
  });

  it("writes nothing when Orzeus denies the edit", async () => {
    const request = helloRequest("default");
    const { outcome } = await drain(new AcpAdapter(config), request, TEST_ACCOUNT, () => ({
      kind: "deny",
      reason: "no",
    }));
    expect(existsSync(join(request.worktree.path, "hello.txt"))).toBe(false);
    expect(outcome.summary).toMatch(/not allowed/);
  });

  it("maps tool kinds to actions and refuses paths outside the worktree", () => {
    const wt = "/tmp/wt";
    expect(
      acpAction({ toolCallId: "1", kind: "read", locations: [{ path: "/tmp/wt/a" }] }, wt),
    ).toBe(null);
    expect(
      acpAction({ toolCallId: "1", kind: "edit", locations: [{ path: "/etc/x" }] }, wt),
    ).toMatch(/outside/);
    expect(
      acpAction({ toolCallId: "1", kind: "execute", rawInput: { command: "npm test" } }, wt),
    ).toEqual({ kind: "shell", argv: ["npm", "test"], cwd: "." });
    expect(
      acpAction({ toolCallId: "1", kind: "fetch", rawInput: { url: "https://x.dev/a" } }, wt),
    ).toEqual({ kind: "network", host: "x.dev" });
  });

  it("probes with initialize only", async () => {
    expect(await new AcpAdapter(config).probe(TEST_ACCOUNT, AbortSignal.timeout(10_000))).toEqual({
      ok: true,
      version: "fake-agent 1.0.0",
      detail: "can resume sessions",
    });
  });
});

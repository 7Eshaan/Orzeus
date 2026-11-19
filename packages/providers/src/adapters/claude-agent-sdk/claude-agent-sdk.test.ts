import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import type { AccountContext } from "../../adapter.js";
import { helloRequest } from "../../conformance/request.js";
import { describeConformance, drain } from "../../conformance/suite.js";
import { actionFor, ClaudeAgentSdkAdapter } from "./adapter.js";

const ACCOUNT: AccountContext = {
  accountId: "anthropic" as never,
  label: "Anthropic API",
  auth: { kind: "api_key", secretName: "anthropic", envVar: "ANTHROPIC_API_KEY" },
  getSecret: async () => "sk-ant-test",
};

/**
 * Stands in for the SDK's query(): plays the message sequence the SDK documents (system init,
 * assistant tool_use, user tool_result, rate limit, result), asking canUseTool before writing.
 * Hand-written from the SDK's types; recording needs an API key.
 */
function fakeQuery(seen: { options?: Options | undefined; prompts: string[] }, hang = false) {
  return ({
    prompt,
    options,
  }: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Options;
  }) => {
    seen.options = options;
    let closed = false;
    const messages = async function* (): AsyncGenerator<SDKMessage, void> {
      const input = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
      const first = await input.next();
      seen.prompts.push(String((first.value as SDKUserMessage).message.content));
      const base = { uuid: "u" as never, session_id: "sess-9" };
      yield { type: "system", subtype: "init", ...base } as unknown as SDKMessage;
      if (hang) {
        while (!closed) await new Promise((r) => setTimeout(r, 20));
        return;
      }
      const cwd = options?.cwd ?? "";
      const file = join(cwd, "hello.txt");
      yield {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Writing hello.txt." },
            {
              type: "tool_use",
              id: "tu1",
              name: "Write",
              input: { file_path: file, content: "hi\n" },
            },
          ],
        },
        parent_tool_use_id: null,
        ...base,
      } as unknown as SDKMessage;
      const verdict = await options?.canUseTool?.("Write", { file_path: file, content: "hi\n" }, {
        signal: new AbortController().signal,
        toolUseID: "tu1",
      } as never);
      const allowed = verdict?.behavior === "allow";
      if (allowed) writeFileSync(file, "hi\n");
      yield {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu1",
              is_error: !allowed,
              content: allowed ? "ok" : (verdict as { message: string }).message,
            },
          ],
        },
        parent_tool_use_id: null,
        ...base,
      } as unknown as SDKMessage;
      yield {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed_warning",
          rateLimitType: "five_hour",
          utilization: 0.81,
          resetsAt: 1_800_000_000,
        },
        ...base,
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 2,
        result: allowed ? "Created hello.txt." : "I could not write the file.",
        total_cost_usd: 0.0123,
        usage: {
          input_tokens: 1500,
          output_tokens: 120,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 0,
        },
        ...base,
      } as unknown as SDKMessage;
    };
    const generator = messages();
    return Object.assign(generator, {
      interrupt: async () => {
        closed = true;
        return undefined;
      },
      close: () => {
        closed = true;
      },
    }) as unknown as Query;
  };
}

const stateDir = () => mkdtempSync(join(tmpdir(), "orzeus-claude-sdk-"));
const fetchOk: typeof fetch = async () =>
  new Response(JSON.stringify({ data: [] }), { status: 200 });

describeConformance("claude-agent-sdk", new URL(".", import.meta.url).pathname, async () => ({
  adapter: new ClaudeAgentSdkAdapter({
    stateDir: stateDir(),
    clientVersion: "0.0.0",
    query: fakeQuery({ prompts: [] }),
    fetch: fetchOk,
  }),
  account: ACCOUNT,
  request: async () => helloRequest("claude-haiku-5-5"),
  hanging: async () => ({
    adapter: new ClaudeAgentSdkAdapter({
      stateDir: stateDir(),
      clientVersion: "0.0.0",
      query: fakeQuery({ prompts: [] }, true),
      fetch: fetchOk,
    }),
    request: helloRequest("claude-haiku-5-5"),
    account: ACCOUNT,
  }),
}));

describe("claude-agent-sdk", () => {
  it("runs isolated from the user's Claude setup, with the key and the gateway only", async () => {
    const seen: { options?: Options | undefined; prompts: string[] } = { prompts: [] };
    const dir = stateDir();
    const request = helloRequest("claude-haiku-5-5", {
      mcp: { url: "http://127.0.0.1:9/mcp", token: "tok" },
    });
    const adapter = new ClaudeAgentSdkAdapter({
      stateDir: dir,
      clientVersion: "1.2.3",
      query: fakeQuery(seen),
      fetch: fetchOk,
    });
    const { events, outcome } = await drain(adapter, request, ACCOUNT);

    const o = seen.options;
    expect(o?.settingSources).toEqual([]);
    expect(o?.strictMcpConfig).toBe(true);
    expect(o?.env).toMatchObject({
      ANTHROPIC_API_KEY: "sk-ant-test",
      CLAUDE_CONFIG_DIR: join(dir, "claude-agent-sdk"),
      CLAUDE_AGENT_SDK_CLIENT_APP: "orzeus/1.2.3",
    });
    expect(Object.keys(o?.env ?? {})).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(o?.mcpServers).toEqual({
      orzeus: {
        type: "http",
        url: "http://127.0.0.1:9/mcp",
        headers: { Authorization: "Bearer tok" },
      },
    });
    expect(seen.prompts[0]).toBe(request.prompt);

    expect(events.find((e) => e.type === "approval_request")).toMatchObject({
      action: { kind: "file_write", path: "hello.txt" },
    });
    expect(events.find((e) => e.type === "file_change")).toEqual({
      type: "file_change",
      path: "hello.txt",
      change: "add",
    });
    expect(events.find((e) => e.type === "quota")).toMatchObject({
      windows: [{ window: "5h", usedPercent: 81, status: "warning", resetsAt: 1_800_000_000_000 }],
    });
    expect(outcome).toMatchObject({
      status: "completed",
      summary: "Created hello.txt.",
      costMicroUsd: 12_300,
      usage: { inputTokens: 1500, outputTokens: 120, cacheReadTokens: 800 },
      resume: { adapter: "claude-agent-sdk", value: "sess-9" },
    });
    expect(readFileSync(join(request.worktree.path, "hello.txt"), "utf8")).toBe("hi\n");
  });

  it("does not report an edit that Orzeus denied", async () => {
    const request = helloRequest("claude-haiku-5-5");
    const adapter = new ClaudeAgentSdkAdapter({
      stateDir: stateDir(),
      clientVersion: "0",
      query: fakeQuery({ prompts: [] }),
      fetch: fetchOk,
    });
    const { events } = await drain(adapter, request, ACCOUNT, () => ({
      kind: "deny",
      reason: "no",
    }));
    expect(events.some((e) => e.type === "file_change")).toBe(false);
    expect(existsSync(join(request.worktree.path, "hello.txt"))).toBe(false);
  });

  it("maps Claude Code tools to Orzeus actions", () => {
    const wt = "/tmp/wt";
    expect(actionFor("Read", { file_path: "/tmp/wt/a.ts" }, wt)).toBeNull();
    expect(actionFor("Read", { file_path: "/etc/passwd" }, wt)).toMatch(/outside/);
    expect(actionFor("Edit", { file_path: "/tmp/wt/src/a.ts" }, wt)).toEqual({
      kind: "file_write",
      path: "src/a.ts",
    });
    expect(actionFor("Bash", { command: "pnpm test" }, wt)).toEqual({
      kind: "shell",
      argv: ["pnpm", "test"],
      cwd: ".",
    });
    expect(actionFor("WebFetch", { url: "https://docs.x.dev/a" }, wt)).toEqual({
      kind: "network",
      host: "docs.x.dev",
    });
    expect(actionFor("mcp__orzeus__orzeus__read_context", {}, wt)).toBeNull();
    expect(actionFor("mcp__other__tool", {}, wt)).toMatch(/gateway/);
    expect(actionFor("Task", {}, wt)).toMatch(/not available/);
  });

  it("refuses an account without an API key", async () => {
    const adapter = new ClaudeAgentSdkAdapter({
      stateDir: stateDir(),
      clientVersion: "0",
      fetch: fetchOk,
    });
    const result = await adapter.probe(
      { ...ACCOUNT, auth: { kind: "own_cli_login", binary: "claude" } },
      AbortSignal.timeout(1_000),
    );
    expect(result).toMatchObject({ ok: false, reason: "unauthenticated" });
  });
});

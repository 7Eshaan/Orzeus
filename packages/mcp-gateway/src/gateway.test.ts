import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import type { ContextPacket, NodeId, PacketId, RunId, Sha256 } from "@orzeus/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CALL_TOOL,
  CONTEXT_TOOL,
  describeUpstream,
  FIND_TOOLS,
  type GatewayCall,
  McpGateway,
  type NodeGrant,
} from "./gateway.js";

const worktree = mkdtempSync(join(tmpdir(), "orzeus-gateway-"));
writeFileSync(join(worktree, "a.ts"), "line1\nline2\nline3\n");
let gateway: McpGateway;
const notes: string[] = [];

beforeAll(async () => {
  const upstream = new McpServer({ name: "upstream", version: "1" });
  upstream.registerTool(
    "echo",
    {
      description: "Echo text",
      inputSchema: z.object({ text: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => ({
      content: [{ type: "text", text: `echo: ${text}` }],
    }),
  );
  upstream.registerTool(
    "write_note",
    { description: "Write a note", inputSchema: z.object({ note: z.string() }) },
    async ({ note }) => {
      notes.push(note);
      return { content: [{ type: "text", text: "saved" }] };
    },
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await upstream.connect(serverSide);
  const client = new Client({ name: "gateway", version: "1" });
  await client.connect(clientSide);
  gateway = await McpGateway.start({ upstreams: [await describeUpstream("up", client)] });
});

afterAll(async () => {
  await gateway.close();
  rmSync(worktree, { recursive: true, force: true });
});

function packet(): ContextPacket {
  return {
    schemaVersion: 1,
    id: "p" as PacketId,
    runId: "01JD7Z5K3Q9V8X2M4N6P8R0T2W" as RunId,
    nodeId: "n" as NodeId,
    objective: "o",
    nonGoals: [],
    acceptance: [{ id: "a", statement: "s", checkId: null }],
    context: [{ kind: "file_range", path: "a.ts", startLine: 2, endLine: 3, why: "the code" }],
    constraints: [],
    tools: {
      mcp: [
        { server: "up", tool: "echo", access: "read", loading: "eager" },
        { server: "up", tool: "write_note", access: "write", loading: "lazy" },
      ],
      builtin: [],
      network: "none",
      networkAllowlist: [],
    },
    upstream: [],
    steering: [],
    limits: { maxContextTokens: 1000 },
    contentHash: "c".repeat(64) as Sha256,
  };
}

function grant(
  decide: (access: "read" | "write") => "auto_allowed" | "approved" | "denied",
  calls: GatewayCall[],
  asked: string[],
): NodeGrant {
  return {
    runId: "01JD7Z5K3Q9V8X2M4N6P8R0T2W" as RunId,
    nodeId: "n" as NodeId,
    attempt: 1,
    worktree,
    packet: packet(),
    authorize: async ({ server, tool, access }) => {
      asked.push(`${server}/${tool}:${access}`);
      return decide(access);
    },
    record: (call) => calls.push(call),
  };
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "worker", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(gateway.url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

const textOf = (result: { content?: unknown }) => JSON.stringify(result.content);

describe("McpGateway", () => {
  it("refuses requests without a valid token and from foreign hosts", async () => {
    const noToken = await fetch(gateway.url, { method: "POST", body: "{}" });
    expect(noToken.status).toBe(401);
    const port = new URL(gateway.url).port;
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve) => {
      request(
        {
          host: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: { host: `evil.example:${port}` },
        },
        (res) => resolve(res.statusCode ?? 0),
      ).end("{}");
    });
    expect(status).toBe(403);
  });

  it("exposes exactly the grant's tools, serves packet context, and records allowed calls", async () => {
    const calls: GatewayCall[] = [];
    const asked: string[] = [];
    const token = gateway.grant(grant(() => "auto_allowed", calls, asked));
    const client = await connect(token);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(
        [CALL_TOOL, FIND_TOOLS, CONTEXT_TOOL, "up__echo"].sort(),
      );

      expect(textOf(await client.callTool({ name: CONTEXT_TOOL, arguments: {} }))).toContain(
        "0: a.ts lines 2-3 (the code)",
      );
      expect(
        textOf(await client.callTool({ name: CONTEXT_TOOL, arguments: { index: 0 } })),
      ).toContain("2  line2");
      const resource = await client.readResource({ uri: "orzeus://context/0" });
      expect(JSON.stringify(resource.contents)).toContain("line3");

      expect(
        textOf(await client.callTool({ name: "up__echo", arguments: { text: "hi" } })),
      ).toContain("echo: hi");
      expect(asked).toEqual(["up/echo:read"]);
      expect(calls).toEqual([
        expect.objectContaining({
          server: "up",
          tool: "echo",
          decision: "auto_allowed",
          isError: false,
        }),
      ]);

      expect(
        textOf(await client.callTool({ name: FIND_TOOLS, arguments: { query: "note" } })),
      ).toContain("write_note");
    } finally {
      await client.close();
      gateway.revoke(token);
    }
  });

  it("asks policy for writes through lazy tools and blocks denied ones before they reach the upstream", async () => {
    const calls: GatewayCall[] = [];
    const asked: string[] = [];
    const token = gateway.grant(
      grant((access) => (access === "write" ? "denied" : "auto_allowed"), calls, asked),
    );
    const client = await connect(token);
    try {
      const result = await client.callTool({
        name: CALL_TOOL,
        arguments: { server: "up", tool: "write_note", arguments: { note: "x" } },
      });
      expect(result.isError).toBe(true);
      expect(notes).toEqual([]);
      expect(asked).toEqual(["up/write_note:write"]);
      expect(calls[0]).toMatchObject({ decision: "denied", isError: true });
      const unknown = await client.callTool({
        name: CALL_TOOL,
        arguments: { server: "up", tool: "echo", arguments: {} },
      });
      expect(unknown.isError).toBe(true);
    } finally {
      await client.close();
      gateway.revoke(token);
    }
    const revoked = await fetch(gateway.url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{}",
    });
    expect(revoked.status).toBe(401);
  });
});

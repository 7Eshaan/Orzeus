import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { Client } from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import { resolveContextRef } from "@orzeus/context";
import type { ContextPacket, ContextRef, McpToolGrant, NodeId, RunId } from "@orzeus/schema";
import { z } from "zod";
import { listenLoopback } from "./http.js";

/** A tool offered by a connected upstream MCP server. */
export interface UpstreamTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly readOnly: boolean;
}

export interface Upstream {
  readonly name: string;
  readonly client: Client;
  readonly tools: readonly UpstreamTool[];
}

export type GatewayDecision = "auto_allowed" | "approved" | "denied";

export interface GatewayCall {
  readonly server: string;
  readonly tool: string;
  readonly args: unknown;
  readonly result: unknown;
  readonly isError: boolean;
  readonly decision: GatewayDecision;
  readonly durationMs: number;
}

/** What one node attempt may do through the gateway, and how its calls are judged and recorded. */
export interface NodeGrant {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attempt: number;
  readonly worktree: string;
  readonly packet: ContextPacket;
  /** Policy (and, when needed, a human) decides each upstream call. */
  authorize(call: {
    readonly server: string;
    readonly tool: string;
    readonly access: "read" | "write";
  }): Promise<GatewayDecision>;
  /** Every call, allowed or not, is recorded in the trace. */
  record(call: GatewayCall): void;
}

const NAME_SEPARATOR = "__";
export const CONTEXT_TOOL = `orzeus${NAME_SEPARATOR}read_context`;
export const FIND_TOOLS = `orzeus${NAME_SEPARATOR}find_tools`;
export const CALL_TOOL = `orzeus${NAME_SEPARATOR}call_tool`;

const text = (value: string, isError = false) => ({
  content: [{ type: "text" as const, text: value }],
  ...(isError ? { isError: true } : {}),
});

function describeRef(ref: ContextRef, index: number): string {
  switch (ref.kind) {
    case "file_range":
      return `${index}: ${ref.path} lines ${ref.startLine}-${ref.endLine} (${ref.why})`;
    case "symbol":
      return `${index}: ${ref.symbolKind} ${ref.symbol} in ${ref.path} (${ref.why})`;
    case "mcp_resource":
      return `${index}: ${ref.uri} from ${ref.server} (${ref.why})`;
    case "memory":
      return `${index}: memory ${ref.memoryId} (${ref.why})`;
  }
}

/**
 * The per-run MCP gateway (docs/architecture/05-policy-and-safety.md). Workers never connect to
 * upstream servers directly: each node attempt gets a bearer token that selects its grant, and
 * the gateway exposes exactly that grant's tools plus the packet's context.
 */
export class McpGateway {
  readonly #grants = new Map<string, NodeGrant>();
  readonly #upstreams: ReadonlyMap<string, Upstream>;
  readonly #server: Server;
  readonly #port: number;
  readonly #handler: ReturnType<typeof createMcpHandler>;
  readonly #now: () => number;
  readonly #ownsUpstreams: boolean;

  private constructor(
    upstreams: readonly Upstream[],
    server: Server,
    port: number,
    handler: ReturnType<typeof createMcpHandler>,
    now: () => number,
    ownsUpstreams: boolean,
  ) {
    this.#upstreams = new Map(upstreams.map((u) => [u.name, u]));
    this.#server = server;
    this.#port = port;
    this.#handler = handler;
    this.#now = now;
    this.#ownsUpstreams = ownsUpstreams;
  }

  /** With ownsUpstreams, closing the gateway also closes the upstream clients (and their processes). */
  static async start(options: {
    readonly upstreams: readonly Upstream[];
    readonly ownsUpstreams?: boolean;
    readonly now?: () => number;
  }): Promise<McpGateway> {
    let gateway: McpGateway | undefined;
    const handler = createMcpHandler((ctx) => {
      const token = ctx.authInfo?.token;
      const grant = token === undefined ? undefined : gateway?.grantFor(token);
      if (gateway === undefined || grant === undefined) throw new Error("unknown token");
      return gateway.serverFor(grant);
    });
    const { server, port } = await listenLoopback(async (request) => {
      const auth = request.headers.get("authorization") ?? "";
      const token = /^Bearer (\S+)$/.exec(auth)?.[1];
      const grant = token === undefined ? undefined : gateway?.grantFor(token);
      if (token === undefined || grant === undefined) {
        return new Response(JSON.stringify({ error: "invalid_token" }), {
          status: 401,
          headers: { "www-authenticate": "Bearer" },
        });
      }
      return handler.fetch(request, {
        authInfo: { token, clientId: `${grant.runId}/${grant.nodeId}`, scopes: [] },
      });
    });
    gateway = new McpGateway(
      options.upstreams,
      server,
      port,
      handler,
      options.now ?? Date.now,
      options.ownsUpstreams ?? false,
    );
    return gateway;
  }

  get url(): string {
    return `http://127.0.0.1:${this.#port}/mcp`;
  }

  /** Issues a token for one node attempt. */
  grant(grant: NodeGrant): string {
    const token = randomBytes(24).toString("hex");
    this.#grants.set(token, grant);
    return token;
  }

  revoke(token: string): void {
    this.#grants.delete(token);
  }

  grantFor(token: string): NodeGrant | undefined {
    return this.#grants.get(token);
  }

  async close(): Promise<void> {
    this.#grants.clear();
    await this.#handler.close();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    this.#server.closeAllConnections();
    if (this.#ownsUpstreams)
      await Promise.all(
        [...this.#upstreams.values()].map((u) => u.client.close().catch(() => undefined)),
      );
  }

  /** Builds the MCP surface for one grant: context tool and resources, eager tools, lazy meta-tools. */
  serverFor(grant: NodeGrant): McpServer {
    const server = new McpServer({ name: "orzeus-gateway", version: "0.0.0" });
    const refs = grant.packet.context;

    server.registerTool(
      CONTEXT_TOOL,
      {
        description:
          "Read the context listed in your task. Call without an index to list it, then with an index to read one item.",
        inputSchema: z.object({ index: z.int().min(0).optional() }),
        annotations: { readOnlyHint: true },
      },
      async ({ index }) => {
        if (index === undefined)
          return text(
            refs.length === 0 ? "This task lists no context." : refs.map(describeRef).join("\n"),
          );
        const ref = refs[index];
        if (ref === undefined) return text(`No context item ${index}.`, true);
        return this.#readRef(grant, ref);
      },
    );

    server.registerResource(
      "context",
      new ResourceTemplate("orzeus://context/{index}", {
        list: async () => ({
          resources: refs.map((ref, i) => ({
            uri: `orzeus://context/${i}`,
            name: describeRef(ref, i),
            mimeType: "text/plain",
          })),
        }),
      }),
      { mimeType: "text/plain", description: "Context pointers from the task packet" },
      async (uri, variables) => {
        const ref = refs[Number(variables["index"])];
        const result =
          ref === undefined ? text("Not found.", true) : await this.#readRef(grant, ref);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: result.content.map((c) => c.text).join("\n"),
            },
          ],
        };
      },
    );

    const grants = grant.packet.tools.mcp;
    for (const g of grants.filter((x) => x.loading === "eager")) {
      const tool = this.#upstreams.get(g.server)?.tools.find((t) => t.name === g.tool);
      if (tool === undefined) continue;
      server.registerTool(
        `${g.server}${NAME_SEPARATOR}${g.tool}`,
        {
          description: tool.description,
          inputSchema: fromJsonSchema(tool.inputSchema as Record<string, unknown>),
          annotations: { readOnlyHint: g.access === "read" && tool.readOnly },
        },
        async (args: unknown) => this.#proxy(grant, g, tool, args),
      );
    }

    const lazy = grants.filter((x) => x.loading === "lazy");
    if (lazy.length > 0) {
      server.registerTool(
        FIND_TOOLS,
        {
          description:
            "Search additional tools available to this task. Returns names, descriptions and input schemas.",
          inputSchema: z.object({ query: z.string() }),
          annotations: { readOnlyHint: true },
        },
        async ({ query }) => {
          const words = query
            .toLowerCase()
            .split(/\W+/)
            .filter((w) => w.length > 1);
          const matches = lazy.flatMap((g) => {
            const tool = this.#upstreams.get(g.server)?.tools.find((t) => t.name === g.tool);
            if (tool === undefined) return [];
            const haystack = `${g.server} ${tool.name} ${tool.description}`.toLowerCase();
            return words.length === 0 || words.some((w) => haystack.includes(w))
              ? [
                  {
                    server: g.server,
                    tool: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                  },
                ]
              : [];
          });
          return text(
            matches.length === 0 ? "No matching tools." : JSON.stringify(matches, null, 2),
          );
        },
      );
      server.registerTool(
        CALL_TOOL,
        {
          description: `Call a tool found with ${FIND_TOOLS}.`,
          inputSchema: z.object({
            server: z.string(),
            tool: z.string(),
            arguments: z.record(z.string(), z.unknown()),
          }),
        },
        async ({ server: name, tool: toolName, arguments: args }) => {
          const g = lazy.find((x) => x.server === name && x.tool === toolName);
          const tool = this.#upstreams.get(name)?.tools.find((t) => t.name === toolName);
          if (g === undefined || tool === undefined)
            return text(`${name}/${toolName} is not available to this task.`, true);
          return this.#proxy(grant, g, tool, args);
        },
      );
    }
    return server;
  }

  async #readRef(grant: NodeGrant, ref: ContextRef): Promise<ReturnType<typeof text>> {
    try {
      if (ref.kind === "file_range" || ref.kind === "symbol") {
        const resolved = await resolveContextRef(ref, grant.worktree);
        return text(`${resolved.title}\n${resolved.text}`);
      }
      if (ref.kind === "memory") {
        const memory = this.#upstreams.get("memory");
        if (memory === undefined) return text("Memory is not available in this run.", true);
        const result = await memory.client.callTool({
          name: "memory_get",
          arguments: { id: ref.memoryId },
        });
        return text(JSON.stringify(result.content));
      }
      const upstream = this.#upstreams.get(ref.server);
      if (upstream === undefined) return text(`Server ${ref.server} is not connected.`, true);
      const result = await upstream.client.readResource({ uri: ref.uri });
      return text(
        result.contents.map((c) => ("text" in c ? c.text : `[binary ${c.uri}]`)).join("\n"),
      );
    } catch (error) {
      return text(error instanceof Error ? error.message : String(error), true);
    }
  }

  async #proxy(grant: NodeGrant, g: McpToolGrant, tool: UpstreamTool, args: unknown) {
    const started = this.#now();
    const access = g.access === "write" || !tool.readOnly ? "write" : "read";
    const decision = await grant.authorize({ server: g.server, tool: tool.name, access });
    if (decision === "denied") {
      const denied = text(`Orzeus policy did not allow ${g.server}/${tool.name}.`, true);
      grant.record({
        server: g.server,
        tool: tool.name,
        args,
        result: denied.content,
        isError: true,
        decision,
        durationMs: this.#now() - started,
      });
      return denied;
    }
    const upstream = this.#upstreams.get(g.server);
    if (upstream === undefined) return text(`Server ${g.server} is not connected.`, true);
    try {
      const result = await upstream.client.callTool({
        name: tool.name,
        arguments: (args ?? {}) as Record<string, unknown>,
      });
      const content = Array.isArray(result.content) ? result.content : [];
      grant.record({
        server: g.server,
        tool: tool.name,
        args,
        result: content,
        isError: result.isError === true,
        decision,
        durationMs: this.#now() - started,
      });
      return { content, ...(result.isError === true ? { isError: true } : {}) };
    } catch (error) {
      const failed = text(error instanceof Error ? error.message : String(error), true);
      grant.record({
        server: g.server,
        tool: tool.name,
        args,
        result: failed.content,
        isError: true,
        decision,
        durationMs: this.#now() - started,
      });
      return failed;
    }
  }
}

/** Connects-time helper: snapshot an upstream client's tools (deterministic order). */
export async function describeUpstream(name: string, client: Client): Promise<Upstream> {
  const { tools } = await client.listTools();
  return {
    name,
    client,
    tools: tools
      .map((t) => ({
        name: t.name,
        description: t.description ?? t.name,
        inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
        readOnly: t.annotations?.readOnlyHint === true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

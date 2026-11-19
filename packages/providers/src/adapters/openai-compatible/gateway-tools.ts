import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { ToolDefinition } from "./workspace-tools.js";

/** Tools exposed by the node's Orzeus MCP gateway, offered to the model next to the built-ins. */
export interface GatewayTools {
  readonly definitions: readonly ToolDefinition[];
  has(name: string): boolean;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

/**
 * Connects to the gateway as an MCP client. The gateway enforces the node's allowlist and the
 * approval policy and records every call in the trace; this side only relays.
 */
export async function connectGateway(
  endpoint: { readonly url: string; readonly token: string },
  signal: AbortSignal,
): Promise<GatewayTools> {
  const client = new Client({ name: "orzeus-worker", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: { authorization: `Bearer ${endpoint.token}` } },
    }),
  );
  const listed = await client.listTools({}, { signal });
  const names = new Set(listed.tools.map((t) => t.name));
  return {
    definitions: listed.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? tool.name,
        parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<
          string,
          unknown
        >,
      },
    })),
    has: (name) => names.has(name),
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args }, { signal });
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .map((item) => (item.type === "text" ? item.text : `[${item.type}]`))
        .join("\n");
      return {
        text: text || JSON.stringify(result.structuredContent ?? null),
        isError: result.isError === true,
      };
    },
    close: () => client.close(),
  };
}

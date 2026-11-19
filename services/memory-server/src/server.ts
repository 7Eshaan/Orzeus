import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import { MEMORY_KINDS, type Memory, type MemoryStore } from "./memory-store.js";

export const MEMORY_SERVER_NAME = "orzeus-memory";

const render = (m: Memory): string =>
  `[${m.id}] ${m.kind}: ${m.title}\n${m.body}${m.paths.length > 0 ? `\nApplies to: ${m.paths.join(", ")}` : ""}`;

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

/**
 * MCP server over a MemoryStore for one repository. Read tools are annotated read-only; write
 * tools are not, so the Orzeus gateway's policy asks a human before a worker records a memory.
 */
export function createMemoryServer(
  store: MemoryStore,
  repoRoot: string,
  version = "0.0.0",
): McpServer {
  const server = new McpServer({ name: MEMORY_SERVER_NAME, version });

  server.registerTool(
    "memory_search",
    {
      description:
        "Search the repository's recorded decisions, constraints, conventions and gotchas.",
      inputSchema: z.object({
        query: z.string().describe("Words to search for"),
        limit: z.int().min(1).max(20).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      const found = store.search(repoRoot, query, limit ?? 5);
      return text(found.length === 0 ? "No matching memories." : found.map(render).join("\n\n"));
    },
  );

  server.registerTool(
    "memory_get",
    {
      description: "Read one memory by id.",
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const memory = store.get(id);
      return memory === undefined || memory.repoRoot !== repoRoot
        ? { ...text(`No memory ${id}.`), isError: true }
        : text(render(memory));
    },
  );

  server.registerTool(
    "memory_propose",
    {
      description:
        "Record a new decision, constraint, convention or gotcha for future tasks. Needs approval.",
      inputSchema: z.object({
        kind: z.enum(MEMORY_KINDS),
        title: z.string().min(3).max(200),
        body: z.string().min(3).max(4_000),
        paths: z.array(z.string()).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ kind, title, body, paths }) => {
      const memory = store.add({ repoRoot, kind, title, body, paths: paths ?? [] });
      return text(`Recorded ${memory.id}.`);
    },
  );

  server.registerTool(
    "memory_supersede",
    {
      description: "Mark a memory as replaced by a newer one.",
      inputSchema: z.object({ id: z.string(), by: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ id, by }) => {
      store.supersede(id, by);
      return text(`${id} is now superseded by ${by}.`);
    },
  );

  server.registerResource(
    "memory",
    new ResourceTemplate("memory://{id}", { list: undefined }),
    { mimeType: "text/plain", description: "One recorded memory" },
    async (uri, variables) => {
      const memory = store.get(String(variables["id"]));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/plain",
            text: memory === undefined ? "Not found." : render(memory),
          },
        ],
      };
    },
  );

  return server;
}

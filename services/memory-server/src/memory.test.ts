import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, describe, expect, it } from "vitest";
import { ftsQuery, MemoryStore } from "./memory-store.js";

const dir = mkdtempSync(join(tmpdir(), "orzeus-memory-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("MemoryStore", () => {
  it("searches by relevance within one repository and hides superseded memories", () => {
    const store = new MemoryStore(join(dir, "a.db"));
    const esm = store.add({
      repoRoot: "/r",
      kind: "convention",
      title: "ES modules only",
      body: "Use ES modules and no runtime dependencies.",
    });
    store.add({
      repoRoot: "/r",
      kind: "decision",
      title: "Node test runner",
      body: "Tests use node --test.",
    });
    store.add({ repoRoot: "/other", kind: "convention", title: "ES modules", body: "Other repo." });
    expect(store.search("/r", "which modules?").map((m) => m.title)).toEqual(["ES modules only"]);

    const newer = store.add({
      repoRoot: "/r",
      kind: "convention",
      title: "ES modules, Node 26",
      body: "ES modules; target Node 26.",
    });
    store.supersede(esm.id, newer.id);
    expect(store.search("/r", "modules").map((m) => m.id)).toEqual([newer.id]);
    expect(store.get(esm.id)?.supersededBy).toBe(newer.id);
    store.close();
  });

  it("never passes raw user text to FTS syntax", () => {
    expect(ftsQuery('title:"x" OR NEAR(a b) -- ;')).toBe('"title" OR "or" OR "near"');
    expect(ftsQuery("   ")).toBeNull();
  });
});

describe("orzeus-memory over MCP stdio", () => {
  it("serves search, get and propose, with read-only annotations on reads", async () => {
    const db = join(dir, "mcp.db");
    const seed = new MemoryStore(db);
    const seeded = seed.add({
      repoRoot: "/repo",
      kind: "gotcha",
      title: "Flaky clock",
      body: "Never use Date.now in reducers.",
    });
    seed.close();

    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [new URL("../dist/main.js", import.meta.url).pathname, "--db", db, "--repo", "/repo"],
      }),
    );
    try {
      const { tools } = await client.listTools();
      expect(Object.fromEntries(tools.map((t) => [t.name, t.annotations?.readOnlyHint]))).toEqual({
        memory_search: true,
        memory_get: true,
        memory_propose: false,
        memory_supersede: false,
      });
      const found = await client.callTool({
        name: "memory_search",
        arguments: { query: "clock reducers" },
      });
      expect(JSON.stringify(found.content)).toContain(seeded.id);
      const proposed = await client.callTool({
        name: "memory_propose",
        arguments: { kind: "decision", title: "Use pnpm", body: "pnpm workspaces." },
      });
      expect(JSON.stringify(proposed.content)).toMatch(/Recorded mem-/);
      const resource = await client.readResource({ uri: `memory://${seeded.id}` });
      expect(JSON.stringify(resource.contents)).toContain("Flaky clock");
    } finally {
      await client.close();
    }
  });
});

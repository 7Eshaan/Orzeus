#!/usr/bin/env node
import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { MemoryStore } from "./memory-store.js";
import { createMemoryServer } from "./server.js";

/** orzeus-memory --db <path> --repo <root> : serves one repository's memory over MCP stdio. */
const { values } = parseArgs({ options: { db: { type: "string" }, repo: { type: "string" } } });
if (values.db === undefined || values.repo === undefined) {
  process.stderr.write("usage: orzeus-memory --db <memory.db> --repo <repository root>\n");
  process.exit(2);
}
const store = new MemoryStore(values.db);
const repo = values.repo;
serveStdio(() => createMemoryServer(store, repo));

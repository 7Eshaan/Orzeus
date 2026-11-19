/**
 * @orzeus/memory-server
 *
 * orzeus-memory: persistent, searchable repository memory served over MCP.
 */
export {
  ftsQuery,
  MEMORY_KINDS,
  type Memory,
  type MemoryKind,
  MemoryStore,
} from "./memory-store.js";
export { createMemoryServer, MEMORY_SERVER_NAME } from "./server.js";

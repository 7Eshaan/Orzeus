import type { Db } from "./db.js";

/** An upstream MCP server the user configured. Config shapes are validated by the engine. */
export interface McpServerRecord {
  readonly id: string;
  readonly name: string;
  readonly transport: "stdio" | "streamable_http";
  /** Transport settings and the default grant, as JSON. */
  readonly config: unknown;
  /** Keychain entry holding the server's secret, if it has one. */
  readonly secretRef: string | null;
  readonly enabled: boolean;
  /** The last connection test, as JSON. */
  readonly discovered: unknown;
}

interface Row {
  id: string;
  name: string;
  transport: "stdio" | "streamable_http";
  config_json: string;
  secret_ref: string | null;
  discovered_json: string | null;
  enabled: number;
}

const fromRow = (row: Row): McpServerRecord => ({
  id: row.id,
  name: row.name,
  transport: row.transport,
  config: JSON.parse(row.config_json),
  secretRef: row.secret_ref,
  enabled: row.enabled === 1,
  discovered: row.discovered_json === null ? null : JSON.parse(row.discovered_json),
});

/**
 * The user's MCP servers (table `mcp_servers`). Servers are global for now (project_id NULL);
 * SQLite does not enforce uniqueness across NULLs, so names are checked here.
 */
export class McpServers {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  list(): McpServerRecord[] {
    return this.#db
      .all<Row>("SELECT * FROM mcp_servers WHERE project_id IS NULL ORDER BY name, id")
      .map(fromRow);
  }

  get(id: string): McpServerRecord | undefined {
    const row = this.#db.get<Row>("SELECT * FROM mcp_servers WHERE id = ?", [id]);
    return row === undefined ? undefined : fromRow(row);
  }

  /** Creates or replaces a server. A changed config clears the last test result. */
  put(server: Omit<McpServerRecord, "discovered">): McpServerRecord {
    return this.#db.transaction(() => {
      const clash = this.#db.get<{ id: string }>(
        "SELECT id FROM mcp_servers WHERE project_id IS NULL AND name = ? AND id <> ?",
        [server.name, server.id],
      );
      if (clash !== undefined) throw new Error(`another server is already named "${server.name}"`);
      const before = this.get(server.id);
      const config = JSON.stringify(server.config);
      const keep =
        before !== undefined &&
        JSON.stringify(before.config) === config &&
        before.transport === server.transport;
      this.#db.run(
        `INSERT INTO mcp_servers (id, project_id, name, transport, config_json, secret_ref, discovered_json, enabled)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, transport = excluded.transport,
           config_json = excluded.config_json, secret_ref = excluded.secret_ref,
           discovered_json = excluded.discovered_json, enabled = excluded.enabled`,
        [
          server.id,
          server.name,
          server.transport,
          config,
          server.secretRef,
          keep && before.discovered !== null ? JSON.stringify(before.discovered) : null,
          server.enabled ? 1 : 0,
        ],
      );
      const saved = this.get(server.id);
      if (saved === undefined) throw new Error(`could not save ${server.id}`);
      return saved;
    });
  }

  setDiscovered(id: string, discovered: unknown): void {
    this.#db.run("UPDATE mcp_servers SET discovered_json = ? WHERE id = ?", [
      JSON.stringify(discovered),
      id,
    ]);
  }

  remove(id: string): void {
    this.#db.run("DELETE FROM mcp_servers WHERE id = ?", [id]);
  }
}

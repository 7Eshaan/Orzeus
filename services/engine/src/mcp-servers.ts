import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describeUpstream, type Upstream } from "@orzeus/mcp-gateway";
import { McpServerConfig, McpServerInput, type McpServerView } from "@orzeus/protocol";
import type { McpToolGrant } from "@orzeus/schema";
import type { McpServerRecord, McpServers } from "@orzeus/store";
import { z } from "zod";
import { ENGINE_VERSION } from "./version.js";

/** Ids the gateway uses itself. */
const RESERVED = new Set(["memory", "orzeus"]);
/** Above this many tools a server's default grants are lazy (found through find_tools). */
const EAGER_LIMIT = 8;
const CONNECT_TIMEOUT_MS = 20_000;

const Stored = z.object({
  config: McpServerConfig,
  defaultGrant: McpServerInput.shape.defaultGrant,
});
const Discovered = z.object({
  at: z.int(),
  ok: z.boolean(),
  error: z.string().nullable(),
  serverName: z.string().nullable(),
  serverVersion: z.string().nullable(),
  tools: z.array(z.object({ name: z.string(), description: z.string(), readOnly: z.boolean() })),
});
type Discovered = z.infer<typeof Discovered>;

/**
 * The environment variable that carries a server's Keychain secret into the engine. The desktop
 * shell sets it (apps/desktop/src-tauri/src/secrets.rs uses the same rule).
 */
export function secretVar(id: string): string {
  return `ORZEUS_MCP_SECRET_${id.toUpperCase().replaceAll("-", "_")}`;
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The user's upstream MCP servers: stored in SQLite, secrets from the environment (never
 * stored), connected for connection tests and for each run's gateway.
 */
export class McpServerRegistry {
  readonly #store: McpServers;
  readonly #env: Env;

  constructor(store: McpServers, env: Env) {
    this.#store = store;
    this.#env = env;
  }

  list(): McpServerView[] {
    return this.#store.list().map((r) => this.#view(r));
  }

  save(input: McpServerInput): McpServerView {
    const server = McpServerInput.parse(input);
    if (RESERVED.has(server.id)) throw new Error(`"${server.id}" is reserved; choose another id`);
    return this.#view(
      this.#store.put({
        id: server.id,
        name: server.name,
        transport: server.config.transport,
        config: { config: server.config, defaultGrant: server.defaultGrant },
        secretRef: `mcp.${server.id}`,
        enabled: server.enabled,
      }),
    );
  }

  remove(id: string): void {
    this.#store.remove(id);
  }

  /** Connects, lists tools and records the outcome (a failure is recorded, not thrown). */
  async test(id: string): Promise<McpServerView> {
    const record = this.#record(id);
    let discovered: Discovered;
    let client: Client | null = null;
    try {
      client = await this.#connect(record);
      const upstream = await describeUpstream(id, client);
      const version = client.getServerVersion();
      discovered = {
        at: Date.now(),
        ok: true,
        error: null,
        serverName: version?.name ?? null,
        serverVersion: version?.version ?? null,
        tools: upstream.tools.map((t) => ({
          name: t.name,
          description: t.description,
          readOnly: t.readOnly,
        })),
      };
    } catch (error) {
      discovered = {
        at: Date.now(),
        ok: false,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
        serverName: null,
        serverVersion: null,
        tools: [],
      };
    } finally {
      await client?.close().catch(() => undefined);
    }
    this.#store.setDiscovered(id, discovered);
    return this.#view(this.#record(id));
  }

  /**
   * Connects every enabled server for a run's gateway. A server that fails is skipped (and
   * reported), so one broken server never blocks a run.
   */
  async upstreams(warn: (message: string) => void): Promise<Upstream[]> {
    const enabled = this.#store.list().filter((r) => r.enabled);
    const connected = await Promise.all(
      enabled.map(async (record) => {
        let client: Client | null = null;
        try {
          client = await this.#connect(record);
          return await describeUpstream(record.id, client);
        } catch (error) {
          await client?.close().catch(() => undefined);
          warn(
            `MCP server ${record.name} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        }
      }),
    );
    return connected.filter((u): u is Upstream => u !== null);
  }

  /** Grants new plans get from the servers' "default access" settings and their last test. */
  defaultGrants(): McpToolGrant[] {
    return this.#store.list().flatMap((record) => {
      if (!record.enabled) return [];
      const { defaultGrant } = Stored.parse(record.config);
      const tools = this.#discovered(record)?.tools ?? [];
      if (defaultGrant === "none") return [];
      const granted = defaultGrant === "read" ? tools.filter((t) => t.readOnly) : tools;
      const loading = granted.length > EAGER_LIMIT ? ("lazy" as const) : ("eager" as const);
      return granted.map((t) => ({
        server: record.id,
        tool: t.name,
        access: t.readOnly ? ("read" as const) : ("write" as const),
        loading,
      }));
    });
  }

  #record(id: string): McpServerRecord {
    const record = this.#store.get(id);
    if (record === undefined) throw new Error(`no MCP server ${id}`);
    return record;
  }

  #discovered(record: McpServerRecord): Discovered | null {
    const parsed = Discovered.safeParse(record.discovered);
    return parsed.success ? parsed.data : null;
  }

  #view(record: McpServerRecord): McpServerView {
    const { config, defaultGrant } = Stored.parse(record.config);
    return {
      id: record.id,
      name: record.name,
      enabled: record.enabled,
      config,
      defaultGrant,
      secretSet: Boolean(this.#env[secretVar(record.id)]),
      secretVar: secretVar(record.id),
      discovered: this.#discovered(record),
    };
  }

  async #connect(record: McpServerRecord): Promise<Client> {
    const { config } = Stored.parse(record.config);
    const secret = this.#env[secretVar(record.id)] || undefined;
    const client = new Client({ name: "orzeus", version: ENGINE_VERSION });
    const transport =
      config.transport === "stdio"
        ? new StdioClientTransport({
            command: config.command,
            args: config.args,
            env: {
              ...getDefaultEnvironment(),
              ...config.env,
              ...(config.secretEnv !== null && secret !== undefined
                ? { [config.secretEnv]: secret }
                : {}),
            },
            stderr: "ignore",
          })
        : new StreamableHTTPClientTransport(new URL(config.url), {
            ...(secret === undefined ? {} : { authProvider: { token: async () => secret } }),
          });
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no answer within ${CONNECT_TIMEOUT_MS / 1000}s`)),
        CONNECT_TIMEOUT_MS,
      );
      timer.unref();
    });
    try {
      await Promise.race([client.connect(transport), timeout]);
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }
}

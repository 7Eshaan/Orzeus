import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isSea } from "node:sea";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { type Clock, createRedactor, quotaHold, type Random, type RunState } from "@orzeus/core";
import { Git, WorktreeManager } from "@orzeus/git";
import { describeUpstream, McpGateway } from "@orzeus/mcp-gateway";
import { MemoryStore } from "@orzeus/memory-server";
import {
  type AccountContext,
  AcpAdapter,
  AdapterRegistry,
  AnthropicApiAdapter,
  ClaudeAgentSdkAdapter,
  CodexAppServerAdapter,
  CodexExecAdapter,
  CursorCliAdapter,
  GeminiApiAdapter,
  OpenAiApiAdapter,
  OpenAiCompatibleAdapter,
  type ProviderAdapter,
} from "@orzeus/providers";
import { type AccountId, DEFAULT_POLICY, type ModelRef, type PolicyDocument } from "@orzeus/schema";
import { type Db, McpServers, openStore, RunLocks, SqliteRunStore, Telemetry } from "@orzeus/store";
import { type Logger, secretValues } from "./logger.js";
import { McpServerRegistry } from "./mcp-servers.js";
import {
  type FrontierModel,
  type GateAnswer,
  type GateRequest,
  RunOrchestrator,
} from "./orchestrator.js";
import type { PlannerModel } from "./planner.js";
import { ENGINE_VERSION } from "./version.js";

export interface EngineConfig {
  readonly dataDir: string;
  readonly logger: Logger;
  readonly approveAsks?: boolean;
  readonly policy?: PolicyDocument;
  /** OpenAI-compatible endpoint for local models; default Ollama on localhost. */
  readonly openAiCompatibleUrl?: string;
  /** Codex uses the user's own subscription, so it is opt-in (app-server and exec adapters). */
  readonly enableCodex?: boolean;
  /** Cursor's CLI uses the user's own login or CURSOR_API_KEY, so it is opt-in too. */
  readonly enableCursor?: boolean;
  /** Agents that speak ACP v1 over stdio, each its own worker adapter. */
  readonly acpAgents?: readonly AcpAgentConfig[];
  /** reasoning_effort for local models; small "thinking" models need "none" or "low" to answer in budget. */
  readonly localReasoningEffort?: "none" | "low" | "medium" | "high";
  /** Headless approval of the merge into your branch (the CLI asks interactively instead). */
  readonly approveMerge?: boolean;
  /** Answers human gates; default: decide from approveAsks / approveMerge. */
  readonly decideGate?: (gate: GateRequest) => Promise<GateAnswer>;
  /** Additional structured-output adapters for planning, steering and review (tests, plugins). */
  readonly extraPlanners?: readonly {
    readonly adapter: ProviderAdapter;
    readonly account: AccountContext;
  }[];
  /** "adapter:model" for steering and review; usually the planner. */
  readonly frontier?: string;
  /** Run lock timing (tests shorten it). */
  readonly lockTtlMs?: number;
  /** Start the per-run MCP gateway with the memory server (default true). */
  readonly gateway?: boolean;
  /** Override the worker adapters (tests). */
  readonly adapters?: AdapterRegistry;
  /** API keys by environment variable name; default process.env. Never logged or stored. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly clock?: Clock;
  readonly random?: Random;
  readonly progress?: (line: string) => void;
}

export interface Engine {
  readonly db: Db;
  readonly store: SqliteRunStore;
  readonly memory: MemoryStore;
  /** Upstream MCP servers the user configured; enabled ones join every run's gateway. */
  readonly mcpServers: McpServerRegistry;
  /** Accounts, quota observations and soft caps. */
  readonly telemetry: Telemetry;
  readonly git: Git;
  readonly orchestrator: RunOrchestrator;
  /** Adapters that can plan (structured output), keyed by adapter id. */
  readonly planners: ReadonlyMap<
    string,
    { readonly adapter: ProviderAdapter; readonly account: AccountContext }
  >;
  /** Resolves "adapter:model" (e.g. "openai-compatible:lfm3:latest") to a planner. */
  planner(spec: string): PlannerModel;
  /** Worker adapters, keyed by adapter id. */
  readonly workers: AdapterRegistry;
  /** Resolves "adapter:model" to a worker model reference. */
  workerModel(spec: string): ModelRef;
  close(): void;
}

function account(
  id: string,
  label: string,
  adapter: ProviderAdapter,
  env: Readonly<Record<string, string | undefined>>,
): AccountContext {
  const auth = adapter.manifest.auth[0] ?? { kind: "none" as const };
  return {
    accountId: id as AccountId,
    label,
    auth,
    getSecret: async () => {
      const name = auth.kind === "api_key" ? auth.envVar : "";
      const value = env[name];
      if (value === undefined || value === "") throw new Error(`${name} is not set`);
      return value;
    },
  };
}

export interface AcpAgentConfig {
  /** Adapter id, e.g. "acp-gemini"; must start with "acp". */
  readonly id: string;
  readonly displayName?: string;
  readonly command: readonly [string, ...string[]];
}

/**
 * Parses ACP agents from "id=command args…" strings (CLI) or a JSON array (ORZEUS_ACP_AGENTS):
 * [{"id": "acp-gemini", "command": ["gemini", "--experimental-acp"]}].
 */
export function parseAcpAgents(values: readonly string[]): AcpAgentConfig[] {
  return values.flatMap((value): AcpAgentConfig[] => {
    const text = value.trim();
    if (text === "") return [];
    if (text.startsWith("[")) {
      const parsed = JSON.parse(text) as AcpAgentConfig[];
      return parsed.flatMap((a) => parseAcpAgents([`${a.id}=${JSON.stringify(a.command)}`]));
    }
    const eq = text.indexOf("=");
    const id = text.slice(0, eq).trim();
    const rest = text.slice(eq + 1).trim();
    const command = (rest.startsWith("[") ? JSON.parse(rest) : rest.split(/\s+/)) as string[];
    if (eq <= 0 || !/^acp[a-z0-9-]*$/.test(id) || command.length === 0 || command[0] === "")
      throw new Error(`expected acp-name=command, got "${value}"`);
    return [{ id, command: command as [string, ...string[]] }];
  });
}

export function defaultAdapters(config: EngineConfig): AdapterRegistry {
  const env = config.env ?? process.env;
  const registry = new AdapterRegistry();
  const local = new OpenAiCompatibleAdapter({
    baseUrl: config.openAiCompatibleUrl ?? "http://localhost:11434/v1",
    ...(config.localReasoningEffort === undefined
      ? {}
      : { reasoningEffort: config.localReasoningEffort }),
  });
  registry.register(local, {
    ...account("local-openai-compatible", "Local models", local, env),
    auth: { kind: "none" },
  });
  if (config.enableCodex) {
    const codex = new CodexAppServerAdapter({ clientVersion: ENGINE_VERSION });
    registry.register(codex, account("codex-cli-login", "Codex (your login)", codex, env));
    // The same login as the app-server adapter: one account, so its quota applies to both.
    const exec = new CodexExecAdapter();
    registry.register(exec, account("codex-cli-login", "Codex (your login)", exec, env));
  }
  if (config.enableCursor) {
    const cursor = new CursorCliAdapter();
    registry.register(
      cursor,
      env["CURSOR_API_KEY"]
        ? {
            ...account("cursor-api-key", "Cursor API key", cursor, env),
            auth: { kind: "api_key", secretName: "cursor", envVar: "CURSOR_API_KEY" },
            getSecret: async () => env["CURSOR_API_KEY"] ?? "",
          }
        : account("cursor-cli-login", "Cursor (your login)", cursor, env),
    );
  }
  // The packaged engine leaves the Agent SDK out (its native binary is 160 MB per platform).
  if (env["ANTHROPIC_API_KEY"] && !isSea()) {
    const claude = new ClaudeAgentSdkAdapter({
      stateDir: config.dataDir,
      clientVersion: ENGINE_VERSION,
    });
    registry.register(claude, account("anthropic-api-key", "Anthropic API", claude, env));
  }
  if (env["OPENAI_API_KEY"]) {
    const openai = new OpenAiApiAdapter();
    registry.register(openai, account("openai-api-key", "OpenAI API", openai, env));
  }
  for (const agent of config.acpAgents ?? []) {
    const acp = new AcpAdapter({
      id: agent.id,
      displayName: agent.displayName ?? agent.id,
      command: agent.command,
      clientVersion: ENGINE_VERSION,
    });
    registry.register(acp, {
      ...account(agent.id, agent.displayName ?? agent.id, acp, env),
      auth: { kind: "none" },
    });
  }
  return registry;
}

function plannerAdapters(
  config: EngineConfig,
): Map<string, { adapter: ProviderAdapter; account: AccountContext }> {
  const env = config.env ?? process.env;
  const map = new Map<string, { adapter: ProviderAdapter; account: AccountContext }>();
  const local = new OpenAiCompatibleAdapter({
    baseUrl: config.openAiCompatibleUrl ?? "http://localhost:11434/v1",
    ...(config.localReasoningEffort === undefined
      ? {}
      : { reasoningEffort: config.localReasoningEffort }),
  });
  map.set(local.manifest.id, {
    adapter: local,
    account: {
      ...account("local-openai-compatible", "Local models", local, env),
      auth: { kind: "none" },
    },
  });
  if (config.enableCodex) {
    const codex = new CodexAppServerAdapter({ clientVersion: ENGINE_VERSION });
    map.set(codex.manifest.id, {
      adapter: codex,
      account: account("codex-cli-login", "Codex (your login)", codex, env),
    });
  }
  if (env["ANTHROPIC_API_KEY"]) {
    const anthropic = new AnthropicApiAdapter();
    map.set(anthropic.manifest.id, {
      adapter: anthropic,
      account: account("anthropic-api-key", "Anthropic API", anthropic, env),
    });
  }
  if (env["OPENAI_API_KEY"]) {
    const openai = new OpenAiApiAdapter();
    map.set(openai.manifest.id, {
      adapter: openai,
      account: account("openai-api-key", "OpenAI API", openai, env),
    });
  }
  if (env["GEMINI_API_KEY"]) {
    const gemini = new GeminiApiAdapter();
    map.set(gemini.manifest.id, {
      adapter: gemini,
      account: account("gemini-api-key", "Gemini API", gemini, env),
    });
  }
  return map;
}

/** Splits "adapter:model"; the model may itself contain colons (e.g. "lfm3:latest"). */
export function parseModelSpec(spec: string): { adapter: string; model: string } {
  const index = spec.indexOf(":");
  if (index <= 0 || index === spec.length - 1)
    throw new Error(`expected adapter:model, got "${spec}"`);
  return { adapter: spec.slice(0, index), model: spec.slice(index + 1) };
}

/**
 * How to start orzeus-memory: the packaged engine runs itself with the "memory-server" role (see
 * sea.ts); otherwise Node runs the built entry point (always dist, even when tests resolve
 * sources).
 */
function memoryServerArgs(): string[] {
  if (isSea()) return ["memory-server"];
  let dir = dirname(createRequire(import.meta.url).resolve("@orzeus/memory-server"));
  while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) dir = dirname(dir);
  return [join(dir, "dist", "main.js")];
}

/**
 * Starts the run's gateway: the memory server for the run's repository, plus every enabled
 * server the user configured (those that fail to connect are skipped with a warning).
 */
async function openGateway(
  dataDir: string,
  state: RunState,
  servers: McpServerRegistry,
  warn: (message: string) => void,
): Promise<McpGateway> {
  const client = new Client({ name: "orzeus-gateway", version: ENGINE_VERSION });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [...memoryServerArgs(), "--db", join(dataDir, "memory.db"), "--repo", state.repo.root],
    }),
  );
  return McpGateway.start({
    upstreams: [await describeUpstream("memory", client), ...(await servers.upstreams(warn))],
    ownsUpstreams: true,
  });
}

/** Headless runs have no human at hand: flags decide, and the policy actor is recorded. */
export function headlessGate(
  config: Pick<EngineConfig, "approveAsks" | "approveMerge">,
): (gate: GateRequest) => Promise<GateAnswer> {
  return async (gate) => {
    const approved =
      gate.action.kind === "merge" ? config.approveMerge === true : config.approveAsks === true;
    const flag = gate.action.kind === "merge" ? "--approve-merge" : "--approve-asks";
    return {
      approved,
      actor: {
        kind: "policy",
        ruleId: approved
          ? `headless${flag.replace("--", "_").replaceAll("-", "_")}`
          : "headless_no_human",
      },
      ...(approved
        ? {}
        : { note: `No human is available in headless mode (run with ${flag} to allow).` }),
    };
  };
}

/** The composition root: the only place concrete adapters are wired to core ports. */
export function createEngine(config: EngineConfig): Engine {
  mkdirSync(config.dataDir, { recursive: true });
  const db = openStore(join(config.dataDir, "orzeus.db"));
  const store = new SqliteRunStore(db, {
    redact: createRedactor(secretValues(config.env ?? process.env)),
  });
  const memory = new MemoryStore(join(config.dataDir, "memory.db"));
  const mcpServers = new McpServerRegistry(new McpServers(db), config.env ?? process.env);
  const telemetry = new Telemetry(db);
  const git = new Git();
  const workers = config.adapters ?? defaultAdapters(config);
  const planners = plannerAdapters(config);
  for (const extra of config.extraPlanners ?? []) planners.set(extra.adapter.manifest.id, extra);
  const resolvePlanner = (spec: string): PlannerModel => {
    const { adapter, model } = parseModelSpec(spec);
    const entry = planners.get(adapter);
    if (entry === undefined) {
      throw new Error(
        `planner adapter ${adapter} is not available (have: ${[...planners.keys()].join(", ")}; API adapters need their key in the environment)`,
      );
    }
    return {
      ref: { provider: entry.adapter.manifest.provider, adapter, model },
      adapter: entry.adapter,
      account: entry.account,
    };
  };
  // Every account the engine may use gets a row, so quota and soft caps can refer to it.
  for (const { adapter, account: acct } of [
    ...workers.ids().flatMap((id) => {
      const entry = workers.get(id);
      return entry === undefined ? [] : [entry];
    }),
    ...planners.values(),
  ]) {
    telemetry.ensureAccount({
      id: acct.accountId,
      provider: adapter.manifest.provider,
      adapter: adapter.manifest.id,
      label: acct.label,
      authKind: acct.auth.kind,
      secretRef: acct.auth.kind === "api_key" ? acct.auth.secretName : null,
    });
  }
  const frontier: FrontierModel | undefined =
    config.frontier === undefined ? undefined : resolvePlanner(config.frontier);
  const ttl = config.lockTtlMs ?? 15_000;
  const orchestrator = new RunOrchestrator({
    store,
    git,
    worktrees: new WorktreeManager(git, join(config.dataDir, "worktrees")),
    adapters: workers,
    policy: config.policy ?? DEFAULT_POLICY,
    clock: config.clock ?? { now: Date.now },
    random: config.random ?? Math.random,
    logger: config.logger,
    decideGate: config.decideGate ?? headlessGate(config),
    lock: { locks: new RunLocks(db), ttlMs: ttl, heartbeatMs: Math.max(100, Math.floor(ttl / 3)) },
    ...(frontier === undefined ? {} : { frontier }),
    ...(config.progress === undefined ? {} : { progress: config.progress }),
    quota: {
      hold: (accountId, now) =>
        quotaHold(
          telemetry.latestQuota().filter((w) => w.accountId === accountId),
          telemetry.softCaps(accountId),
          now,
        ),
      observe: (windows) => telemetry.recordQuota(windows),
    },
    ...(config.gateway === false
      ? {}
      : {
          openGateway: (state: RunState) =>
            openGateway(config.dataDir, state, mcpServers, (message) => {
              config.logger.log("warn", message, { runId: state.runId });
              config.progress?.(`Run ${state.runId}: ${message}`);
            }),
        }),
  });

  return {
    db,
    store,
    memory,
    mcpServers,
    telemetry,
    git,
    orchestrator,
    planners,
    workers,
    planner(spec) {
      const { adapter, model } = parseModelSpec(spec);
      const entry = planners.get(adapter);
      if (entry === undefined) {
        throw new Error(
          `planner adapter ${adapter} is not available (have: ${[...planners.keys()].join(", ")}; API adapters need their key in the environment)`,
        );
      }
      return {
        ref: { provider: entry.adapter.manifest.provider, adapter, model },
        adapter: entry.adapter,
        account: entry.account,
      };
    },
    workerModel(spec) {
      const { adapter, model } = parseModelSpec(spec);
      const entry = workers.get(adapter);
      if (entry === undefined)
        throw new Error(
          `worker adapter ${adapter} is not enabled (have: ${workers.ids().join(", ")})`,
        );
      return { provider: entry.adapter.manifest.provider, adapter, model };
    },
    close: () => {
      orchestrator.stop();
      memory.close();
      db.close();
    },
  };
}

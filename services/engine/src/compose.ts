import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Clock, Random } from "@orzeus/core";
import { Git, WorktreeManager } from "@orzeus/git";
import {
  type AccountContext,
  AdapterRegistry,
  CodexAppServerAdapter,
  OpenAiCompatibleAdapter,
} from "@orzeus/providers";
import { type AccountId, DEFAULT_POLICY, type PolicyDocument } from "@orzeus/schema";
import { type Db, openStore, SqliteRunStore } from "@orzeus/store";
import type { Logger } from "./logger.js";
import { RunOrchestrator } from "./orchestrator.js";
import { ENGINE_VERSION } from "./version.js";

export interface EngineConfig {
  readonly dataDir: string;
  readonly logger: Logger;
  readonly approveAsks?: boolean;
  readonly policy?: PolicyDocument;
  /** OpenAI-compatible endpoint for local workers; default Ollama on localhost. */
  readonly openAiCompatibleUrl?: string;
  /** Codex uses the user's own subscription, so it is opt-in. */
  readonly enableCodex?: boolean;
  /** Override the adapters (tests). */
  readonly adapters?: AdapterRegistry;
  readonly clock?: Clock;
  readonly random?: Random;
  readonly progress?: (line: string) => void;
}

export interface Engine {
  readonly db: Db;
  readonly store: SqliteRunStore;
  readonly git: Git;
  readonly orchestrator: RunOrchestrator;
  close(): void;
}

const noSecrets = async (name: string): Promise<string> => {
  const value = process.env[name.toUpperCase().replace(/[^A-Z0-9]/g, "_")];
  if (value === undefined) throw new Error(`secret ${name} is not configured`);
  return value;
};

export function defaultAdapters(config: EngineConfig): AdapterRegistry {
  const registry = new AdapterRegistry();
  const local: AccountContext = {
    accountId: "local-openai-compatible" as AccountId,
    label: "Local models",
    auth: { kind: "none" },
    getSecret: noSecrets,
  };
  registry.register(
    new OpenAiCompatibleAdapter({
      baseUrl: config.openAiCompatibleUrl ?? "http://localhost:11434/v1",
    }),
    local,
  );
  if (config.enableCodex) {
    const codex: AccountContext = {
      accountId: "codex-cli-login" as AccountId,
      label: "Codex (your login)",
      auth: { kind: "own_cli_login", binary: "codex" },
      getSecret: noSecrets,
    };
    registry.register(new CodexAppServerAdapter({ clientVersion: ENGINE_VERSION }), codex);
  }
  return registry;
}

/** The composition root: the only place concrete adapters are wired to core ports. */
export function createEngine(config: EngineConfig): Engine {
  mkdirSync(config.dataDir, { recursive: true });
  const db = openStore(join(config.dataDir, "orzeus.db"));
  const store = new SqliteRunStore(db);
  const git = new Git();
  const orchestrator = new RunOrchestrator({
    store,
    git,
    worktrees: new WorktreeManager(git, join(config.dataDir, "worktrees")),
    adapters: config.adapters ?? defaultAdapters(config),
    policy: config.policy ?? DEFAULT_POLICY,
    clock: config.clock ?? { now: Date.now },
    random: config.random ?? Math.random,
    logger: config.logger,
    approveAsks: config.approveAsks ?? false,
    ...(config.progress === undefined ? {} : { progress: config.progress }),
  });
  return { db, store, git, orchestrator, close: () => db.close() };
}

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalDecision, ProposedAction, TokenUsage } from "@orzeus/schema";
import type {
  AccountContext,
  AdapterManifest,
  ModelInfo,
  ProbeResult,
  ProviderAdapter,
  SessionRequest,
} from "../../adapter.js";
import { USER_AGENT } from "../../http.js";
import { hostOf, insideWorktree } from "../../paths.js";
import { quotaFromClaudeRateLimit } from "../../quota.js";
import { EventQueue, SessionController } from "../../session.js";
import { shellWords } from "../../shell-words.js";

export const CLAUDE_AGENT_SDK_MANIFEST: AdapterManifest = {
  id: "claude-agent-sdk",
  provider: "anthropic",
  displayName: "Claude Agent SDK",
  transport: "cli_stream_json",
  auth: [{ kind: "api_key", secretName: "anthropic", envVar: "ANTHROPIC_API_KEY" }],
  capabilities: {
    structuredOutput: false,
    agentSession: true,
    mcpClient: true,
    resume: true,
    steerMidTurn: true,
    approvalCallbacks: true,
    reportsUsage: "exact",
    reportsQuota: false,
  },
  compliance: {
    officialInterface: "https://platform.claude.com/docs/en/agent-sdk/typescript",
    readsForeignCredentials: false,
    rotatesAccounts: false,
    spoofsClient: false,
    notes:
      "API key only. Claude Code runs with its own config directory inside Orzeus's data folder and no user or project settings, so it never sees a claude.ai login. Every edit, command and fetch is decided by Orzeus's policy through canUseTool.",
  },
};

type QueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => Query;

export interface ClaudeAgentSdkConfig {
  /** Where Claude Code keeps its sessions (CLAUDE_CONFIG_DIR); one per Orzeus data folder. */
  readonly stateDir: string;
  readonly clientVersion: string;
  /** The SDK's query function; tests pass a fake. Default: the real SDK, loaded on first use. */
  readonly query?: QueryFn;
  readonly fetch?: typeof fetch;
}

/** Tools that only read inside the worktree; Orzeus allows them without asking. */
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "TodoWrite", "NotebookRead"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const SYSTEM_APPEND = [
  "You are a worker in Orzeus, a coding orchestrator. You get one small, self-contained task in this repository.",
  "Stay inside the repository. Orzeus approves or denies each edit, command and fetch; a denial is final, so adapt instead of retrying.",
  "Orzeus runs the verification checks after you finish. Tools from the orzeus MCP server give you the task's context.",
  "If the task cannot be done without a decision, say what is unclear and stop. End with a one-paragraph summary of what you changed.",
].join("\n");

function toUsage(raw: Record<string, unknown> | undefined): TokenUsage {
  const n = (k: string) => (typeof raw?.[k] === "number" ? (raw[k] as number) : 0);
  return {
    inputTokens: n("input_tokens"),
    outputTokens: n("output_tokens"),
    cacheReadTokens: n("cache_read_input_tokens"),
    cacheWriteTokens: n("cache_creation_input_tokens"),
    reasoningTokens: 0,
  };
}

/**
 * What a tool call would do, in Orzeus's terms; null for reads inside the worktree (allowed) and
 * an error string for anything Orzeus refuses outright.
 */
export function actionFor(
  tool: string,
  input: Record<string, unknown>,
  worktree: string,
): ProposedAction | null | string {
  if (tool.startsWith("mcp__orzeus__")) return null; // the gateway decides those itself
  if (tool.startsWith("mcp__")) return "Only the Orzeus gateway's MCP tools are available.";
  const path = String(input["file_path"] ?? input["notebook_path"] ?? input["path"] ?? "");
  if (READ_TOOLS.has(tool)) {
    if (path === "") return null;
    return insideWorktree(worktree, path) === null ? `${path} is outside the repository.` : null;
  }
  if (WRITE_TOOLS.has(tool)) {
    const rel = insideWorktree(worktree, path);
    return rel === null ? `${path} is outside the repository.` : { kind: "file_write", path: rel };
  }
  if (tool === "Bash") {
    const command = String(input["command"] ?? "");
    return { kind: "shell", argv: command === "" ? ["(empty)"] : shellWords(command), cwd: "." };
  }
  if (tool === "WebFetch") return { kind: "network", host: hostOf(String(input["url"] ?? "")) };
  if (tool === "WebSearch") return { kind: "network", host: "web search" };
  return `${tool} is not available to Orzeus workers.`;
}

function permission(decision: ApprovalDecision, toolUseID: string): PermissionResult {
  switch (decision.kind) {
    case "allow_once":
    case "allow_for_node":
      return { behavior: "allow", toolUseID };
    case "deny":
      return { behavior: "deny", message: `Not allowed: ${decision.reason}`, toolUseID };
    case "steer":
      return {
        behavior: "deny",
        message: `Not done. Your supervisor says: ${decision.message}`,
        toolUseID,
      };
  }
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}

/**
 * Worker adapter over the Claude Agent SDK, with an Anthropic API key. Claude Code's own tools do
 * the work; every edit, command and fetch becomes an Orzeus approval request.
 */
export class ClaudeAgentSdkAdapter implements ProviderAdapter {
  readonly manifest: AdapterManifest = CLAUDE_AGENT_SDK_MANIFEST;
  readonly #config: ClaudeAgentSdkConfig;
  readonly #fetch: typeof fetch;

  constructor(config: ClaudeAgentSdkConfig) {
    this.#config = config;
    this.#fetch = config.fetch ?? fetch;
  }

  async #query(): Promise<QueryFn> {
    if (this.#config.query !== undefined) return this.#config.query;
    return (await import("@anthropic-ai/claude-agent-sdk")).query as QueryFn;
  }

  async #key(account: AccountContext): Promise<string> {
    if (account.auth.kind !== "api_key")
      throw new Error("the Claude Agent SDK adapter needs an Anthropic API key");
    return account.getSecret(account.auth.secretName);
  }

  /** Lists models with the key: checks it without spending tokens. */
  async probe(account: AccountContext, signal: AbortSignal): Promise<ProbeResult> {
    let key: string;
    try {
      key = await this.#key(account);
    } catch (error) {
      return { ok: false, reason: "unauthenticated", detail: (error as Error).message };
    }
    try {
      const response = await this.#fetch("https://api.anthropic.com/v1/models?limit=1", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "user-agent": USER_AGENT },
        signal,
      });
      if (response.status === 401 || response.status === 403)
        return { ok: false, reason: "unauthenticated", detail: `HTTP ${response.status}` };
      if (!response.ok)
        return { ok: false, reason: "unreachable", detail: `HTTP ${response.status}` };
      return { ok: true, version: "agent-sdk", detail: "API key accepted" };
    } catch (error) {
      return { ok: false, reason: "unreachable", detail: (error as Error).message };
    }
  }

  async listModels(account: AccountContext, signal: AbortSignal): Promise<readonly ModelInfo[]> {
    const response = await this.#fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: {
        "x-api-key": await this.#key(account),
        "anthropic-version": "2023-06-01",
        "user-agent": USER_AGENT,
      },
      signal,
    });
    const body = (await response.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => ({
      model: m.id,
      suggestedTier: /haiku/.test(m.id) ? "worker" : "frontier",
      contextWindow: null,
      pricing: null,
    }));
  }

  startSession(request: SessionRequest, account: AccountContext) {
    const controller = new SessionController();
    const input = new EventQueue<SDKUserMessage>();
    const abort = new AbortController();
    let query: Query | null = null;
    let sessionId: string | null = request.resume?.value ?? null;
    let lastText = "";
    /** Edits waiting for their result, so only edits that happened are reported. */
    const writes = new Map<string, { path: string; add: boolean }>();
    const resume = () =>
      sessionId === null ? null : { adapter: this.manifest.id, value: sessionId };

    const canUseTool = async (
      tool: string,
      toolInput: Record<string, unknown>,
      options: { signal: AbortSignal; toolUseID: string },
    ): Promise<PermissionResult> => {
      const action = actionFor(tool, toolInput, request.worktree.path);
      if (action === null) return { behavior: "allow", toolUseID: options.toolUseID };
      if (typeof action === "string")
        return { behavior: "deny", message: action, toolUseID: options.toolUseID };
      const decision = await controller.requestApproval(options.toolUseID, action);
      return permission(decision, options.toolUseID);
    };

    const handle = (message: SDKMessage) => {
      switch (message.type) {
        case "system":
          if (message.subtype === "init") sessionId = message.session_id;
          break;
        case "assistant":
          for (const block of message.message.content) {
            if (block.type === "text") {
              lastText = block.text;
              controller.emit({ type: "message_delta", text: block.text });
            } else if (block.type === "tool_use") {
              controller.emit({
                type: "tool_call",
                callId: block.id,
                tool: block.name,
                input: block.input,
              });
              const action = actionFor(
                block.name,
                block.input as Record<string, unknown>,
                request.worktree.path,
              );
              if (action !== null && typeof action !== "string" && action.kind === "file_write")
                writes.set(block.id, { path: action.path, add: block.name === "Write" });
            }
          }
          break;
        case "user": {
          const content = message.message.content;
          if (typeof content === "string") break;
          for (const block of content) {
            if (block.type !== "tool_result") continue;
            const isError = block.is_error === true;
            controller.emit({
              type: "tool_result",
              callId: block.tool_use_id,
              isError,
              output: block.content ?? null,
            });
            const write = writes.get(block.tool_use_id);
            writes.delete(block.tool_use_id);
            if (write !== undefined && !isError)
              controller.emit({
                type: "file_change",
                path: write.path,
                change: write.add ? "add" : "modify",
              });
          }
          break;
        }
        case "rate_limit_event":
          controller.emit({
            type: "quota",
            windows: quotaFromClaudeRateLimit(
              account.accountId,
              message.rate_limit_info,
              Date.now(),
            ),
          });
          break;
        case "result": {
          sessionId = message.session_id;
          const usage = toUsage(message.usage as unknown as Record<string, unknown>);
          const cost = Math.round(message.total_cost_usd * 1_000_000);
          controller.emit({ type: "usage", usage, costMicroUsd: cost });
          input.close();
          const status =
            message.subtype === "success" && !message.is_error
              ? "completed"
              : message.subtype === "error_max_turns" || message.subtype === "error_max_budget_usd"
                ? "budget_exceeded"
                : "failed";
          controller.finish({
            status,
            summary:
              message.subtype === "success"
                ? message.result.trim() || lastText || "Claude finished."
                : `Claude stopped: ${message.subtype}`,
            costMicroUsd: cost,
            resume: resume(),
            errorClass: status === "failed" ? `provider.${message.subtype}` : null,
          });
          break;
        }
        default:
          break;
      }
    };

    const run = async () => {
      const key = await this.#key(account);
      const configDir = join(this.#config.stateDir, "claude-agent-sdk");
      mkdirSync(configDir, { recursive: true });
      input.push(userMessage(request.prompt));
      const queryFn = await this.#query();
      const maxBudgetUsd = request.budget.maxCostMicroUsd / 1_000_000;
      query = queryFn({
        prompt: input,
        options: {
          cwd: request.worktree.path,
          model: request.model,
          permissionMode: "default",
          canUseTool,
          settingSources: [],
          tools: ["Read", "Glob", "Grep", "Write", "Edit", "MultiEdit", "Bash", "WebFetch"],
          systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_APPEND },
          maxTurns: request.budget.maxTurns,
          ...(maxBudgetUsd > 0 ? { maxBudgetUsd } : {}),
          ...(request.resume === null ? {} : { resume: request.resume.value }),
          strictMcpConfig: true,
          mcpServers:
            request.mcp === null
              ? {}
              : {
                  orzeus: {
                    type: "http",
                    url: request.mcp.url,
                    headers: { Authorization: `Bearer ${request.mcp.token}` },
                  },
                },
          abortController: abort,
          env: {
            PATH: process.env["PATH"] ?? "/usr/bin:/bin",
            HOME: process.env["HOME"] ?? configDir,
            TMPDIR: process.env["TMPDIR"] ?? "/tmp",
            LANG: process.env["LANG"] ?? "en_US.UTF-8",
            ANTHROPIC_API_KEY: key,
            CLAUDE_CONFIG_DIR: configDir,
            CLAUDE_AGENT_SDK_CLIENT_APP: `orzeus/${this.#config.clientVersion}`,
          },
        },
      });
      for await (const message of query) {
        handle(message);
        if (controller.finished) break;
      }
      if (!controller.finished)
        controller.finish({
          status: "failed",
          summary: "Claude ended without a result.",
          costMicroUsd: null,
          resume: resume(),
          errorClass: "provider.no_result",
        });
    };

    run()
      .catch((error: unknown) => {
        if (!controller.finished)
          controller.finish({
            status: abort.signal.aborted ? "cancelled" : "failed",
            summary: error instanceof Error ? error.message : String(error),
            costMicroUsd: null,
            resume: resume(),
            errorClass: abort.signal.aborted ? null : "provider.agent_sdk_error",
          });
      })
      .finally(() => {
        input.close();
        query?.close();
      });

    return controller.session({
      onSteer: async (message) => {
        input.push(userMessage(`Guidance from your supervisor: ${message}`));
      },
      onCancel: async (reason) => {
        await Promise.race([
          query?.interrupt().catch(() => undefined),
          new Promise((r) => setTimeout(r, 1_000)),
        ]);
        abort.abort(reason);
        input.close();
        query?.close();
        controller.finish({
          status: "cancelled",
          summary: `Cancelled: ${reason}`,
          costMicroUsd: null,
          resume: resume(),
          errorClass: null,
        });
      },
    });
  }
}

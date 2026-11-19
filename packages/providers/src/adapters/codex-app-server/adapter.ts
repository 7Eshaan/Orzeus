import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AccountId,
  type ApprovalDecision,
  type QuotaWindow,
  type TokenUsage,
  ZERO_USAGE,
} from "@orzeus/schema";
import type {
  AccountContext,
  AdapterManifest,
  ModelInfo,
  ProbeResult,
  ProviderAdapter,
  SessionRequest,
} from "../../adapter.js";
import { SessionController } from "../../session.js";
import { shellWords } from "../../shell-words.js";
import {
  type GenerateRequest,
  type GenerateResult,
  parseJsonOutput,
  StructuredOutputError,
  toStrictJsonSchema,
} from "../../structured.js";
import { CodexRpc } from "./rpc.js";

export interface CodexAppServerConfig {
  /** How to start the server; default ["codex", "app-server"]. Tests point this at a fake. */
  readonly command?: readonly [string, ...string[]];
  readonly clientVersion: string;
  /** Extra environment for the server process (on top of a minimal base). */
  readonly env?: Readonly<Record<string, string>>;
}

export const CODEX_APP_SERVER_MANIFEST: AdapterManifest = {
  id: "codex-app-server",
  provider: "openai",
  displayName: "Codex (app-server)",
  transport: "json_rpc_stdio",
  auth: [
    { kind: "own_cli_login", binary: "codex" },
    { kind: "api_key", secretName: "openai", envVar: "OPENAI_API_KEY" },
  ],
  capabilities: {
    structuredOutput: true,
    agentSession: true,
    mcpClient: true,
    resume: true,
    steerMidTurn: true,
    approvalCallbacks: true,
    reportsUsage: "exact",
    reportsQuota: true,
  },
  compliance: {
    officialInterface: "https://learn.chatgpt.com/docs/app-server",
    readsForeignCredentials: false,
    rotatesAccounts: false,
    spoofsClient: false,
    notes:
      "Runs the user's own codex CLI. Orzeus identifies itself as clientInfo.name = orzeus and never touches Codex's stored login.",
  },
};

/** Minimal environment for the CLI: enough for it to find itself and its own login. */
function baseEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "USER", "SHELL", "CODEX_HOME"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

interface Breakdown {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

function toUsage(b: Breakdown): TokenUsage {
  return {
    inputTokens: Math.max(0, b.inputTokens - b.cachedInputTokens),
    outputTokens: b.outputTokens,
    cacheReadTokens: b.cachedInputTokens,
    cacheWriteTokens: b.cacheWriteInputTokens ?? 0,
    reasoningTokens: b.reasoningOutputTokens,
  };
}

function diffUsage(now: TokenUsage, before: TokenUsage): TokenUsage {
  return {
    inputTokens: Math.max(0, now.inputTokens - before.inputTokens),
    outputTokens: Math.max(0, now.outputTokens - before.outputTokens),
    cacheReadTokens: Math.max(0, now.cacheReadTokens - before.cacheReadTokens),
    cacheWriteTokens: Math.max(0, now.cacheWriteTokens - before.cacheWriteTokens),
    reasoningTokens: Math.max(0, now.reasoningTokens - before.reasoningTokens),
  };
}

interface RateWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

function windowName(mins: number | null, fallback: string): string {
  if (mins === null || mins <= 0) return fallback;
  if (mins % 1_440 === 0) return `${mins / 1_440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

export function toQuotaWindows(
  accountId: AccountId,
  snapshot: { primary: RateWindow | null; secondary: RateWindow | null },
  now: number,
): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  for (const [slot, window] of [
    ["primary", snapshot.primary],
    ["secondary", snapshot.secondary],
  ] as const) {
    if (window === null) continue;
    windows.push({
      accountId,
      window: windowName(window.windowDurationMins, slot),
      usedPercent: Math.min(100, Math.max(0, window.usedPercent)),
      resetsAt: window.resetsAt === null ? null : window.resetsAt * 1000,
      status: window.usedPercent >= 100 ? "limited" : window.usedPercent >= 80 ? "warning" : "ok",
      source: "official_api",
      observedAt: now,
    });
  }
  return windows;
}

function approvalDecision(decision: ApprovalDecision): "accept" | "acceptForSession" | "decline" {
  if (decision.kind === "allow_once") return "accept";
  if (decision.kind === "allow_for_node") return "acceptForSession";
  return "decline";
}

/**
 * Worker adapter over `codex app-server` (JSON-RPC threads, turns and approvals). Threads start
 * in the node's worktree with the workspace-write sandbox; anything beyond that comes back to
 * Orzeus as an approval request, which the engine's policy answers.
 */
export class CodexAppServerAdapter implements ProviderAdapter {
  readonly manifest: AdapterManifest = CODEX_APP_SERVER_MANIFEST;
  readonly #config: CodexAppServerConfig;

  constructor(config: CodexAppServerConfig) {
    this.#config = config;
  }

  #spawn(cwd: string, account: AccountContext): Promise<CodexRpc> {
    return (async () => {
      const extra: Record<string, string> = { ...this.#config.env };
      if (account.auth.kind === "api_key")
        extra[account.auth.envVar] = await account.getSecret(account.auth.secretName);
      return new CodexRpc(this.#config.command ?? ["codex", "app-server"], {
        cwd,
        env: baseEnv(extra),
      });
    })();
  }

  async #initialize(rpc: CodexRpc): Promise<{ userAgent: string }> {
    const result = await rpc.request<{ userAgent: string }>("initialize", {
      clientInfo: { name: "orzeus", title: "Orzeus", version: this.#config.clientVersion },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    rpc.notify("initialized");
    return result;
  }

  async probe(account: AccountContext, signal: AbortSignal): Promise<ProbeResult> {
    let rpc: CodexRpc | undefined;
    try {
      rpc = await this.#spawn(process.cwd(), account);
      const kill = () => rpc?.kill();
      signal.addEventListener("abort", kill, { once: true });
      const init = await this.#initialize(rpc);
      const account_ = await rpc.request<{
        account: { type: string } | null;
        requiresOpenaiAuth: boolean;
      }>("account/read", {});
      if (account_.account === null && account_.requiresOpenaiAuth) {
        return {
          ok: false,
          reason: "unauthenticated",
          detail: "Run `codex login` in a terminal first.",
        };
      }
      return {
        ok: true,
        version: init.userAgent,
        detail: `signed in (${account_.account?.type ?? "unknown"})`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        reason: /ENOENT/.test(message) ? "not_installed" : "unreachable",
        detail: message,
      };
    } finally {
      rpc?.kill();
    }
  }

  async listModels(account: AccountContext): Promise<readonly ModelInfo[]> {
    const rpc = await this.#spawn(process.cwd(), account);
    try {
      await this.#initialize(rpc);
      const result = await rpc.request<{ data?: { model?: string; id?: string }[] }>(
        "model/list",
        {},
      );
      return (result.data ?? []).map((m) => ({
        model: m.model ?? m.id ?? "unknown",
        suggestedTier: "worker",
        contextWindow: null,
        pricing: null,
      }));
    } finally {
      rpc.kill();
    }
  }

  async readQuota(account: AccountContext): Promise<readonly QuotaWindow[]> {
    const rpc = await this.#spawn(process.cwd(), account);
    try {
      await this.#initialize(rpc);
      const result = await rpc.request<{
        rateLimits: { primary: RateWindow | null; secondary: RateWindow | null };
      }>("account/rateLimits/read", {});
      return toQuotaWindows(account.accountId, result.rateLimits, Date.now());
    } finally {
      rpc.kill();
    }
  }

  /**
   * One-shot structured output (planning, review): an ephemeral, read-only thread in an empty
   * temporary directory, with the turn's outputSchema set, so Codex cannot touch any repository.
   */
  async generate<T>(
    request: GenerateRequest<T>,
    account: AccountContext,
    signal: AbortSignal,
  ): Promise<GenerateResult<T>> {
    const started = Date.now();
    const dir = await mkdtemp(join(tmpdir(), "orzeus-codex-generate-"));
    const rpc = await this.#spawn(dir, account);
    const abort = () => rpc.kill();
    signal.addEventListener("abort", abort, { once: true });
    try {
      let usage: TokenUsage = ZERO_USAGE;
      const messages: string[] = [];
      const quota: QuotaWindow[] = [];
      const done = new Promise<{ status: string; error: string | null }>((resolve, reject) => {
        void rpc.exited.then((code) =>
          reject(new Error(`codex app-server exited with code ${code}`)),
        );
        rpc.onNotification((method, params) => {
          const p = params as Record<string, unknown>;
          if (method === "item/completed") {
            const item = p["item"] as Record<string, unknown> | undefined;
            if (item?.["type"] === "agentMessage") messages.push(String(item["text"] ?? ""));
          } else if (method === "thread/tokenUsage/updated") {
            usage = toUsage((p["tokenUsage"] as { total: Breakdown }).total);
          } else if (method === "account/rateLimits/updated") {
            const limits = p["rateLimits"] as
              | { primary: RateWindow | null; secondary: RateWindow | null }
              | undefined;
            if (limits)
              quota.splice(
                0,
                quota.length,
                ...toQuotaWindows(account.accountId, limits, Date.now()),
              );
          } else if (method === "turn/completed") {
            const turn = p["turn"] as { status: string; error: { message: string } | null };
            resolve({ status: turn.status, error: turn.error?.message ?? null });
          }
        });
      });
      await this.#initialize(rpc);
      const thread = await rpc.request<{ thread: { id: string } }>("thread/start", {
        cwd: dir,
        model: request.model,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        developerInstructions: request.system,
        serviceName: "orzeus",
      });
      await rpc.request("turn/start", {
        threadId: thread.thread.id,
        input: [{ type: "text", text: request.prompt, text_elements: [] }],
        outputSchema: toStrictJsonSchema(request.output.jsonSchema),
      });
      const result = await done;
      const text = messages.at(-1) ?? "";
      if (result.status !== "completed")
        throw new StructuredOutputError(
          `${request.output.name}: turn ${result.status}: ${result.error ?? ""}`,
          text,
        );
      return {
        value: parseJsonOutput(text, request.output),
        usage,
        costMicroUsd: null,
        quota,
        latencyMs: Date.now() - started,
      };
    } finally {
      signal.removeEventListener("abort", abort);
      rpc.kill();
      await rm(dir, { recursive: true, force: true });
    }
  }

  startSession(request: SessionRequest, account: AccountContext) {
    const controller = new SessionController();
    let rpc: CodexRpc | undefined;
    let threadId: string | null = null;
    let turnId: string | null = null;
    let lastTotal: TokenUsage | null = null;
    const summary: string[] = [];

    const fail = (error: unknown) =>
      controller.finish({
        status: "failed",
        summary: error instanceof Error ? error.message : String(error),
        costMicroUsd: null,
        resume: threadId === null ? null : { adapter: this.manifest.id, value: threadId },
        errorClass: "provider.app_server_error",
      });

    const run = async () => {
      rpc = await this.#spawn(request.worktree.path, account);
      const r = rpc;
      void r.exited.then((code) => {
        if (!controller.finished)
          fail(
            new Error(
              `codex app-server exited with code ${code}: ${r.stderr.join("").slice(-500)}`,
            ),
          );
      });

      r.onNotification((method, params) => {
        const p = params as Record<string, unknown>;
        switch (method) {
          case "item/agentMessage/delta":
            controller.emit({ type: "message_delta", text: String(p["delta"] ?? "") });
            break;
          case "item/started":
          case "item/completed": {
            const item = p["item"] as Record<string, unknown> | undefined;
            if (item === undefined) break;
            const id = String(item["id"] ?? "");
            if (item["type"] === "commandExecution") {
              if (method === "item/started")
                controller.emit({
                  type: "tool_call",
                  callId: id,
                  tool: "shell",
                  input: { command: item["command"] },
                });
              else
                controller.emit({
                  type: "tool_result",
                  callId: id,
                  isError: item["exitCode"] !== 0,
                  output: item["aggregatedOutput"] ?? null,
                });
            } else if (item["type"] === "fileChange" && method === "item/completed") {
              for (const change of (item["changes"] as
                | { path: string; kind: { type: string } }[]
                | undefined) ?? []) {
                const kind = change.kind.type;
                controller.emit({
                  type: "file_change",
                  path: change.path,
                  change: kind === "add" ? "add" : kind === "delete" ? "delete" : "modify",
                });
              }
            } else if (item["type"] === "mcpToolCall") {
              if (method === "item/started")
                controller.emit({
                  type: "tool_call",
                  callId: id,
                  tool: `${item["server"]}/${item["tool"]}`,
                  input: item["arguments"],
                });
              else
                controller.emit({
                  type: "tool_result",
                  callId: id,
                  isError: item["error"] !== null,
                  output: item["result"] ?? item["error"],
                });
            } else if (item["type"] === "agentMessage" && method === "item/completed") {
              summary.push(String(item["text"] ?? ""));
            }
            break;
          }
          case "thread/tokenUsage/updated": {
            const total = toUsage((p["tokenUsage"] as { total: Breakdown }).total);
            controller.emit({
              type: "usage",
              usage: lastTotal === null ? total : diffUsage(total, lastTotal),
              costMicroUsd: null,
            });
            lastTotal = total;
            break;
          }
          case "account/rateLimits/updated": {
            const limits = p["rateLimits"] as
              | { primary: RateWindow | null; secondary: RateWindow | null }
              | undefined;
            if (limits)
              controller.emit({
                type: "quota",
                windows: toQuotaWindows(account.accountId, limits, Date.now()),
              });
            break;
          }
          case "error":
            controller.emit({
              type: "log",
              level: "warn",
              message: JSON.stringify((p["error"] as { message?: string })?.message ?? p),
            });
            break;
          case "turn/completed": {
            const turn = p["turn"] as { status: string; error: { message: string } | null };
            const resume =
              threadId === null ? null : { adapter: this.manifest.id, value: threadId };
            const text = summary.at(-1)?.trim() || "Codex finished the turn.";
            if (turn.status === "completed")
              controller.finish({
                status: "completed",
                summary: text,
                costMicroUsd: null,
                resume,
                errorClass: null,
              });
            else if (turn.status === "interrupted")
              controller.finish({
                status: "cancelled",
                summary: "Interrupted.",
                costMicroUsd: null,
                resume,
                errorClass: null,
              });
            else
              controller.finish({
                status: "failed",
                summary: turn.error?.message ?? "Turn failed.",
                costMicroUsd: null,
                resume,
                errorClass: "provider.turn_failed",
              });
            r.kill();
            break;
          }
          default:
            break;
        }
      });

      r.onRequest(async (method, params) => {
        const p = params as Record<string, unknown>;
        const id = String(p["approvalId"] ?? p["itemId"] ?? method);
        switch (method) {
          case "item/commandExecution/requestApproval": {
            const command = String(p["command"] ?? "");
            const decision = await controller.requestApproval(id, {
              kind: "shell",
              argv: command === "" ? ["(unknown)"] : shellWords(command),
              cwd: String(p["cwd"] ?? "."),
            });
            if (decision.kind === "steer") await this.#steer(r, threadId, turnId, decision.message);
            return { decision: approvalDecision(decision) };
          }
          case "item/fileChange/requestApproval": {
            const decision = await controller.requestApproval(id, {
              kind: "file_write",
              path: String(p["grantRoot"] ?? "/"),
            });
            return { decision: approvalDecision(decision) };
          }
          case "item/tool/requestUserInput":
          case "mcpServer/elicitation/request":
            controller.emit({ type: "ambiguity", question: JSON.stringify(p).slice(0, 2_000) });
            throw new Error(
              "Orzeus workers cannot ask for interactive input; report ambiguity instead.",
            );
          default:
            throw new Error(`${method} is not supported by Orzeus`);
        }
      });

      await this.#initialize(r);
      const thread = await (request.resume === null
        ? r.request<{ thread: { id: string } }>("thread/start", {
            cwd: request.worktree.path,
            model: request.model,
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
            serviceName: "orzeus",
          })
        : r.request<{ thread: { id: string } }>("thread/resume", {
            threadId: request.resume.value,
            cwd: request.worktree.path,
          }));
      threadId = thread.thread.id;
      const turn = await r.request<{ turn: { id: string } }>("turn/start", {
        threadId,
        input: [{ type: "text", text: request.prompt, text_elements: [] }],
      });
      turnId = turn.turn.id;
    };

    run().catch((error: unknown) => {
      if (!controller.finished) fail(error);
      rpc?.kill();
    });

    return controller.session({
      onSteer: async (message) => {
        if (rpc) await this.#steer(rpc, threadId, turnId, message);
      },
      onCancel: async (reason) => {
        if (rpc && threadId !== null && turnId !== null) {
          await Promise.race([
            rpc.request("turn/interrupt", { threadId, turnId }).catch(() => undefined),
            new Promise((r) => setTimeout(r, 1_000)),
          ]);
        }
        rpc?.kill();
        controller.finish({
          status: "cancelled",
          summary: `Cancelled: ${reason}`,
          costMicroUsd: null,
          resume: threadId === null ? null : { adapter: this.manifest.id, value: threadId },
          errorClass: null,
        });
      },
    });
  }

  async #steer(
    rpc: CodexRpc,
    threadId: string | null,
    turnId: string | null,
    message: string,
  ): Promise<void> {
    if (threadId === null || turnId === null) return;
    await rpc.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text: message, text_elements: [] }],
    });
  }
}

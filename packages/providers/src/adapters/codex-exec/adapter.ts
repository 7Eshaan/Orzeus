import type { TokenUsage } from "@orzeus/schema";
import type {
  AccountContext,
  AdapterManifest,
  ModelInfo,
  ProbeResult,
  ProviderAdapter,
  SessionRequest,
} from "../../adapter.js";
import { cliEnv, JsonlProcess, runOnce } from "../../jsonl-process.js";
import { insideWorktree } from "../../paths.js";
import { SessionController } from "../../session.js";

export const CODEX_EXEC_MANIFEST: AdapterManifest = {
  id: "codex-exec",
  provider: "openai",
  displayName: "Codex (exec)",
  transport: "cli_jsonl",
  auth: [
    { kind: "own_cli_login", binary: "codex" },
    { kind: "api_key", secretName: "openai", envVar: "CODEX_API_KEY" },
  ],
  capabilities: {
    structuredOutput: false,
    agentSession: true,
    mcpClient: false,
    resume: true,
    steerMidTurn: false,
    approvalCallbacks: false,
    reportsUsage: "exact",
    reportsQuota: false,
  },
  compliance: {
    officialInterface: "https://learn.chatgpt.com/docs/non-interactive-mode",
    readsForeignCredentials: false,
    rotatesAccounts: false,
    spoofsClient: false,
    notes:
      "Runs the user's own codex CLI non-interactively. Writes are confined by Codex's workspace-write sandbox to the node's worktree and checked afterwards by Orzeus's scope guard; there are no per-action approvals in exec mode.",
  },
};

export interface CodexExecConfig {
  /** How to run codex; default ["codex"]. Tests point this at a fake. */
  readonly command?: readonly [string, ...string[]];
  /** Called with each started process id (tests check that cancelled sessions leave none). */
  readonly onSpawn?: (pid: number | undefined) => void;
}

function toUsage(raw: Record<string, unknown> | undefined): TokenUsage {
  const n = (k: string) => (typeof raw?.[k] === "number" ? (raw[k] as number) : 0);
  const cached = n("cached_input_tokens");
  return {
    inputTokens: Math.max(0, n("input_tokens") - cached),
    outputTokens: n("output_tokens"),
    cacheReadTokens: cached,
    cacheWriteTokens: n("cache_write_input_tokens"),
    reasoningTokens: n("reasoning_output_tokens"),
  };
}

/**
 * One-shot worker over `codex exec --json` (docs: non-interactive mode; event types from
 * codex-rs/exec/src/exec_events.rs). Simpler than the app-server adapter: no steering and no
 * approvals, so it suits small, well-scoped nodes.
 */
export class CodexExecAdapter implements ProviderAdapter {
  readonly manifest: AdapterManifest = CODEX_EXEC_MANIFEST;
  readonly #command: readonly [string, ...string[]];
  readonly #onSpawn: (pid: number | undefined) => void;

  constructor(config: CodexExecConfig = {}) {
    this.#command = config.command ?? ["codex"];
    this.#onSpawn = config.onSpawn ?? (() => undefined);
  }

  async #env(account: AccountContext): Promise<Record<string, string>> {
    return cliEnv(
      ["CODEX_HOME"],
      account.auth.kind === "api_key"
        ? { CODEX_API_KEY: await account.getSecret(account.auth.secretName) }
        : {},
    );
  }

  async probe(account: AccountContext, signal: AbortSignal): Promise<ProbeResult> {
    const result = await runOnce([...this.#command, "--version"], await this.#env(account), signal);
    if (result.missing) return { ok: false, reason: "not_installed", detail: result.stderr };
    if (result.code !== 0)
      return { ok: false, reason: "unreachable", detail: result.stderr.slice(0, 300) };
    return { ok: true, version: result.stdout.trim(), detail: "codex exec available" };
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return []; // the app-server adapter lists models for the same login
  }

  startSession(request: SessionRequest, account: AccountContext) {
    const controller = new SessionController();
    let threadId: string | null = request.resume?.value ?? null;
    let lastMessage = "";
    let failure: string | null = null;
    let child: JsonlProcess | null = null;
    const resume = () =>
      threadId === null ? null : { adapter: this.manifest.id, value: threadId };

    const onEvent = (event: Record<string, unknown>) => {
      const item = event["item"] as Record<string, unknown> | undefined;
      switch (event["type"]) {
        case "thread.started":
          threadId = String(event["thread_id"] ?? threadId ?? "");
          break;
        case "item.started":
          if (item?.["type"] === "command_execution")
            controller.emit({
              type: "tool_call",
              callId: String(item["id"]),
              tool: "shell",
              input: { command: item["command"] },
            });
          else if (item?.["type"] === "mcp_tool_call")
            controller.emit({
              type: "tool_call",
              callId: String(item["id"]),
              tool: `${item["server"]}/${item["tool"]}`,
              input: item["arguments"] ?? null,
            });
          break;
        case "item.completed":
          if (item === undefined) break;
          switch (item["type"]) {
            case "agent_message":
              lastMessage = String(item["text"] ?? "");
              controller.emit({ type: "message_delta", text: lastMessage });
              break;
            case "command_execution":
              controller.emit({
                type: "tool_result",
                callId: String(item["id"]),
                isError: item["status"] !== "completed" || (item["exit_code"] ?? 0) !== 0,
                output: item["aggregated_output"] ?? null,
              });
              break;
            case "mcp_tool_call":
              controller.emit({
                type: "tool_result",
                callId: String(item["id"]),
                isError: item["status"] === "failed",
                output: item["result"] ?? item["error"] ?? null,
              });
              break;
            case "file_change":
              if (item["status"] !== "completed") break;
              for (const change of (item["changes"] as { path: string; kind: string }[]) ?? []) {
                const path = insideWorktree(request.worktree.path, change.path) ?? change.path;
                controller.emit({
                  type: "file_change",
                  path,
                  change:
                    change.kind === "add" ? "add" : change.kind === "delete" ? "delete" : "modify",
                });
              }
              break;
            case "error":
              controller.emit({ type: "log", level: "warn", message: String(item["message"]) });
              break;
            default:
              break;
          }
          break;
        case "turn.completed":
          controller.emit({
            type: "usage",
            usage: toUsage(event["usage"] as Record<string, unknown> | undefined),
            costMicroUsd: null,
          });
          break;
        case "turn.failed":
          failure = String((event["error"] as { message?: string } | undefined)?.message ?? "");
          break;
        case "error":
          controller.emit({ type: "log", level: "warn", message: String(event["message"] ?? "") });
          break;
        default:
          controller.emit({ type: "log", level: "debug", message: JSON.stringify(event) });
          break;
      }
    };

    const run = async () => {
      const common = [
        "--json",
        "--sandbox",
        "workspace-write",
        "-C",
        request.worktree.path,
        "-c",
        'approval_policy="never"',
        "-m",
        request.model,
      ];
      const args =
        request.resume === null
          ? [...this.#command, "exec", ...common, "-"]
          : [...this.#command, "exec", "resume", request.resume.value, ...common, "-"];
      child = new JsonlProcess(args as [string, ...string[]], {
        cwd: request.worktree.path,
        env: await this.#env(account),
        stdin: request.prompt,
        onEvent,
        onText: (line) => controller.emit({ type: "log", level: "debug", message: line }),
      });
      this.#onSpawn(child.pid);
      const code = await child.exited;
      if (controller.finished) return;
      if (failure !== null || code !== 0)
        controller.finish({
          status: "failed",
          summary: failure || `codex exec exited with code ${code}: ${child.stderrTail()}`,
          costMicroUsd: null,
          resume: resume(),
          errorClass: "provider.turn_failed",
        });
      else
        controller.finish({
          status: "completed",
          summary: lastMessage.trim() || "Codex finished.",
          costMicroUsd: null,
          resume: resume(),
          errorClass: null,
        });
    };

    run().catch((error: unknown) => {
      if (!controller.finished)
        controller.finish({
          status: "failed",
          summary: error instanceof Error ? error.message : String(error),
          costMicroUsd: null,
          resume: resume(),
          errorClass: "provider.cli_error",
        });
    });

    return controller.session({
      onSteer: async () => {
        controller.emit({
          type: "log",
          level: "info",
          message: "codex exec cannot be steered mid-turn; the note applies to the next attempt.",
        });
      },
      onCancel: async (reason) => {
        (child as JsonlProcess | null)?.kill();
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

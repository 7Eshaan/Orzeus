import { ZERO_USAGE } from "@orzeus/schema";
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
import { estimateTokens } from "../../quota.js";
import { SessionController } from "../../session.js";

export const CURSOR_CLI_MANIFEST: AdapterManifest = {
  id: "cursor-cli",
  provider: "cursor",
  displayName: "Cursor CLI",
  transport: "cli_stream_json",
  auth: [
    { kind: "own_cli_login", binary: "cursor-agent" },
    { kind: "api_key", secretName: "cursor", envVar: "CURSOR_API_KEY" },
  ],
  capabilities: {
    structuredOutput: false,
    agentSession: true,
    mcpClient: false,
    resume: true,
    steerMidTurn: false,
    approvalCallbacks: false,
    reportsUsage: "estimated",
    reportsQuota: false,
  },
  compliance: {
    officialInterface: "https://cursor.com/docs/cli/reference/output-format",
    readsForeignCredentials: false,
    rotatesAccounts: false,
    spoofsClient: false,
    notes:
      "Runs the user's own cursor-agent in print mode inside the node's worktree, with Cursor's sandbox on. Print mode has no approval callbacks, so commands run under --force and Orzeus's scope guard checks the result. Cursor reports no token usage; Orzeus estimates it from text length and labels it as an estimate.",
  },
};

export interface CursorCliConfig {
  /** How to run the CLI; default ["cursor-agent"]. Tests point this at a fake. */
  readonly command?: readonly [string, ...string[]];
  readonly onSpawn?: (pid: number | undefined) => void;
}

type ToolCall = Record<string, { args?: Record<string, unknown>; result?: unknown } | undefined>;

/** The tool key ("writeToolCall", "shellToolCall", ...) and its body. */
function toolOf(call: ToolCall | undefined): {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
} {
  const [key, body] = Object.entries(call ?? {})[0] ?? ["unknown", undefined];
  if (key === "function") {
    const fn = body as { name?: string; arguments?: unknown } | undefined;
    return { name: fn?.name ?? "function", args: { arguments: fn?.arguments }, result: undefined };
  }
  return { name: key.replace(/ToolCall$/, ""), args: body?.args ?? {}, result: body?.result };
}

/**
 * Worker adapter over `cursor-agent -p --output-format stream-json` (Cursor's documented headless
 * mode). Tool names are documented for read and write; others are mapped leniently.
 */
export class CursorCliAdapter implements ProviderAdapter {
  readonly manifest: AdapterManifest = CURSOR_CLI_MANIFEST;
  readonly #command: readonly [string, ...string[]];
  readonly #onSpawn: (pid: number | undefined) => void;

  constructor(config: CursorCliConfig = {}) {
    this.#command = config.command ?? ["cursor-agent"];
    this.#onSpawn = config.onSpawn ?? (() => undefined);
  }

  async #env(account: AccountContext): Promise<Record<string, string>> {
    return cliEnv(
      [],
      account.auth.kind === "api_key"
        ? { CURSOR_API_KEY: await account.getSecret(account.auth.secretName) }
        : {},
    );
  }

  async probe(account: AccountContext, signal: AbortSignal): Promise<ProbeResult> {
    const env = await this.#env(account);
    const version = await runOnce([...this.#command, "--version"], env, signal);
    if (version.missing) return { ok: false, reason: "not_installed", detail: version.stderr };
    if (version.code !== 0)
      return { ok: false, reason: "unreachable", detail: version.stderr.slice(0, 300) };
    const status = await runOnce([...this.#command, "status", "--format", "json"], env, signal);
    if (status.code !== 0)
      return { ok: false, reason: "unauthenticated", detail: status.stderr.slice(0, 300) };
    return { ok: true, version: version.stdout.trim(), detail: "cursor-agent signed in" };
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return [];
  }

  startSession(request: SessionRequest, account: AccountContext) {
    const controller = new SessionController();
    let chatId: string | null = request.resume?.value ?? null;
    let child: JsonlProcess | null = null;
    let output = "";
    let result: { ok: boolean; text: string } | null = null;
    const resume = () => (chatId === null ? null : { adapter: this.manifest.id, value: chatId });

    const onEvent = (event: Record<string, unknown>) => {
      if (typeof event["session_id"] === "string") chatId = event["session_id"];
      switch (event["type"]) {
        case "assistant": {
          const content = (event["message"] as { content?: { type: string; text?: string }[] })
            ?.content;
          const text = (content ?? [])
            .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
            .join("");
          if (text !== "") {
            output += text;
            controller.emit({ type: "message_delta", text });
          }
          break;
        }
        case "tool_call": {
          const callId = String(event["call_id"] ?? "");
          const tool = toolOf(event["tool_call"] as ToolCall | undefined);
          if (event["subtype"] === "started") {
            controller.emit({ type: "tool_call", callId, tool: tool.name, input: tool.args });
            break;
          }
          const failed =
            tool.result !== undefined &&
            typeof tool.result === "object" &&
            tool.result !== null &&
            !("success" in tool.result);
          output += JSON.stringify(tool.result ?? "").slice(0, 2_000);
          controller.emit({
            type: "tool_result",
            callId,
            isError: failed,
            output: tool.result ?? null,
          });
          const path = typeof tool.args["path"] === "string" ? tool.args["path"] : null;
          if (!failed && path !== null && ["write", "edit", "delete"].includes(tool.name)) {
            controller.emit({
              type: "file_change",
              path: insideWorktree(request.worktree.path, path) ?? path,
              change: tool.name === "delete" ? "delete" : tool.name === "write" ? "add" : "modify",
            });
          }
          break;
        }
        case "result":
          result = {
            ok: event["is_error"] !== true && event["subtype"] === "success",
            text: String(event["result"] ?? ""),
          };
          break;
        default:
          break;
      }
    };

    const run = async () => {
      const args = [
        ...this.#command,
        "-p",
        "--output-format",
        "stream-json",
        "--force",
        "--trust",
        "--sandbox",
        "enabled",
        "--workspace",
        request.worktree.path,
        "--model",
        request.model,
        ...(request.resume === null ? [] : ["--resume", request.resume.value]),
        request.prompt,
      ] as [string, ...string[]];
      child = new JsonlProcess(args, {
        cwd: request.worktree.path,
        env: await this.#env(account),
        onEvent,
        onText: (line) => controller.emit({ type: "log", level: "debug", message: line }),
      });
      this.#onSpawn(child.pid);
      const code = await child.exited;
      if (controller.finished) return;
      // Cursor reports no token usage: estimate it, and say so.
      controller.emit({
        type: "usage",
        usage: {
          ...ZERO_USAGE,
          inputTokens: estimateTokens(request.prompt),
          outputTokens: estimateTokens(output),
        },
        costMicroUsd: null,
      });
      const done = result as { ok: boolean; text: string } | null;
      if (done?.ok && code === 0)
        controller.finish({
          status: "completed",
          summary: done.text.trim() || "Cursor finished.",
          costMicroUsd: null,
          resume: resume(),
          errorClass: null,
        });
      else
        controller.finish({
          status: "failed",
          summary: done?.text || `cursor-agent exited with code ${code}: ${child.stderrTail()}`,
          costMicroUsd: null,
          resume: resume(),
          errorClass: "provider.cli_error",
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
          message: "cursor-agent cannot be steered mid-turn; the note applies to the next attempt.",
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

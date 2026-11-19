import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  client as acpClient,
  type ClientContext,
  type McpServer,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import { type ProposedAction, ZERO_USAGE } from "@orzeus/schema";
import type {
  AccountContext,
  AdapterManifest,
  ModelInfo,
  ProbeResult,
  ProviderAdapter,
  SessionRequest,
} from "../../adapter.js";
import { cliEnv } from "../../jsonl-process.js";
import { hostOf, insideWorktree, safeWorktreePath } from "../../paths.js";
import { estimateTokens } from "../../quota.js";
import { SessionController } from "../../session.js";
import { shellWords } from "../../shell-words.js";

export interface AcpConfig {
  /** How to start the agent, e.g. ["gemini", "--experimental-acp"] or an ACP bridge. */
  readonly command: readonly [string, ...string[]];
  /** Adapter id when more than one ACP agent is configured; default "acp". */
  readonly id?: string;
  readonly displayName?: string;
  /** Extra environment for the agent (its own API key, if it needs one). */
  readonly env?: Readonly<Record<string, string>>;
  readonly clientVersion: string;
  readonly onSpawn?: (pid: number | undefined) => void;
}

export function acpManifest(id = "acp", displayName = "ACP agent"): AdapterManifest {
  return {
    id,
    provider: "acp",
    displayName,
    transport: "acp_stdio",
    auth: [{ kind: "none" }],
    capabilities: {
      structuredOutput: false,
      agentSession: true,
      mcpClient: true,
      resume: true,
      steerMidTurn: false,
      approvalCallbacks: true,
      reportsUsage: "estimated",
      reportsQuota: false,
    },
    compliance: {
      officialInterface: "https://agentclientprotocol.com/protocol/v1/overview",
      readsForeignCredentials: false,
      rotatesAccounts: false,
      spoofsClient: false,
      notes:
        "Any agent that speaks the Agent Client Protocol v1 over stdio. Orzeus is the client: it serves file reads and writes inside the node's worktree only, answers permission requests with its policy, and offers no terminal. Token usage is estimated unless the agent reports cost.",
    },
  };
}

/** What a permission request would do, from the tool call's kind, locations and raw input. */
export function acpAction(call: ToolCallUpdate, worktree: string): ProposedAction | null | string {
  const raw = (call.rawInput ?? {}) as Record<string, unknown>;
  const location =
    call.locations?.[0]?.path ??
    (raw["path"] as string | undefined) ??
    (raw["file_path"] as string | undefined);
  const inside = (path: string | undefined) =>
    path === undefined ? null : insideWorktree(worktree, path);
  switch (call.kind) {
    case "read":
    case "search":
    case "think":
      return location === undefined || inside(location) !== null
        ? null
        : `${location} is outside the repository.`;
    case "edit":
    case "move": {
      const rel = inside(location);
      return rel === null
        ? `${location ?? "that file"} is outside the repository.`
        : { kind: "file_write", path: rel };
    }
    case "delete": {
      const rel = inside(location);
      return rel === null
        ? `${location ?? "that file"} is outside the repository.`
        : { kind: "file_delete", path: rel };
    }
    case "execute": {
      const command = String(raw["command"] ?? call.title ?? "");
      return {
        kind: "shell",
        argv: command === "" ? ["(unknown)"] : shellWords(command),
        cwd: ".",
      };
    }
    case "fetch":
      return { kind: "network", host: hostOf(String(raw["url"] ?? call.title ?? "")) };
    default:
      return `${call.title ?? "That tool"} is not available to Orzeus workers.`;
  }
}

/**
 * Worker adapter for any Agent Client Protocol v1 agent. Orzeus plays the editor: it gives the
 * agent the worktree as its workspace, serves reads and writes, and decides permissions.
 */
export class AcpAdapter implements ProviderAdapter {
  readonly manifest: AdapterManifest;
  readonly #config: AcpConfig;

  constructor(config: AcpConfig) {
    this.#config = config;
    this.manifest = acpManifest(config.id, config.displayName);
  }

  #spawn(cwd: string) {
    const [program, ...args] = this.#config.command;
    const child = spawn(program, args, {
      cwd,
      env: cliEnv([], { ...this.#config.env }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => undefined);
    const stderr: string[] = [];
    child.stderr.setEncoding("utf8").on("data", (c: string) => {
      stderr.push(c);
      if (stderr.length > 200) stderr.shift();
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on("close", (code) => resolve(code));
      child.on("error", (error) => {
        stderr.push(error.message);
        resolve(null);
      });
    });
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const kill = () => {
      const alive = () => child.exitCode === null && child.signalCode === null;
      if (alive()) child.kill("SIGTERM");
      setTimeout(() => {
        if (alive()) child.kill("SIGKILL");
      }, 1_000).unref();
    };
    return { child, stream, exited, kill, stderr };
  }

  #initialize(ctx: ClientContext) {
    return ctx.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: "orzeus", version: this.#config.clientVersion },
    });
  }

  /** Starts the agent and runs initialize: no prompt, so no tokens. */
  async probe(_account: AccountContext, signal: AbortSignal): Promise<ProbeResult> {
    const proc = this.#spawn(process.cwd());
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    try {
      const init = await Promise.race([
        acpClient({ name: "orzeus" }).connectWith(proc.stream, (ctx) => this.#initialize(ctx)),
        proc.exited.then((code) => {
          throw new Error(`agent exited (${code}): ${proc.stderr.join("").slice(-300)}`);
        }),
        new Promise<never>((_, reject) =>
          timeout.addEventListener("abort", () => reject(new Error("no answer to initialize"))),
        ),
      ]);
      if (init.protocolVersion !== PROTOCOL_VERSION)
        return {
          ok: false,
          reason: "incompatible_version",
          detail: `agent speaks ACP ${init.protocolVersion}, Orzeus speaks ${PROTOCOL_VERSION}`,
        };
      const info = init.agentInfo;
      return {
        ok: true,
        version: info ? `${info.name} ${info.version}` : `ACP ${init.protocolVersion}`,
        detail: init.agentCapabilities?.loadSession ? "can resume sessions" : "no session resume",
      };
    } catch (error) {
      const missing = (error as Error).message.includes("ENOENT");
      return {
        ok: false,
        reason: missing ? "not_installed" : "unreachable",
        detail: (error as Error).message,
      };
    } finally {
      proc.kill();
    }
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return []; // ACP agents choose their own model
  }

  startSession(request: SessionRequest, _account: AccountContext) {
    const controller = new SessionController();
    const worktree = request.worktree.path;
    const proc = this.#spawn(worktree);
    this.#config.onSpawn?.(proc.child.pid);
    let sessionId: string | null = request.resume?.value ?? null;
    let context: ClientContext | null = null;
    let text = "";
    let lastMessage = "";
    let costMicroUsd: number | null = null;
    /** Paths a permission request already approved, so the write that follows is not asked again. */
    const approved = new Set<string>();
    const resume = () =>
      sessionId === null ? null : { adapter: this.manifest.id, value: sessionId };

    const onUpdate = (n: SessionNotification) => {
      const u = n.update;
      switch (u.sessionUpdate) {
        case "agent_message_chunk":
          if (u.content.type === "text") {
            text += u.content.text;
            lastMessage += u.content.text;
            controller.emit({ type: "message_delta", text: u.content.text });
          }
          break;
        case "tool_call":
          lastMessage = "";
          controller.emit({
            type: "tool_call",
            callId: u.toolCallId,
            tool: u.kind ? `${u.kind}: ${u.title}` : u.title,
            input: u.rawInput ?? null,
          });
          break;
        case "tool_call_update":
          if (u.status === "completed" || u.status === "failed") {
            text += JSON.stringify(u.rawOutput ?? "").slice(0, 2_000);
            controller.emit({
              type: "tool_result",
              callId: u.toolCallId,
              isError: u.status === "failed",
              output: u.rawOutput ?? u.content ?? null,
            });
          }
          break;
        case "usage_update":
          if (u.cost && u.cost.currency.toUpperCase() === "USD")
            costMicroUsd = Math.round(u.cost.amount * 1_000_000);
          break;
        default:
          break;
      }
    };

    const permission = async (
      params: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> => {
      const pick = (kinds: string[]) =>
        params.options.find((o) => kinds.includes(o.kind))?.optionId ?? null;
      const allow = pick(["allow_once", "allow_always"]);
      const reject = pick(["reject_once", "reject_always"]);
      const answer = (ok: boolean): RequestPermissionResponse => {
        const id = ok ? allow : reject;
        return id === null
          ? { outcome: { outcome: "cancelled" } }
          : { outcome: { outcome: "selected", optionId: id } };
      };
      const action = acpAction(params.toolCall, worktree);
      if (action === null) return answer(true);
      if (typeof action === "string") return answer(false);
      const decision = await controller.requestApproval(params.toolCall.toolCallId, action);
      const ok = decision.kind === "allow_once" || decision.kind === "allow_for_node";
      if (ok && (action.kind === "file_write" || action.kind === "file_delete"))
        approved.add(action.path);
      if (decision.kind === "steer")
        controller.emit({
          type: "log",
          level: "info",
          message: `Steer (next attempt): ${decision.message}`,
        });
      return answer(ok);
    };

    const app = acpClient({ name: "orzeus" })
      .onRequest(methods.client.session.requestPermission, ({ params }) => permission(params))
      .onNotification(methods.client.session.update, ({ params }) => onUpdate(params))
      .onRequest(methods.client.fs.readTextFile, async ({ params }) => {
        const rel = insideWorktree(worktree, params.path);
        if (rel === null) throw new Error(`${params.path} is outside the repository`);
        const content = await readFile(await safeWorktreePath(worktree, rel), "utf8");
        if (params.line == null && params.limit == null) return { content };
        const lines = content.split("\n");
        const start = Math.max(0, (params.line ?? 1) - 1);
        return {
          content: lines
            .slice(start, params.limit == null ? undefined : start + params.limit)
            .join("\n"),
        };
      })
      .onRequest(methods.client.fs.writeTextFile, async ({ params }) => {
        const rel = insideWorktree(worktree, params.path);
        if (rel === null) throw new Error(`${params.path} is outside the repository`);
        if (!approved.has(rel)) {
          const decision = await controller.requestApproval(`write-${rel}-${Date.now()}`, {
            kind: "file_write",
            path: rel,
          });
          if (decision.kind !== "allow_once" && decision.kind !== "allow_for_node")
            throw new Error(`Not allowed to write ${rel}`);
        }
        const full = await safeWorktreePath(worktree, rel);
        let existed = true;
        await readFile(full).catch(() => {
          existed = false;
        });
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, params.content);
        controller.emit({ type: "file_change", path: rel, change: existed ? "modify" : "add" });
        return {};
      });

    const finish = (
      status: "completed" | "failed" | "budget_exceeded" | "cancelled",
      summary: string,
      errorClass: string | null,
    ) => {
      controller.emit({
        type: "usage",
        usage: {
          ...ZERO_USAGE,
          inputTokens: estimateTokens(request.prompt),
          outputTokens: estimateTokens(text),
        },
        costMicroUsd,
      });
      controller.finish({ status, summary, costMicroUsd, resume: resume(), errorClass });
    };

    const run = app.connectWith(proc.stream, async (ctx) => {
      context = ctx;
      const init = await this.#initialize(ctx);
      const caps = init.agentCapabilities;
      const mcpServers: McpServer[] =
        request.mcp !== null && caps?.mcpCapabilities?.http
          ? [
              {
                type: "http",
                name: "orzeus",
                url: request.mcp.url,
                headers: [{ name: "Authorization", value: `Bearer ${request.mcp.token}` }],
              },
            ]
          : [];
      if (request.resume !== null && caps?.loadSession) {
        await ctx.request(methods.agent.session.load, {
          sessionId: request.resume.value,
          cwd: worktree,
          mcpServers,
        });
        sessionId = request.resume.value;
      } else {
        sessionId = (await ctx.request(methods.agent.session.new, { cwd: worktree, mcpServers }))
          .sessionId;
      }
      const response = await ctx.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: request.prompt }],
      });
      if (controller.finished) return;
      const summary = lastMessage.trim() || text.trim().slice(-2_000) || "The agent finished.";
      switch (response.stopReason) {
        case "end_turn":
          finish("completed", summary, null);
          break;
        case "max_tokens":
        case "max_turn_requests":
          finish("budget_exceeded", `The agent stopped: ${response.stopReason}`, null);
          break;
        case "cancelled":
          finish("cancelled", "Cancelled.", null);
          break;
        default:
          finish(
            "failed",
            `The agent stopped: ${response.stopReason}`,
            `provider.${response.stopReason}`,
          );
      }
    });

    Promise.race([
      run,
      proc.exited.then((code) => {
        if (!controller.finished)
          throw new Error(`agent exited (${code}): ${proc.stderr.join("").slice(-500)}`);
      }),
    ])
      .catch((error: unknown) => {
        if (!controller.finished)
          finish(
            "failed",
            error instanceof Error ? error.message : String(error),
            "provider.acp_error",
          );
      })
      .finally(() => proc.kill());

    return controller.session({
      onSteer: async (message) => {
        controller.emit({
          type: "log",
          level: "info",
          message: `ACP agents cannot be steered mid-turn; noted for the next attempt: ${message}`,
        });
      },
      onCancel: async (reason) => {
        const ctx = context as ClientContext | null;
        if (ctx !== null && sessionId !== null)
          await Promise.race([
            ctx.notify(methods.agent.session.cancel, { sessionId }).catch(() => undefined),
            new Promise((r) => setTimeout(r, 500)),
          ]);
        proc.kill();
        if (!controller.finished) finish("cancelled", `Cancelled: ${reason}`, null);
      },
    });
  }
}

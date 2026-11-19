import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TokenUsage } from "@orzeus/schema";
import type {
  AccountContext,
  AdapterManifest,
  ModelInfo,
  ProbeResult,
  ProviderAdapter,
  SessionRequest,
} from "../../adapter.js";
import { SessionController } from "../../session.js";
import {
  deleteFile,
  listFiles,
  readText,
  toolsFor,
  toWorktreePath,
  writeText,
} from "./workspace-tools.js";

export interface OpenAiCompatibleConfig {
  /** e.g. http://localhost:11434/v1 for Ollama. */
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly requestTimeoutMs?: number;
  readonly temperature?: number;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface ChatResponse {
  choices?: { message?: ChatMessage; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export const SYSTEM_PROMPT = [
  "You are a worker in Orzeus, a coding orchestrator. You get one small, self-contained task.",
  "Work only through the tools. Paths are relative to the repository root.",
  "Read before you edit. Write complete file contents with write_file.",
  "Do not run commands: Orzeus runs the verification checks after you finish.",
  "If the task cannot be done without a decision, call report_ambiguity instead of guessing.",
  "When the task is complete, call finish with a short summary.",
].join("\n");

export const OPENAI_COMPATIBLE_MANIFEST: AdapterManifest = {
  id: "openai-compatible",
  provider: "openai_compatible",
  displayName: "OpenAI-compatible endpoint (Ollama, LM Studio, vLLM)",
  transport: "http_api",
  auth: [
    { kind: "none" },
    { kind: "api_key", secretName: "openai-compatible", envVar: "OPENAI_COMPATIBLE_API_KEY" },
  ],
  capabilities: {
    structuredOutput: false,
    agentSession: true,
    mcpClient: false,
    resume: false,
    steerMidTurn: true,
    approvalCallbacks: true,
    reportsUsage: "exact",
    reportsQuota: false,
  },
  compliance: {
    officialInterface: "https://github.com/ollama/ollama/blob/main/docs/openai.md",
    readsForeignCredentials: false,
    rotatesAccounts: false,
    spoofsClient: false,
    notes:
      "Talks to a local or self-hosted OpenAI-compatible endpoint. Orzeus runs its own minimal tool loop.",
  },
};

function toUsage(raw: ChatResponse["usage"]): TokenUsage {
  const cached = raw?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (raw?.prompt_tokens ?? 0) - cached),
    outputTokens: raw?.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
}

/**
 * Worker adapter for OpenAI-compatible chat-completions endpoints. Because these are plain model
 * APIs, Orzeus runs the agent loop itself with a handful of worktree tools; every write goes
 * through an approval request, so the engine's policy decides before the file changes.
 */
export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly manifest: AdapterManifest = OPENAI_COMPATIBLE_MANIFEST;
  readonly #config: OpenAiCompatibleConfig;
  readonly #fetch: typeof fetch;

  constructor(config: OpenAiCompatibleConfig) {
    this.#config = config;
    this.#fetch = config.fetch ?? fetch;
  }

  async probe(account: AccountContext, signal: AbortSignal): Promise<ProbeResult> {
    try {
      const response = await this.#request("GET", "/models", undefined, account, signal);
      if (response.status === 401 || response.status === 403)
        return { ok: false, reason: "unauthenticated", detail: `HTTP ${response.status}` };
      if (!response.ok)
        return { ok: false, reason: "unreachable", detail: `HTTP ${response.status}` };
      const body = (await response.json()) as { data?: unknown[] };
      return {
        ok: true,
        version: "openai-compatible",
        detail: `${body.data?.length ?? 0} models at ${this.#config.baseUrl}`,
      };
    } catch (error) {
      return {
        ok: false,
        reason: "unreachable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listModels(account: AccountContext, signal: AbortSignal): Promise<readonly ModelInfo[]> {
    const response = await this.#request("GET", "/models", undefined, account, signal);
    const body = (await response.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => ({
      model: m.id,
      suggestedTier: "local",
      contextWindow: null,
      pricing: null,
    }));
  }

  startSession(request: SessionRequest, account: AccountContext) {
    const controller = new SessionController();
    const abort = new AbortController();
    const steering: string[] = [];
    void this.#loop(request, account, controller, abort.signal, steering).catch(
      (error: unknown) => {
        const aborted = abort.signal.aborted;
        controller.finish({
          status: aborted ? "cancelled" : "failed",
          summary: aborted ? "Cancelled." : error instanceof Error ? error.message : String(error),
          costMicroUsd: 0,
          resume: null,
          errorClass: aborted ? null : "provider.request_failed",
        });
      },
    );
    return controller.session({
      onSteer: async (message) => {
        steering.push(message);
      },
      onCancel: async (reason) => {
        abort.abort(reason);
        controller.finish({
          status: "cancelled",
          summary: `Cancelled: ${reason}`,
          costMicroUsd: 0,
          resume: null,
          errorClass: null,
        });
      },
    });
  }

  async #loop(
    request: SessionRequest,
    account: AccountContext,
    controller: SessionController,
    signal: AbortSignal,
    steering: string[],
  ): Promise<void> {
    const tools = toolsFor(request.packet.tools);
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: request.prompt },
    ];
    const done = (status: "completed" | "needs_input" | "budget_exceeded", summary: string) =>
      controller.finish({ status, summary, costMicroUsd: 0, resume: null, errorClass: null });

    for (let turn = 1; turn <= request.budget.maxTurns; turn++) {
      if (controller.finished) return;
      for (const note of steering.splice(0))
        messages.push({ role: "user", content: `Guidance from your supervisor: ${note}` });

      const response = await this.#request(
        "POST",
        "/chat/completions",
        {
          model: request.model,
          messages,
          tools,
          tool_choice: "auto",
          temperature: this.#config.temperature ?? 0.2,
        },
        account,
        signal,
      );
      if (!response.ok)
        throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const body = (await response.json()) as ChatResponse;
      controller.emit({ type: "usage", usage: toUsage(body.usage), costMicroUsd: 0 });

      const message = body.choices?.[0]?.message;
      if (message === undefined) throw new Error("response had no message");
      messages.push({
        role: "assistant",
        content: message.content ?? "",
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      });
      if (message.content) controller.emit({ type: "message_delta", text: message.content });

      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        done("completed", message.content?.trim() || "Finished without a summary.");
        return;
      }

      for (const call of calls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = {};
        }
        controller.emit({
          type: "tool_call",
          callId: call.id,
          tool: call.function.name,
          input: args,
        });
        const result = await this.#runTool(request, controller, call.id, call.function.name, args);
        controller.emit({
          type: "tool_result",
          callId: call.id,
          isError: result.isError,
          output: result.text,
        });
        messages.push({ role: "tool", tool_call_id: call.id, content: result.text });
        if (result.stop !== undefined) {
          if (result.stop.status === "needs_input")
            controller.emit({ type: "ambiguity", question: result.stop.summary });
          done(result.stop.status, result.stop.summary);
          return;
        }
      }
    }
    done("budget_exceeded", `Stopped after ${request.budget.maxTurns} turns without finishing.`);
  }

  async #runTool(
    request: SessionRequest,
    controller: SessionController,
    callId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{
    text: string;
    isError: boolean;
    stop?: { status: "completed" | "needs_input"; summary: string };
  }> {
    const worktree = request.worktree.path;
    const fail = (text: string) => ({ text, isError: true });
    const offered = new Set(toolsFor(request.packet.tools).map((t) => t.function.name));
    if (!offered.has(name)) return fail(`Unknown or unavailable tool: ${name}`);

    if (name === "finish")
      return {
        text: "ok",
        isError: false,
        stop: { status: "completed", summary: String(args["summary"] ?? "") },
      };
    if (name === "report_ambiguity") {
      return {
        text: "ok",
        isError: false,
        stop: { status: "needs_input", summary: String(args["question"] ?? "") },
      };
    }

    const path = toWorktreePath(name === "list_files" ? (args["path"] ?? ".") : args["path"]);
    if (path === null) return fail("Path must be inside the repository.");

    try {
      switch (name) {
        case "list_files":
          return { text: await listFiles(worktree, path), isError: false };
        case "read_file": {
          const start = typeof args["start_line"] === "number" ? args["start_line"] : undefined;
          const end = typeof args["end_line"] === "number" ? args["end_line"] : undefined;
          return { text: await readText(worktree, path, start, end), isError: false };
        }
        case "write_file":
        case "delete_file": {
          const existed = existsSync(join(worktree, path));
          const action =
            name === "write_file"
              ? ({ kind: "file_write", path } as const)
              : ({ kind: "file_delete", path } as const);
          const decision = await controller.requestApproval(callId, action);
          if (decision.kind === "deny") return fail(`Not allowed: ${decision.reason}`);
          if (decision.kind === "steer")
            return fail(`Not done. Supervisor says: ${decision.message}`);
          if (name === "write_file") {
            if (typeof args["content"] !== "string") return fail("content must be a string");
            await writeText(worktree, path, args["content"]);
            controller.emit({ type: "file_change", path, change: existed ? "modify" : "add" });
            return { text: `Wrote ${path}.`, isError: false };
          }
          await deleteFile(worktree, path);
          controller.emit({ type: "file_change", path, change: "delete" });
          return { text: `Deleted ${path}.`, isError: false };
        }
        default:
          return fail(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  async #request(
    method: string,
    path: string,
    body: unknown,
    account: AccountContext,
    signal: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "orzeus/0.0.0",
    };
    const auth = account.auth;
    if (auth.kind === "api_key")
      headers["authorization"] = `Bearer ${await account.getSecret(auth.secretName)}`;
    const timeout = AbortSignal.timeout(this.#config.requestTimeoutMs ?? 300_000);
    return this.#fetch(`${this.#config.baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers,
      signal: AbortSignal.any([signal, timeout]),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
}

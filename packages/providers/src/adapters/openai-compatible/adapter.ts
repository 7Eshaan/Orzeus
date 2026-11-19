import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AccountId, QuotaWindow, TokenUsage } from "@orzeus/schema";
import type {
  AccountContext,
  AdapterManifest,
  ModelInfo,
  ProbeResult,
  ProviderAdapter,
  SessionRequest,
} from "../../adapter.js";
import { USER_AGENT } from "../../http.js";
import { costOf, pricesFor, type TokenPrices } from "../../pricing.js";
import { SessionController } from "../../session.js";
import {
  type GenerateRequest,
  type GenerateResult,
  parseJsonOutput,
  toStrictJsonSchema,
} from "../../structured.js";
import { connectGateway, type GatewayTools } from "./gateway-tools.js";
import {
  deleteFile,
  listFiles,
  readText,
  type ToolDefinition,
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
  /**
   * Sent as reasoning_effort when set. Small local "thinking" models can spend a whole token
   * budget on hidden reasoning; "none" or "low" keeps them answering.
   */
  readonly reasoningEffort?: "none" | "low" | "medium" | "high";
  /** Another identity for the same wire protocol (the hosted OpenAI API uses this). */
  readonly manifest?: AdapterManifest;
  /** Prices per model, for cost accounting; local endpoints are free. */
  readonly prices?: Readonly<Record<string, TokenPrices>>;
  /** Reads rate-limit headers into quota windows (hosted APIs). */
  readonly quotaFromHeaders?: (
    accountId: AccountId,
    headers: Headers,
    now: number,
  ) => QuotaWindow[];
  /** Reasoning models reject a temperature; false leaves it out. Default true. */
  readonly sendTemperature?: boolean;
  /** Hosted OpenAI models take max_completion_tokens instead of max_tokens. */
  readonly maxTokensField?: "max_tokens" | "max_completion_tokens";
  readonly suggestedTier?: "local" | "worker" | "frontier";
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
  "Tools whose names start with a server prefix (e.g. orzeus__read_context) come from Orzeus; use them to read the context listed in the task.",
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
    structuredOutput: true,
    agentSession: true,
    mcpClient: true,
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
  readonly manifest: AdapterManifest;
  readonly #config: OpenAiCompatibleConfig;
  readonly #fetch: typeof fetch;

  constructor(config: OpenAiCompatibleConfig) {
    this.#config = config;
    this.manifest = config.manifest ?? OPENAI_COMPATIBLE_MANIFEST;
    this.#fetch = config.fetch ?? fetch;
  }

  #cost(model: string, usage: TokenUsage): number {
    const table = this.#config.prices;
    return table === undefined ? 0 : (costOf(pricesFor(table, model), usage) ?? 0);
  }

  #quota(account: AccountContext, response: Response): QuotaWindow[] {
    return this.#config.quotaFromHeaders?.(account.accountId, response.headers, Date.now()) ?? [];
  }

  #temperature(value: number): { temperature?: number } {
    return this.#config.sendTemperature === false ? {} : { temperature: value };
  }

  #maxTokens(value: number): Record<string, number> {
    return { [this.#config.maxTokensField ?? "max_tokens"]: value };
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
    return (body.data ?? []).map((m) => {
      const prices =
        this.#config.prices === undefined ? null : pricesFor(this.#config.prices, m.id);
      return {
        model: m.id,
        suggestedTier: this.#config.suggestedTier ?? "local",
        contextWindow: null,
        pricing:
          prices === null ? null : { inputPerMTok: prices.input, outputPerMTok: prices.output },
      };
    });
  }

  /**
   * Structured output with graceful degradation, because local runtimes differ: JSON-schema
   * constrained decoding first; if the runtime cannot do it (e.g. Ollama's MLX runner answers
   * 501), a single forced tool call whose parameters are the schema; the answer is always
   * validated against the schema either way.
   */
  async generate<T>(
    request: GenerateRequest<T>,
    account: AccountContext,
    signal: AbortSignal,
  ): Promise<GenerateResult<T>> {
    const started = Date.now();
    const schema = toStrictJsonSchema(request.output.jsonSchema);
    const messages = [
      { role: "system", content: request.system },
      { role: "user", content: request.prompt },
    ];
    const constrained = await this.#request(
      "POST",
      "/chat/completions",
      {
        model: request.model,
        messages,
        response_format: {
          type: "json_schema",
          json_schema: { name: request.output.name, schema, strict: true },
        },
        ...this.#maxTokens(request.maxOutputTokens),
        ...this.#temperature(0),
        ...this.#reasoning(),
      },
      account,
      signal,
    );
    if (constrained.ok) {
      const body = (await constrained.json()) as ChatResponse;
      const text = body.choices?.[0]?.message?.content ?? "";
      const usage = toUsage(body.usage);
      return {
        value: parseJsonOutput(text, request.output),
        usage,
        costMicroUsd: this.#cost(request.model, usage),
        quota: this.#quota(account, constrained),
        latencyMs: Date.now() - started,
      };
    }
    const reason = await constrained.text();
    if (
      constrained.status !== 400 &&
      constrained.status !== 501 &&
      !/structured output|response_format/i.test(reason)
    ) {
      throw new Error(`HTTP ${constrained.status}: ${reason.slice(0, 500)}`);
    }

    const toolName = `submit_${request.output.name}`.replace(/[^a-zA-Z0-9_]/g, "_");
    const viaTool = await this.#request(
      "POST",
      "/chat/completions",
      {
        model: request.model,
        messages: [
          {
            role: "system",
            content: `${request.system}\n\nSubmit your answer by calling the ${toolName} tool exactly once.`,
          },
          messages[1],
        ],
        tools: [
          {
            type: "function",
            function: {
              name: toolName,
              description: `Submit the ${request.output.name}.`,
              parameters: schema,
            },
          },
        ],
        tool_choice: { type: "function", function: { name: toolName } },
        ...this.#maxTokens(request.maxOutputTokens),
        ...this.#temperature(0),
        ...this.#reasoning(),
      },
      account,
      signal,
    );
    if (!viaTool.ok)
      throw new Error(`HTTP ${viaTool.status}: ${(await viaTool.text()).slice(0, 500)}`);
    const body = (await viaTool.json()) as ChatResponse;
    const message = body.choices?.[0]?.message;
    const call =
      message?.tool_calls?.find((c) => c.function.name === toolName) ?? message?.tool_calls?.[0];
    const text = call?.function.arguments ?? message?.content ?? "";
    const usage = toUsage(body.usage);
    return {
      value: parseJsonOutput(text, request.output),
      usage,
      costMicroUsd: this.#cost(request.model, usage),
      quota: this.#quota(account, viaTool),
      latencyMs: Date.now() - started,
    };
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
    const gateway: GatewayTools | null =
      request.mcp === null ? null : await connectGateway(request.mcp, signal);
    try {
      await this.#loopWith(request, account, controller, signal, steering, gateway);
    } finally {
      await gateway?.close();
    }
  }

  async #loopWith(
    request: SessionRequest,
    account: AccountContext,
    controller: SessionController,
    signal: AbortSignal,
    steering: string[],
    gateway: GatewayTools | null,
  ): Promise<void> {
    const tools: ToolDefinition[] = [
      ...toolsFor(request.packet.tools),
      ...(gateway?.definitions ?? []),
    ];
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: request.prompt },
    ];
    let totalCost = 0;
    const done = (status: "completed" | "needs_input" | "budget_exceeded", summary: string) =>
      controller.finish({
        status,
        summary,
        costMicroUsd: totalCost,
        resume: null,
        errorClass: null,
      });

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
          ...this.#temperature(this.#config.temperature ?? 0.2),
          ...this.#reasoning(),
        },
        account,
        signal,
      );
      const quota = this.#quota(account, response);
      if (quota.length > 0) controller.emit({ type: "quota", windows: quota });
      if (!response.ok)
        throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const body = (await response.json()) as ChatResponse;
      const usage = toUsage(body.usage);
      totalCost += this.#cost(request.model, usage);
      controller.emit({ type: "usage", usage, costMicroUsd: this.#cost(request.model, usage) });

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
        const result: {
          text: string;
          isError: boolean;
          stop?: { status: "completed" | "needs_input"; summary: string };
        } =
          gateway?.has(call.function.name) === true
            ? await gateway.call(call.function.name, args)
            : await this.#runTool(request, controller, call.id, call.function.name, args);
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

  #reasoning(): { reasoning_effort?: string } {
    return this.#config.reasoningEffort === undefined
      ? {}
      : { reasoning_effort: this.#config.reasoningEffort };
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
      "user-agent": USER_AGENT,
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

import { randomBytes } from "node:crypto";
import { createRedactor, type RunState } from "@orzeus/core";
import { MEMORY_KINDS } from "@orzeus/memory-server";
import {
  type MethodResult,
  type NotificationName,
  type PendingGate,
  PlanEdit,
  type RpcHandlers,
  type RunDetail,
  type RunSummary,
} from "@orzeus/protocol";
import type { AccountId, GitOid, RunId } from "@orzeus/schema";
import { exportJsonl, exportOtlp } from "@orzeus/trace";
import { createEngine, type Engine, type EngineConfig } from "./compose.js";
import { createHandlers, type EngineInfo } from "./handlers.js";
import { ulid } from "./ids.js";
import { type Logger, secretValues } from "./logger.js";
import type { GateAnswer, GateRequest } from "./orchestrator.js";
import { checkCommandsExist } from "./plan-checks.js";
import { applyPlanEdit, toPlanEdit, withGrants } from "./plan-edit.js";
import { expandHandPlan, PlanFileError } from "./plan-file.js";
import { planRun, prepareRepo } from "./plan-run.js";

type Notify = (method: string, params: unknown) => void;

export interface ServiceOptions {
  readonly dataDir: string;
  readonly logger: Logger;
  readonly notify: Notify;
  readonly info: EngineInfo;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly ollamaUrl?: string;
  readonly enableCodex?: boolean;
  readonly enableCursor?: boolean;
  readonly acpAgents?: EngineConfig["acpAgents"];
  readonly worker?: string;
  readonly planner?: string;
  /** Test seams, passed to createEngine. */
  readonly engineOverrides?: Partial<
    Omit<EngineConfig, "dataDir" | "logger" | "decideGate" | "progress">
  >;
}

interface Pending {
  readonly gate: PendingGate;
  readonly resolve: (answer: GateAnswer) => void;
}

const LOCAL_MODEL = "openai-compatible:lfm3:latest";

function summarize(state: RunState): RunSummary {
  const nodes = Object.values(state.nodes);
  return {
    runId: state.runId,
    goal: state.goal,
    status: state.status,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    nodes: nodes.length || (state.proposedDag?.nodes.length ?? 0),
    succeeded: nodes.filter((n) => n.status === "succeeded").length,
    failed: nodes.filter((n) => n.status === "failed").length,
    totals: state.totals,
  };
}

/**
 * The engine as the desktop app sees it: protocol handlers over one Engine, a human-approval
 * inbox that the UI answers, and change notifications. Runs execute in the background; the UI
 * follows them through notifications and reads.
 */
export class EngineService {
  readonly engine: Engine;
  readonly #o: ServiceOptions;
  readonly #inbox = new Map<string, Pending>();
  readonly #active = new Map<RunId, Promise<unknown>>();
  readonly #planner: string | null;
  readonly #worker: string;
  #quotaReadAt: number | null = null;

  constructor(options: ServiceOptions) {
    this.#o = options;
    const env = options.env ?? process.env;
    this.#worker = options.worker ?? LOCAL_MODEL;
    this.#planner =
      options.planner ??
      (env["ANTHROPIC_API_KEY"]
        ? "anthropic-api:claude-opus-5-5"
        : env["GEMINI_API_KEY"]
          ? null
          : LOCAL_MODEL);
    const redact = createRedactor(secretValues(env));
    this.engine = createEngine({
      dataDir: options.dataDir,
      logger: options.logger,
      env,
      enableCodex: options.enableCodex ?? false,
      enableCursor: options.enableCursor ?? false,
      ...(options.acpAgents === undefined ? {} : { acpAgents: options.acpAgents }),
      ...(options.ollamaUrl === undefined ? {} : { openAiCompatibleUrl: options.ollamaUrl }),
      ...(this.#planner === null ? {} : { frontier: this.#planner }),
      decideGate: (gate) => this.#ask(gate),
      progress: (line) =>
        options.notify("progress" satisfies NotificationName, { line: redact(line) }),
      ...options.engineOverrides,
    });
    this.engine.store.onAppend((runId, state) =>
      options.notify("run.updated" satisfies NotificationName, {
        runId,
        status: state.status,
        headSeq: state.headSeq,
      }),
    );
  }

  close(): void {
    for (const pending of this.#inbox.values())
      pending.resolve({
        approved: false,
        actor: { kind: "engine" },
        note: "Engine shutting down.",
      });
    this.engine.close();
  }

  async #ask(gate: GateRequest): Promise<GateAnswer> {
    const id = `gate-${randomBytes(6).toString("hex")}`;
    let diff: string | null = null;
    if (gate.action.kind === "merge") {
      const dag = this.engine.store.load(gate.runId)?.dag;
      if (dag !== undefined && dag !== null) {
        diff = (
          await this.engine.git.diff(
            dag.repo.root,
            dag.repo.baseCommit,
            (await this.engine.git.revParse(dag.repo.root, gate.action.from)) as GitOid,
          )
        ).patch;
      }
    }
    return new Promise<GateAnswer>((resolve) => {
      this.#inbox.set(id, {
        gate: {
          id,
          runId: gate.runId,
          nodeId: gate.nodeId,
          action: gate.action,
          reason: gate.reason,
          requestedAt: Date.now(),
          diff,
        },
        resolve,
      });
      this.#notifyInbox();
    });
  }

  #notifyInbox(): void {
    this.#o.notify("approvals.changed" satisfies NotificationName, { pending: this.#inbox.size });
  }

  #drive(runId: RunId, work: () => Promise<unknown>): void {
    if (this.#active.has(runId)) throw new Error(`run ${runId} is already running`);
    const task = work()
      .catch((error: unknown) =>
        this.#o.notify("progress", {
          line: `Run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
        }),
      )
      .finally(() => {
        this.#active.delete(runId);
        const state = this.engine.store.load(runId);
        if (state !== null)
          this.#o.notify("run.updated", { runId, status: state.status, headSeq: state.headSeq });
      });
    this.#active.set(runId, task);
  }

  #state(runId: RunId): RunState {
    const state = this.engine.store.load(runId);
    if (state === null) throw new Error(`unknown run ${runId}`);
    return state;
  }

  #detail(state: RunState): RunDetail {
    return {
      ...summarize(state),
      repo: state.repo,
      dag: state.dag ?? state.proposedDag,
      awaitingPlanApproval: state.status === "awaiting_plan_approval",
      nodeViews: (state.dag?.nodes ?? state.proposedDag?.nodes ?? []).map((task) => {
        const n = state.nodes[task.id];
        return {
          id: task.id,
          title: task.title,
          kind: task.kind,
          tier: task.tier,
          dependsOn: task.dependsOn,
          writeScope: task.writeScope,
          status: n?.status ?? "pending",
          attempt: n?.attempt ?? 0,
          steers: n?.steers ?? 0,
          model: n?.model ?? task.candidates[0] ?? null,
          headCommit: n?.headCommit ?? null,
          summary: n?.summary ?? null,
          lastError: n?.lastError ?? null,
          usage: n?.usage ?? {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
          costMicroUsd: n?.costMicroUsd ?? 0,
        };
      }),
      checkpoints: Object.values(state.checkpoints).map((c) => ({
        id: c.id,
        label: c.label,
        atSeq: c.atSeq,
      })),
      headSeq: state.headSeq,
      active: this.#active.has(state.runId),
    };
  }

  handlers(): RpcHandlers {
    const engine = this.engine;
    const ok = { ok: true as const };
    return {
      ...createHandlers(this.#o.info),
      "runs.list": () => engine.store.runIds().map((id) => summarize(this.#state(id))),
      "runs.get": ({ runId }) => this.#detail(this.#state(runId as RunId)),
      "runs.events": ({ runId, afterSeq, limit }) =>
        engine.store.events(runId as RunId, { afterSeq: afterSeq ?? 0, limit: limit ?? 2_000 }),
      "runs.start": async ({ goal, repo, baseRef, planner, worker }) => {
        const prepared = await prepareRepo(engine, repo, baseRef ?? "HEAD");
        const plannerSpec = planner ?? this.#planner;
        if (plannerSpec === null) throw new Error("no planner is configured");
        let started: RunId | null = null;
        const planning = planRun(
          engine,
          { goal, prepared, planner: plannerSpec, worker: worker ?? this.#worker },
          (line) => {
            const id = /^Run (\w{26}):/.exec(line)?.[1];
            if (id !== undefined) started ??= id as RunId;
            this.#o.notify("progress", { line });
          },
        );
        // planRun records run.created before its first await, so the id is known already.
        const runId = started ?? (await planning).runId;
        this.#active.set(
          runId,
          planning.finally(() => this.#active.delete(runId)),
        );
        return { runId };
      },
      "runs.startPlan": async ({ repo, baseRef, plan }) => {
        const prepared = await prepareRepo(engine, repo, baseRef ?? "HEAD");
        const runId = ulid() as RunId;
        engine.orchestrator.createRun(
          prepared.projectId,
          withGrants(expandHandPlan(plan, runId, prepared.repo), engine.mcpServers.defaultGrants()),
        );
        return { runId };
      },
      "runs.plan": ({ runId }) => toPlanEdit(engine.orchestrator.proposedPlan(runId as RunId)),
      "runs.revisePlan": ({ runId, plan }) => {
        if (this.#active.has(runId as RunId)) throw new Error("the run is still being planned");
        const revised = applyPlanEdit(
          engine.orchestrator.proposedPlan(runId as RunId),
          PlanEdit.parse(plan),
        );
        const problems = [
          ...checkCommandsExist(revised, revised.dag.repo.root),
          ...revised.dag.nodes.flatMap((n) =>
            n.candidates.flatMap((c) =>
              engine.workers.get(c.adapter) === undefined
                ? [`${n.id}: worker adapter ${c.adapter} is not enabled`]
                : [],
            ),
          ),
        ];
        if (problems.length > 0)
          throw new PlanFileError(
            `Plan has problems:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
          );
        engine.orchestrator.revisePlan(runId as RunId, revised);
        return { revision: revised.dag.revision };
      },
      "runs.approvePlan": ({ runId }) => {
        engine.orchestrator.approvePlan(runId as RunId);
        this.#drive(runId as RunId, () => engine.orchestrator.execute(runId as RunId));
        return ok;
      },
      "runs.resume": ({ runId }) => {
        this.#drive(runId as RunId, () => engine.orchestrator.resume(runId as RunId));
        return ok;
      },
      "runs.rollback": async ({ runId, checkpointId }) => {
        if (this.#active.has(runId as RunId))
          throw new Error("stop the run before rolling it back");
        await engine.orchestrator.rollback(runId as RunId, checkpointId as never);
        return ok;
      },
      "runs.verify": ({ runId }) => {
        const result = engine.store.verify(runId as RunId);
        return result.ok
          ? { ok: true, detail: `Chain OK (${result.head?.seq ?? 0} events).` }
          : { ok: false, detail: `Broken at event ${result.seq}: ${result.reason}` };
      },
      "runs.export": ({ runId, format }) => {
        const events = engine.store.events(runId as RunId);
        return format === "jsonl"
          ? {
              filename: `orzeus-${runId}.jsonl`,
              mediaType: "application/x-ndjson",
              content: exportJsonl(events),
            }
          : {
              filename: `orzeus-${runId}.otlp.json`,
              mediaType: "application/json",
              content: exportOtlp(events),
            };
      },
      "blobs.read": ({ hash, maxChars }) => {
        const blob = engine.store.blobs.get(hash as never);
        if (blob === undefined) throw new Error(`no blob ${hash}`);
        const text = new TextDecoder().decode(blob.bytes);
        const limit = maxChars ?? 200_000;
        return {
          mediaType: blob.mediaType,
          text: text.slice(0, limit),
          truncated: text.length > limit,
        };
      },
      "approvals.list": () => [...this.#inbox.values()].map((p) => p.gate),
      "approvals.answer": ({ id, decision, note }) => {
        const pending = this.#inbox.get(id);
        if (pending === undefined) throw new Error(`no pending approval ${id}`);
        this.#inbox.delete(id);
        pending.resolve(
          decision === "steer"
            ? {
                approved: false,
                actor: { kind: "human" },
                steer: note ?? "",
                note: note ?? "Steered",
              }
            : {
                approved: decision === "approve",
                actor: { kind: "human" },
                ...(note === undefined ? {} : { note }),
              },
        );
        this.#notifyInbox();
        return ok;
      },
      "quota.setSoftCap": ({ accountId, window, percent }) => {
        engine.telemetry.setSoftCap(accountId, window, percent);
        this.#o.notify("quota.changed" satisfies NotificationName, {});
        return ok;
      },
      "quota.read": async () => {
        const runs = engine.store.runIds().map((id) => this.#state(id).totals);
        const totals = runs.reduce(
          (a, t) => ({
            frontierTokens: a.frontierTokens + t.frontierTokens,
            workerTokens: a.workerTokens + t.workerTokens,
            costMicroUsd: a.costMicroUsd + t.costMicroUsd,
          }),
          { frontierTokens: 0, workerTokens: 0, costMicroUsd: 0 },
        );
        return {
          accounts: await this.#quotas(),
          totals: { ...totals, frontierTokensAvoided: totals.workerTokens },
          routing: { planner: this.#planner, worker: this.#worker },
        };
      },
      "settings.read": () => {
        const env = this.#o.env ?? process.env;
        const adapters = new Map<
          string,
          { id: string; displayName: string; provider: string; roles: ("worker" | "planner")[] }
        >();
        for (const [id, entry] of engine.planners)
          adapters.set(id, {
            id,
            displayName: entry.adapter.manifest.displayName,
            provider: entry.adapter.manifest.provider,
            roles: ["planner"],
          });
        for (const id of engine.workers.ids()) {
          const entry = engine.workers.get(id);
          if (entry === undefined) continue;
          const existing = adapters.get(id);
          adapters.set(id, {
            id,
            displayName: entry.adapter.manifest.displayName,
            provider: entry.adapter.manifest.provider,
            roles: [...(existing?.roles ?? []), "worker"],
          });
        }
        return {
          dataDir: this.#o.dataDir,
          adapters: [...adapters.values()],
          defaults: { planner: this.#planner, worker: this.#worker },
          secrets: {
            anthropic: Boolean(env["ANTHROPIC_API_KEY"]),
            gemini: Boolean(env["GEMINI_API_KEY"]),
            openai: Boolean(env["OPENAI_API_KEY"]),
            cursor: Boolean(env["CURSOR_API_KEY"]),
          },
          codexEnabled: this.#o.enableCodex ?? false,
        };
      },
      "mcp.list": () => engine.mcpServers.list(),
      "mcp.save": ({ server }) => engine.mcpServers.save(server),
      "mcp.remove": ({ id }) => {
        engine.mcpServers.remove(id);
        return ok;
      },
      "mcp.test": ({ id }) => engine.mcpServers.test(id),
      "memory.list": async ({ repo }) => {
        const root = await engine.git.topLevel(repo);
        return engine.memory
          .list(root)
          .map((m) => ({ id: m.id, kind: m.kind, title: m.title, body: m.body }));
      },
      "memory.add": async ({ repo, kind, title, body }) => {
        if (!MEMORY_KINDS.includes(kind)) throw new Error(`unknown memory kind ${kind}`);
        const root = await engine.git.topLevel(repo);
        const m = engine.memory.add({ repoRoot: root, kind, title, body });
        return { id: m.id, kind: m.kind, title: m.title, body: m.body };
      },
    };
  }

  /**
   * Every account the engine uses, with the latest observation of each window from any source
   * (official reads, CLI events, response headers) and its soft caps. Official quota reads are
   * free (no tokens) and refreshed at most once a minute.
   */
  async #quotas(): Promise<MethodResult<"quota.read">["accounts"]> {
    const engine = this.engine;
    if (this.#quotaReadAt === null || Date.now() - this.#quotaReadAt >= 60_000) {
      this.#quotaReadAt = Date.now();
      for (const id of engine.workers.ids()) {
        const entry = engine.workers.get(id);
        if (entry?.adapter.readQuota === undefined) continue;
        const windows = await entry.adapter
          .readQuota(entry.account, AbortSignal.timeout(15_000))
          .catch(() => []);
        engine.telemetry.recordQuota(windows);
      }
    }
    const now = Date.now();
    const latest = engine.telemetry
      .latestQuota()
      .filter((w) => w.resetsAt === null || w.resetsAt > now);
    const accounts = new Map<string, MethodResult<"quota.read">["accounts"][number]>();
    const entries = [
      ...engine.workers.ids().flatMap((id) => {
        const entry = engine.workers.get(id);
        return entry === undefined ? [] : [{ id, ...entry }];
      }),
      ...[...engine.planners].map(([id, entry]) => ({ id, ...entry })),
    ];
    for (const { id, account } of entries) {
      if (accounts.has(account.accountId)) continue;
      accounts.set(account.accountId, {
        accountId: account.accountId as AccountId,
        label: account.label,
        adapter: id,
        windows: latest.filter((w) => w.accountId === account.accountId),
        softCaps: engine.telemetry.softCaps(account.accountId),
      });
    }
    return [...accounts.values()];
  }
}

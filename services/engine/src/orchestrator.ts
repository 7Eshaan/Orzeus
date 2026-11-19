import { hostname } from "node:os";
import { type CheckResult, outOfScope, runChecks } from "@orzeus/checks";
import {
  CircuitBreakers,
  type Clock,
  crossedCostThresholds,
  decideAfterFailure,
  decideNext,
  evaluatePolicy,
  type FailureKind,
  frontierTokensExceeded,
  type NodeState,
  nextWakeAt,
  nodeBudgetTrips,
  type QuotaHold,
  type Random,
  REVIEW_SYSTEM_PROMPT,
  type RunState,
  renderPacketPrompt,
  renderReviewPrompt,
  renderSteerPrompt,
  STEER_SYSTEM_PROMPT,
} from "@orzeus/core";
import type { Git, WorktreeManager } from "@orzeus/git";
import type { GatewayCall, GatewayDecision, McpGateway } from "@orzeus/mcp-gateway";
import type {
  AccountContext,
  AdapterEvent,
  AdapterRegistry,
  AgentSession,
  OutputSchema,
  ProviderAdapter,
  SessionOutcome,
} from "@orzeus/providers";
import {
  type Actor,
  type ApprovalId,
  type CheckpointId,
  type CheckSpec,
  ContextPacket,
  type ContextPacketBody,
  type EventDraft,
  type GateAction,
  type GitOid,
  type ModelRef,
  type NodeId,
  type PlannerOutput,
  type PolicyDocument,
  type ProjectId,
  type ProposedAction,
  type QuotaWindow,
  ReviewDecision,
  type RunId,
  type Sha256,
  SteerDecision,
  type TaskNode,
  TERMINAL_RUN_STATUSES,
  type TraceEvent,
  type TraceEventPayload,
  type TraceEventType,
} from "@orzeus/schema";
import { type RunLocks, type SqliteRunStore, sha256Text } from "@orzeus/store";
import { canonicalize, contentHash } from "@orzeus/trace";
import { z } from "zod";
import { randomHex } from "./ids.js";
import type { Logger } from "./logger.js";

/** A model that can answer with structured output: used for steering and review. */
export interface FrontierModel {
  readonly ref: ModelRef;
  readonly adapter: ProviderAdapter;
  readonly account: AccountContext;
}

/** Something only a human may decide. */
export interface GateRequest {
  readonly runId: RunId;
  readonly nodeId: NodeId | null;
  readonly action: ProposedAction | GateAction;
  readonly reason: string;
}

/** The human's answer, and who gave it (a person, or a headless flag acting for them). */
export interface GateAnswer {
  readonly approved: boolean;
  readonly actor: Actor;
  readonly note?: string;
  /** Instead of yes/no, guidance for the worker that asked (worker approvals only). */
  readonly steer?: string;
}

export interface LockSettings {
  readonly locks: RunLocks;
  readonly ttlMs: number;
  readonly heartbeatMs: number;
}

export interface OrchestratorOptions {
  readonly store: SqliteRunStore;
  readonly git: Git;
  readonly worktrees: WorktreeManager;
  readonly adapters: AdapterRegistry;
  readonly policy: PolicyDocument;
  readonly clock: Clock;
  readonly random: Random;
  readonly logger: Logger;
  /** Answers human gates: policy asks, budget thresholds and the merge into the user's branch. */
  readonly decideGate: (gate: GateRequest) => Promise<GateAnswer>;
  /** Steers escalated nodes and reviews the integrated result; without it, escalations fail. */
  readonly frontier?: FrontierModel;
  /** One engine per run (Phase 4). Without it, nothing stops two engines sharing a run. */
  readonly lock?: LockSettings;
  /** Human-readable progress lines (the CLI prints them). */
  readonly progress?: (line: string) => void;
  /** Starts a run's MCP gateway with its upstream servers. Without it, workers get no gateway. */
  readonly openGateway?: (state: RunState) => Promise<McpGateway>;
  readonly breakers?: CircuitBreakers;
  /** Account quota: holds accounts that are limited or over a soft cap, and records observations. */
  readonly quota?: QuotaPort;
}

export interface QuotaPort {
  hold(accountId: string, now: number): QuotaHold | null;
  observe(windows: readonly QuotaWindow[]): void;
}

/** One planner model call, recorded in the trace when the plan is proposed. */
export interface PlanningRecord {
  readonly model: ModelRef;
  readonly usage: TraceEventPayload<"model.call">["usage"];
  readonly costMicroUsd: number | null;
  readonly latencyMs: number;
}

export class RunLockedError extends Error {
  override readonly name = "RunLockedError";
}

const ENGINE: Actor = { kind: "engine" };
const INTEGRATION_WORKTREE = "_integration";
const ACTIVE_NODE_STATUSES = new Set(["running", "verifying", "awaiting_approval"]);

const steerOutput: OutputSchema<SteerDecision> = {
  name: "orzeus_steer",
  jsonSchema: z.toJSONSchema(SteerDecision) as Record<string, unknown>,
  parse: (v) => SteerDecision.parse(v),
};
const reviewOutput: OutputSchema<ReviewDecision> = {
  name: "orzeus_review",
  jsonSchema: z.toJSONSchema(ReviewDecision) as Record<string, unknown>,
  parse: (v) => ReviewDecision.parse(v),
};

/**
 * Drives runs: turns scheduler decisions into events, runs worker sessions in worktrees,
 * verifies their work, steers failures through the frontier model, integrates and re-verifies
 * the result, has it reviewed, and offers the merge. Every decision is an appended event, so a
 * crash at any point resumes from the log (see resume).
 */
export class RunOrchestrator {
  readonly #o: OrchestratorOptions;
  readonly #owner = `${hostname()}-${process.pid}-${randomHex(4)}`;
  readonly #traceIds = new Map<RunId, string>();
  readonly #active = new Map<string, Promise<void>>();
  readonly #gateways = new Map<RunId, Promise<McpGateway | null>>();
  #stopped = false;
  readonly #announcedHolds = new Set<string>();
  readonly #heartbeats = new Set<ReturnType<typeof setInterval>>();
  readonly #breakers: CircuitBreakers;

  constructor(options: OrchestratorOptions) {
    this.#o = options;
    this.#breakers = options.breakers ?? new CircuitBreakers();
  }

  // ───────────────────────── Run creation ─────────────────────────

  /** Records a new run with a ready-made (hand-written) plan, awaiting plan approval. */
  /**
   * Stops lock heartbeats before the database closes. Locks held by runs still in flight are left
   * to expire, so another engine can take them over after the TTL.
   */
  stop(): void {
    this.#stopped = true;
    for (const beat of this.#heartbeats) clearInterval(beat);
    this.#heartbeats.clear();
  }

  createRun(projectId: ProjectId, plan: PlannerOutput): RunId {
    this.startRun(projectId, plan.dag.runId, plan.dag.goal, plan.dag.repo);
    return this.proposePlan(plan, []);
  }

  /** Records that a run exists before its plan does, so planning is part of its trace. */
  startRun(projectId: ProjectId, runId: RunId, goal: string, repo: RunState["repo"]): void {
    this.#append(runId, [this.#draft(runId, "run.created", { projectId, goal, repo })]);
  }

  /** Records the planner's model calls, issues every packet, and proposes the plan. */
  proposePlan(plan: PlannerOutput, planning: readonly PlanningRecord[]): RunId {
    const { dag, packets } = plan;
    const runId = dag.runId;
    if (planning.length > 0) this.#append(runId, this.#planningDrafts(runId, planning));
    const issued = packets.map((body) => this.#issuePacket(runId, this.#sealPacket(body)));
    this.#append(runId, [
      ...issued,
      this.#draft(runId, "plan.proposed", { revision: dag.revision, dag }),
    ]);
    this.#say(`Run ${runId}: plan with ${dag.nodes.length} nodes is waiting for approval.`);
    return runId;
  }

  /** Records the planner's calls and fails the run when no valid plan could be produced. */
  failPlanning(runId: RunId, planning: readonly PlanningRecord[], message: string): RunState {
    this.#say(`Run ${runId}: planning failed: ${message}`);
    return this.#append(runId, [
      ...this.#planningDrafts(runId, planning),
      this.#draft(runId, "run.failed", {
        errorClass: "planning.failed",
        message: message.slice(0, 2_000),
      }),
    ]);
  }

  /** The plan waiting for approval, with each node's latest packet. */
  proposedPlan(runId: RunId): PlannerOutput {
    const dag = this.#state(runId).proposedDag;
    if (dag === null) throw new Error("no plan is waiting for approval");
    return {
      dag,
      packets: dag.nodes.map((n) => {
        const { contentHash: _hash, ...body } = this.#plannedPacket(runId, n.id);
        return body;
      }),
    };
  }

  /**
   * Proposes a human-edited revision of the waiting plan. Only packets that changed are issued
   * again; the reducer checks that the revision moves forward.
   */
  revisePlan(runId: RunId, plan: PlannerOutput): void {
    const issued = plan.packets.flatMap((body) => {
      const sealed = this.#sealPacket(body);
      let before: string | null = null;
      try {
        before = this.#plannedPacket(runId, body.nodeId).contentHash;
      } catch {
        before = null; // a node added in this edit
      }
      return before === sealed.contentHash ? [] : [this.#issuePacket(runId, sealed)];
    });
    this.#append(runId, [
      ...issued,
      this.#draft(
        runId,
        "plan.proposed",
        { revision: plan.dag.revision, dag: plan.dag },
        { actor: { kind: "human" } },
      ),
    ]);
    this.#say(`Run ${runId}: plan revision ${plan.dag.revision} (edited) is waiting for approval.`);
  }

  /** `edited` defaults to whether a person revised the plan since it was proposed. */
  approvePlan(runId: RunId, edited?: boolean): void {
    const state = this.#state(runId);
    const revision = state.proposedDag?.revision;
    if (revision === undefined) throw new Error("no plan is waiting for approval");
    edited ??=
      this.#o.store.events(runId).findLast((e) => e.type === "plan.proposed")?.actor.kind ===
      "human";
    this.#append(runId, [
      this.#draft(runId, "plan.approved", { revision, edited }, { actor: { kind: "human" } }),
      this.#checkpointDraft(runId, this.#state(runId), "plan approved"),
    ]);
  }

  // ───────────────────────── Execution ─────────────────────────

  /**
   * Recovers a run after a crash or pause: pending approvals of interrupted nodes are closed,
   * interrupted attempts are rescheduled immediately, and execution continues where it stopped
   * (including mid-integration).
   */
  async resume(runId: RunId): Promise<RunState> {
    return this.#withLock(runId, async () => {
      const state = this.#state(runId);
      if (TERMINAL_RUN_STATUSES.has(state.status)) return state;
      const drafts: EventDraft[] = [
        this.#draft(runId, "run.resumed", { afterCrash: state.status !== "paused" }),
      ];
      for (const node of Object.values(state.nodes)) {
        if (!ACTIVE_NODE_STATUSES.has(node.status)) continue;
        for (const approval of Object.values(state.approvals)) {
          if (approval.nodeId === node.id && approval.status === "pending") {
            drafts.push(
              this.#draft(runId, "approval.resolved", {
                approvalId: approval.id,
                decision: { kind: "deny", reason: "Interrupted by an engine restart." },
              }),
            );
          }
        }
        drafts.push(
          this.#draft(
            runId,
            "node.retry_scheduled",
            {
              nextAttempt: node.attempt + 1,
              delayMs: 0,
              reason: "interrupted by an engine restart",
            },
            { nodeId: node.id, attempt: node.attempt },
          ),
        );
        this.#say(`${node.id}: attempt ${node.attempt} was interrupted; retrying.`);
      }
      this.#append(runId, drafts);
      return this.#run(runId);
    });
  }

  /** Runs the approved plan until it settles, pauses or needs a human. */
  async execute(runId: RunId): Promise<RunState> {
    return this.#withLock(runId, () => this.#run(runId));
  }

  /** Rolls a run back to a checkpoint. Only call it on a human's explicit request: it discards later work. */
  async rollback(
    runId: RunId,
    checkpointId: CheckpointId,
    actor: Actor = { kind: "human" },
  ): Promise<RunState> {
    return this.#withLock(runId, async () => {
      const state = this.#state(runId);
      const checkpoint = state.checkpoints[checkpointId];
      if (checkpoint === undefined) throw new Error(`unknown checkpoint ${checkpointId}`);
      // The caller is the human's decision (e.g. `orzeus rollback`), recorded as the event's actor.
      this.#append(runId, [
        this.#draft(runId, "run.rolled_back", { toCheckpoint: checkpointId }, { actor }),
      ]);
      this.#say(`Run ${runId}: rolled back to "${checkpoint.label}".`);
      return this.#state(runId);
    });
  }

  async #withLock<T>(runId: RunId, work: () => Promise<T>): Promise<T> {
    const settings = this.#o.lock;
    if (settings === undefined) return this.#withGateway(runId, work);
    let acquired = settings.locks.acquire(runId, this.#owner, process.pid, settings.ttlMs);
    if (!acquired.ok) {
      // A crashed engine's lock expires on its own; wait for that rather than failing.
      const wait = acquired.heldBy.expiresAt - this.#o.clock.now() + 50;
      if (wait > 0 && wait <= settings.ttlMs + 100) {
        this.#say(
          `Run ${runId} is locked by ${acquired.heldBy.owner}; waiting ${Math.ceil(wait / 1000)}s for it to expire.`,
        );
        await new Promise((r) => setTimeout(r, wait));
        acquired = settings.locks.acquire(runId, this.#owner, process.pid, settings.ttlMs);
      }
      if (!acquired.ok) {
        throw new RunLockedError(
          `run ${runId} is being run by another engine (${acquired.heldBy.owner}, pid ${acquired.heldBy.pid})`,
        );
      }
    }
    const beat = setInterval(() => {
      try {
        if (!settings.locks.heartbeat(runId, this.#owner, settings.ttlMs)) {
          this.#o.logger.log("error", "lost run lock", { runId });
        }
      } catch (error) {
        this.#o.logger.log("error", "run lock heartbeat failed", { runId, error: String(error) });
      }
    }, settings.heartbeatMs);
    this.#heartbeats.add(beat);
    try {
      return await this.#withGateway(runId, work);
    } finally {
      clearInterval(beat);
      this.#heartbeats.delete(beat);
      if (!this.#stopped) settings.locks.release(runId, this.#owner);
    }
  }

  async #withGateway<T>(runId: RunId, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } finally {
      const gateway = this.#gateways.get(runId);
      this.#gateways.delete(runId);
      await (await gateway)?.close();
    }
  }

  async #run(runId: RunId): Promise<RunState> {
    for (;;) {
      const state = this.#state(runId);
      if (TERMINAL_RUN_STATUSES.has(state.status)) return state;
      if (state.status === "paused") {
        await Promise.all(this.#active.values());
        return this.#state(runId);
      }
      if (
        state.status === "integrating" ||
        state.status === "reviewing" ||
        state.status === "awaiting_merge_approval"
      ) {
        return this.#finish(runId);
      }
      if (state.status !== "executing") throw new Error(`run is ${state.status}, not executing`);

      const now = this.#o.clock.now();
      const actions = decideNext(this.#withInFlight(state), now);
      const settled = actions.find((a) => a.kind === "settled");
      if (settled !== undefined) {
        await Promise.all(this.#active.values());
        if (!settled.allSucceeded) {
          this.#say(`Run ${runId} failed: not every node succeeded.`);
          return this.#append(runId, [
            this.#draft(runId, "run.failed", {
              errorClass: "run.nodes_failed",
              message: "Not every node succeeded.",
            }),
          ]);
        }
        const dag = state.dag;
        if (dag === null) throw new Error("run has no plan");
        this.#append(runId, [
          this.#draft(runId, "integration.started", {
            baseCommit: dag.repo.baseCommit,
            branch: dag.integration.branch,
          }),
        ]);
        continue;
      }

      const drafts: EventDraft[] = [];
      for (const action of actions) {
        if (action.kind === "mark_ready")
          drafts.push(this.#draft(runId, "node.ready", {}, { nodeId: action.nodeId }));
        if (action.kind === "skip") {
          drafts.push(
            this.#draft(
              runId,
              "node.skipped",
              { because: action.because },
              { nodeId: action.nodeId },
            ),
          );
          this.#say(`${action.nodeId}: skipped because ${action.because} did not succeed.`);
        }
      }
      if (drafts.length > 0) this.#append(runId, drafts);

      let started = 0;
      let breakerWake: number | null = null;
      for (const action of actions) {
        // A node stays "ready" until its attempt records node.dispatched, so skip ones in flight.
        if (action.kind !== "dispatch" || this.#active.has(action.nodeId)) continue;
        const task = state.dag?.nodes.find((n) => n.id === action.nodeId);
        const blockedUntil = task === undefined ? null : this.#blockedUntil(runId, task, now);
        if (blockedUntil !== null) {
          breakerWake = breakerWake === null ? blockedUntil : Math.min(breakerWake, blockedUntil);
          continue;
        }
        this.#track(action.nodeId, this.#attempt(runId, action.nodeId));
        started++;
      }
      for (const node of Object.values(this.#state(runId).nodes)) {
        if (node.status === "escalated" && !this.#active.has(node.id)) {
          this.#track(node.id, this.#steer(runId, node.id));
          started++;
        }
      }
      if (started > 0) {
        // Let the new tasks reach their first await before scheduling again.
        await Promise.resolve();
        continue;
      }

      const retryWake = nextWakeAt(this.#state(runId));
      const wake = [retryWake, breakerWake]
        .filter((w): w is number => w !== null)
        .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
      if (this.#active.size > 0) {
        const timer = Number.isFinite(wake)
          ? new Promise((r) => setTimeout(r, Math.max(0, wake - this.#o.clock.now())))
          : null;
        await Promise.race([...this.#active.values(), ...(timer === null ? [] : [timer])]);
        continue;
      }
      if (Number.isFinite(wake)) {
        await new Promise((r) => setTimeout(r, Math.max(0, wake - this.#o.clock.now())));
        continue;
      }
      if (drafts.length > 0) continue;
      throw new Error(`run ${runId} is stuck: nothing is running, ready or waiting`);
    }
  }

  /**
   * The scheduler's view of the run: a node whose attempt has started but not yet recorded
   * node.dispatched (it is preparing its worktree) already holds a slot and its write scope.
   */
  #withInFlight(state: RunState): RunState {
    const starting = [...this.#active.keys()].filter((id) => state.nodes[id]?.status === "ready");
    if (starting.length === 0) return state;
    const nodes = { ...state.nodes };
    for (const id of starting) {
      const node = nodes[id];
      if (node !== undefined) nodes[id] = { ...node, status: "running" };
    }
    return { ...state, nodes };
  }

  #track(key: string, task: Promise<void>): void {
    this.#active.set(
      key,
      task.finally(() => this.#active.delete(key)),
    );
  }

  /** The quota hold on a candidate's account, if any. */
  #quotaHold(candidate: ModelRef, now: number): QuotaHold | null {
    const entry = this.#o.adapters.get(candidate.adapter);
    return entry === undefined ? null : (this.#o.quota?.hold(entry.account.accountId, now) ?? null);
  }

  #usable(candidate: ModelRef, now: number): boolean {
    return (
      this.#breakers.allows(candidate.adapter, now) && this.#quotaHold(candidate, now) === null
    );
  }

  /**
   * When no candidate can take work (circuit breaker open, or the account held by its quota): the
   * earliest time one may. A quota hold is recorded once per node and window, so the trace and
   * the progress line say why the node waits.
   */
  #blockedUntil(runId: RunId, task: TaskNode, now: number): number | null {
    const candidates = task.candidates.filter((c) => this.#o.adapters.get(c.adapter) !== undefined);
    if (candidates.length === 0) return null; // routing failure is reported by the attempt
    if (candidates.some((c) => this.#usable(c, now))) return null;
    const times = candidates.map((c) => {
      const hold = this.#quotaHold(c, now);
      if (hold !== null) this.#announceHold(runId, task.id, c, hold);
      return Math.max(this.#breakers.retryAt(c.adapter) ?? now, hold?.until ?? now);
    });
    return Math.min(...times);
  }

  #announceHold(runId: RunId, nodeId: NodeId, candidate: ModelRef, hold: QuotaHold): void {
    const entry = this.#o.adapters.get(candidate.adapter);
    if (entry === undefined) return;
    const key = `${runId}/${nodeId}/${entry.account.accountId}/${hold.window}/${hold.until}`;
    if (this.#announcedHolds.has(key)) return;
    this.#announcedHolds.add(key);
    this.#append(runId, [
      this.#draft(
        runId,
        "budget.tripped",
        {
          scope: "account",
          limit: `${entry.account.accountId} ${hold.window}`,
          limitValue: hold.cap ?? 100,
          observed: hold.usedPercent ?? 100,
        },
        { nodeId },
      ),
    ]);
    const wait = Math.max(0, hold.until - this.#o.clock.now());
    this.#say(
      `${nodeId}: waiting for ${entry.account.label}: ${hold.reason}; checking again in ${Math.ceil(wait / 60_000)} min.`,
    );
  }

  // ───────────────────────── Attempts ─────────────────────────

  async #attempt(runId: RunId, nodeId: NodeId): Promise<void> {
    try {
      await this.#runAttempt(runId, nodeId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#o.logger.log("error", "attempt crashed", { runId, nodeId, error: message });
      const node = this.#state(runId).nodes[nodeId];
      if (node !== undefined && ["ready", "running", "verifying"].includes(node.status)) {
        this.#fail(
          runId,
          nodeId,
          node.status === "ready" ? "engine.dispatch_failed" : "engine.attempt_crashed",
          message,
        );
      }
    }
  }

  async #runAttempt(runId: RunId, nodeId: NodeId): Promise<void> {
    const state = this.#state(runId);
    const node = state.nodes[nodeId] as NodeState;
    const dag = state.dag;
    const task = dag?.nodes.find((n) => n.id === nodeId);
    if (dag === null || task === undefined) throw new Error(`unknown node ${nodeId}`);

    const now = this.#o.clock.now();
    const allowed = task.candidates.filter((c) => this.#usable(c, now));
    const pick = this.#o.adapters.pick(allowed);
    if (pick === null) {
      this.#fail(
        runId,
        nodeId,
        "routing.no_adapter",
        `None of ${task.candidates.map((c) => c.adapter).join(", ")} is available.`,
      );
      return;
    }

    const base = await this.#baseFor(state, node);
    if (!base.ok) {
      this.#fail(
        runId,
        nodeId,
        "git.merge_conflict",
        `Dependencies conflict in ${base.conflicts.join(", ")}.`,
      );
      return;
    }
    const worktree = await this.#o.worktrees.prepare(dag.repo.root, runId, nodeId, base.commit);
    const attempt = node.attempt + 1;
    const packet = this.#packetFor(runId, state, task);
    const packetBlob = this.#o.store.blobs.put(
      canonicalize(packet),
      "application/vnd.orzeus.packet+json",
    );

    this.#append(runId, [
      this.#draft(
        runId,
        "node.dispatched",
        {
          model: pick.model,
          accountId: pick.entry.account.accountId,
          worktree: worktree.path,
          branch: worktree.branch,
          baseCommit: base.commit,
          packetHash: packet.contentHash,
        },
        { nodeId, attempt, blobs: [packetBlob] },
      ),
    ]);
    this.#say(
      `${nodeId}: attempt ${attempt} started on ${pick.model.adapter}/${pick.model.model}.`,
    );

    const startSession = pick.entry.adapter.startSession;
    if (startSession === undefined) throw new Error(`${pick.model.adapter} cannot run sessions`);
    const at = { nodeId, attempt };
    const gateway = await this.#gatewayFor(runId);
    const token =
      gateway?.grant({
        runId,
        nodeId,
        attempt,
        worktree: worktree.path,
        packet,
        authorize: (call) => this.#authorizeMcp(runId, at, task, packet, call),
        record: (call) => this.#recordMcp(runId, at, call),
      }) ?? null;

    let outcome: SessionOutcome;
    try {
      const session = startSession.call(
        pick.entry.adapter,
        {
          runId,
          nodeId,
          attempt,
          model: pick.model.model,
          packet,
          prompt: renderPacketPrompt(packet, task.checks, task.writeScope),
          worktree,
          mcp: gateway === null || token === null ? null : { url: gateway.url, token },
          budget: task.budget,
          resume: null,
        },
        pick.entry.account,
      );
      outcome = await this.#watch(runId, nodeId, attempt, task, session);
    } finally {
      if (token !== null) gateway?.revoke(token);
    }

    if (outcome.status !== "completed") {
      const kind: FailureKind =
        outcome.status === "budget_exceeded"
          ? "budget"
          : outcome.status === "needs_input"
            ? "ambiguity"
            : "transient";
      const errorClass = outcome.errorClass ?? `worker.${outcome.status}`;
      if (kind === "transient")
        this.#breakers.recordFailure(pick.model.adapter, errorClass, this.#o.clock.now());
      this.#say(`${nodeId}: attempt ${attempt} ended ${outcome.status}: ${outcome.summary}`);
      this.#afterFailure(runId, nodeId, task, kind, outcome.summary, errorClass);
      return;
    }
    this.#breakers.recordSuccess(pick.model.adapter);

    const snapshot = await this.#o.git.snapshot(
      worktree.path,
      `${task.title}\n\n${outcome.summary}\n\nOrzeus-Run: ${runId}\nOrzeus-Node: ${nodeId}\nOrzeus-Attempt: ${attempt}\n`,
    );
    const diff = await this.#o.git.diff(dag.repo.root, base.commit, snapshot.commit);
    const changed = diff.files.map((f) => f.path);
    const diffBlob = this.#o.store.blobs.put(diff.patch, "text/x-diff");
    this.#append(runId, [
      this.#draft(
        runId,
        "diff.captured",
        {
          baseCommit: base.commit,
          headCommit: snapshot.commit,
          diffBlob,
          files: diff.files.length,
          insertions: diff.insertions,
          deletions: diff.deletions,
          outOfScope: outOfScope(changed, task.writeScope),
        },
        { nodeId, attempt, blobs: [diffBlob] },
      ),
      this.#draft(runId, "node.verifying", {}, { nodeId, attempt }),
    ]);

    const results = await runChecks(task.checks, {
      worktree: worktree.path,
      changedPaths: changed,
      writeScope: task.writeScope,
    });
    this.#append(runId, this.#checkDrafts(runId, results, { nodeId, attempt }));

    const failed = results.filter((r) => !r.passed);
    if (failed.length === 0) {
      this.#append(runId, [
        this.#draft(
          runId,
          "node.succeeded",
          { headCommit: snapshot.commit, summary: outcome.summary },
          { nodeId, attempt },
        ),
      ]);
      this.#append(runId, [
        this.#checkpointDraft(runId, this.#state(runId), `${nodeId} succeeded`),
      ]);
      this.#say(
        `${nodeId}: succeeded (${diff.files.length} files, +${diff.insertions} -${diff.deletions}).`,
      );
      return;
    }
    this.#say(`${nodeId}: checks failed: ${failed.map((r) => r.label).join(", ")}.`);
    this.#afterFailure(
      runId,
      nodeId,
      task,
      "checks_failed",
      failed
        .map((r) => r.output)
        .join("\n\n")
        .slice(0, 4_000),
      "checks.failed",
    );
  }

  #checkDrafts(
    runId: RunId,
    results: readonly CheckResult[],
    at: { nodeId: NodeId | null; attempt: number | null },
  ): EventDraft[] {
    return results.map((r) => {
      const outputBlob = this.#o.store.blobs.put(r.output, "text/plain");
      return this.#draft(
        runId,
        "check.completed",
        {
          checkId: r.checkId,
          passed: r.passed,
          exitCode: r.exitCode,
          outputBlob,
          durationMs: r.durationMs,
        },
        { ...at, blobs: [outputBlob] },
      );
    });
  }

  /** Consumes session events: usage, tool calls, quota, and policy decisions on approvals. */
  async #watch(
    runId: RunId,
    nodeId: NodeId,
    attempt: number,
    task: TaskNode,
    session: AgentSession,
  ): Promise<SessionOutcome> {
    const at = { nodeId, attempt };
    const toolStarts = new Map<string, { tool: string; argsHash: Sha256; started: number }>();
    const decisions = new Map<string, GatewayDecision>();
    let lastCall = this.#o.clock.now();
    let turns = 0;
    let tripped = false;
    const started = this.#o.clock.now();
    const wallTimer = setTimeout(() => {
      tripped = true;
      this.#append(runId, [
        this.#draft(
          runId,
          "budget.tripped",
          {
            scope: "node",
            limit: "wall_time",
            limitValue: task.budget.maxWallMs,
            observed: this.#o.clock.now() - started,
          },
          at,
        ),
      ]);
      void session.cancel("wall-time budget exceeded");
    }, task.budget.maxWallMs);

    try {
      for await (const event of session.events) {
        switch (event.type) {
          case "usage": {
            turns++;
            const now = this.#o.clock.now();
            const model = this.#state(runId).nodes[nodeId]?.model;
            if (model === null || model === undefined) break;
            await this.#recordModelCall(runId, at, {
              model,
              tier: task.tier,
              purpose: "work",
              usage: event.usage,
              costMicroUsd: event.costMicroUsd,
              latencyMs: now - lastCall,
            });
            lastCall = now;
            const node = this.#state(runId).nodes[nodeId];
            const trips =
              node === undefined
                ? []
                : nodeBudgetTrips(node, task.budget, { wallMs: now - started, turns });
            if (trips.length > 0 && !tripped) {
              tripped = true;
              this.#append(
                runId,
                trips.map((t) =>
                  this.#draft(
                    runId,
                    "budget.tripped",
                    {
                      scope: "node",
                      limit: t.limit,
                      limitValue: t.limitValue,
                      observed: t.observed,
                    },
                    at,
                  ),
                ),
              );
              void session.cancel(`budget exceeded: ${trips.map((t) => t.limit).join(", ")}`);
            }
            break;
          }
          case "tool_call":
            toolStarts.set(event.callId, {
              tool: event.tool,
              argsHash: contentHash(event.input ?? null, sha256Text),
              started: this.#o.clock.now(),
            });
            break;
          case "tool_result": {
            const start = toolStarts.get(event.callId);
            if (start === undefined) break;
            this.#append(runId, [
              this.#draft(
                runId,
                "tool.call",
                {
                  server: "worker",
                  tool: start.tool,
                  argsHash: start.argsHash,
                  decision: decisions.get(event.callId) ?? "auto_allowed",
                  isError: event.isError,
                  resultHash: contentHash(event.output ?? null, sha256Text),
                  durationMs: this.#o.clock.now() - start.started,
                },
                at,
              ),
            ]);
            break;
          }
          case "approval_request":
            decisions.set(event.requestId, await this.#decide(runId, at, task, session, event));
            break;
          case "quota":
            this.#append(runId, [
              this.#draft(runId, "quota.observed", { windows: [...event.windows] }, at),
            ]);
            this.#o.quota?.observe(event.windows);
            break;
          case "ambiguity":
            this.#say(`${nodeId}: worker reports ambiguity: ${event.question}`);
            break;
          case "log":
            this.#o.logger.log(event.level === "warn" ? "warn" : "debug", "worker", {
              nodeId,
              message: event.message,
            });
            break;
          default:
            break;
        }
      }
      const outcome = await session.outcome;
      return tripped && outcome.status === "cancelled"
        ? { ...outcome, status: "budget_exceeded" }
        : outcome;
    } finally {
      clearTimeout(wallTimer);
    }
  }

  /** Appends a model call and enforces run-level budgets (cost thresholds, frontier tokens). */
  async #recordModelCall(
    runId: RunId,
    at: { nodeId: NodeId | null; attempt: number | null },
    call: TraceEventPayload<"model.call">,
    actor?: Actor,
  ): Promise<void> {
    const before = this.#state(runId);
    const after = this.#append(runId, [
      this.#draft(runId, "model.call", call, { ...at, ...(actor === undefined ? {} : { actor }) }),
    ]);
    const dag = after.dag;
    if (dag === null || after.status !== "executing") return;
    for (const fraction of crossedCostThresholds(dag.budget, before.totals, after.totals)) {
      const exhausted = fraction >= 1;
      const answer = exhausted
        ? null
        : await this.#gate(
            runId,
            null,
            { kind: "budget_threshold", fraction },
            `Spend crossed ${Math.round(fraction * 100)}% of the run budget.`,
          );
      if (answer === null || !answer.approved) {
        this.#pause(
          runId,
          exhausted
            ? "Run cost budget exhausted."
            : `Spending past ${Math.round(fraction * 100)}% of the budget was not approved.`,
        );
        return;
      }
    }
    if (frontierTokensExceeded(dag.budget, after.totals))
      this.#pause(runId, "Frontier token budget exhausted.");
  }

  #pause(runId: RunId, reason: string): void {
    if (this.#state(runId).status !== "executing") return;
    this.#append(runId, [this.#draft(runId, "run.paused", { reason })]);
    this.#say(`Run ${runId} paused: ${reason} Resume with: orzeus resume ${runId}`);
  }

  // ───────────────────────── Policy and gates ─────────────────────────

  async #decide(
    runId: RunId,
    at: { nodeId: NodeId; attempt: number },
    task: TaskNode,
    session: AgentSession,
    event: Extract<AdapterEvent, { type: "approval_request" }>,
  ): Promise<GatewayDecision> {
    const packet = this.#packetFor(runId, this.#state(runId), task);
    const verdict = evaluatePolicy(this.#o.policy, event.action, {
      writeScope: task.writeScope,
      tools: packet.tools,
      checkCommands: task.checks.flatMap((c) => (c.kind === "command" ? [c.argv] : [])),
    });
    if (verdict.effect === "allow") {
      await session.respond(event.requestId, { kind: "allow_once" });
      return "auto_allowed";
    }
    if (verdict.effect === "deny") {
      await session.respond(event.requestId, { kind: "deny", reason: verdict.reason });
      this.#say(`${at.nodeId}: denied ${event.action.kind} (${verdict.ruleId}).`);
      return "denied";
    }
    const answer = await this.#gate(
      runId,
      at,
      event.action,
      `${verdict.reason} (${verdict.ruleId})`,
    );
    await session.respond(
      event.requestId,
      answer.steer !== undefined
        ? { kind: "steer", message: answer.steer }
        : answer.approved
          ? { kind: "allow_once" }
          : { kind: "deny", reason: answer.note ?? "A human gate was not approved." },
    );
    return answer.approved ? "approved" : "denied";
  }

  /** Asks the human (through decideGate) and records the request and the answer. */
  async #gate(
    runId: RunId,
    at: { nodeId: NodeId; attempt: number } | null,
    action: ProposedAction | GateAction,
    reason: string,
  ): Promise<GateAnswer> {
    const approvalId = `ap-${randomHex(8)}` as ApprovalId;
    const where = at ?? { nodeId: null, attempt: null };
    this.#append(runId, [this.#draft(runId, "approval.requested", { approvalId, action }, where)]);
    const answer = await this.#o.decideGate({ runId, nodeId: at?.nodeId ?? null, action, reason });
    this.#append(runId, [
      this.#draft(
        runId,
        "approval.resolved",
        {
          approvalId,
          decision:
            answer.steer !== undefined
              ? { kind: "steer", message: answer.steer }
              : answer.approved
                ? { kind: "allow_once" }
                : { kind: "deny", reason: answer.note ?? "Not approved." },
        },
        { ...where, actor: answer.actor },
      ),
    ]);
    this.#say(
      `${at?.nodeId ?? "run"}: ${answer.approved ? "approved" : "denied"} ${action.kind} (${reason}).`,
    );
    return answer;
  }

  /** Policy for upstream MCP calls made through the gateway. */
  async #authorizeMcp(
    runId: RunId,
    at: { nodeId: NodeId; attempt: number },
    task: TaskNode,
    packet: ContextPacket,
    call: { readonly server: string; readonly tool: string; readonly access: "read" | "write" },
  ): Promise<GatewayDecision> {
    const action: ProposedAction = {
      kind: "mcp_call",
      server: call.server,
      tool: call.tool,
      access: call.access,
    };
    const verdict = evaluatePolicy(this.#o.policy, action, {
      writeScope: task.writeScope,
      tools: packet.tools,
      checkCommands: task.checks.flatMap((c) => (c.kind === "command" ? [c.argv] : [])),
    });
    if (verdict.effect === "allow") return "auto_allowed";
    if (verdict.effect === "deny") return "denied";
    return (await this.#gate(runId, at, action, `${verdict.reason} (${verdict.ruleId})`)).approved
      ? "approved"
      : "denied";
  }

  /** Every gateway call becomes a tool.call event; arguments and result go to the blob store. */
  #recordMcp(runId: RunId, at: { nodeId: NodeId; attempt: number }, call: GatewayCall): void {
    const blob = this.#o.store.blobs.put(
      canonicalize({ args: call.args ?? null, result: call.result ?? null }),
      "application/vnd.orzeus.tool-call+json",
    );
    this.#append(runId, [
      this.#draft(
        runId,
        "tool.call",
        {
          server: call.server,
          tool: call.tool,
          argsHash: contentHash(call.args ?? null, sha256Text),
          decision: call.decision,
          isError: call.isError,
          resultHash: contentHash(call.result ?? null, sha256Text),
          durationMs: call.durationMs,
        },
        { ...at, blobs: [blob] },
      ),
    ]);
  }

  /** The run's gateway, started on first use; null if it cannot start (workers then go without). */
  #gatewayFor(runId: RunId): Promise<McpGateway | null> {
    const open = this.#o.openGateway;
    if (open === undefined) return Promise.resolve(null);
    let gateway = this.#gateways.get(runId);
    if (gateway === undefined) {
      gateway = open(this.#state(runId)).catch((error: unknown) => {
        this.#o.logger.log("warn", "gateway unavailable", {
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.#say(`MCP gateway unavailable; workers run without it (${String(error)}).`);
        return null;
      });
      this.#gateways.set(runId, gateway);
    }
    return gateway;
  }

  // ───────────────────────── Failure, escalation, steering ─────────────────────────

  #afterFailure(
    runId: RunId,
    nodeId: NodeId,
    task: TaskNode,
    kind: FailureKind,
    detail: string,
    errorClass: string,
  ): void {
    const node = this.#state(runId).nodes[nodeId];
    if (node === undefined) return;
    const at = { nodeId, attempt: node.attempt };
    const decision = decideAfterFailure(node, task.retry, task.escalation, kind, this.#o.random());
    switch (decision.kind) {
      case "retry":
        this.#append(runId, [
          this.#draft(
            runId,
            "node.retry_scheduled",
            { nextAttempt: decision.nextAttempt, delayMs: decision.delayMs, reason: kind },
            at,
          ),
        ]);
        this.#say(`${nodeId}: retrying in ${Math.round(decision.delayMs / 1000)}s (${kind}).`);
        return;
      case "escalate":
        // The scheduler loop picks up escalated nodes and steers them (also after a crash).
        this.#append(runId, [
          this.#draft(runId, "node.escalated", { reason: decision.reason }, at),
        ]);
        this.#say(`${nodeId}: escalated to the frontier model (${decision.reason}).`);
        return;
      case "ask_human":
        this.#fail(
          runId,
          nodeId,
          "node.needs_human",
          detail.slice(0, 500) || "The worker needs a decision.",
        );
        return;
      case "fail":
        this.#fail(runId, nodeId, errorClass, detail.slice(0, 500));
        return;
    }
  }

  /**
   * Asks the frontier model what to do with an escalated node, sending only the packet, the
   * last diff and the failing output.
   */
  async #steer(runId: RunId, nodeId: NodeId): Promise<void> {
    const state = this.#state(runId);
    const node = state.nodes[nodeId];
    const task = state.dag?.nodes.find((n) => n.id === nodeId);
    const frontier = this.#o.frontier;
    if (node === undefined || task === undefined) return;
    if (frontier?.adapter.generate === undefined) {
      this.#fail(
        runId,
        nodeId,
        "escalation.unavailable",
        "Needs frontier steering, but no frontier model is configured.",
      );
      return;
    }
    try {
      const events = this.#o.store.events(runId);
      const last = <K extends TraceEventType>(type: K) =>
        events
          .filter(
            (e): e is Extract<TraceEvent, { type: K }> =>
              e.type === type && e.nodeId === nodeId && e.attempt === node.attempt,
          )
          .at(-1);
      const diffEvent = last("diff.captured");
      const diff =
        diffEvent === undefined ? "" : this.#blobText(diffEvent.payload.diffBlob, 12_000);
      const failures = events
        .filter(
          (e): e is Extract<TraceEvent, { type: "check.completed" }> =>
            e.type === "check.completed" &&
            e.nodeId === nodeId &&
            e.attempt === node.attempt &&
            !e.payload.passed,
        )
        .map((e) => this.#blobText(e.payload.outputBlob, 4_000))
        .join("\n\n");
      const reason = events
        .filter((e) => e.type === "node.escalated" && e.nodeId === nodeId)
        .at(-1);
      const packet = this.#packetFor(runId, state, task);
      const adapter = frontier.adapter as Required<Pick<ProviderAdapter, "generate">>;
      const result = await adapter.generate<SteerDecision>(
        {
          model: frontier.ref.model,
          system: STEER_SYSTEM_PROMPT,
          prompt: renderSteerPrompt({
            packet,
            reason: reason?.type === "node.escalated" ? reason.payload.reason : "escalated",
            attempt: node.attempt,
            diff,
            failures,
            workerSummary: node.summary ?? node.lastError?.message ?? "",
          }),
          output: steerOutput,
          maxOutputTokens: 4_000,
        },
        frontier.account,
        AbortSignal.timeout(300_000),
      );
      await this.#recordModelCall(
        runId,
        { nodeId, attempt: node.attempt },
        {
          model: frontier.ref,
          tier: "frontier",
          purpose: "steer",
          usage: result.usage,
          costMicroUsd: result.costMicroUsd,
          latencyMs: result.latencyMs,
        },
        { kind: "model", model: frontier.ref, tier: "frontier" },
      );
      const decision = result.value;
      const actor: Actor = { kind: "model", model: frontier.ref, tier: "frontier" };
      if (decision.action === "give_up") {
        this.#fail(runId, nodeId, "steer.gave_up", decision.note);
        return;
      }
      const drafts: EventDraft[] = [];
      if (decision.action === "rewrite_task" && decision.revisedObjective !== null) {
        const { contentHash: _old, ...body } = this.#plannedPacket(runId, nodeId);
        drafts.push(
          this.#issuePacket(
            runId,
            this.#sealPacket({
              ...body,
              objective: decision.revisedObjective,
              constraints: decision.revisedConstraints.map((text, i) => ({
                id: `s-${i + 1}`,
                text,
                source: "planner" as const,
              })),
            }),
          ),
        );
      }
      drafts.push(
        this.#draft(
          runId,
          "node.steered",
          { note: decision.note, replan: decision.action === "rewrite_task" },
          { nodeId, actor },
        ),
      );
      this.#append(runId, drafts);
      this.#say(`${nodeId}: steered (${decision.action}): ${decision.note}`);
    } catch (error) {
      const current = this.#state(runId).nodes[nodeId];
      if (current?.status === "escalated")
        this.#fail(
          runId,
          nodeId,
          "steer.failed",
          error instanceof Error ? error.message : String(error),
        );
    }
  }

  #fail(runId: RunId, nodeId: NodeId, errorClass: string, message: string): void {
    const node = this.#state(runId).nodes[nodeId];
    this.#append(runId, [
      this.#draft(
        runId,
        "node.failed",
        { errorClass: errorClass.replace(/[^a-z0-9_.]/g, "_"), message },
        { nodeId, attempt: node?.attempt ?? null },
      ),
    ]);
    this.#say(`${nodeId}: failed (${errorClass}): ${message.split("\n")[0] ?? ""}`);
  }

  // ───────────────────────── Integration, review, merge ─────────────────────────

  /**
   * Continues a run whose nodes all succeeded, from whichever step it reached: merge and re-run
   * every check on the combined result, frontier review, then the merge gate.
   */
  async #finish(runId: RunId): Promise<RunState> {
    let state = this.#state(runId);
    const dag = state.dag;
    if (dag === null) throw new Error("run has no plan");
    if (state.status === "integrating") {
      const heads = state.nodeOrder
        .map((id) => state.nodes[id]?.headCommit)
        .filter((c): c is GitOid => c !== null && c !== undefined);
      const merged = await this.#o.git.mergeAll(
        dag.repo.root,
        dag.repo.baseCommit,
        heads,
        (h) => `Orzeus: integrate ${h.slice(0, 12)}\n\nOrzeus-Run: ${runId}\n`,
      );
      if (!merged.ok) {
        this.#say(
          `Run ${runId} failed: integrating ${merged.with.slice(0, 12)} conflicts in ${merged.conflicts.join(", ")}.`,
        );
        return this.#append(runId, [
          this.#draft(runId, "run.failed", {
            errorClass: "integration.conflict",
            message: `Conflicts in ${merged.conflicts.join(", ")}`,
          }),
        ]);
      }
      const worktree = await this.#o.worktrees.prepare(
        dag.repo.root,
        runId,
        INTEGRATION_WORKTREE,
        merged.commit,
      );
      const checks = integrationChecks(dag.nodes, dag.integration.globalChecks);
      this.#say(`Run ${runId}: re-running ${checks.length} checks on the integrated result.`);
      const results = await runChecks(checks, {
        worktree: worktree.path,
        changedPaths: [],
        writeScope: ["**"],
      });
      const recorded = results.map((r) => ({
        checkId: r.checkId,
        passed: r.passed,
        outputBlob: this.#o.store.blobs.put(r.output, "text/plain"),
      }));
      const passed = results.every((r) => r.passed);
      state = this.#append(runId, [
        this.#draft(
          runId,
          "integration.checked",
          { commit: merged.commit, passed, checks: recorded },
          { blobs: recorded.map((r) => r.outputBlob) },
        ),
      ]);
      if (!passed) {
        const failing = results.filter((r) => !r.passed).map((r) => r.label);
        this.#say(`Run ${runId} failed: the integrated result fails ${failing.join(", ")}.`);
        return this.#append(runId, [
          this.#draft(runId, "run.failed", {
            errorClass: "integration.checks_failed",
            message: `Failing after integration: ${failing.join(", ")}`,
          }),
        ]);
      }
      await this.#o.git.updateBranch(dag.repo.root, dag.integration.branch, merged.commit);
    }

    const checked = this.#o.store
      .events(runId)
      .filter((e) => e.type === "integration.checked")
      .at(-1);
    if (checked?.type !== "integration.checked") throw new Error("integration result missing");
    const commit = checked.payload.commit;

    if (state.status === "reviewing") {
      const reviewed = await this.#review(runId, commit);
      if (reviewed === "rejected") return this.#state(runId);
      state = this.#state(runId);
    }

    return this.#merge(runId, commit);
  }

  async #review(runId: RunId, commit: GitOid): Promise<"approved" | "rejected" | "skipped"> {
    const state = this.#state(runId);
    const dag = state.dag;
    const frontier = this.#o.frontier;
    if (dag === null || !dag.integration.frontierReview || frontier?.adapter.generate === undefined)
      return "skipped";
    const diff = await this.#o.git.diff(dag.repo.root, dag.repo.baseCommit, commit);
    const adapter = frontier.adapter as Required<Pick<ProviderAdapter, "generate">>;
    const result = await adapter.generate<ReviewDecision>(
      {
        model: frontier.ref.model,
        system: REVIEW_SYSTEM_PROMPT,
        prompt: renderReviewPrompt({
          goal: state.goal,
          diff: diff.patch.slice(0, 40_000),
          summaries: state.nodeOrder.map((id) => `${id}: ${state.nodes[id]?.summary ?? ""}`),
        }),
        output: reviewOutput,
        maxOutputTokens: 4_000,
      },
      frontier.account,
      AbortSignal.timeout(300_000),
    );
    const actor: Actor = { kind: "model", model: frontier.ref, tier: "frontier" };
    this.#append(runId, [
      this.#draft(
        runId,
        "model.call",
        {
          model: frontier.ref,
          tier: "frontier",
          purpose: "review",
          usage: result.usage,
          costMicroUsd: result.costMicroUsd,
          latencyMs: result.latencyMs,
        },
        { actor },
      ),
      this.#draft(runId, "review.completed", result.value, { actor }),
    ]);
    if (result.value.verdict === "approve") {
      this.#say(`Review approved: ${result.value.summary}`);
      return "approved";
    }
    this.#say(`Review requested changes: ${result.value.concerns.join("; ")}`);
    this.#append(runId, [
      this.#draft(runId, "run.failed", {
        errorClass: "review.rejected",
        message: result.value.concerns.join("\n").slice(0, 2_000) || result.value.summary,
      }),
    ]);
    return "rejected";
  }

  /** The merge gate: offers to fast-forward the user's branch to the integrated result. */
  async #merge(runId: RunId, commit: GitOid): Promise<RunState> {
    const state = this.#state(runId);
    const dag = state.dag;
    if (dag === null) throw new Error("run has no plan");
    const repo = dag.repo.root;
    const branch =
      dag.repo.baseRef === "HEAD" ? await this.#o.git.currentBranch(repo) : dag.repo.baseRef;
    let mergedInto: string | null = null;
    if (branch !== null && (await this.#o.git.branchExists(repo, branch))) {
      const answer = await this.#gate(
        runId,
        null,
        { kind: "merge", from: dag.integration.branch, into: branch },
        `Fast-forward ${branch} to the integrated result.`,
      );
      if (answer.approved) {
        const result = await this.#o.git.fastForward(repo, branch, dag.repo.baseCommit, commit);
        if (result.ok) {
          mergedInto = branch;
          this.#say(`Merged into ${branch}.`);
        } else {
          this.#say(`Not merged: ${result.reason}. The result stays on ${dag.integration.branch}.`);
        }
      }
    }
    this.#say(
      `Run ${runId} completed. Integrated result is on branch ${dag.integration.branch} (${commit.slice(0, 12)}).`,
    );
    return this.#append(runId, [
      this.#draft(runId, "run.completed", { integrationCommit: commit, mergedInto }),
    ]);
  }

  // ───────────────────────── Packets, checkpoints, helpers ─────────────────────────

  /** Base commit for a node: the run's base, or its dependencies' results merged together. */
  async #baseFor(
    state: RunState,
    node: NodeState,
  ): Promise<{ ok: true; commit: GitOid } | { ok: false; conflicts: readonly string[] }> {
    const dag = state.dag;
    if (dag === null) throw new Error("run has no plan");
    const heads = node.dependsOn
      .map((d) => state.nodes[d]?.headCommit)
      .filter((c): c is GitOid => c !== null && c !== undefined);
    if (heads.length === 0) return { ok: true, commit: dag.repo.baseCommit };
    return this.#o.git.mergeAll(
      dag.repo.root,
      dag.repo.baseCommit,
      heads,
      (head) => `Orzeus: combine dependency ${head.slice(0, 12)} for ${node.id}`,
    );
  }

  /** The node's latest issued packet (re-issued when steering rewrites the task). */
  #plannedPacket(runId: RunId, nodeId: NodeId): ContextPacket {
    const issued = this.#o.store
      .events(runId)
      .filter((e) => e.type === "packet.issued" && e.nodeId === nodeId)
      .at(-1);
    const blob =
      issued?.blobs[0] === undefined ? undefined : this.#o.store.blobs.get(issued.blobs[0]);
    if (blob === undefined) throw new Error(`no packet for ${nodeId}`);
    return ContextPacket.parse(JSON.parse(new TextDecoder().decode(blob.bytes)));
  }

  /** The packet a worker gets: the latest planned packet plus upstream results and steering notes. */
  #packetFor(runId: RunId, state: RunState, task: TaskNode): ContextPacket {
    const planned = this.#plannedPacket(runId, task.id);
    const upstream = task.dependsOn.flatMap((dep) => {
      const d = state.nodes[dep];
      if (d === undefined || d.headCommit === null) return [];
      return [
        {
          nodeId: dep,
          summary: d.summary ?? "",
          headCommit: d.headCommit,
          diffStat: { files: 0, insertions: 0, deletions: 0 },
        },
      ];
    });
    const steering = this.#o.store.events(runId).flatMap((e) =>
      e.type === "node.steered" && e.nodeId === task.id && e.actor.kind === "model"
        ? [
            {
              attempt: Math.max(1, state.nodes[task.id]?.attempt ?? 1),
              from: e.actor.model,
              note: e.payload.note,
            },
          ]
        : [],
    );
    const { contentHash: _old, ...body } = planned;
    return this.#sealPacket({ ...body, upstream, steering });
  }

  #issuePacket(runId: RunId, packet: ContextPacket): EventDraft {
    const blob = this.#o.store.blobs.put(
      canonicalize(packet),
      "application/vnd.orzeus.packet+json",
    );
    return this.#draft(
      runId,
      "packet.issued",
      { packetId: packet.id, contentHash: packet.contentHash },
      { nodeId: packet.nodeId, blobs: [blob] },
    );
  }

  #sealPacket(body: ContextPacketBody): ContextPacket {
    return { ...body, contentHash: contentHash(body, sha256Text) };
  }

  #checkpointDraft(runId: RunId, state: RunState, label: string): EventDraft {
    const refs: Record<string, GitOid> = {};
    for (const node of Object.values(state.nodes))
      if (node.status === "succeeded" && node.headCommit !== null) refs[node.id] = node.headCommit;
    // Checkpoint ids are global in the store, so they carry the run id.
    const checkpointId = `${runId}.cp${Object.keys(state.checkpoints).length + 1}` as CheckpointId;
    return this.#draft(runId, "checkpoint.created", { checkpointId, label, refs });
  }

  #blobText(hash: Sha256, max: number): string {
    const blob = this.#o.store.blobs.get(hash);
    return blob === undefined ? "" : new TextDecoder().decode(blob.bytes).slice(0, max);
  }

  #planningDrafts(runId: RunId, planning: readonly PlanningRecord[]): EventDraft[] {
    return planning.map((c) =>
      this.#draft(
        runId,
        "model.call",
        {
          model: c.model,
          tier: "frontier",
          purpose: "plan",
          usage: c.usage,
          costMicroUsd: c.costMicroUsd,
          latencyMs: c.latencyMs,
        },
        { actor: { kind: "model", model: c.model, tier: "frontier" } },
      ),
    );
  }

  #state(runId: RunId): RunState {
    const state = this.#o.store.load(runId);
    if (state === null) throw new Error(`unknown run ${runId}`);
    return state;
  }

  #append(runId: RunId, drafts: readonly EventDraft[]): RunState {
    return this.#o.store.append(runId, drafts);
  }

  #draft<K extends TraceEventType>(
    runId: RunId,
    type: K,
    payload: TraceEventPayload<K>,
    options: {
      nodeId?: NodeId | null;
      attempt?: number | null;
      actor?: Actor;
      blobs?: readonly Sha256[];
    } = {},
  ): EventDraft {
    let traceId = this.#traceIds.get(runId);
    if (traceId === undefined) {
      traceId = sha256Text(runId).slice(0, 32);
      this.#traceIds.set(runId, traceId);
    }
    return {
      ts: this.#o.clock.now(),
      type,
      nodeId: options.nodeId ?? null,
      attempt: options.attempt ?? null,
      actor: options.actor ?? ENGINE,
      payload,
      blobs: [...(options.blobs ?? [])],
      otel: { traceId, spanId: randomHex(8), parentSpanId: null },
    } as EventDraft;
  }

  #say(line: string): void {
    this.#o.progress?.(line);
  }
}

/** Every node's command checks (deduplicated) plus the plan's global checks, for the merged result. */
export function integrationChecks(
  nodes: readonly TaskNode[],
  global: readonly CheckSpec[],
): CheckSpec[] {
  const seen = new Set<string>();
  const out: CheckSpec[] = [];
  const all = [
    ...nodes.flatMap((n) => n.checks.map((c) => ({ node: n.id as string, check: c }))),
    ...global.map((c) => ({ node: "global", check: c })),
  ];
  for (const check of all) {
    if (check.check.kind !== "command") continue;
    const key = `${check.check.cwd}\u0000${check.check.argv.join("\u0000")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...check.check,
      id: `${check.node}.${check.check.id}`.replace(/[^a-z0-9_.-]/g, "-").slice(0, 64),
    });
  }
  return out;
}

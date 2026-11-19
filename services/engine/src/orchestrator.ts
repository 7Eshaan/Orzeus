import { outOfScope, runChecks } from "@orzeus/checks";
import {
  type Clock,
  decideAfterFailure,
  decideNext,
  evaluatePolicy,
  type FailureKind,
  type NodeState,
  nextWakeAt,
  nodeBudgetTrips,
  type Random,
  type RunState,
  renderPacketPrompt,
} from "@orzeus/core";
import type { Git, WorktreeManager } from "@orzeus/git";
import type {
  AdapterEvent,
  AdapterRegistry,
  AgentSession,
  SessionOutcome,
} from "@orzeus/providers";
import {
  type Actor,
  type ApprovalId,
  ContextPacket,
  type ContextPacketBody,
  type EventDraft,
  type GitOid,
  type NodeId,
  type PlannerOutput,
  type PolicyDocument,
  type ProjectId,
  type RunId,
  type Sha256,
  type TaskNode,
  TERMINAL_RUN_STATUSES,
  type TraceEventPayload,
  type TraceEventType,
} from "@orzeus/schema";
import { type SqliteRunStore, sha256Text } from "@orzeus/store";
import { canonicalize, contentHash } from "@orzeus/trace";
import { randomHex } from "./ids.js";
import type { Logger } from "./logger.js";

export interface OrchestratorOptions {
  readonly store: SqliteRunStore;
  readonly git: Git;
  readonly worktrees: WorktreeManager;
  readonly adapters: AdapterRegistry;
  readonly policy: PolicyDocument;
  readonly clock: Clock;
  readonly random: Random;
  readonly logger: Logger;
  /** Headless runs have no human: policy "ask" verdicts are denied unless this is true. */
  readonly approveAsks: boolean;
  /** Human-readable progress lines (the CLI prints them). */
  readonly progress?: (line: string) => void;
}

const ENGINE: Actor = { kind: "engine" };

/**
 * Drives runs: turns scheduler decisions into events, runs worker sessions in worktrees,
 * verifies their work, and integrates the result. Every decision is an appended event, so a
 * crash at any point can be resumed from the log (see resume).
 *
 * Phase 2 scope: one engine process per database (leases arrive in Phase 4) and no frontier
 * steering (escalations go to a human, which headless mode reports as a failure).
 */
export class RunOrchestrator {
  readonly #o: OrchestratorOptions;
  readonly #traceIds = new Map<RunId, string>();
  readonly #active = new Map<string, Promise<void>>();

  constructor(options: OrchestratorOptions) {
    this.#o = options;
  }

  /** Records a new run with its plan and packets, awaiting plan approval. */
  createRun(projectId: ProjectId, plan: PlannerOutput): RunId {
    const { dag, packets } = plan;
    const runId = dag.runId;
    this.#append(runId, [
      this.#draft(runId, "run.created", { projectId, goal: dag.goal, repo: dag.repo }),
    ]);
    const issued: EventDraft[] = packets.map((body) => {
      const packet = this.#sealPacket(body);
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
    });
    this.#append(runId, [
      ...issued,
      this.#draft(runId, "plan.proposed", { revision: dag.revision, dag }),
    ]);
    this.#say(`Run ${runId}: plan with ${dag.nodes.length} nodes is waiting for approval.`);
    return runId;
  }

  approvePlan(runId: RunId, edited = false): void {
    const state = this.#state(runId);
    const revision = state.proposedDag?.revision;
    if (revision === undefined) throw new Error("no plan is waiting for approval");
    this.#append(runId, [
      this.#draft(runId, "plan.approved", { revision, edited }, { actor: { kind: "human" } }),
    ]);
  }

  /**
   * Recovers a run after a crash: pending approvals of interrupted nodes are closed and the
   * interrupted attempts are rescheduled immediately; then execution continues.
   */
  async resume(runId: RunId): Promise<RunState> {
    const state = this.#state(runId);
    if (TERMINAL_RUN_STATUSES.has(state.status)) return state;
    const drafts: EventDraft[] = [this.#draft(runId, "run.resumed", { afterCrash: true })];
    for (const node of Object.values(state.nodes)) {
      if (!["running", "verifying", "awaiting_approval"].includes(node.status)) continue;
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
          { nextAttempt: node.attempt + 1, delayMs: 0, reason: "interrupted by an engine restart" },
          { nodeId: node.id, attempt: node.attempt },
        ),
      );
      this.#say(`${node.id}: attempt ${node.attempt} was interrupted; retrying.`);
    }
    this.#append(runId, drafts);
    return this.execute(runId);
  }

  /** Runs the approved plan until it settles. */
  async execute(runId: RunId): Promise<RunState> {
    for (;;) {
      const state = this.#state(runId);
      if (TERMINAL_RUN_STATUSES.has(state.status)) return state;
      if (state.status !== "executing") throw new Error(`run is ${state.status}, not executing`);

      const actions = decideNext(state, this.#o.clock.now());
      const settled = actions.find((a) => a.kind === "settled");
      if (settled !== undefined) {
        await Promise.all(this.#active.values());
        return this.#settle(runId, settled.allSucceeded);
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
      for (const action of actions) {
        // A node stays "ready" until its attempt records node.dispatched, so skip ones in flight.
        if (action.kind !== "dispatch" || this.#active.has(action.nodeId)) continue;
        const task = this.#attempt(runId, action.nodeId).finally(() =>
          this.#active.delete(action.nodeId),
        );
        this.#active.set(action.nodeId, task);
        started++;
      }
      if (started > 0) {
        // Let the new attempts reach their first await before scheduling again.
        await Promise.resolve();
        continue;
      }

      if (this.#active.size > 0) {
        await Promise.race(this.#active.values());
        continue;
      }
      const wake = nextWakeAt(this.#state(runId));
      if (wake !== null) {
        await new Promise((r) => setTimeout(r, Math.max(0, wake - this.#o.clock.now())));
        continue;
      }
      if (drafts.length > 0) continue;
      throw new Error(`run ${runId} is stuck: nothing is running, ready or waiting`);
    }
  }

  async #settle(runId: RunId, allSucceeded: boolean): Promise<RunState> {
    const state = this.#state(runId);
    if (!allSucceeded) {
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
    const heads = state.nodeOrder
      .map((id) => state.nodes[id]?.headCommit)
      .filter((c): c is GitOid => c !== null && c !== undefined);
    const merged = await this.#o.git.mergeAll(
      dag.repo.root,
      dag.repo.baseCommit,
      heads,
      (head) => `Orzeus: integrate ${head.slice(0, 12)}\n\nOrzeus-Run: ${runId}\n`,
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
    await this.#o.git.updateBranch(dag.repo.root, dag.integration.branch, merged.commit);
    this.#say(
      `Run ${runId} completed. Integrated result is on branch ${dag.integration.branch} (${merged.commit.slice(0, 12)}).`,
    );
    return this.#append(runId, [
      this.#draft(runId, "run.completed", { integrationCommit: merged.commit }),
    ]);
  }

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

    const pick = this.#o.adapters.pick(task.candidates);
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
        mcp: null,
        budget: task.budget,
        resume: null,
      },
      pick.entry.account,
    );

    const outcome = await this.#watch(runId, nodeId, attempt, task, session);
    if (outcome.status !== "completed") {
      const kind: FailureKind =
        outcome.status === "budget_exceeded"
          ? "budget"
          : outcome.status === "needs_input"
            ? "ambiguity"
            : "transient";
      this.#say(`${nodeId}: attempt ${attempt} ended ${outcome.status}: ${outcome.summary}`);
      this.#afterFailure(
        runId,
        nodeId,
        task,
        kind,
        outcome.summary,
        outcome.errorClass ?? `worker.${outcome.status}`,
      );
      return;
    }

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
    this.#append(
      runId,
      results.map((r) => {
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
          { nodeId, attempt, blobs: [outputBlob] },
        );
      }),
    );

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
        .slice(0, 2_000),
      "checks.failed",
    );
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
    const decisions = new Map<string, "auto_allowed" | "approved" | "denied">();
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
          { ...at },
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
            this.#append(runId, [
              this.#draft(
                runId,
                "model.call",
                {
                  model,
                  tier: task.tier,
                  purpose: "work",
                  usage: event.usage,
                  costMicroUsd: event.costMicroUsd,
                  latencyMs: now - lastCall,
                },
                at,
              ),
            ]);
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

  async #decide(
    runId: RunId,
    at: { nodeId: NodeId; attempt: number },
    task: TaskNode,
    session: AgentSession,
    event: Extract<AdapterEvent, { type: "approval_request" }>,
  ): Promise<"auto_allowed" | "approved" | "denied"> {
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
    // "ask": a human gate. Headless mode has no human, so it records the request and decides now.
    const approvalId = `ap-${randomHex(8)}` as ApprovalId;
    const decision = this.#o.approveAsks
      ? ({ kind: "allow_once" } as const)
      : ({
          kind: "deny",
          reason: "No human is available in headless mode (run with --approve-asks to allow).",
        } as const);
    const policyActor: Actor = {
      kind: "policy",
      ruleId: this.#o.approveAsks ? "headless_approve_asks" : "headless_deny_asks",
    };
    this.#append(runId, [
      this.#draft(runId, "approval.requested", { approvalId, action: event.action }, at),
      this.#draft(
        runId,
        "approval.resolved",
        { approvalId, decision },
        { ...at, actor: policyActor },
      ),
    ]);
    await session.respond(event.requestId, decision);
    this.#say(
      `${at.nodeId}: ${decision.kind === "allow_once" ? "approved" : "denied"} ${event.action.kind} needing a human (${verdict.ruleId}).`,
    );
    return decision.kind === "allow_once" ? "approved" : "denied";
  }

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
        this.#append(runId, [
          this.#draft(runId, "node.escalated", { reason: decision.reason }, at),
          this.#draft(
            runId,
            "node.failed",
            {
              errorClass: "escalation.unavailable",
              message: `Needs frontier steering (${decision.reason}), which arrives in Phase 3.`,
            },
            at,
          ),
        ]);
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

  /** The node's packet with upstream results filled in from its dependencies. */
  #packetFor(runId: RunId, state: RunState, task: TaskNode): ContextPacket {
    const issued = this.#o.store
      .events(runId)
      .find((e) => e.type === "packet.issued" && e.nodeId === task.id);
    const blob =
      issued?.blobs[0] === undefined ? undefined : this.#o.store.blobs.get(issued.blobs[0]);
    if (blob === undefined) throw new Error(`no packet for ${task.id}`);
    const planned = ContextPacket.parse(JSON.parse(new TextDecoder().decode(blob.bytes)));
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
    const { contentHash: _old, ...body } = planned;
    return this.#sealPacket({ ...body, upstream });
  }

  #sealPacket(body: ContextPacketBody): ContextPacket {
    return { ...body, contentHash: contentHash(body, sha256Text) };
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

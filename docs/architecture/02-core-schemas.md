# Core schemas

> **Implemented in Phase 1.** The Zod schemas in `packages/schema/src` are now the source of
> truth. This page is the readable type-level view; where the two differ, the code wins.

These are the type-level views of the four core contracts. In code, the source of truth will be
**Zod 4 schemas in `@orzeus/schema`**, with these types produced by `z.infer`. Zod matters here
because three of these shapes arrive from untrusted places (LLM planner output, provider
streams, MCP results) and must be validated at runtime, and because Zod 4 can emit JSON Schema
for providers' structured-output modes.

All snippets in this file were extracted and typechecked together with TypeScript 7.0.2 in
strict mode (see "How this file is checked" at the end).

Conventions:

- Ids are branded strings. Run ids are ULIDs (sortable). Node ids are short planner-chosen
  slugs, unique within a run.
- Times are unix milliseconds. Money is integer **micro-USD** (no floats in accounting).
- Everything is `readonly`. State changes happen by appending events, never by mutation.
- Every top-level document has `schemaVersion` so stored JSON can be migrated.

## Shared primitives

```ts
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type RunId = Brand<string, "RunId">;
export type NodeId = Brand<string, "NodeId">;
export type PacketId = Brand<string, "PacketId">;
export type AccountId = Brand<string, "AccountId">;
export type ApprovalId = Brand<string, "ApprovalId">;
export type CheckpointId = Brand<string, "CheckpointId">;
export type ProjectId = Brand<string, "ProjectId">;
/** Lowercase hex SHA-256. Content address for blobs, packets and trace hashes. */
export type Sha256 = Brand<string, "Sha256">;
/** Git object id (SHA-1 or SHA-256 repos). */
export type GitOid = Brand<string, "GitOid">;

export type UnixMs = number;
export type MicroUsd = number;

export type Tier = "frontier" | "worker" | "local";
export type ProviderId = "anthropic" | "openai" | "cursor" | "google" | "acp" | "openai_compatible";

export interface ModelRef {
  readonly provider: ProviderId;
  /** Adapter id, e.g. "claude-cli", "codex-app-server", "gemini-api". */
  readonly adapter: string;
  /** Provider's model name as the adapter expects it. */
  readonly model: string;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
}
```

## TaskDAG

The plan. Produced by the planner, validated, approved by you, then immutable for the run. A
re-plan creates a new DAG revision (an event), it never edits the old one.

```ts
export interface TaskDAG {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  /** Increments on every re-plan of the run. */
  readonly revision: number;
  /** Your goal, verbatim. */
  readonly goal: string;
  readonly repo: RepoRef;
  readonly plannedBy: ModelRef;
  /** Dependencies live on nodes (`dependsOn`); there is no separate edge list to drift. */
  readonly nodes: readonly TaskNode[];
  readonly integration: IntegrationSpec;
  readonly budget: RunBudget;
}

export interface RepoRef {
  readonly root: string;
  /** Branch or ref the run starts from, e.g. "main". */
  readonly baseRef: string;
  /** Commit pinned at plan time so every worktree starts from the same point. */
  readonly baseCommit: GitOid;
}

export type NodeKind = "implement" | "test" | "refactor" | "investigate" | "docs";

export interface TaskNode {
  readonly id: NodeId;
  readonly title: string;
  readonly kind: NodeKind;
  readonly dependsOn: readonly NodeId[];
  readonly tier: Tier;
  /** Ordered preferences; the router picks the first with an account and quota headroom. */
  readonly candidates: readonly ModelRef[];
  readonly packetId: PacketId;
  /**
   * Globs the node may change. Empty means read-only. The scheduler never runs two nodes with
   * overlapping write scopes at once, and verification rejects changes outside the scope.
   */
  readonly writeScope: readonly string[];
  readonly checks: readonly CheckSpec[];
  readonly budget: NodeBudget;
  readonly retry: RetryPolicy;
  readonly escalation: EscalationPolicy;
}

export type CheckSpec =
  | {
      readonly kind: "command";
      readonly id: string;
      readonly label: string;
      /** argv, executed without a shell. */
      readonly argv: readonly [string, ...string[]];
      /** Relative to the worktree root. */
      readonly cwd: string;
      readonly timeoutMs: number;
      readonly expectExitCode: number;
    }
  | {
      readonly kind: "json_schema";
      readonly id: string;
      readonly label: string;
      /** File in the worktree that must validate against the schema. */
      readonly path: string;
      readonly schema: Readonly<Record<string, unknown>>;
    }
  | {
      /** Built in: fails if the diff touches anything outside writeScope. */
      readonly kind: "scope_guard";
      readonly id: string;
      readonly label: string;
    };

export interface NodeBudget {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxCostMicroUsd: MicroUsd;
  readonly maxWallMs: number;
  readonly maxTurns: number;
}

export interface RunBudget {
  readonly maxCostMicroUsd: MicroUsd;
  /** Cap on frontier tokens across planning, steering and review. */
  readonly maxFrontierTokens: number;
  readonly maxConcurrency: number;
  /** Ask a human when spend crosses these fractions of maxCostMicroUsd, e.g. [0.5, 0.8]. */
  readonly approvalThresholds: readonly number[];
}

export interface RetryPolicy {
  /** Includes the first attempt. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** delay = random(0, min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))) */
  readonly jitter: "full";
}

export interface EscalationPolicy {
  /** Worker retries with check output this many times before the frontier model is asked. */
  readonly workerRetriesOnCheckFailure: number;
  readonly onAmbiguity: "escalate" | "ask_human";
  /** Frontier steers allowed for this node before it fails and asks a human. */
  readonly maxSteers: number;
}

export interface IntegrationSpec {
  readonly strategy: "merge_topological";
  readonly branch: string;
  /** Run after all nodes merge, before frontier review. */
  readonly globalChecks: readonly CheckSpec[];
  readonly frontierReview: boolean;
}
```

### Node and run state machines

```ts
export type RunStatus =
  | "planning"
  | "awaiting_plan_approval"
  | "executing"
  | "paused"
  | "integrating"
  | "reviewing"
  | "awaiting_merge_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type NodeStatus =
  | "pending" // waiting on dependencies
  | "ready" // dependencies succeeded, waiting for a slot
  | "running" // leased by a worker session
  | "verifying" // Orzeus is running checks
  | "awaiting_approval" // blocked on a human gate
  | "retry_wait" // backoff timer
  | "escalated" // waiting on a frontier steer
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped"; // an upstream node failed
```

Transitions are defined in `@orzeus/core` as a pure reducer `(state, event) => state`, and the
same reducer is used for live execution and for crash replay, so the two cannot drift.

```
pending ─deps ok─▶ ready ─lease─▶ running ─worker done─▶ verifying ─pass─▶ succeeded
                     ▲              │  ▲                   │
                     │              │  └─ approval ◀───────┤ (gate)
                     │              ▼                      ▼ fail
                retry_wait ◀── transient error      worker retry left? ─yes─▶ ready
                                                           │ no
                                                           ▼
                                                       escalated ─steer─▶ ready
                                                           │ out of steers
                                                           ▼
                                                     failed ─▶ dependents skipped
```

### Plan validation (all in `core`, all property-tested)

- Schema valid; node ids unique; every `dependsOn` exists; graph is acyclic.
- Every node has a packet and every packet references its node.
- Every `candidates` entry matches the node's tier and an enabled adapter.
- Tool grants in packets are within the policy (no write tools for read-only nodes).
- Write-scope overlaps between nodes with no dependency path are reported. They are allowed but
  serialized by the scheduler; the plan view shows it.
- Budgets fit inside the run budget.

## ContextPacket

Everything a worker needs, and nothing else. Immutable and content-addressed: `contentHash` is
SHA-256 over the canonical JSON of the packet minus that field, so the trace can prove exactly
what a worker saw.

```ts
export interface ContextPacket {
  readonly schemaVersion: 1;
  readonly id: PacketId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  /** One focused paragraph. */
  readonly objective: string;
  readonly nonGoals: readonly string[];
  readonly acceptance: readonly AcceptanceCriterion[];
  /** Pointers, not file dumps. Resolved lazily through the gateway's MCP resources. */
  readonly context: readonly ContextRef[];
  readonly constraints: readonly Constraint[];
  readonly tools: ToolAllowlist;
  /** Compact results of dependency nodes, filled in when the node becomes ready. */
  readonly upstream: readonly UpstreamResult[];
  /** Steering notes from the frontier model on earlier attempts, newest last. */
  readonly steering: readonly SteerNote[];
  readonly limits: { readonly maxContextTokens: number };
  readonly contentHash: Sha256;
}

export interface AcceptanceCriterion {
  readonly id: string;
  readonly statement: string;
  /** Links to a CheckSpec id when the criterion is machine-checkable. */
  readonly checkId: string | null;
}

export type ContextRef =
  | {
      readonly kind: "file_range";
      readonly path: string;
      readonly startLine: number;
      readonly endLine: number;
      readonly why: string;
    }
  | {
      readonly kind: "symbol";
      readonly path: string;
      /** e.g. "AuthService.refresh" */
      readonly symbol: string;
      readonly symbolKind: "function" | "method" | "class" | "interface" | "type" | "const";
      readonly why: string;
    }
  | {
      /** Any resource on an allowlisted upstream MCP server. */
      readonly kind: "mcp_resource";
      readonly server: string;
      readonly uri: string;
      readonly why: string;
    }
  | {
      readonly kind: "memory";
      readonly memoryId: string;
      readonly why: string;
    };

export interface Constraint {
  readonly id: string;
  readonly text: string;
  readonly source: "memory" | "planner" | "user";
}

export interface ToolAllowlist {
  readonly mcp: readonly McpToolGrant[];
  /** Built-in agent capabilities, enforced through the adapter's permission mode. */
  readonly builtin: readonly BuiltinGrant[];
  readonly network: "none" | "package_registries" | "allowlist";
  readonly networkAllowlist: readonly string[];
}

export interface McpToolGrant {
  readonly server: string;
  readonly tool: string;
  readonly access: "read" | "write";
  /**
   * eager: listed up front. lazy: hidden behind the gateway's `find_tools` meta-tool, so large
   * tool sets do not bloat the worker's context.
   */
  readonly loading: "eager" | "lazy";
}

export type BuiltinGrant =
  | { readonly kind: "read_files" }
  | { readonly kind: "edit_files" }
  | {
      /** Allowed argv prefixes, e.g. ["pnpm", "test"]. Anything else is a gated action. */
      readonly kind: "shell";
      readonly argvPrefixes: readonly (readonly string[])[];
    };

export interface UpstreamResult {
  readonly nodeId: NodeId;
  readonly summary: string;
  readonly headCommit: GitOid;
  readonly diffStat: {
    readonly files: number;
    readonly insertions: number;
    readonly deletions: number;
  };
}

export interface SteerNote {
  readonly attempt: number;
  readonly from: ModelRef;
  readonly note: string;
}
```

The gateway exposes packet context as MCP resources with stable URIs, for example
`orzeus://run/<runId>/node/<nodeId>/file/src/auth.ts#L10-L80` and
`orzeus://run/<runId>/node/<nodeId>/symbol/src/auth.ts#AuthService.refresh`. Symbol ranges are
resolved with tree-sitter at read time against the node's worktree.

## ProviderAdapter

One interface for every provider. Two shapes of work:

- `generate` for one-shot structured output (planning, steering, review). Needs a model API or
  a CLI that supports a JSON schema output mode.
- `startSession` for agentic work inside a worktree (workers). CLIs and ACP agents run their own
  loop; raw model APIs (Anthropic, OpenAI, Gemini, Ollama) get Orzeus's minimal built-in tool
  loop over the gateway.

```ts
export interface ProviderAdapter {
  readonly manifest: AdapterManifest;
  /** Is the binary present, the key valid, the endpoint reachable? Never spends tokens. */
  probe(account: AccountContext, signal: AbortSignal): Promise<ProbeResult>;
  listModels(account: AccountContext, signal: AbortSignal): Promise<readonly ModelInfo[]>;
  /** Present when manifest.capabilities.structuredOutput is true. */
  generate?<T>(
    request: GenerateRequest<T>,
    account: AccountContext,
    signal: AbortSignal,
  ): Promise<GenerateResult<T>>;
  /** Present when manifest.capabilities.agentSession is true. */
  startSession?(request: SessionRequest, account: AccountContext): AgentSession;
  /** Official quota signal, when the provider has one (e.g. codex account/rateLimits/read). */
  readQuota?(account: AccountContext, signal: AbortSignal): Promise<readonly QuotaWindow[]>;
}

export interface AdapterManifest {
  readonly id: string;
  readonly provider: ProviderId;
  readonly displayName: string;
  readonly transport: "http_api" | "cli_stream_json" | "cli_jsonl" | "json_rpc_stdio" | "acp_stdio";
  readonly auth: readonly AuthMethod[];
  readonly capabilities: AdapterCapabilities;
  readonly compliance: ComplianceProfile;
}

export type AuthMethod =
  /** Stored in the OS keychain under secretName; Orzeus passes it via env or header. */
  | { readonly kind: "api_key"; readonly secretName: string; readonly envVar: string }
  /**
   * The user's own installed CLI, already signed in by the user in that CLI.
   * Orzeus never reads, copies or refreshes that CLI's credentials.
   */
  | { readonly kind: "own_cli_login"; readonly binary: string }
  | { readonly kind: "service_account"; readonly secretName: string }
  | { readonly kind: "none" };

export interface AdapterCapabilities {
  readonly structuredOutput: boolean;
  readonly agentSession: boolean;
  readonly mcpClient: boolean;
  readonly resume: boolean;
  readonly steerMidTurn: boolean;
  /** Adapter surfaces tool approvals to Orzeus instead of deciding itself. */
  readonly approvalCallbacks: boolean;
  readonly reportsUsage: "exact" | "estimated" | "none";
  readonly reportsQuota: boolean;
}

/**
 * Literal `false` types make non-compliant adapters fail to typecheck, and the conformance
 * suite asserts the runtime behaviour matches.
 */
export interface ComplianceProfile {
  /** Link to the provider's documentation for the interface used. */
  readonly officialInterface: string;
  readonly readsForeignCredentials: false;
  readonly rotatesAccounts: false;
  readonly spoofsClient: false;
  readonly notes: string;
}

export interface AccountContext {
  readonly accountId: AccountId;
  readonly label: string;
  readonly auth: AuthMethod;
  /** Resolves a keychain secret at call time. Never cached by adapters. */
  getSecret(name: string): Promise<string>;
}

export type ProbeResult =
  | { readonly ok: true; readonly version: string; readonly detail: string }
  | {
      readonly ok: false;
      readonly reason: "not_installed" | "unauthenticated" | "unreachable" | "incompatible_version";
      readonly detail: string;
    };

export interface ModelInfo {
  readonly model: string;
  readonly suggestedTier: Tier;
  readonly contextWindow: number | null;
  /** Price per million tokens in micro-USD, when known. Used for cost and quota-saved estimates. */
  readonly pricing: {
    readonly inputPerMTok: MicroUsd;
    readonly outputPerMTok: MicroUsd;
  } | null;
}

export interface GenerateRequest<T> {
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  /** Zod schema at runtime; adapters convert to JSON Schema for the provider. */
  readonly output: OutputSchema<T>;
  readonly maxOutputTokens: number;
  readonly trace: TraceContext;
}

export interface OutputSchema<T> {
  readonly name: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  parse(value: unknown): T;
}

export interface GenerateResult<T> {
  readonly value: T;
  readonly usage: TokenUsage;
  readonly costMicroUsd: MicroUsd | null;
  readonly quota: readonly QuotaWindow[];
}

export interface SessionRequest {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attempt: number;
  readonly model: string;
  readonly packet: ContextPacket;
  /** Packet rendered into the adapter's prompt format by core's renderer. */
  readonly prompt: string;
  readonly worktree: { readonly path: string; readonly branch: string };
  /** Per-node MCP endpoint on the gateway (loopback URL + bearer token). */
  readonly mcp: { readonly url: string; readonly token: string };
  readonly budget: NodeBudget;
  readonly resume: ResumeToken | null;
  readonly trace: TraceContext;
}

export interface ResumeToken {
  readonly adapter: string;
  /** e.g. Claude session id or Codex thread id. */
  readonly value: string;
}

export interface TraceContext {
  readonly traceId: string;
  readonly parentSpanId: string;
}

export interface AgentSession {
  readonly events: AsyncIterable<AdapterEvent>;
  /** Mid-turn steering, when capabilities.steerMidTurn; otherwise queued for the next turn. */
  steer(message: string): Promise<void>;
  respond(requestId: string, decision: ApprovalDecision): Promise<void>;
  cancel(reason: string): Promise<void>;
  readonly outcome: Promise<SessionOutcome>;
}

export type AdapterEvent =
  | { readonly type: "message_delta"; readonly text: string }
  | {
      readonly type: "tool_call";
      readonly callId: string;
      readonly tool: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly callId: string;
      readonly isError: boolean;
      readonly output: unknown;
    }
  | {
      readonly type: "file_change";
      readonly path: string;
      readonly change: "add" | "modify" | "delete" | "rename";
    }
  | {
      /** The agent wants to do something its permission mode does not allow. Policy decides. */
      readonly type: "approval_request";
      readonly requestId: string;
      readonly action: ProposedAction;
    }
  | { readonly type: "usage"; readonly usage: TokenUsage; readonly costMicroUsd: MicroUsd | null }
  | { readonly type: "quota"; readonly windows: readonly QuotaWindow[] }
  | { readonly type: "ambiguity"; readonly question: string }
  | { readonly type: "log"; readonly level: "debug" | "info" | "warn"; readonly message: string };

export type ProposedAction =
  | { readonly kind: "shell"; readonly argv: readonly string[]; readonly cwd: string }
  | { readonly kind: "file_write"; readonly path: string }
  | { readonly kind: "file_delete"; readonly path: string }
  | {
      readonly kind: "mcp_call";
      readonly server: string;
      readonly tool: string;
      readonly access: "read" | "write";
    }
  | { readonly kind: "network"; readonly host: string };

export type ApprovalDecision =
  | { readonly kind: "allow_once" }
  | { readonly kind: "allow_for_node" }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "steer"; readonly message: string };

export interface SessionOutcome {
  readonly status: "completed" | "failed" | "cancelled" | "budget_exceeded" | "needs_input";
  readonly summary: string;
  readonly usage: TokenUsage;
  readonly costMicroUsd: MicroUsd | null;
  readonly resume: ResumeToken | null;
  readonly errorClass: string | null;
}

export interface QuotaWindow {
  readonly accountId: AccountId;
  /** "5h", "7d", "monthly", or a provider bucket id. */
  readonly window: string;
  /** 0..100, null when the provider only reports allowed/blocked. */
  readonly usedPercent: number | null;
  readonly resetsAt: UnixMs | null;
  readonly status: "ok" | "warning" | "limited";
  readonly source: "official_api" | "cli_event" | "response_headers" | "local_estimate";
  readonly observedAt: UnixMs;
}
```

## TraceEvent

The trace and the event store are the **same log**. Every state transition and every
observation is one append-only, hash-chained event. Projections (node status, approvals, usage)
are derived from it, so "what happened" and "what the UI shows" cannot disagree.

```ts
export type Actor =
  | { readonly kind: "engine" }
  | { readonly kind: "human" }
  | { readonly kind: "model"; readonly model: ModelRef; readonly tier: Tier }
  | { readonly kind: "policy"; readonly ruleId: string };

export interface TraceEnvelope<K extends TraceEventType> {
  readonly v: 1;
  readonly runId: RunId;
  /** Gap-free per run, starting at 1. */
  readonly seq: number;
  readonly ts: UnixMs;
  readonly type: K;
  readonly nodeId: NodeId | null;
  readonly attempt: number | null;
  readonly actor: Actor;
  readonly payload: TraceEventPayloads[K];
  /** Large content (packets, diffs, check output, prompts) lives in the blob store. */
  readonly blobs: readonly Sha256[];
  readonly otel: {
    readonly traceId: string;
    readonly spanId: string;
    readonly parentSpanId: string | null;
  };
  /** null only for seq 1. */
  readonly prevHash: Sha256 | null;
  /** sha256(JCS(envelope without `hash`)); the envelope includes prevHash, which chains it. */
  readonly hash: Sha256;
}

export interface TraceEventPayloads {
  "run.created": { readonly projectId: ProjectId; readonly goal: string; readonly repo: RepoRef };
  /** The DAG is inline: it is small, and reducers must not need the blob store. */
  "plan.proposed": { readonly revision: number; readonly dag: TaskDAG };
  "plan.approved": { readonly revision: number; readonly edited: boolean };
  "packet.issued": { readonly packetId: PacketId; readonly contentHash: Sha256 };
  "node.ready": Record<string, never>;
  "node.dispatched": {
    readonly model: ModelRef;
    readonly accountId: AccountId;
    readonly worktree: string;
    readonly branch: string;
    readonly baseCommit: GitOid;
    readonly packetHash: Sha256;
  };
  "node.verifying": Record<string, never>;
  "model.call": {
    readonly model: ModelRef;
    readonly tier: Tier;
    readonly purpose: "plan" | "work" | "steer" | "review";
    readonly usage: TokenUsage;
    readonly costMicroUsd: MicroUsd | null;
    readonly latencyMs: number;
  };
  "tool.call": {
    readonly server: string;
    readonly tool: string;
    readonly argsHash: Sha256;
    readonly decision: "auto_allowed" | "approved" | "denied";
    readonly isError: boolean;
    readonly resultHash: Sha256 | null;
    readonly durationMs: number;
  };
  "diff.captured": {
    readonly baseCommit: GitOid;
    readonly headCommit: GitOid;
    readonly diffBlob: Sha256;
    readonly files: number;
    readonly insertions: number;
    readonly deletions: number;
    readonly outOfScope: readonly string[];
  };
  "check.completed": {
    readonly checkId: string;
    readonly passed: boolean;
    readonly exitCode: number | null;
    readonly outputBlob: Sha256;
    readonly durationMs: number;
  };
  "node.succeeded": { readonly headCommit: GitOid; readonly summary: string };
  "node.failed": { readonly errorClass: string; readonly message: string };
  "node.retry_scheduled": {
    readonly nextAttempt: number;
    readonly delayMs: number;
    readonly reason: string;
  };
  "node.escalated": { readonly reason: "checks_failed" | "ambiguity" | "budget" | "worker_error" };
  "node.steered": { readonly note: string; readonly replan: boolean };
  "node.cancelled": { readonly reason: string };
  "node.skipped": { readonly because: NodeId };
  "approval.requested": {
    readonly approvalId: ApprovalId;
    readonly action: ProposedAction | GateAction;
  };
  "approval.resolved": { readonly approvalId: ApprovalId; readonly decision: ApprovalDecision };
  "budget.tripped": {
    readonly scope: "node" | "run" | "account";
    readonly limit: string;
    readonly limitValue: number;
    readonly observed: number;
  };
  "quota.observed": { readonly windows: readonly QuotaWindow[] };
  "checkpoint.created": {
    readonly checkpointId: CheckpointId;
    readonly label: string;
    /** Commit per node worktree, so a rollback restores code and state together. */
    readonly refs: Readonly<Record<string, GitOid>>;
  };
  "run.rolled_back": { readonly toCheckpoint: CheckpointId };
  "run.paused": { readonly reason: string };
  "run.resumed": { readonly afterCrash: boolean };
  "integration.started": { readonly baseCommit: GitOid; readonly branch: string };
  "integration.checked": {
    readonly commit: GitOid;
    readonly passed: boolean;
    readonly checks: readonly {
      readonly checkId: string;
      readonly passed: boolean;
      readonly outputBlob: Sha256;
    }[];
  };
  "review.completed": {
    readonly verdict: "approve" | "request_changes";
    readonly summary: string;
    readonly concerns: readonly string[];
  };
  /** mergedInto is the user's branch when the merge gate was approved, otherwise null. */
  "run.completed": { readonly integrationCommit: GitOid; readonly mergedInto: string | null };
  "run.failed": { readonly errorClass: string; readonly message: string };
  "run.cancelled": { readonly reason: string };
}

export type GateAction =
  | { readonly kind: "plan_approval"; readonly revision: number }
  | { readonly kind: "merge"; readonly from: string; readonly into: string }
  | { readonly kind: "budget_threshold"; readonly fraction: number }
  | { readonly kind: "rollback"; readonly toCheckpoint: CheckpointId };

export type TraceEventType = keyof TraceEventPayloads;

export type TraceEvent = { [K in TraceEventType]: TraceEnvelope<K> }[TraceEventType];
```

Hashing details:

- Canonical form is RFC 8785 JSON Canonicalization Scheme (JCS), so the hash is stable across
  key order and number formatting.
- Blobs are hashed by content first; the envelope lists their hashes, so the chain covers them.
- `orzeus trace verify <run>` recomputes the chain and every referenced blob hash.
- Export: JSONL (envelopes + blobs) and OTLP JSON spans following the OpenTelemetry GenAI
  semantic conventions, with `otel` ids already on each event (and propagated to MCP servers via
  `_meta.traceparent`, as the 2026-07-28 spec now documents).

## How this file is checked

Every `ts` block above is extracted in order into one module and compiled with
`tsc --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess --noEmit` on
TypeScript 7.0.2. When these move into `@orzeus/schema` as Zod schemas, a type-level test
(`expectTypeOf<z.infer<typeof TaskDAGSchema>>().toEqualTypeOf<TaskDAG>()`) keeps the two in sync.

import type {
  AccountId,
  ApprovalDecision,
  ContextPacket,
  MicroUsd,
  NodeBudget,
  NodeId,
  ProposedAction,
  ProviderId,
  QuotaWindow,
  RunId,
  Tier,
  TokenUsage,
} from "@orzeus/schema";

/**
 * One interface for every provider (docs/architecture/02-core-schemas.md). Two shapes of work:
 * `generate` for one-shot structured output (planning, steering, review) and `startSession` for
 * agentic work inside a worktree.
 */
export interface ProviderAdapter {
  readonly manifest: AdapterManifest;
  /** Is the binary present, the key valid, the endpoint reachable? Never spends tokens. */
  probe(account: AccountContext, signal: AbortSignal): Promise<ProbeResult>;
  listModels(account: AccountContext, signal: AbortSignal): Promise<readonly ModelInfo[]>;
  /** Present when manifest.capabilities.agentSession is true. */
  startSession?(request: SessionRequest, account: AccountContext): AgentSession;
  /** Official quota signal, when the provider has one. */
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
  /** The user's own installed, signed-in CLI. Orzeus never reads, copies or refreshes its credentials. */
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

/** Literal `false` types make a non-compliant adapter fail to typecheck (docs/architecture/04-providers.md). */
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
  /** Resolves a keychain secret at call time. Adapters never cache it. */
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
  readonly pricing: { readonly inputPerMTok: MicroUsd; readonly outputPerMTok: MicroUsd } | null;
}

export interface SessionRequest {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attempt: number;
  readonly model: string;
  readonly packet: ContextPacket;
  /** Packet rendered by @orzeus/core's renderPacketPrompt. */
  readonly prompt: string;
  readonly worktree: { readonly path: string; readonly branch: string };
  /** Per-node MCP endpoint on the gateway (Phase 3); null until then. */
  readonly mcp: { readonly url: string; readonly token: string } | null;
  readonly budget: NodeBudget;
  readonly resume: ResumeToken | null;
}

export interface ResumeToken {
  readonly adapter: string;
  /** e.g. a Codex thread id. */
  readonly value: string;
}

export interface AgentSession {
  readonly events: AsyncIterable<AdapterEvent>;
  /** Mid-turn steering when capabilities.steerMidTurn; otherwise queued for the next turn. */
  steer(message: string): Promise<void>;
  /** Answers an approval_request event. */
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
      readonly type: "approval_request";
      readonly requestId: string;
      readonly action: ProposedAction;
    }
  | { readonly type: "usage"; readonly usage: TokenUsage; readonly costMicroUsd: MicroUsd | null }
  | { readonly type: "quota"; readonly windows: readonly QuotaWindow[] }
  | { readonly type: "ambiguity"; readonly question: string }
  | { readonly type: "log"; readonly level: "debug" | "info" | "warn"; readonly message: string };

export interface SessionOutcome {
  readonly status: "completed" | "failed" | "cancelled" | "budget_exceeded" | "needs_input";
  readonly summary: string;
  readonly usage: TokenUsage;
  readonly costMicroUsd: MicroUsd | null;
  readonly resume: ResumeToken | null;
  readonly errorClass: string | null;
}

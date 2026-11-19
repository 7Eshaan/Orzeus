import type {
  AccountId,
  ApprovalDecision,
  ApprovalId,
  CheckpointId,
  GateAction,
  GitOid,
  ModelRef,
  NodeId,
  NodeKind,
  NodeStatus,
  ProjectId,
  ProposedAction,
  RepoRef,
  RunId,
  RunStatus,
  Sha256,
  TaskDAG,
  Tier,
  TokenUsage,
  UnixMs,
} from "@orzeus/schema";

export interface NodeState {
  readonly id: NodeId;
  readonly title: string;
  readonly kind: NodeKind;
  readonly tier: Tier;
  readonly dependsOn: readonly NodeId[];
  readonly writeScope: readonly string[];
  readonly status: NodeStatus;
  /** Highest attempt dispatched so far; 0 before the first dispatch. */
  readonly attempt: number;
  /** Attempts since the last frontier steer; retry limits count these. */
  readonly attemptsThisRound: number;
  readonly steers: number;
  readonly packetHash: Sha256 | null;
  readonly accountId: AccountId | null;
  readonly model: ModelRef | null;
  readonly worktree: string | null;
  readonly branch: string | null;
  readonly baseCommit: GitOid | null;
  readonly headCommit: GitOid | null;
  readonly retryAt: UnixMs | null;
  /** Latest result per check id for the current attempt. */
  readonly checks: Readonly<Record<string, boolean>>;
  readonly usage: TokenUsage;
  readonly costMicroUsd: number;
  readonly lastError: { readonly errorClass: string; readonly message: string } | null;
  /** Status to return to when pending approvals clear. */
  readonly statusBeforeApproval: NodeStatus | null;
  readonly summary: string | null;
  readonly updatedSeq: number;
}

export interface ApprovalState {
  readonly id: ApprovalId;
  readonly nodeId: NodeId | null;
  readonly action: ProposedAction | GateAction;
  readonly status: "pending" | "approved" | "denied" | "steered";
  readonly decision: ApprovalDecision | null;
  readonly requestedSeq: number;
  readonly resolvedSeq: number | null;
}

export interface CheckpointState {
  readonly id: CheckpointId;
  readonly label: string;
  readonly atSeq: number;
  readonly refs: Readonly<Record<string, GitOid>>;
  /** Run state at the checkpoint, without the checkpoint table itself. */
  readonly snapshot: Omit<RunState, "checkpoints">;
}

export interface RunTotals {
  readonly frontierTokens: number;
  readonly workerTokens: number;
  readonly costMicroUsd: number;
}

export interface RunState {
  readonly runId: RunId;
  readonly projectId: ProjectId;
  readonly goal: string;
  readonly repo: RepoRef;
  readonly status: RunStatus;
  readonly statusBeforePause: RunStatus | null;
  /** The approved plan. */
  readonly dag: TaskDAG | null;
  /** A proposed plan awaiting approval. */
  readonly proposedDag: TaskDAG | null;
  readonly nodes: Readonly<Record<string, NodeState>>;
  /** Node ids in stable topological order. */
  readonly nodeOrder: readonly NodeId[];
  readonly approvals: Readonly<Record<string, ApprovalState>>;
  readonly checkpoints: Readonly<Record<string, CheckpointState>>;
  readonly totals: RunTotals;
  readonly budgetTrips: number;
  readonly headSeq: number;
  readonly headHash: Sha256;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

export function nodeList(state: RunState): NodeState[] {
  return state.nodeOrder
    .map((id) => state.nodes[id])
    .filter((n): n is NodeState => n !== undefined);
}

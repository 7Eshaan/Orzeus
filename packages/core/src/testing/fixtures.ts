import type {
  AccountId,
  EventDraft,
  GitOid,
  ModelRef,
  NodeId,
  PacketId,
  ProjectId,
  RunId,
  Sha256,
  TaskDAG,
  TaskNode,
  TraceEventPayload,
  TraceEventType,
} from "@orzeus/schema";

export const TEST_RUN_ID = "01JD7Z5K3Q9V8X2M4N6P8R0T2W" as RunId;
export const TEST_PROJECT = "project-test" as ProjectId;
export const TEST_COMMIT = "a".repeat(40) as GitOid;
export const TEST_HASH = "b".repeat(64) as Sha256;
export const TEST_ACCOUNT = "acct-test" as AccountId;
export const WORKER_MODEL: ModelRef = {
  provider: "openai_compatible",
  adapter: "openai-compatible",
  model: "test-worker",
};
export const PLANNER_MODEL: ModelRef = {
  provider: "anthropic",
  adapter: "anthropic-api",
  model: "test-planner",
};

export interface NodeSpec {
  readonly id: string;
  readonly dependsOn?: readonly string[];
  readonly writeScope?: readonly string[];
}

/** Builds a schema-valid DAG from a compact spec. */
export function buildDag(
  specs: readonly NodeSpec[],
  options: {
    readonly runId?: RunId;
    readonly maxConcurrency?: number;
    readonly revision?: number;
  } = {},
): TaskDAG {
  const node = (spec: NodeSpec): TaskNode => ({
    id: spec.id as NodeId,
    title: `Task ${spec.id}`,
    kind: "implement",
    dependsOn: (spec.dependsOn ?? []) as NodeId[],
    tier: "worker",
    candidates: [WORKER_MODEL],
    packetId: `packet-${spec.id}` as PacketId,
    writeScope: [...(spec.writeScope ?? [`src/${spec.id}/**`])],
    checks: [
      {
        kind: "command",
        id: "test",
        label: "Unit tests",
        argv: ["pnpm", "test"],
        cwd: ".",
        timeoutMs: 60_000,
        expectExitCode: 0,
      },
    ],
    budget: {
      maxInputTokens: 100_000,
      maxOutputTokens: 20_000,
      maxCostMicroUsd: 1_000_000,
      maxWallMs: 600_000,
      maxTurns: 40,
    },
    retry: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000, jitter: "full" },
    escalation: { workerRetriesOnCheckFailure: 1, onAmbiguity: "escalate", maxSteers: 2 },
  });
  return {
    schemaVersion: 1,
    runId: options.runId ?? TEST_RUN_ID,
    revision: options.revision ?? 1,
    goal: "Test goal",
    repo: { root: "/repo", baseRef: "main", baseCommit: TEST_COMMIT },
    plannedBy: PLANNER_MODEL,
    nodes: specs.map(node),
    integration: {
      strategy: "merge_topological",
      branch: "orzeus/test/integration",
      globalChecks: [],
      frontierReview: true,
    },
    budget: {
      maxCostMicroUsd: 50_000_000,
      maxFrontierTokens: 1_000_000,
      maxConcurrency: options.maxConcurrency ?? 3,
      approvalThresholds: [0.5, 0.8],
    },
  };
}

let spanCounter = 0;

/** A schema-valid draft with deterministic-looking OTel ids. */
export function draft<K extends TraceEventType>(
  type: K,
  payload: TraceEventPayload<K>,
  options: {
    readonly ts: number;
    readonly nodeId?: string | null;
    readonly attempt?: number | null;
  },
): EventDraft {
  spanCounter = (spanCounter + 1) % 0xffff_ffff;
  return {
    ts: options.ts,
    type,
    nodeId: (options.nodeId ?? null) as NodeId | null,
    attempt: options.attempt ?? null,
    actor: { kind: "engine" },
    payload,
    blobs: [],
    otel: {
      traceId: `${"0".repeat(31)}1`,
      spanId: spanCounter.toString(16).padStart(16, "0"),
      parentSpanId: null,
    },
  } as EventDraft;
}

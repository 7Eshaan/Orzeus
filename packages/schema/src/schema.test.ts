import { describe, expect, expectTypeOf, it } from "vitest";
import { CheckSpec, NodeStatus, type TaskDAG } from "./dag.js";
import { ContextRef } from "./packet.js";
import { NodeId, RunId, Sha256 } from "./primitives.js";
import {
  type EventDraft,
  parseEventDraft,
  parseTraceEvent,
  TRACE_EVENT_TYPES,
  type TraceEvent,
} from "./trace-event.js";

const otel = { traceId: `${"0".repeat(31)}1`, spanId: `${"0".repeat(15)}1`, parentSpanId: null };

describe("identifiers", () => {
  it("accept well-formed ids and reject the rest", () => {
    expect(RunId.safeParse("01JD7Z5K3Q9V8X2M4N6P8R0T2W").success).toBe(true);
    expect(RunId.safeParse("01jd7z5k3q9v8x2m4n6p8r0t2w").success).toBe(false);
    expect(NodeId.safeParse("api-auth").success).toBe(true);
    expect(NodeId.safeParse("API auth").success).toBe(false);
    expect(Sha256.safeParse("A".repeat(64)).success).toBe(false);
  });

  it("brands ids so plain strings cannot be passed by accident", () => {
    expectTypeOf<string>().not.toExtend<NodeId>();
    expectTypeOf<NodeId>().toExtend<string>();
  });
});

describe("plan pieces", () => {
  it("require non-empty argv and sane line ranges", () => {
    const base = {
      kind: "command",
      id: "t",
      label: "t",
      cwd: ".",
      timeoutMs: 1,
      expectExitCode: 0,
    };
    expect(CheckSpec.safeParse({ ...base, argv: [] }).success).toBe(false);
    expect(CheckSpec.safeParse({ ...base, argv: ["pnpm", "test"] }).success).toBe(true);
    const range = { kind: "file_range", path: "a.ts", why: "context" };
    expect(ContextRef.safeParse({ ...range, startLine: 5, endLine: 4 }).success).toBe(false);
    expect(ContextRef.safeParse({ ...range, startLine: 5, endLine: 5 }).success).toBe(true);
  });

  it("exposes the node lifecycle documented in docs/architecture/02-core-schemas.md", () => {
    expect(NodeStatus.options).toEqual([
      "pending",
      "ready",
      "running",
      "verifying",
      "awaiting_approval",
      "retry_wait",
      "escalated",
      "succeeded",
      "failed",
      "cancelled",
      "skipped",
    ]);
    expectTypeOf<TaskDAG["nodes"][number]["dependsOn"]>().toEqualTypeOf<NodeId[]>();
  });
});

describe("events", () => {
  const draft = {
    ts: 1,
    type: "run.paused",
    nodeId: null,
    attempt: null,
    actor: { kind: "engine" },
    payload: { reason: "lunch" },
    blobs: [],
    otel,
  };

  it("validate the payload for the event's own type", () => {
    expect(parseEventDraft(draft).ok).toBe(true);
    expect(parseEventDraft({ ...draft, payload: { reason: "" } })).toMatchObject({ ok: false });
    expect(parseEventDraft({ ...draft, type: "run.exploded" })).toMatchObject({ ok: false });
    expect(parseEventDraft({ ...draft, extra: true })).toMatchObject({ ok: false });
  });

  it("require sealing fields on stored events", () => {
    expect(parseTraceEvent(draft)).toMatchObject({ ok: false });
    const sealed = {
      ...draft,
      v: 1,
      runId: "01JD7Z5K3Q9V8X2M4N6P8R0T2W",
      seq: 1,
      prevHash: null,
      hash: "a".repeat(64),
    };
    expect(parseTraceEvent(sealed).ok).toBe(true);
  });

  it("narrow payloads by event type", () => {
    expect(TRACE_EVENT_TYPES).toContain("node.verifying");
    expectTypeOf<Extract<TraceEvent, { type: "node.failed" }>["payload"]>().toEqualTypeOf<{
      errorClass: string;
      message: string;
    }>();
    expectTypeOf<Extract<EventDraft, { type: "node.ready" }>["payload"]>().toEqualTypeOf<
      Record<string, never>
    >();
  });
});

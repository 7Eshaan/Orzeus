import type { NodeId } from "@orzeus/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { scopesMayOverlap } from "./glob.js";
import { replay } from "./reducer.js";
import { decideNext } from "./scheduler.js";
import { nodeList, type RunState } from "./state.js";
import {
  type AttemptOutcome,
  buildDag,
  InMemoryRunLog,
  type NodeSpec,
  simulateRun,
  TEST_RUN_ID,
} from "./testing/index.js";

const SCOPES = [["src/a/**"], ["src/b/**"], ["src/a/x.ts"], ["docs/**"], [], ["**"]] as const;
const OUTCOMES: readonly AttemptOutcome[] = [
  "success",
  "transient",
  "checks_failed",
  "ambiguity",
  "budget",
  "fatal",
];

/** Random acyclic plans: each node may depend only on earlier nodes. */
const plans = fc
  .integer({ min: 1, max: 12 })
  .chain((size) =>
    fc.tuple(
      fc.tuple(
        ...Array.from({ length: size }, (_, i) =>
          fc.record({
            deps: fc.subarray(Array.from({ length: i }, (_, j) => j)),
            scope: fc.nat(SCOPES.length - 1),
          }),
        ),
      ),
      fc.integer({ min: 1, max: 4 }),
    ),
  )
  .map(([nodes, maxConcurrency]) => ({
    specs: nodes.map(
      (n, i): NodeSpec => ({
        id: `n${i}`,
        dependsOn: n.deps.map((d) => `n${d}`),
        writeScope: [...(SCOPES[n.scope] ?? [])],
      }),
    ),
    maxConcurrency,
  }));

/** Deterministic pseudo-random stream from a seed (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function checkInvariants(state: RunState, maxConcurrency: number): void {
  const nodes = nodeList(state);
  const occupying = nodes.filter((n) =>
    ["running", "verifying", "awaiting_approval"].includes(n.status),
  );
  expect(occupying.length).toBeLessThanOrEqual(maxConcurrency);
  for (let i = 0; i < occupying.length; i++) {
    for (let j = i + 1; j < occupying.length; j++) {
      const a = occupying[i];
      const b = occupying[j];
      if (a && b) expect(scopesMayOverlap(a.writeScope, b.writeScope)).toBe(false);
    }
  }
  for (const node of nodes) {
    if (node.attempt > 0) {
      for (const dep of node.dependsOn) expect(state.nodes[dep]?.status).toBe("succeeded");
    }
  }
}

describe("scheduler", () => {
  it("dispatches roots in topological order up to the concurrency limit", () => {
    const log = new InMemoryRunLog();
    const dag = buildDag([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d", dependsOn: ["a"] }], {
      maxConcurrency: 2,
    });
    const states: RunState[] = [];
    try {
      simulateRun(log, {
        dag,
        outcome: () => "success",
        random: () => 0,
        maxSteps: 1,
        onAppend: (s) => states.push(s),
      });
    } catch {
      // stopped after one step on purpose
    }
    const afterApproval = states[2] as RunState;
    expect(decideNext(afterApproval, 0)).toEqual([
      { kind: "mark_ready", nodeId: "a" },
      { kind: "mark_ready", nodeId: "b" },
      { kind: "mark_ready", nodeId: "c" },
      { kind: "dispatch", nodeId: "a" },
      { kind: "dispatch", nodeId: "b" },
    ]);
  });

  it("serializes overlapping write scopes", () => {
    const log = new InMemoryRunLog();
    const dag = buildDag(
      [
        { id: "a", writeScope: ["src/**"] },
        { id: "b", writeScope: ["src/b.ts"] },
      ],
      { maxConcurrency: 4 },
    );
    const states: RunState[] = [];
    simulateRun(log, {
      dag,
      outcome: () => "success",
      random: () => 0,
      onAppend: (s) => states.push(s),
    });
    const dispatchedTogether = states.some(
      (s) => nodeList(s).filter((n) => n.status === "running").length > 1,
    );
    expect(dispatchedTogether).toBe(false);
  });

  it("every random plan settles, respects its invariants, and replays to the same state", () => {
    fc.assert(
      fc.property(plans, fc.integer(), ({ specs, maxConcurrency }, seed) => {
        const random = seeded(seed);
        const script = seeded(seed ^ 0x5bd1e995);
        const outcomes = new Map<string, AttemptOutcome>();
        const outcome = (nodeId: NodeId, attempt: number): AttemptOutcome => {
          const key = `${nodeId}#${attempt}`;
          let value = outcomes.get(key);
          if (value === undefined) {
            const r = script();
            value = r < 0.6 ? "success" : (OUTCOMES[1 + Math.floor((r - 0.6) * 12.5)] ?? "fatal");
            outcomes.set(key, value);
          }
          return value;
        };

        const log = new InMemoryRunLog();
        const dag = buildDag(specs, { maxConcurrency });
        const final = simulateRun(log, {
          dag,
          outcome,
          random,
          checkpointAfterSteps: 3,
          onAppend: (state) => checkInvariants(state, maxConcurrency),
        });

        const nodes = nodeList(final);
        expect(nodes.every((n) => ["succeeded", "failed", "skipped"].includes(n.status))).toBe(
          true,
        );
        expect(final.status).toBe(
          nodes.every((n) => n.status === "succeeded") ? "completed" : "failed",
        );
        for (const n of nodes.filter((x) => x.status === "skipped")) {
          expect(
            n.dependsOn.some((d) => ["failed", "skipped"].includes(final.nodes[d]?.status ?? "")),
          ).toBe(true);
        }
        expect(replay(log.events(TEST_RUN_ID))).toEqual({ ok: true, value: final });
      }),
      { numRuns: 300 },
    );
  });
});

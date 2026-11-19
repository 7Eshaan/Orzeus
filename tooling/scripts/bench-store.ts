/**
 * Measures the event store on a large run: appending, reading the whole run, and the filtered
 * reads the orchestrator and UI make. Numbers are recorded in docs/plan/phased-plan.md.
 *
 * Usage: node tooling/scripts/bench-store.ts [events]   (after pnpm build)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, SqliteRunStore } from "../../packages/store/dist/index.js";

const total = Number(process.argv[2] ?? 10_000);
const dir = mkdtempSync(join(tmpdir(), "orzeus-bench-"));
const store = new SqliteRunStore(openStore(join(dir, "bench.db")));
const runId = "01JBENCH000000000000000000" as never;
const actor = { kind: "engine" } as const;
const otel = { traceId: "0".repeat(32), spanId: "0".repeat(16), parentSpanId: null };
const draft = (type: string, payload: unknown, nodeId: string | null = null) =>
  ({ ts: Date.now(), type, nodeId, attempt: null, actor, payload, blobs: [], otel }) as never;

store.ensureProject({ id: "p", name: "p", repoRoot: "/r", defaultBranch: "main", createdAt: 0 });
store.append(runId, [
  draft("run.created", {
    projectId: "p",
    goal: "bench",
    repo: { root: "/r", baseRef: "main", baseCommit: "a".repeat(40) },
  }),
]);

const time = (label: string, fn: () => unknown, repeat = 1) => {
  const started = performance.now();
  for (let i = 0; i < repeat; i++) fn();
  const ms = (performance.now() - started) / repeat;
  process.stdout.write(`${label.padEnd(44)} ${ms.toFixed(2)} ms\n`);
};

time(`append ${total} events (batches of 10)`, () => {
  for (let i = 0; i < total / 10; i++)
    store.append(
      runId,
      Array.from({ length: 10 }, (_, j) =>
        draft("quota.observed", {
          windows: [
            {
              accountId: "a",
              window: "5h",
              usedPercent: (i + j) % 100,
              resetsAt: null,
              status: "ok",
              source: "official_api",
              observedAt: i,
            },
          ],
        }),
      ),
    );
});
time("events(): whole run", () => store.events(runId), 5);
time("events({ afterSeq: last - 50 })", () => store.events(runId, { afterSeq: total - 50 }), 20);
time("events({ type: run.created })", () => store.events(runId, { types: ["run.created"] }), 20);
time("load() (cached state)", () => store.load(runId), 100);
rmSync(dir, { recursive: true, force: true });

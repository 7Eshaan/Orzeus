import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunState } from "@orzeus/core";
import {
  type AttemptOutcome,
  buildDag,
  draft,
  simulateRun,
  TEST_PROJECT,
  TEST_RUN_ID,
} from "@orzeus/core/testing";
import type { NodeId, RunId } from "@orzeus/schema";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlobStore } from "./blobs.js";
import { type Db, openDatabase } from "./db.js";
import { openStore } from "./index.js";
import { MigrationError, migrate } from "./migrate.js";
import { MIGRATIONS } from "./migrations/index.js";
import { InvalidDraftError, SqliteRunStore, TransitionRejectedError } from "./run-store.js";

const PROJECTION_TABLES = [
  "runs",
  "nodes",
  "node_deps",
  "attempts",
  "approvals",
  "checkpoints",
  "node_summaries",
] as const;

function dumpProjections(db: Db, runId: string): Record<string, unknown[]> {
  const dump: Record<string, unknown[]> = {};
  for (const table of PROJECTION_TABLES) {
    const column = table === "runs" ? "id" : "run_id";
    dump[table] = db.all(`SELECT * FROM ${table} WHERE ${column} = ? ORDER BY 1, 2, 3`, [runId]);
  }
  return dump;
}

function newStore(db: Db): SqliteRunStore {
  const store = new SqliteRunStore(db);
  store.ensureProject({
    id: TEST_PROJECT,
    name: "Test",
    repoRoot: "/repo",
    defaultBranch: "main",
    createdAt: 0,
  });
  return store;
}

/** Deterministic pseudo-random stream (mulberry32). */
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

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orzeus-store-"));
  db = openStore(join(dir, "orzeus.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("migrations", () => {
  it("apply once, are idempotent, and use WAL", () => {
    expect(migrate(db)).toEqual([]);
    expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
    expect(db.all("SELECT version FROM schema_migrations")).toEqual([
      { version: 1 },
      { version: 2 },
    ]);
  });

  it("match the SQL documented in docs/architecture/03-sqlite-schema.md", () => {
    const doc = readFileSync(
      new URL("../../../docs/architecture/03-sqlite-schema.md", import.meta.url),
      "utf8",
    );
    for (const migration of MIGRATIONS) {
      const heading = `## Migration ${String(migration.version).padStart(4, "0")}`;
      const start = doc.indexOf(heading);
      expect(start, heading).toBeGreaterThanOrEqual(0);
      const documented = /```sql\n([\s\S]*?)```/.exec(doc.slice(start))?.[1];
      expect(documented?.trim(), heading).toBe(migration.sql.trim());
    }
  });

  it("refuse an edited migration and an unknown future version", () => {
    const fresh = openDatabase({ path: ":memory:" });
    migrate(fresh);
    const edited = MIGRATIONS.map((m) => ({ ...m, sql: `${m.sql}\n-- edited` }));
    expect(() => migrate(fresh, edited)).toThrow(MigrationError);
    expect(() => migrate(fresh, [])).toThrow(/does not know/);
    fresh.close();
  });
});

describe("run locks", () => {
  it("allow one owner at a time, refresh with heartbeats, and expire after a crash", async () => {
    const { RunLocks } = await import("./run-locks.js");
    let now = 1_000;
    const locks = new RunLocks(db, () => now);
    const store = newStore(db);
    const dag = buildDag([{ id: "a" }]);
    store.append(TEST_RUN_ID, [
      draft("run.created", { projectId: TEST_PROJECT, goal: dag.goal, repo: dag.repo }, { ts: 1 }),
    ]);
    expect(locks.acquire(TEST_RUN_ID, "engine-a", 1, 5_000)).toEqual({ ok: true });
    expect(locks.acquire(TEST_RUN_ID, "engine-b", 2, 5_000)).toMatchObject({
      ok: false,
      heldBy: { owner: "engine-a", pid: 1 },
    });
    now = 4_000;
    expect(locks.heartbeat(TEST_RUN_ID, "engine-a", 5_000)).toBe(true);
    now = 8_000;
    expect(locks.acquire(TEST_RUN_ID, "engine-b", 2, 5_000).ok).toBe(false);
    now = 9_100; // engine-a stopped heartbeating at 4_000 (expired 9_000)
    expect(locks.acquire(TEST_RUN_ID, "engine-b", 2, 5_000)).toEqual({ ok: true });
    expect(locks.heartbeat(TEST_RUN_ID, "engine-a", 5_000)).toBe(false);
    locks.release(TEST_RUN_ID, "engine-b");
    expect(locks.holder(TEST_RUN_ID)).toBeNull();
  });
});

describe("blobs", () => {
  it("store small and large content by hash, deduplicate, and detect corruption", () => {
    const store = newStore(db);
    const small = store.blobs.put("hello", "text/plain");
    const big = store.blobs.put("x".repeat(10_000), "text/plain");
    expect(store.blobs.put("hello", "text/plain")).toBe(small);
    expect(new TextDecoder().decode(store.blobs.get(big)?.bytes)).toBe("x".repeat(10_000));
    expect(
      db.get<{ encoding: string }>("SELECT encoding FROM blobs WHERE hash = ?", [big])?.encoding,
    ).toBe("zstd");
    expect(() => db.run("UPDATE blobs SET size = 0 WHERE hash = ?", [small])).toThrow(/immutable/);

    db.exec("DROP TRIGGER blobs_no_update");
    db.run("UPDATE blobs SET bytes = ? WHERE hash = ?", [new TextEncoder().encode("hellp"), small]);
    expect(store.blobs.verify(small)).toBe(false);
    expect(store.blobs.verify(big)).toBe(true);
  });
});

describe("SqliteRunStore", () => {
  it("writes nothing when any draft in an append is rejected", () => {
    const store = newStore(db);
    const dag = buildDag([{ id: "a" }]);
    store.append(TEST_RUN_ID, [
      draft("run.created", { projectId: TEST_PROJECT, goal: dag.goal, repo: dag.repo }, { ts: 1 }),
    ]);
    const before = dumpProjections(db, TEST_RUN_ID);
    expect(() =>
      store.append(TEST_RUN_ID, [
        draft("plan.proposed", { revision: 1, dag }, { ts: 2 }),
        draft("node.ready", {}, { ts: 2, nodeId: "a" }),
      ]),
    ).toThrow(TransitionRejectedError);
    expect(store.events(TEST_RUN_ID)).toHaveLength(1);
    expect(dumpProjections(db, TEST_RUN_ID)).toEqual(before);
    expect(store.load(TEST_RUN_ID)?.status).toBe("planning");
  });

  it("validates drafts against the schema before touching the database", () => {
    const store = newStore(db);
    const bad = { ...draft("run.paused", { reason: "" }, { ts: 1 }) };
    expect(() => store.append(TEST_RUN_ID, [bad])).toThrow(InvalidDraftError);
    expect(() => store.append(TEST_RUN_ID, [])).toThrow(InvalidDraftError);
  });

  it("rejects direct edits and deletes of events at the database level", () => {
    const store = newStore(db);
    const dag = buildDag([{ id: "a" }]);
    store.append(TEST_RUN_ID, [
      draft("run.created", { projectId: TEST_PROJECT, goal: dag.goal, repo: dag.repo }, { ts: 1 }),
    ]);
    expect(() => db.run("UPDATE events SET type = 'x'")).toThrow(/append-only/);
    expect(() => db.run("DELETE FROM events")).toThrow(/append-only/);
  });
});

describe("Phase 1 exit check", () => {
  it("runs a scripted 10-node plan to completion; restart and rebuild reproduce it exactly", () => {
    const specs = [
      { id: "schema" },
      { id: "api", dependsOn: ["schema"] },
      { id: "db", dependsOn: ["schema"] },
      { id: "auth", dependsOn: ["api"] },
      { id: "ui-shell" },
      { id: "ui-forms", dependsOn: ["ui-shell", "api"] },
      { id: "jobs", dependsOn: ["db"] },
      { id: "docs", writeScope: ["docs/**"] },
      { id: "tests", dependsOn: ["auth", "jobs"], writeScope: ["src/**/*.test.ts"] },
      { id: "release", dependsOn: ["tests", "ui-forms", "docs"], writeScope: ["CHANGELOG.md"] },
    ];
    const dag = buildDag(specs, { maxConcurrency: 3 });
    // Script some trouble: a transient error, a failed check, and an escalation that gets steered.
    const script: Record<string, AttemptOutcome> = {
      "api#1": "transient",
      "db#1": "checks_failed",
      "auth#1": "ambiguity",
    };
    const store = newStore(db);
    const final = simulateRun(store, {
      dag,
      outcome: (nodeId: NodeId, attempt: number) => script[`${nodeId}#${attempt}`] ?? "success",
      random: seeded(42),
      checkpointAfterSteps: 5,
    });

    expect(final.status).toBe("completed");
    expect(Object.values(final.nodes).every((n) => n.status === "succeeded")).toBe(true);
    expect(final.nodes["auth"]?.steers).toBe(1);
    expect(store.verify(TEST_RUN_ID).ok).toBe(true);

    const live = dumpProjections(db, TEST_RUN_ID);
    expect(live["nodes"]).toHaveLength(10);
    expect(live["attempts"]).toHaveLength(13); // 10 + api retry + db retry + auth after steer

    // "Restart": a fresh store over the same database replays to the same state.
    const restarted = new SqliteRunStore(db);
    expect(restarted.load(TEST_RUN_ID)).toEqual(final);

    // Dropping and rebuilding projections from events yields identical rows.
    expect(restarted.rebuildProjections(TEST_RUN_ID)).toEqual(final);
    expect(dumpProjections(db, TEST_RUN_ID)).toEqual(live);

    // Tampering with a stored event is detected.
    db.exec("DROP TRIGGER events_no_update");
    db.run(
      "UPDATE events SET payload_json = replace(payload_json, 'Finished', 'Finishes') WHERE run_id = ? AND type = 'node.succeeded'",
      [TEST_RUN_ID],
    );
    expect(new SqliteRunStore(db).verify(TEST_RUN_ID)).toMatchObject({
      ok: false,
      reason: "hash does not match content",
    });
  });

  it("live projections always equal rebuilt projections for random plans and outcomes", () => {
    const outcomes: readonly AttemptOutcome[] = [
      "success",
      "success",
      "success",
      "transient",
      "checks_failed",
      "ambiguity",
      "fatal",
    ];
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), fc.integer(), (size, seed) => {
        const random = seeded(seed);
        const specs = Array.from({ length: size }, (_, i) => ({
          id: `n${i}`,
          dependsOn: Array.from({ length: i }, (_, j) => `n${j}`).filter(() => random() < 0.3),
          writeScope: [random() < 0.5 ? `src/n${i}/**` : "src/**"],
        }));
        const runId =
          `01JD7Z5K3Q9V8X2M4N6P8R${String(Math.abs(seed) % 10_000).padStart(4, "0")}` as RunId;
        const memory = openStore(":memory:");
        const store = newStore(memory);
        let final: RunState | null = null;
        try {
          final = simulateRun(store, {
            dag: buildDag(specs, { runId, maxConcurrency: 1 + Math.floor(random() * 3) }),
            outcome: () => outcomes[Math.floor(random() * outcomes.length)] ?? "success",
            random,
            checkpointAfterSteps: 2,
          });
          const live = dumpProjections(memory, runId);
          expect(store.rebuildProjections(runId)).toEqual(final);
          expect(dumpProjections(memory, runId)).toEqual(live);
          expect(store.verify(runId).ok).toBe(true);
        } finally {
          memory.close();
        }
        expect(final?.status === "completed" || final?.status === "failed").toBe(true);
      }),
      { numRuns: 60 },
    );
  });
});

describe("blob redaction", () => {
  it("redacts free-text blobs before storing them, and leaves packets alone", () => {
    const redact = (text: string) => text.replaceAll("sk-secret", "[redacted]");
    const blobs = new BlobStore(openStore(":memory:"), Date.now, redact);
    const out = blobs.put("token sk-secret in output", "text/plain");
    expect(new TextDecoder().decode(blobs.get(out)?.bytes)).toBe("token [redacted] in output");
    const packet = blobs.put('{"note":"sk-secret"}', "application/vnd.orzeus.packet+json");
    expect(new TextDecoder().decode(blobs.get(packet)?.bytes)).toContain("sk-secret");
  });
});

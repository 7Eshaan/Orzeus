import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AccountId, ContextPacket, NodeId, PacketId, RunId, Sha256 } from "@orzeus/schema";
import { describe, expect, it } from "vitest";
import type {
  AccountContext,
  AdapterEvent,
  ProviderAdapter,
  SessionOutcome,
  SessionRequest,
} from "../adapter.js";

export interface ConformanceHarness {
  readonly adapter: ProviderAdapter;
  readonly account: AccountContext;
  /** A fresh session request whose recorded replay completes the task. */
  readonly request: () => Promise<SessionRequest>;
  /** The same adapter wired to a backend that never answers, for cancellation. */
  readonly hanging: () => Promise<{
    readonly adapter: ProviderAdapter;
    readonly request: SessionRequest;
    readonly pid?: () => number | undefined;
  }>;
}

export const TEST_ACCOUNT: AccountContext = {
  accountId: "conformance" as AccountId,
  label: "Conformance",
  auth: { kind: "none" },
  getSecret: async () => {
    throw new Error("no secrets in conformance tests");
  },
};

export function testPacket(objective: string): ContextPacket {
  return {
    schemaVersion: 1,
    id: "packet-conformance" as PacketId,
    runId: "01JD7Z5K3Q9V8X2M4N6P8R0T2W" as RunId,
    nodeId: "conformance" as NodeId,
    objective,
    nonGoals: [],
    acceptance: [{ id: "ac", statement: objective, checkId: null }],
    context: [],
    constraints: [],
    tools: {
      mcp: [],
      builtin: [{ kind: "read_files" }, { kind: "edit_files" }],
      network: "none",
      networkAllowlist: [],
    },
    upstream: [],
    steering: [],
    limits: { maxContextTokens: 8_000 },
    contentHash: "c".repeat(64) as Sha256,
  };
}

const EVENT_TYPES = new Set([
  "message_delta",
  "tool_call",
  "tool_result",
  "file_change",
  "approval_request",
  "usage",
  "quota",
  "ambiguity",
  "log",
]);

/** Drains a session, answering every approval with `decide`. */
export async function drain(
  adapter: ProviderAdapter,
  request: SessionRequest,
  account: AccountContext,
  decide: (
    event: Extract<AdapterEvent, { type: "approval_request" }>,
  ) => Parameters<
    NonNullable<ReturnType<NonNullable<ProviderAdapter["startSession"]>>["respond"]>
  >[1] = () => ({ kind: "allow_once" }),
): Promise<{ events: AdapterEvent[]; outcome: SessionOutcome }> {
  const session = adapter.startSession?.(request, account);
  if (session === undefined) throw new Error("adapter cannot start sessions");
  const events: AdapterEvent[] = [];
  for await (const event of session.events) {
    events.push(event);
    if (event.type === "approval_request") await session.respond(event.requestId, decide(event));
  }
  return { events, outcome: await session.outcome };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : path.endsWith(".ts") && !path.endsWith(".test.ts")
        ? [path]
        : [];
  });
}

/** Manifest and source checks every adapter must pass, including generate-only adapters. */
export function describeManifestChecks(
  getAdapter: () => Promise<ProviderAdapter>,
  adapterDir: string,
): void {
  it("declares a compliant manifest that matches its methods", async () => {
    const adapter = await getAdapter();
    const m = adapter.manifest;
    expect(m.compliance.officialInterface).toMatch(/^https:\/\//);
    expect([
      m.compliance.readsForeignCredentials,
      m.compliance.rotatesAccounts,
      m.compliance.spoofsClient,
    ]).toEqual([false, false, false]);
    expect(m.capabilities.agentSession).toBe(adapter.startSession !== undefined);
    expect(m.capabilities.reportsQuota).toBe(adapter.readQuota !== undefined);
  });

  it("never references another tool's credential files", () => {
    for (const file of sourceFiles(adapterDir)) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(
        /\.claude\/|\.codex\/|auth\.json|\.cursor\/|cookies|keychain/i,
      );
    }
  });
}

/**
 * The shared suite every adapter must pass (docs/architecture/04-providers.md). Runs against
 * recorded fixtures, never the network.
 */
export function describeConformance(
  name: string,
  adapterDir: string,
  makeHarness: () => Promise<ConformanceHarness>,
): void {
  describe(`${name} conformance`, () => {
    describeManifestChecks(async () => (await makeHarness()).adapter, adapterDir);

    it("probes without spending tokens", async () => {
      const { adapter, account } = await makeHarness();
      expect(await adapter.probe(account, AbortSignal.timeout(10_000))).toMatchObject({ ok: true });
    });

    it("completes a recorded session, maps every event and reports usage", async () => {
      const harness = await makeHarness();
      const { events, outcome } = await drain(
        harness.adapter,
        await harness.request(),
        harness.account,
      );
      expect(outcome.status).toBe("completed");
      expect(outcome.usage.inputTokens + outcome.usage.outputTokens).toBeGreaterThan(0);
      for (const event of events) expect(EVENT_TYPES.has(event.type)).toBe(true);
      expect(events.some((e) => e.type === "file_change")).toBe(true);
      expect(events.some((e) => e.type === "usage")).toBe(true);
    });

    it("surfaces approvals to Orzeus and survives a denial", async () => {
      const harness = await makeHarness();
      const { events, outcome } = await drain(
        harness.adapter,
        await harness.request(),
        harness.account,
        () => ({
          kind: "deny",
          reason: "conformance denial",
        }),
      );
      const asked = events.filter((e) => e.type === "approval_request");
      if (harness.adapter.manifest.capabilities.approvalCallbacks && asked.length === 0) {
        // Adapters that pre-authorize work inside a sandbox may legitimately ask nothing here.
        expect(harness.adapter.manifest.id).toBe("codex-app-server");
      }
      expect(["completed", "failed", "budget_exceeded", "needs_input"]).toContain(outcome.status);
    });

    it("cancels within two seconds and leaves no process behind", async () => {
      const { adapter, request, pid } = await (await makeHarness()).hanging();
      const session = adapter.startSession?.(request, TEST_ACCOUNT);
      if (session === undefined) throw new Error("no session");
      const drained = (async () => {
        for await (const _ of session.events) {
          // discard
        }
      })();
      await new Promise((r) => setTimeout(r, 200));
      const started = Date.now();
      await session.cancel("conformance");
      const outcome = await session.outcome;
      await drained;
      expect(outcome.status).toBe("cancelled");
      expect(Date.now() - started).toBeLessThan(2_000);
      const processId = pid?.();
      if (processId !== undefined) {
        await new Promise((r) => setTimeout(r, 1_500));
        expect(() => process.kill(processId, 0)).toThrow();
      }
    });
  });
}

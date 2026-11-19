import type { AccountId, QuotaWindow } from "@orzeus/schema";
import { describe, expect, it } from "vitest";
import { openStore } from "./index.js";
import { Telemetry } from "./telemetry.js";

const window = (
  used: number,
  observedAt: number,
  extra: Partial<QuotaWindow> = {},
): QuotaWindow => ({
  accountId: "codex" as AccountId,
  window: "5h",
  usedPercent: used,
  resetsAt: null,
  status: "ok",
  source: "official_api",
  observedAt,
  ...extra,
});

describe("Telemetry", () => {
  it("keeps the latest observation per window and ignores unknown accounts", () => {
    let now = 1_000;
    const t = new Telemetry(openStore(":memory:"), () => now);
    t.ensureAccount({
      id: "codex",
      provider: "openai",
      adapter: "codex-app-server",
      label: "Codex",
      authKind: "own_cli_login",
      secretRef: null,
    });
    t.recordQuota([window(10, 1), window(20, 2), window(5, 3, { window: "7d" })]);
    t.recordQuota([window(99, 4, { accountId: "nobody" as AccountId })]);
    expect(t.latestQuota().map((w) => [w.window, w.usedPercent])).toEqual([
      ["5h", 20],
      ["7d", 5],
    ]);
    now = 40 * 24 * 3_600_000;
    t.recordQuota([window(30, now)]);
    expect(t.latestQuota().map((w) => [w.window, w.usedPercent])).toEqual([["5h", 30]]);
  });

  it("stores soft caps per window and validates them", () => {
    const t = new Telemetry(openStore(":memory:"));
    t.ensureAccount({
      id: "a",
      provider: "anthropic",
      adapter: "anthropic-api",
      label: "A",
      authKind: "api_key",
      secretRef: "anthropic",
    });
    t.setSoftCap("a", "5h", 85);
    t.setSoftCap("a", "7d", 90);
    t.setSoftCap("a", "7d", null);
    expect(t.softCaps("a")).toEqual({ "5h": 85 });
    expect(() => t.setSoftCap("a", "5h", 0)).toThrow(/percentage/);
    expect(() => t.setSoftCap("ghost", "5h", 50)).toThrow(/unknown account/);
    t.ensureAccount({
      id: "a",
      provider: "anthropic",
      adapter: "anthropic-api",
      label: "Renamed",
      authKind: "api_key",
      secretRef: "anthropic",
    });
    expect(t.softCaps("a")).toEqual({ "5h": 85 });
  });
});

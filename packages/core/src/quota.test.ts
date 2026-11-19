import type { AccountId, QuotaWindow } from "@orzeus/schema";
import { describe, expect, it } from "vitest";
import { quotaHold } from "./quota.js";

const w = (window: string, used: number | null, extra: Partial<QuotaWindow> = {}): QuotaWindow => ({
  accountId: "a" as AccountId,
  window,
  usedPercent: used,
  resetsAt: 10_000,
  status: "ok",
  source: "official_api",
  observedAt: 0,
  ...extra,
});

describe("quotaHold", () => {
  it("holds an account above its soft cap until the window resets", () => {
    expect(quotaHold([w("5h", 92)], { "5h": 85 }, 1_000)).toMatchObject({
      window: "5h",
      cap: 85,
      until: 10_000,
      reason: "the 5h window is at 92% (your limit is 85%)",
    });
    expect(quotaHold([w("5h", 80)], { "5h": 85 }, 1_000)).toBeNull();
    expect(quotaHold([w("5h", 99)], {}, 1_000)).toBeNull();
  });

  it("always holds a limited window, and forgets windows that already reset", () => {
    expect(quotaHold([w("7d", null, { status: "limited" })], {}, 1_000)?.cap).toBeNull();
    expect(quotaHold([w("5h", 100, { status: "limited", resetsAt: 500 })], {}, 1_000)).toBeNull();
  });

  it("waits for the window that resets last, and rechecks unknown resets in a minute", () => {
    const hold = quotaHold(
      [w("5h", 95, { resetsAt: 5_000 }), w("7d", 96, { resetsAt: 90_000 })],
      { "5h": 90, "7d": 90 },
      1_000,
    );
    expect(hold?.window).toBe("7d");
    expect(quotaHold([w("x", 95, { resetsAt: null })], { x: 90 }, 1_000)?.until).toBe(61_000);
  });
});

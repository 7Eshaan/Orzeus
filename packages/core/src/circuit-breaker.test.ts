import { describe, expect, it } from "vitest";
import { CircuitBreakers } from "./circuit-breaker.js";

describe("CircuitBreakers", () => {
  const options = { threshold: 3, windowMs: 1_000, cooldownMs: 500 };

  it("opens after repeated failures of the same class within the window", () => {
    const b = new CircuitBreakers(options);
    b.recordFailure("codex", "provider.timeout", 0);
    b.recordFailure("codex", "provider.http_error", 10);
    b.recordFailure("codex", "provider.timeout", 20);
    expect(b.allows("codex", 30)).toBe(true);
    b.recordFailure("codex", "provider.timeout", 40);
    expect(b.allows("codex", 50)).toBe(false);
    expect(b.retryAt("codex")).toBe(540);
    expect(b.allows("ollama", 50)).toBe(true);
  });

  it("forgets failures outside the window", () => {
    const b = new CircuitBreakers(options);
    b.recordFailure("x", "e", 0);
    b.recordFailure("x", "e", 100);
    b.recordFailure("x", "e", 1_200);
    expect(b.allows("x", 1_300)).toBe(true);
  });

  it("admits one trial after the cool-down; success closes, failure reopens", () => {
    const b = new CircuitBreakers(options);
    for (const t of [0, 1, 2]) b.recordFailure("x", "e", t);
    expect(b.allows("x", 600)).toBe(true);
    expect(b.allows("x", 601)).toBe(false);
    b.recordFailure("x", "e", 700);
    expect(b.allows("x", 1_100)).toBe(false);
    expect(b.allows("x", 1_200)).toBe(true);
    b.recordSuccess("x");
    expect(b.allows("x", 1_201)).toBe(true);
    expect(b.retryAt("x")).toBeNull();
  });
});

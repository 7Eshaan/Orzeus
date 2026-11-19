import { describe, expect, it } from "vitest";
import { describeEngine, type EngineSnapshot } from "./engine-state.js";

const base: EngineSnapshot = {
  inShell: true,
  status: { state: "running", pid: 1 },
  ping: {
    engineVersion: "0.0.0",
    protocolVersion: 1,
    runtime: { node: "v26.13.0", platform: "darwin", arch: "arm64" },
    startedAt: 0,
  },
  error: null,
  expectedProtocol: 1,
};

describe("describeEngine", () => {
  it("shows ready with version details when the ping succeeds", () => {
    expect(describeEngine(base)).toEqual({
      tone: "ok",
      label: "Engine ready",
      detail: "orzeusd 0.0.0 · Node v26.13.0 · darwin/arm64",
    });
  });

  it("flags a protocol mismatch", () => {
    expect(describeEngine({ ...base, expectedProtocol: 2 }).label).toBe("Engine version mismatch");
  });

  it("explains how to connect when opened outside the desktop shell", () => {
    expect(describeEngine({ ...base, inShell: false }).tone).toBe("attention");
  });

  it("covers every lifecycle state", () => {
    expect(describeEngine({ ...base, status: { state: "starting" } }).label).toBe(
      "Starting engine",
    );
    expect(describeEngine({ ...base, status: { state: "exited", code: 1 } }).detail).toContain(
      "Exit code 1",
    );
    expect(describeEngine({ ...base, status: { state: "failed", message: "boom" } }).detail).toBe(
      "boom",
    );
    expect(describeEngine({ ...base, ping: null }).label).toBe("Connecting");
    expect(describeEngine({ ...base, error: "timed out" }).label).toBe("Engine not responding");
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPacketPrompt } from "@orzeus/core";
import type { NodeId, RunId } from "@orzeus/schema";
import type { SessionRequest } from "../adapter.js";
import { testPacket } from "./suite.js";

export const HELLO_OBJECTIVE =
  "Create a file named hello.txt in the repository root containing exactly the text: hi";

/** A fresh temporary worktree and the hello.txt task, for adapters tested against fakes. */
export function helloRequest(
  model: string,
  overrides: Partial<SessionRequest> = {},
): SessionRequest {
  const worktree = mkdtempSync(join(tmpdir(), "orzeus-adapter-"));
  const packet = testPacket(HELLO_OBJECTIVE);
  return {
    runId: "01JD7Z5K3Q9V8X2M4N6P8R0T2W" as RunId,
    nodeId: "conformance" as NodeId,
    attempt: 1,
    model,
    packet,
    prompt: renderPacketPrompt(packet, [], ["hello.txt"]),
    worktree: { path: worktree, branch: "orzeus/test/conformance" },
    mcp: null,
    budget: {
      maxInputTokens: 100_000,
      maxOutputTokens: 10_000,
      maxCostMicroUsd: 0,
      maxWallMs: 120_000,
      maxTurns: 10,
    },
    resume: null,
    ...overrides,
  };
}

import type { AccountId } from "@orzeus/schema";
import { describe, expect, it } from "vitest";
import { toQuotaWindows } from "./adapters/codex-app-server/adapter.js";
import { EventQueue, SessionController } from "./session.js";
import { shellWords } from "./shell-words.js";

describe("shellWords", () => {
  it.each([
    ["pnpm test --run", ["pnpm", "test", "--run"]],
    [`git commit -m "fix: a b"`, ["git", "commit", "-m", "fix: a b"]],
    ["echo 'a  b' c\\ d", ["echo", "a  b", "c d"]],
    ['echo ""', ["echo", ""]],
    ["rm -rf build && ls", ["sh", "-c", "rm -rf build && ls"]],
    ["cat $(whoami)", ["sh", "-c", "cat $(whoami)"]],
    ["echo 'unterminated", ["sh", "-c", "echo 'unterminated"]],
  ])("%s", (command, argv) => {
    expect(shellWords(command)).toEqual(argv);
  });
});

describe("toQuotaWindows", () => {
  it("names windows by duration and converts reset times to ms", () => {
    const windows = toQuotaWindows(
      "a" as AccountId,
      {
        primary: { usedPercent: 74, windowDurationMins: 43_200, resetsAt: 1_796_462_545 },
        secondary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null },
      },
      5,
    );
    expect(windows).toEqual([
      {
        accountId: "a",
        window: "30d",
        usedPercent: 74,
        resetsAt: 1_796_462_545_000,
        status: "ok",
        source: "official_api",
        observedAt: 5,
      },
      {
        accountId: "a",
        window: "5h",
        usedPercent: 100,
        resetsAt: null,
        status: "limited",
        source: "official_api",
        observedAt: 5,
      },
    ]);
  });
});

describe("SessionController", () => {
  it("delivers events in order, resolves approvals, and finishes once", async () => {
    const controller = new SessionController();
    const approval = controller.requestApproval("r1", { kind: "file_write", path: "a" });
    controller.respond("r1", { kind: "allow_once" });
    await expect(approval).resolves.toEqual({ kind: "allow_once" });
    controller.emit({
      type: "usage",
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      costMicroUsd: 0,
    });
    const pending = controller.requestApproval("r2", { kind: "file_delete", path: "b" });
    controller.finish({
      status: "completed",
      summary: "done",
      costMicroUsd: 0,
      resume: null,
      errorClass: null,
    });
    controller.finish({
      status: "failed",
      summary: "ignored",
      costMicroUsd: 0,
      resume: null,
      errorClass: "x",
    });
    await expect(pending).resolves.toMatchObject({ kind: "deny" });
    const seen: string[] = [];
    for await (const event of controller.events) seen.push(event.type);
    expect(seen).toEqual(["approval_request", "usage", "approval_request"]);
    await expect(controller.outcome).resolves.toMatchObject({
      status: "completed",
      usage: { inputTokens: 1, outputTokens: 2 },
    });
  });

  it("EventQueue ends iteration after close", async () => {
    const queue = new EventQueue<number>();
    queue.push(1);
    queue.close();
    queue.push(2);
    const seen: number[] = [];
    for await (const n of queue) seen.push(n);
    expect(seen).toEqual([1]);
  });
});

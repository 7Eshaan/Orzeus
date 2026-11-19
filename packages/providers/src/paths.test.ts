import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeText } from "./adapters/openai-compatible/workspace-tools.js";
import { hostOf, insideWorktree, safeWorktreePath } from "./paths.js";

function worktreeWithEscape() {
  const outside = mkdtempSync(join(tmpdir(), "orzeus-outside-"));
  writeFileSync(join(outside, "secret.txt"), "do not touch\n");
  const worktree = mkdtempSync(join(tmpdir(), "orzeus-wt-"));
  mkdirSync(join(worktree, "src"));
  symlinkSync(outside, join(worktree, "src", "linked"));
  return { worktree, outside };
}

describe("worktree paths", () => {
  it("keeps relative and absolute paths inside the worktree", () => {
    expect(insideWorktree("/w", "a/b.ts")).toBe("a/b.ts");
    expect(insideWorktree("/w", "/w/a/b.ts")).toBe("a/b.ts");
    expect(insideWorktree("/w", "../x")).toBeNull();
    expect(insideWorktree("/w", "/etc/passwd")).toBeNull();
    expect(hostOf("https://docs.example.com/a?b")).toBe("docs.example.com");
  });

  it("refuses to follow a symbolic link out of the worktree", async () => {
    const { worktree, outside } = worktreeWithEscape();
    await expect(safeWorktreePath(worktree, "src/linked/secret.txt")).rejects.toThrow(
      /symbolic link/,
    );
    await expect(safeWorktreePath(worktree, "src/linked/new/dir/file.txt")).rejects.toThrow(
      /symbolic link/,
    );
    await expect(writeText(worktree, "src/linked/secret.txt", "pwned")).rejects.toThrow();
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("do not touch\n");
    expect(await safeWorktreePath(worktree, "src/new/file.ts")).toMatch(/src\/new\/file\.ts$/);
  });
});

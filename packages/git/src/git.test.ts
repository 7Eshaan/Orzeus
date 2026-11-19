import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitOid } from "@orzeus/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Git } from "./git.js";
import { createFixtureRepo } from "./testing/index.js";
import { WorktreeManager } from "./worktrees.js";

let dir: string;
let repo: string;
let base: GitOid;
const git = new Git();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "orzeus-git-"));
  repo = join(dir, "repo");
  base = await createFixtureRepo(repo, {
    "README.md": "# Fixture\n",
    "src/a.ts": "export const a = 1;\n",
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Git", () => {
  it("creates a clean fixture repository", async () => {
    expect(await git.revParse(repo, "main")).toBe(base);
    expect(await git.run(repo, ["status", "--porcelain"])).toBe("");
  });

  it("snapshots additions, edits and deletions with Orzeus's identity, and leaves the user's checkout alone", async () => {
    const worktrees = new WorktreeManager(git, join(dir, "worktrees"));
    const wt = await worktrees.prepare(repo, "RUN", "node-a", base);
    writeFileSync(join(wt.path, "src/a.ts"), "export const a = 2;\n");
    writeFileSync(join(wt.path, "src/b.ts"), "export const b = 1;\n");
    unlinkSync(join(wt.path, "README.md"));

    const snap = await git.snapshot(wt.path, "Node a\n\nOrzeus-Run: RUN\nOrzeus-Node: node-a\n");
    expect(snap.changed).toBe(true);
    expect(await git.revParse(repo, "orzeus/RUN/node-a")).toBe(snap.commit);
    expect(
      (
        await git.run(repo, [
          "log",
          "-1",
          "--format=%an <%ae>|%(trailers:key=Orzeus-Node,valueonly)",
          snap.commit,
        ])
      ).trim(),
    ).toBe("Orzeus <orzeus@localhost>|node-a");
    expect(await git.run(wt.path, ["status", "--porcelain"])).toBe("");

    const diff = await git.diff(repo, base, snap.commit);
    expect(diff.files.map((f) => [f.path, f.status]).sort()).toEqual([
      ["README.md", "deleted"],
      ["src/a.ts", "modified"],
      ["src/b.ts", "added"],
    ]);
    expect(diff.insertions).toBe(2);
    expect(diff.deletions).toBe(2);
    expect(diff.patch).toContain("+export const b = 1;");

    // The user's own checkout and branch are untouched.
    expect(await git.revParse(repo, "main")).toBe(base);
    expect(await git.run(repo, ["status", "--porcelain"])).toBe("");
  });

  it("reports no change when nothing was edited", async () => {
    const worktrees = new WorktreeManager(git, join(dir, "worktrees"));
    const wt = await worktrees.prepare(repo, "RUN", "idle", base);
    expect(await git.snapshot(wt.path, "noop")).toEqual({ commit: base, changed: false });
  });

  it("resets a reused worktree, including untracked files", async () => {
    const worktrees = new WorktreeManager(git, join(dir, "worktrees"));
    const wt = await worktrees.prepare(repo, "RUN", "retry", base);
    writeFileSync(join(wt.path, "src/a.ts"), "broken");
    writeFileSync(join(wt.path, "junk.txt"), "junk");
    await worktrees.prepare(repo, "RUN", "retry", base);
    expect(readFileSync(join(wt.path, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(await git.run(wt.path, ["status", "--porcelain"])).toBe("");
  });

  it("merges independent work, fast-forwards, and stops at conflicts", async () => {
    const worktrees = new WorktreeManager(git, join(dir, "worktrees"));
    const edit = async (node: string, file: string, content: string) => {
      const wt = await worktrees.prepare(repo, "RUN", node, base);
      writeFileSync(join(wt.path, file), content);
      return (await git.snapshot(wt.path, node)).commit;
    };
    const x = await edit("x", "src/x.ts", "x\n");
    const y = await edit("y", "src/y.ts", "y\n");
    const merged = await git.mergeAll(repo, base, [x, y], (h) => `merge ${h}`);
    if (!merged.ok) throw new Error("expected a clean merge");
    const files = (await git.run(repo, ["ls-tree", "-r", "--name-only", merged.commit]))
      .trim()
      .split("\n");
    expect(files).toEqual(["README.md", "src/a.ts", "src/x.ts", "src/y.ts"]);
    expect(await git.mergeAll(repo, base, [x], () => "ff")).toEqual({ ok: true, commit: x });

    const c1 = await edit("c1", "src/a.ts", "one\n");
    const c2 = await edit("c2", "src/a.ts", "two\n");
    expect(await git.mergeAll(repo, base, [c1, c2], () => "m")).toEqual({
      ok: false,
      conflicts: ["src/a.ts"],
      with: c2,
    });
  });
});

describe("WorktreeManager", () => {
  it("refuses to touch paths outside its root", async () => {
    const worktrees = new WorktreeManager(git, join(dir, "worktrees"));
    await expect(worktrees.remove(repo, repo)).rejects.toThrow(/outside the Orzeus worktree root/);
    await expect(worktrees.prepare(repo, "..", "..", base)).rejects.toThrow(/outside/);
  });
});

describe("fastForward", () => {
  it("moves a checked-out branch only when clean and fast-forwardable", async () => {
    const worktrees = new WorktreeManager(git, join(dir, "worktrees"));
    const wt = await worktrees.prepare(repo, "RUN", "ff", base);
    writeFileSync(join(wt.path, "new.txt"), "new\n");
    const { commit } = await git.snapshot(wt.path, "add new");
    expect(await git.currentBranch(repo)).toBe("main");

    writeFileSync(join(repo, "README.md"), "dirty\n");
    expect(await git.fastForward(repo, "main", base, commit)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("uncommitted"),
    });
    await git.run(repo, ["checkout", "--", "README.md"]);

    expect(await git.fastForward(repo, "main", base, commit)).toEqual({ ok: true });
    expect(await git.revParse(repo, "main")).toBe(commit);
    expect(readFileSync(join(repo, "new.txt"), "utf8")).toBe("new\n");
    expect(await git.fastForward(repo, "main", base, commit)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("moved"),
    });
  });
});

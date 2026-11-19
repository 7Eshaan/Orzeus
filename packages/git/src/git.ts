import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitOid } from "@orzeus/schema";
import { type ExecOptions, type ExecResult, execGit, GitError } from "./exec.js";

export interface GitOptions {
  /** git executable, default "git". */
  readonly binary?: string;
  readonly timeoutMs?: number;
}

export interface Identity {
  readonly name: string;
  readonly email: string;
}

/** Commits Orzeus makes carry this identity, so they never depend on the user's git config. */
export const ORZEUS_IDENTITY: Identity = { name: "Orzeus", email: "orzeus@localhost" };

export interface ChangedFile {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "renamed" | "other";
  /** null for binary files. */
  readonly insertions: number | null;
  readonly deletions: number | null;
}

export interface Diff {
  readonly patch: string;
  readonly files: readonly ChangedFile[];
  readonly insertions: number;
  readonly deletions: number;
}

export type MergeResult =
  | { readonly ok: true; readonly commit: GitOid }
  | { readonly ok: false; readonly conflicts: readonly string[]; readonly with: GitOid };

/**
 * Typed wrapper over the git CLI. Uses porcelain only for read-only queries and worktree
 * management; snapshots and merges are built from plumbing (temporary index, write-tree,
 * commit-tree, merge-tree, update-ref), so Orzeus never touches the user's index, never runs
 * hooks, and never depends on the user's identity configuration.
 */
export class Git {
  readonly #binary: string;
  readonly #timeoutMs: number;

  constructor(options: GitOptions = {}) {
    this.#binary = options.binary ?? "git";
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  async raw(args: readonly string[], options: ExecOptions): Promise<ExecResult> {
    return execGit(this.#binary, args, { timeoutMs: this.#timeoutMs, ...options });
  }

  /** Runs git and returns stdout, throwing GitError on a non-zero exit. */
  async run(
    cwd: string,
    args: readonly string[],
    options: Omit<ExecOptions, "cwd"> = {},
  ): Promise<string> {
    const result = await this.raw(args, { cwd, ...options });
    if (result.exitCode !== 0) throw new GitError(args, result.exitCode, result.stderr);
    return result.stdout;
  }

  async version(): Promise<string> {
    return (await this.run(process.cwd(), ["--version"])).trim();
  }

  async revParse(cwd: string, rev: string): Promise<GitOid> {
    return (
      await this.run(cwd, ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`])
    ).trim() as GitOid;
  }

  async topLevel(cwd: string): Promise<string> {
    return (await this.run(cwd, ["rev-parse", "--show-toplevel"])).trim();
  }

  async treeOf(cwd: string, commit: GitOid): Promise<string> {
    return (await this.run(cwd, ["rev-parse", `${commit}^{tree}`])).trim();
  }

  async addWorktree(repo: string, path: string, branch: string, base: GitOid): Promise<void> {
    await this.run(repo, ["worktree", "add", "--quiet", "-B", branch, path, base]);
  }

  async removeWorktree(repo: string, path: string): Promise<void> {
    await this.run(repo, ["worktree", "remove", "--force", path]);
  }

  async pruneWorktrees(repo: string): Promise<void> {
    await this.run(repo, ["worktree", "prune"]);
  }

  /** Moves the worktree's branch to `commit` and discards every change (tracked and untracked). */
  async hardReset(worktree: string, commit: GitOid): Promise<void> {
    await this.run(worktree, ["reset", "--quiet", "--hard", commit]);
    await this.run(worktree, ["clean", "-fdq"]);
  }

  /**
   * Records the worktree's current files as a commit on its branch, using a temporary index.
   * Returns the new commit, or the current HEAD when nothing changed.
   */
  async snapshot(
    worktree: string,
    message: string,
    identity: Identity = ORZEUS_IDENTITY,
  ): Promise<{ readonly commit: GitOid; readonly changed: boolean }> {
    const head = await this.revParse(worktree, "HEAD");
    const index = join(tmpdir(), `orzeus-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      await this.run(worktree, ["read-tree", head], { env });
      const changed = await this.run(
        worktree,
        ["ls-files", "-z", "--modified", "--deleted", "--others", "--exclude-standard"],
        {
          env,
        },
      );
      if (changed !== "") {
        await this.run(worktree, ["update-index", "-z", "--add", "--remove", "--stdin"], {
          env,
          input: changed,
        });
      }
      const tree = (await this.run(worktree, ["write-tree"], { env })).trim();
      if (tree === (await this.treeOf(worktree, head))) return { commit: head, changed: false };
      const commit = await this.commitTree(worktree, tree, [head], message, identity);
      await this.run(worktree, ["update-ref", "-m", "orzeus: snapshot", "HEAD", commit, head]);
      // Bring the worktree's own index in line with the new HEAD (stat info refreshes lazily).
      await this.run(worktree, ["read-tree", "HEAD"]);
      return { commit, changed: true };
    } finally {
      await rm(index, { force: true });
    }
  }

  async commitTree(
    cwd: string,
    tree: string,
    parents: readonly GitOid[],
    message: string,
    identity: Identity = ORZEUS_IDENTITY,
  ): Promise<GitOid> {
    const env = {
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    };
    const args = ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-F", "-"];
    return (await this.run(cwd, args, { env, input: message })).trim() as GitOid;
  }

  async diff(cwd: string, base: GitOid, head: GitOid): Promise<Diff> {
    const [patch, numstat, nameStatus] = await Promise.all([
      this.run(cwd, ["diff", "--no-color", "--no-ext-diff", "--binary", base, head]),
      this.run(cwd, ["diff", "--numstat", "-z", "--no-renames", base, head]),
      this.run(cwd, ["diff", "--name-status", "-z", "--no-renames", base, head]),
    ]);

    const statuses = new Map<string, ChangedFile["status"]>();
    const ns = nameStatus.split("\0");
    for (let i = 0; i + 1 < ns.length; i += 2) {
      const code = ns[i] ?? "";
      const path = ns[i + 1] ?? "";
      statuses.set(
        path,
        code === "A" ? "added" : code === "M" ? "modified" : code === "D" ? "deleted" : "other",
      );
    }

    const files: ChangedFile[] = [];
    for (const entry of numstat.split("\0")) {
      if (entry === "") continue;
      const [added, removed, path] = entry.split("\t");
      if (path === undefined) continue;
      files.push({
        path,
        status: statuses.get(path) ?? "other",
        insertions: added === "-" ? null : Number(added),
        deletions: removed === "-" ? null : Number(removed),
      });
    }
    return {
      patch,
      files,
      insertions: files.reduce((sum, f) => sum + (f.insertions ?? 0), 0),
      deletions: files.reduce((sum, f) => sum + (f.deletions ?? 0), 0),
    };
  }

  /**
   * Merges `heads` one by one onto `base` with `git merge-tree --write-tree` (no worktree, no
   * index), creating merge commits as needed. Stops at the first conflict.
   */
  async mergeAll(
    repo: string,
    base: GitOid,
    heads: readonly GitOid[],
    message: (head: GitOid) => string,
  ): Promise<MergeResult> {
    let current = base;
    for (const head of heads) {
      if (head === current) continue;
      const isAncestor = await this.raw(["merge-base", "--is-ancestor", head, current], {
        cwd: repo,
      });
      if (isAncestor.exitCode === 0) continue;
      const fastForward = await this.raw(["merge-base", "--is-ancestor", current, head], {
        cwd: repo,
      });
      if (fastForward.exitCode === 0) {
        current = head;
        continue;
      }
      const result = await this.raw(
        ["merge-tree", "--write-tree", "--name-only", "--no-messages", current, head],
        { cwd: repo },
      );
      const lines = result.stdout.split("\n").filter((l) => l !== "");
      if (result.exitCode === 1) return { ok: false, conflicts: lines.slice(1), with: head };
      if (result.exitCode !== 0) throw new GitError(["merge-tree"], result.exitCode, result.stderr);
      const tree = lines[0] ?? "";
      current = await this.commitTree(repo, tree, [current, head], message(head));
    }
    return { ok: true, commit: current };
  }

  async updateBranch(repo: string, branch: string, commit: GitOid): Promise<void> {
    await this.run(repo, ["update-ref", "-m", "orzeus", `refs/heads/${branch}`, commit]);
  }

  async branchExists(repo: string, branch: string): Promise<boolean> {
    return (
      (await this.raw(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo }))
        .exitCode === 0
    );
  }
}

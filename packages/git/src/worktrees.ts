import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { GitOid } from "@orzeus/schema";
import type { Git } from "./git.js";

export interface WorktreeHandle {
  readonly path: string;
  readonly branch: string;
}

/**
 * Owns Orzeus's worktrees under one root directory, outside the user's checkout. Every
 * destructive operation is refused for paths outside that root, so a bug cannot reset or
 * delete the user's own working tree.
 */
export class WorktreeManager {
  readonly #git: Git;
  readonly #root: string;

  constructor(git: Git, root: string) {
    this.#git = git;
    this.#root = resolve(root);
  }

  get root(): string {
    return this.#root;
  }

  pathFor(runId: string, nodeId: string): string {
    return join(this.#root, runId, nodeId);
  }

  static branchFor(runId: string, nodeId: string): string {
    return `orzeus/${runId}/${nodeId}`;
  }

  /** Creates the node's worktree at `base`, or resets an existing one to `base`. */
  async prepare(
    repo: string,
    runId: string,
    nodeId: string,
    base: GitOid,
  ): Promise<WorktreeHandle> {
    const path = this.pathFor(runId, nodeId);
    const branch = WorktreeManager.branchFor(runId, nodeId);
    this.#assertOwned(path);
    if (existsSync(path)) {
      await this.#git.hardReset(path, base);
    } else {
      await mkdir(join(this.#root, runId), { recursive: true });
      await this.#git.pruneWorktrees(repo);
      await this.#git.addWorktree(repo, path, branch, base);
    }
    return { path, branch };
  }

  async remove(repo: string, path: string): Promise<void> {
    this.#assertOwned(path);
    if (existsSync(path)) await this.#git.removeWorktree(repo, path);
  }

  #assertOwned(path: string): void {
    const rel = relative(this.#root, resolve(path));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(
        `refusing to manage ${path}: it is outside the Orzeus worktree root ${this.#root}`,
      );
    }
  }
}

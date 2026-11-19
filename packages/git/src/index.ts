/**
 * @orzeus/git
 *
 * Git worktree management, plumbing-based snapshots and merges, and diffs. Every git call uses
 * an argv array and an explicit cwd; nothing goes through a shell.
 */
export { type ExecResult, GitError } from "./exec.js";
export {
  type ChangedFile,
  type Diff,
  Git,
  type GitOptions,
  type Identity,
  type MergeResult,
  ORZEUS_IDENTITY,
} from "./git.js";
export { type WorktreeHandle, WorktreeManager } from "./worktrees.js";

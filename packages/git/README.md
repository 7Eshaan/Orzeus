# @orzeus/git

Git worktree manager over the git CLI: create, reset, diff, commit, cleanup.

## Rules

Every git call uses an argv array and an explicit cwd. Nothing goes through a shell.

## Status

Implemented in Phase 2.

Entry points: `Git` (typed wrapper: `snapshot`, `diff`, `mergeAll`, `hardReset`, worktree add/remove) and `WorktreeManager` (owns worktrees under one root and refuses to touch anything outside it). Snapshots and merges use plumbing only (temporary index, `write-tree`, `commit-tree`, `merge-tree --write-tree`, `update-ref`), so Orzeus never touches your index, never runs hooks, and commits as `Orzeus <orzeus@localhost>` on its own `orzeus/<run>/<node>` branches. `@orzeus/git/testing` has `createFixtureRepo` for tests.

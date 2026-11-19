import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * A path an agent named, made relative to the worktree; null when it points outside it.
 * Agents report absolute or relative paths, so both are accepted.
 */
export function insideWorktree(worktree: string, path: string): string | null {
  const root = resolve(worktree);
  const full = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rel = relative(root, full);
  if (rel === "") return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split("\\").join("/");
}

/** The host of a URL, or the text itself when it is not one. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * Resolves a worktree-relative path to an absolute one that really is inside the worktree,
 * following symlinks: a link committed in the repository (say `docs -> /etc`) must not let a
 * worker read or write outside it. The deepest existing ancestor is checked, so new files in
 * new directories work. Throws when the path escapes.
 */
export async function safeWorktreePath(worktree: string, relativePath: string): Promise<string> {
  const root = await realpath(worktree);
  const target = resolve(root, relativePath);
  if (insideWorktree(root, target) === null)
    throw new Error(`${relativePath} is outside the repository`);
  let existing = target;
  const missing: string[] = [];
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) break;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
  const real = join(existing, ...missing);
  if (insideWorktree(root, real) === null)
    throw new Error(`${relativePath} leads outside the repository through a symbolic link`);
  return real;
}

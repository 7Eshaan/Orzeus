import { isAbsolute, relative, resolve } from "node:path";

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

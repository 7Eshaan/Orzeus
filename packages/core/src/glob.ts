/**
 * Minimal, dependency-free glob support for write scopes and policy checks.
 *
 * Supported: `**` (any number of path segments), `*` (within one segment), `?` (one character
 * within a segment). Paths are POSIX-style and relative to the worktree root.
 */

const GLOB_META = /[*?[\]{}]/;

/** Normalizes a relative POSIX path. Returns null if it is absolute or escapes the root. */
export function normalizeRelativePath(path: string): string | null {
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.includes("\\")) return null;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] as string;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        const followedBySlash = glob[i + 2] === "/";
        source += followedBySlash ? "(?:.*/)?" : ".*";
        i += followedBySlash ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/** True if the (normalized) path matches any of the globs. */
export function matchesAny(path: string, globs: readonly string[]): boolean {
  const normalized = normalizeRelativePath(path);
  if (normalized === null) return false;
  return globs.some((glob) => globToRegExp(glob).test(normalized));
}

/** The literal directory part of a glob before any wildcard, e.g. "src/api/**" → "src/api". */
function staticPrefix(glob: string): string {
  const metaIndex = glob.search(GLOB_META);
  if (metaIndex === -1) return glob;
  const head = glob.slice(0, metaIndex);
  const slash = head.lastIndexOf("/");
  return slash === -1 ? "" : head.slice(0, slash);
}

function isPathPrefix(prefix: string, path: string): boolean {
  return prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Conservative overlap test between two write scopes: two entries may overlap when the literal
 * part of one is a path prefix of the other's (a literal entry may name a directory). It can
 * report an overlap that cannot happen (the scheduler then serializes two nodes unnecessarily),
 * but never misses a real one.
 */
export function scopesMayOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((left) =>
    b.some((right) => {
      const l = staticPrefix(left);
      const r = staticPrefix(right);
      return isPathPrefix(l, r) || isPathPrefix(r, l);
    }),
  );
}

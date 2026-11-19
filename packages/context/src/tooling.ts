import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A short description of how the repository is built and tested, so the planner writes checks
 * that actually exist (e.g. it must not invent `npm test` when there is no test script).
 */
export function describeTooling(root: string): string {
  const lines: string[] = [];
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
        packageManager?: string;
        type?: string;
      };
      const scripts = Object.entries(pkg.scripts ?? {});
      lines.push(
        scripts.length === 0
          ? "package.json has no scripts (run tools directly, e.g. node --test <file>)."
          : `package.json scripts: ${scripts.map(([name, cmd]) => `${name} = ${cmd}`).join("; ")}`,
      );
      if (pkg.packageManager) lines.push(`package manager: ${pkg.packageManager}`);
      if (pkg.type) lines.push(`module type: ${pkg.type}`);
    } catch {
      lines.push("package.json is present but not valid JSON.");
    }
  }
  for (const [file, note] of [
    ["pnpm-lock.yaml", "uses pnpm"],
    ["yarn.lock", "uses yarn"],
    ["pyproject.toml", "Python project (pyproject.toml)"],
    ["Cargo.toml", "Rust project (cargo test)"],
    ["go.mod", "Go module (go test ./...)"],
    ["Makefile", "has a Makefile"],
  ] as const) {
    if (existsSync(join(root, file))) lines.push(note);
  }
  return lines.length === 0 ? "No build or test tooling detected." : lines.join("\n");
}

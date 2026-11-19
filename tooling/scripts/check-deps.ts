/**
 * Enforces the package layering described in docs/architecture/01-monorepo-layout.md.
 *
 * 1. Every workspace package has a rule in dependency-rules.json.
 * 2. Its @orzeus/* dependencies are all allowed by that rule.
 * 3. Its tsconfig project references match those dependencies exactly.
 * 4. Its source only imports @orzeus/* packages it declares.
 * 5. Pure packages import no Node built-ins.
 *
 * Run with: node tooling/scripts/check-deps.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Rules {
  readonly pure: readonly string[];
  readonly allowed: Readonly<Record<string, readonly string[]>>;
}

interface PackageJson {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

interface TsConfig {
  readonly references?: readonly { readonly path: string }[];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const rules = readJson<Rules>(join(root, "tooling/scripts/dependency-rules.json"));
const workspaceDirs = ["apps", "services", "packages"].flatMap((group) =>
  listDirs(join(root, group)),
);
const errors: string[] = [];

const nameByDir = new Map<string, string>();
for (const dir of workspaceDirs) {
  nameByDir.set(dir, readJson<PackageJson>(join(dir, "package.json")).name);
}

const nodeBuiltins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

for (const dir of workspaceDirs) {
  const pkg = readJson<PackageJson>(join(dir, "package.json"));
  const where = relative(root, dir);
  const allowed = rules.allowed[pkg.name];
  if (allowed === undefined) {
    errors.push(`${where}: ${pkg.name} has no entry in dependency-rules.json`);
    continue;
  }

  const declared = new Set(
    Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) =>
      d.startsWith("@orzeus/"),
    ),
  );
  for (const dep of declared) {
    if (!allowed.includes(dep)) errors.push(`${where}: ${pkg.name} may not depend on ${dep}`);
  }

  const referenced = new Set<string>();
  for (const config of ["tsconfig.json", "tsconfig.app.json"]) {
    const path = join(dir, config);
    if (!existsSync(path)) continue;
    for (const ref of readJson<TsConfig>(path).references ?? []) {
      const target = nameByDir.get(resolve(dir, ref.path));
      if (target !== undefined) referenced.add(target);
    }
  }
  for (const dep of declared) {
    if (!referenced.has(dep))
      errors.push(`${where}: depends on ${dep} but tsconfig has no reference to it`);
  }
  for (const ref of referenced) {
    if (!declared.has(ref))
      errors.push(`${where}: tsconfig references ${ref} but package.json does not depend on it`);
  }

  const isPure = rules.pure.includes(pkg.name);
  for (const file of listSourceFiles(join(dir, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[1] ?? "";
      const fileWhere = relative(root, file);
      if (specifier.startsWith("@orzeus/")) {
        const target = specifier.split("/").slice(0, 2).join("/");
        if (target !== pkg.name && !declared.has(target)) {
          errors.push(`${fileWhere}: imports ${target}, which ${pkg.name} does not declare`);
        }
      } else if (isPure && nodeBuiltins.has(specifier) && !file.endsWith(".test.ts")) {
        errors.push(`${fileWhere}: pure package imports Node built-in "${specifier}"`);
      }
    }
  }
}

if (errors.length > 0) {
  process.stderr.write(`Dependency rules violated:\n${errors.map((e) => `  - ${e}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Dependency rules OK (${workspaceDirs.length} packages).\n`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function listDirs(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .map((name) => join(path, name))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, "package.json")));
}

function listSourceFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { recursive: true, encoding: "utf8" })
    .map((name) => join(path, name))
    .filter((p) => /\.(ts|tsx)$/.test(p) && statSync(p).isFile());
}

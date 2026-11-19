import { isAbsolute, join, relative, resolve } from "node:path";
import { matchesAny, normalizeRelativePath } from "@orzeus/core";
import type { CheckSpec } from "@orzeus/schema";
import { runCommand } from "./run-command.js";

export interface CheckResult {
  readonly checkId: string;
  readonly label: string;
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly output: string;
  readonly timedOut: boolean;
}

export interface CheckContext {
  readonly worktree: string;
  /** Paths changed by the attempt, relative to the worktree. */
  readonly changedPaths: readonly string[];
  readonly writeScope: readonly string[];
  /** Changed paths that became symbolic links or submodules; the scope guard refuses them. */
  readonly links?: readonly string[];
  /** Extra environment for commands, on top of a minimal safe base. */
  readonly env?: Readonly<Record<string, string>>;
  readonly maxOutputChars?: number;
}

/** Variables passed through from the engine's environment to check commands. */
const PASSTHROUGH_ENV = ["PATH", "HOME", "LANG", "TMPDIR", "SHELL", "USER"];

export function checkEnvironment(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = { CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" };
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

/** The changed paths that fall outside the write scope. */
export function outOfScope(
  changedPaths: readonly string[],
  writeScope: readonly string[],
): string[] {
  return changedPaths.filter((path) => !matchesAny(path, writeScope));
}

export async function runCheck(check: CheckSpec, context: CheckContext): Promise<CheckResult> {
  const base = { checkId: check.id, label: check.label, timedOut: false };
  switch (check.kind) {
    case "scope_guard": {
      const outside = outOfScope(context.changedPaths, context.writeScope);
      const links = context.links ?? [];
      const problems = [
        ...(outside.length === 0
          ? []
          : [
              `Changed outside the write scope (${context.writeScope.join(", ") || "read-only"}):\n${outside.map((p) => `  ${p}`).join("\n")}`,
            ]),
        ...(links.length === 0
          ? []
          : [
              `Created symbolic links or submodules, which could point outside the repository:\n${links.map((p) => `  ${p}`).join("\n")}`,
            ]),
      ];
      return {
        ...base,
        passed: problems.length === 0,
        exitCode: null,
        durationMs: 0,
        output:
          problems.length === 0
            ? `All ${context.changedPaths.length} changed files are inside the write scope.`
            : problems.join("\n"),
      };
    }
    case "json_schema":
      return {
        ...base,
        passed: false,
        exitCode: null,
        durationMs: 0,
        output: "json_schema checks are not supported yet (Phase 3).",
      };
    case "command": {
      const relativeCwd = normalizeRelativePath(check.cwd === "" ? "." : check.cwd);
      const cwd = relativeCwd === null ? null : resolve(join(context.worktree, relativeCwd));
      const rel = cwd === null ? ".." : relative(resolve(context.worktree), cwd);
      if (cwd === null || rel.startsWith("..") || isAbsolute(rel)) {
        return {
          ...base,
          passed: false,
          exitCode: null,
          durationMs: 0,
          output: `cwd ${check.cwd} is outside the worktree.`,
        };
      }
      const result = await runCommand(check.argv, {
        cwd,
        env: checkEnvironment(context.env),
        timeoutMs: check.timeoutMs,
        ...(context.maxOutputChars === undefined ? {} : { maxOutputChars: context.maxOutputChars }),
      });
      const header = `$ ${check.argv.join(" ")}\n`;
      const footer = result.timedOut ? `\nTimed out after ${check.timeoutMs} ms.` : "";
      return {
        ...base,
        passed: !result.timedOut && result.exitCode === check.expectExitCode,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        output: header + result.output + footer,
        timedOut: result.timedOut,
      };
    }
  }
}

/**
 * Runs the node's checks in order, always including the scope guard first (it is free and its
 * failure makes the rest meaningless to trust).
 */
export async function runChecks(
  checks: readonly CheckSpec[],
  context: CheckContext,
): Promise<CheckResult[]> {
  const all: CheckSpec[] = checks.some((c) => c.kind === "scope_guard")
    ? [...checks]
    : [{ kind: "scope_guard", id: "scope", label: "Changes stay in scope" }, ...checks];
  const results: CheckResult[] = [];
  for (const check of all) results.push(await runCheck(check, context));
  return results;
}

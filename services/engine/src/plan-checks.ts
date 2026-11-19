import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { PlannerOutput } from "@orzeus/schema";

function onPath(command: string): boolean {
  if (command.includes("/")) return true; // relative or absolute paths are checked at run time
  return (process.env["PATH"] ?? "").split(delimiter).some((dir) => {
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Checks a plan's verification commands against the actual repository, so a plan cannot rely on
 * a script or tool that does not exist (planners like to assume `npm test`). Problems go back to
 * the planner in its repair round.
 */
export function checkCommandsExist(plan: PlannerOutput, root: string): string[] {
  let scripts: Record<string, string> = {};
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      scripts =
        (JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> })
          .scripts ?? {};
    } catch {
      scripts = {};
    }
  }
  const problems: string[] = [];
  for (const node of plan.dag.nodes) {
    for (const check of node.checks) {
      if (check.kind !== "command") continue;
      const [command, first, second] = check.argv;
      const where = `${node.id}: check "${check.argv.join(" ")}"`;
      if (!onPath(command)) {
        problems.push(`${where} uses ${command}, which is not installed`);
        continue;
      }
      if (["npm", "pnpm", "yarn", "bun"].includes(command)) {
        const script = first === "run" || first === "run-script" ? second : first;
        const builtins = ["exec", "dlx", "x", "install", "ci"];
        if (script !== undefined && !builtins.includes(script) && scripts[script] === undefined) {
          problems.push(
            `${where} needs a package.json "${script}" script, which does not exist; call the tool directly (for example node --test <file>)`,
          );
        }
      }
    }
  }
  return problems;
}

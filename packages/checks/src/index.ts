/**
 * @orzeus/checks
 *
 * Deterministic verification of a node's work: argv commands (no shell) with timeouts that
 * kill the whole process group, head-and-tail output capture, and the write-scope guard.
 */
export {
  type CheckContext,
  type CheckResult,
  checkEnvironment,
  outOfScope,
  runCheck,
  runChecks,
} from "./checks.js";
export { HeadTailBuffer } from "./output-buffer.js";
export { type CommandOptions, type CommandResult, runCommand } from "./run-command.js";

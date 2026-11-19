import { spawn } from "node:child_process";
import { HeadTailBuffer } from "./output-buffer.js";

export interface CommandResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** stdout and stderr interleaved in arrival order, head and tail kept when long. */
  readonly output: string;
  readonly truncated: boolean;
}

export interface CommandOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputChars?: number;
  /** Time between SIGTERM and SIGKILL on timeout. */
  readonly killGraceMs?: number;
  readonly now?: () => number;
}

/**
 * Runs argv without a shell in its own process group, so a timeout kills the whole tree
 * (test runners love to spawn workers).
 */
export function runCommand(
  argv: readonly [string, ...string[]],
  options: CommandOptions,
): Promise<CommandResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const output = new HeadTailBuffer(options.maxOutputChars ?? 64_000);
  const [command, ...args] = argv;

  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null, signal: string | null, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (extra !== "") output.push(extra);
      resolve({
        exitCode,
        signal,
        timedOut,
        durationMs: now() - started,
        output: output.toString(),
        truncated: output.truncated,
      });
    };

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...options.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    };

    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), options.killGraceMs ?? 2_000);
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => output.push(chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => output.push(chunk));
    child.on("error", (error) =>
      finish(null, null, `\nFailed to start ${command}: ${error.message}\n`),
    );
    child.on("close", (code, signal) => {
      // Reap anything the command left running in its group.
      killGroup("SIGKILL");
      finish(code, signal);
    });
  });
}

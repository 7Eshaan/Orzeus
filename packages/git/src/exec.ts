import { spawn } from "node:child_process";

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
  readonly timeoutMs?: number;
}

export class GitError extends Error {
  override readonly name = "GitError";
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(args: readonly string[], exitCode: number | null, stderr: string, reason?: string) {
    super(
      `git ${args.join(" ")} failed${exitCode === null ? "" : ` (exit ${exitCode})`}: ${reason ?? stderr.trim()}`,
    );
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** Environment for every git call: no prompts, stable output, nothing inherited by accident. */
function gitEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    GIT_OPTIONAL_LOCKS: "0",
  };
  for (const key of ["PATH", "HOME", "TMPDIR", "XDG_CONFIG_HOME"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

/** Runs git with an argv array (never a shell). Resolves with the exit code; does not throw on non-zero. */
export function execGit(
  binary: string,
  args: readonly string[],
  options: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: gitEnv(options.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const err = Buffer.concat(stderr).toString("utf8");
      if (timedOut) {
        reject(new GitError(args, null, err, `timed out after ${options.timeoutMs} ms`));
        return;
      }
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: err,
      });
    });
    // git may exit before reading all of stdin (e.g. a command that ignores it). The exit code
    // reports any real failure, so a broken pipe here must not become an uncaught exception.
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(options.input ?? "");
  });
}

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * A CLI that prints one JSON event per line (codex exec --json, cursor-agent stream-json).
 * Lines that are not JSON objects are passed to `onText` so nothing is silently lost.
 */
export class JsonlProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<number | null>;
  readonly stderr: string[] = [];

  constructor(
    command: readonly [string, ...string[]],
    options: {
      readonly cwd: string;
      readonly env: Record<string, string>;
      readonly stdin?: string;
      readonly onEvent: (event: Record<string, unknown>) => void;
      readonly onText?: (line: string) => void;
    },
  ) {
    const [program, ...args] = command;
    this.#child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stdin.on("error", () => undefined);
    this.#child.stdin.end(options.stdin ?? "");
    this.#child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderr.push(chunk);
      if (this.stderr.length > 200) this.stderr.shift();
    });
    const lines = createInterface({ input: this.#child.stdout });
    lines.on("line", (line) => {
      const text = line.trim();
      if (text === "") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        options.onText?.(text);
        return;
      }
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
        options.onEvent(parsed as Record<string, unknown>);
      else options.onText?.(text);
    });
    // "close" fires after stdout is fully read, so every event is handled before exit.
    this.exited = new Promise((resolve) => {
      this.#child.on("close", (code) => resolve(code));
      this.#child.on("error", (error) => {
        this.stderr.push(error.message);
        resolve(null);
      });
    });
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  /** SIGTERM, then SIGKILL after a second if it is still running. */
  kill(): void {
    const alive = () => this.#child.exitCode === null && this.#child.signalCode === null;
    if (alive()) this.#child.kill("SIGTERM");
    setTimeout(() => {
      if (alive()) this.#child.kill("SIGKILL");
    }, 1_000).unref();
  }

  stderrTail(chars = 500): string {
    return this.stderr.join("").slice(-chars).trim();
  }
}

/** PATH, HOME and friends: enough for a CLI to find itself and its own login, nothing more. */
export function cliEnv(
  keep: readonly string[],
  extra: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "USER", "SHELL", ...keep]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

/** Runs a command to completion and returns its output (for --version probes). */
export function runOnce(
  command: readonly [string, ...string[]],
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string; missing: boolean }> {
  return new Promise((resolve) => {
    const [program, ...args] = command;
    let stdout = "";
    let stderr = "";
    const child = spawn(program, args, { env, stdio: ["ignore", "pipe", "pipe"], signal });
    child.stdout.setEncoding("utf8").on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.setEncoding("utf8").on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", (error: NodeJS.ErrnoException) =>
      resolve({ code: null, stdout, stderr: error.message, missing: error.code === "ENOENT" }),
    );
    child.on("close", (code) => resolve({ code, stdout, stderr, missing: false }));
  });
}

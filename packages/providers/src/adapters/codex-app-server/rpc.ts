import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Minimal JSON-RPC peer for `codex app-server`: newline-delimited JSON over stdio, with the
 * "jsonrpc" field omitted on the wire (as the app-server documents).
 */
export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown>;
export type NotificationHandler = (method: string, params: unknown) => void;

export class RpcRemoteError extends Error {
  override readonly name = "RpcRemoteError";
  readonly code: number;

  constructor(method: string, code: number, message: string) {
    super(`${method}: ${message}`);
    this.code = code;
  }
}

export class CodexRpc {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<
    number | string,
    { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  #nextId = 1;
  #onNotification: NotificationHandler = () => undefined;
  #onRequest: ServerRequestHandler = async (method) => {
    throw new RpcRemoteError(method, -32601, "not supported by Orzeus");
  };
  readonly exited: Promise<number | null>;
  readonly stderr: string[] = [];

  constructor(
    command: readonly [string, ...string[]],
    options: { cwd: string; env: Record<string, string> },
  ) {
    const [program, ...args] = command;
    this.#child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) => {
      this.#child.on("close", (code) => {
        for (const pending of this.#pending.values())
          pending.reject(new Error(`app-server exited (${code}) during ${pending.method}`));
        this.#pending.clear();
        resolve(code);
      });
      this.#child.on("error", (error) => {
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
        resolve(null);
      });
    });
    this.#child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderr.push(chunk);
      if (this.stderr.length > 200) this.stderr.shift();
    });
    createInterface({ input: this.#child.stdout }).on("line", (line) => this.#receive(line));
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  onNotification(handler: NotificationHandler): void {
    this.#onNotification = handler;
  }

  onRequest(handler: ServerRequestHandler): void {
    this.#onRequest = handler;
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject });
      this.#write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.#write(params === undefined ? { method } : { method, params });
  }

  kill(): void {
    if (this.#child.exitCode === null && this.#child.signalCode === null)
      this.#child.kill("SIGTERM");
    setTimeout(() => {
      if (this.#child.exitCode === null && this.#child.signalCode === null)
        this.#child.kill("SIGKILL");
    }, 1_000).unref();
  }

  #write(message: RpcMessage): void {
    if (this.#child.stdin.writable) this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receive(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      const { id, method } = message;
      this.#onRequest(method, message.params).then(
        (result) => this.#write({ id, result }),
        (error: unknown) =>
          this.#write({
            id,
            error: {
              code: error instanceof RpcRemoteError ? error.code : -32000,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
      );
      return;
    }
    if (message.method !== undefined) {
      this.#onNotification(message.method, message.params);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (message.error !== undefined)
        pending.reject(
          new RpcRemoteError(pending.method, message.error.code, message.error.message),
        );
      else pending.resolve(message.result);
    }
  }
}

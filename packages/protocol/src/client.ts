import {
  encodeLine,
  parseLine,
  RpcError,
  RpcErrorCode,
  type RpcNotification,
  RpcNotificationSchema,
  RpcResponseSchema,
} from "./jsonrpc.js";
import { type MethodName, type MethodParams, type MethodResult, methods } from "./methods.js";

/** Sends one encoded line to the engine. */
export type SendLine = (line: string) => void | Promise<void>;

interface Pending {
  readonly method: MethodName;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: RpcError) => void;
}

/**
 * Typed JSON-RPC client. Transport-agnostic: give it a way to send lines and feed it every line
 * received with `receive`. Results are validated against the method's result schema.
 *
 * Timeouts are the caller's job, so this stays free of timer APIs.
 */
export class RpcClient {
  readonly #send: SendLine;
  readonly #pending = new Map<number, Pending>();
  readonly #onNotification: ((notification: RpcNotification) => void) | undefined;
  #nextId = 1;
  #disposed = false;

  constructor(send: SendLine, onNotification?: (notification: RpcNotification) => void) {
    this.#send = send;
    this.#onNotification = onNotification;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  async request<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
  ): Promise<MethodResult<M>> {
    if (this.#disposed) {
      throw new RpcError({ code: RpcErrorCode.Disposed, message: "Client is disposed" });
    }
    const id = this.#nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
    });
    try {
      await this.#send(encodeLine({ jsonrpc: "2.0", id, method, params }));
    } catch (error) {
      this.#pending.delete(id);
      throw new RpcError({
        code: RpcErrorCode.InternalError,
        message: `Failed to send ${method}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return (await response) as MethodResult<M>;
  }

  /** Feed every line received from the engine. Unknown or malformed lines are ignored. */
  receive(line: string): void {
    const message = parseLine(line);
    if (message === undefined) return;

    const response = RpcResponseSchema.safeParse(message);
    if (response.success) {
      const { id } = response.data;
      if (typeof id !== "number") return;
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      this.#pending.delete(id);

      if ("error" in response.data) {
        pending.reject(new RpcError(response.data.error));
        return;
      }
      const result = methods[pending.method].result.safeParse(response.data.result);
      if (result.success) {
        pending.resolve(result.data);
      } else {
        pending.reject(
          new RpcError({
            code: RpcErrorCode.InvalidResult,
            message: `Engine returned an invalid result for ${pending.method}`,
          }),
        );
      }
      return;
    }

    const notification = RpcNotificationSchema.safeParse(message);
    if (notification.success) this.#onNotification?.(notification.data);
  }

  /** Rejects every pending request, e.g. when the engine process exits. */
  dispose(reason: string): void {
    this.#disposed = true;
    for (const pending of this.#pending.values()) {
      pending.reject(new RpcError({ code: RpcErrorCode.Disposed, message: reason }));
    }
    this.#pending.clear();
  }
}

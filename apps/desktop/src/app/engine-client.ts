import {
  type MethodName,
  type MethodParams,
  type MethodResult,
  type NotificationName,
  type NotificationParams,
  PROTOCOL_VERSION,
  parseNotification,
  RpcClient,
} from "@orzeus/protocol";
import type { EngineStatus, PingResult } from "./engine-state.ts";
import type { Transport } from "./transport.ts";

type Listener<N extends NotificationName> = (params: NotificationParams<N>) => void;

const TIMEOUT_MS = 30_000;

/** Typed requests with timeouts, notification fan-out, and the engine's lifecycle status. */
export class EngineClient {
  readonly #transport: Transport;
  #rpc: RpcClient;
  readonly #listeners = new Map<NotificationName, Set<Listener<NotificationName>>>();
  readonly #statusListeners = new Set<(status: EngineStatus) => void>();
  #status: EngineStatus = { state: "starting" };

  constructor(transport: Transport) {
    this.#transport = transport;
    this.#rpc = this.#newRpc();
    transport.onLine((line) => this.#rpc.receive(line));
    transport.onStatus((status) => this.#setStatus(status));
  }

  #newRpc(): RpcClient {
    return new RpcClient(
      (line) => this.#transport.send(line),
      (n) => {
        const parsed = parseNotification(n.method, n.params);
        if (parsed === null) return;
        for (const l of this.#listeners.get(parsed.method) ?? []) l(parsed.params as never);
      },
    );
  }

  #setStatus(status: EngineStatus): void {
    if (status.state !== "running" && this.#status.state === "running") {
      // Requests in flight will never be answered by a dead engine.
      this.#rpc.dispose("The engine stopped.");
      this.#rpc = this.#newRpc();
    }
    this.#status = status;
    for (const l of this.#statusListeners) l(status);
  }

  async init(): Promise<void> {
    this.#setStatus(await this.#transport.initialStatus());
  }

  get transportKind(): Transport["kind"] {
    return this.#transport.kind;
  }

  get status(): EngineStatus {
    return this.#status;
  }

  onStatus(listener: (status: EngineStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  on<N extends NotificationName>(name: N, listener: Listener<N>): () => void {
    const set = this.#listeners.get(name) ?? new Set();
    set.add(listener as Listener<NotificationName>);
    this.#listeners.set(name, set);
    return () => set.delete(listener as Listener<NotificationName>);
  }

  request<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), TIMEOUT_MS);
      this.#rpc.request(method, params).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  async ping(): Promise<PingResult> {
    const result = await this.request("engine.ping", {});
    if (result.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `Engine speaks protocol ${result.protocolVersion}; this app expects ${PROTOCOL_VERSION}.`,
      );
    }
    return result;
  }

  close(): void {
    this.#rpc.dispose("closed");
    this.#transport.close();
  }
}

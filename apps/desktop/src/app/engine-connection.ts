import { RpcClient } from "@orzeus/protocol";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { EngineStatus } from "./engine-state.ts";

/** Must match LINE_EVENT and STATUS_EVENT in src-tauri/src/sidecar.rs. */
const LINE_EVENT = "engine://line";
const STATUS_EVENT = "engine://status";

export interface EngineConnection {
  readonly client: RpcClient;
  readonly initialStatus: EngineStatus;
  close(): void;
}

/**
 * Connects the UI to the engine through the Rust relay. Returns null outside the Tauri shell
 * (e.g. when the Vite page is opened in a normal browser).
 */
export async function connectEngine(
  onStatus: (status: EngineStatus) => void,
): Promise<EngineConnection | null> {
  if (!isTauri()) return null;

  const client = new RpcClient((line) => invoke<void>("engine_send", { line: line.trimEnd() }));
  const unlisteners: UnlistenFn[] = await Promise.all([
    listen<string>(LINE_EVENT, (event) => client.receive(event.payload)),
    listen<EngineStatus>(STATUS_EVENT, (event) => onStatus(event.payload)),
  ]);
  const initialStatus = await invoke<EngineStatus>("engine_status");

  return {
    client,
    initialStatus,
    close() {
      for (const unlisten of unlisteners) unlisten();
      client.dispose("connection closed");
    },
  };
}

/** Rejects if the promise does not settle within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    promise.then(
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

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { EngineStatus } from "./engine-state.ts";

/** How the UI reaches the engine: the Tauri relay in the app, or the dev bridge in a browser. */
export interface Transport {
  readonly kind: "tauri" | "bridge";
  send(line: string): Promise<void>;
  /** Engine stdout lines (responses and notifications). */
  onLine(listener: (line: string) => void): void;
  onStatus(listener: (status: EngineStatus) => void): void;
  initialStatus(): Promise<EngineStatus>;
  close(): void;
}

/** Must match LINE_EVENT and STATUS_EVENT in src-tauri/src/sidecar.rs. */
const LINE_EVENT = "engine://line";
const STATUS_EVENT = "engine://status";

async function tauriTransport(): Promise<Transport> {
  const lineListeners: ((line: string) => void)[] = [];
  const statusListeners: ((status: EngineStatus) => void)[] = [];
  const unlisten = await Promise.all([
    listen<string>(LINE_EVENT, (event) => {
      for (const l of lineListeners) l(event.payload);
    }),
    listen<EngineStatus>(STATUS_EVENT, (event) => {
      for (const l of statusListeners) l(event.payload);
    }),
  ]);
  return {
    kind: "tauri",
    send: (line) => invoke<void>("engine_send", { line: line.trimEnd() }),
    onLine: (l) => lineListeners.push(l),
    onStatus: (l) => statusListeners.push(l),
    initialStatus: () => invoke<EngineStatus>("engine_status"),
    close: () => {
      for (const u of unlisten) u();
    },
  };
}

function bridgeTransport(url: string): Transport {
  const lineListeners: ((line: string) => void)[] = [];
  const statusListeners: ((status: EngineStatus) => void)[] = [];
  const source = new EventSource(`${url}/events`);
  let status: EngineStatus = { state: "starting" };
  source.onmessage = (event: MessageEvent<string>) => {
    if (event.data.includes('"bridge.status"')) {
      const pid = (JSON.parse(event.data) as { params: { pid: number } }).params.pid;
      status = { state: "running", pid };
      for (const l of statusListeners) l(status);
      return;
    }
    for (const l of lineListeners) l(event.data);
  };
  source.onerror = () => {
    status = { state: "failed", message: `Lost the dev bridge at ${url}` };
    for (const l of statusListeners) l(status);
  };
  return {
    kind: "bridge",
    send: async (line) => {
      const response = await fetch(`${url}/send`, { method: "POST", body: line.trimEnd() });
      if (!response.ok) throw new Error(`bridge refused the message (${response.status})`);
    },
    onLine: (l) => lineListeners.push(l),
    onStatus: (l) => statusListeners.push(l),
    initialStatus: async () => status,
    close: () => source.close(),
  };
}

/**
 * The transport for this window: Tauri inside the app; in a browser, the dev bridge named by
 * the `bridge` query parameter (only loopback addresses are accepted); otherwise none.
 */
export async function openTransport(
  location: Location = window.location,
): Promise<Transport | null> {
  if (isTauri()) return tauriTransport();
  const bridge = new URLSearchParams(location.search).get("bridge");
  if (bridge !== null && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(bridge))
    return bridgeTransport(bridge);
  return null;
}

import type { MethodResult } from "@orzeus/protocol";

/** Mirrors the Rust `EngineStatus` enum (serde tag "state"). */
export type EngineStatus =
  | { readonly state: "starting" }
  | { readonly state: "running"; readonly pid: number }
  | { readonly state: "exited"; readonly code: number | null }
  | { readonly state: "failed"; readonly message: string };

export type PingResult = MethodResult<"engine.ping">;

export type EngineView =
  | { readonly tone: "neutral"; readonly label: string; readonly detail: string | null }
  | { readonly tone: "ok"; readonly label: string; readonly detail: string }
  | { readonly tone: "attention"; readonly label: string; readonly detail: string };

export interface EngineSnapshot {
  readonly inShell: boolean;
  readonly status: EngineStatus;
  readonly ping: PingResult | null;
  readonly error: string | null;
  readonly expectedProtocol: number;
}

/** Turns the raw connection state into what the status pill shows. Pure, so it is unit-tested. */
export function describeEngine(snapshot: EngineSnapshot): EngineView {
  const { inShell, status, ping, error, expectedProtocol } = snapshot;
  if (!inShell) {
    return {
      tone: "attention",
      label: "Engine unavailable",
      detail: "Open Orzeus through the desktop app (pnpm dev) to connect to the engine.",
    };
  }
  switch (status.state) {
    case "starting":
      return { tone: "neutral", label: "Starting engine", detail: null };
    case "exited":
      return {
        tone: "attention",
        label: "Engine stopped",
        detail: status.code === null ? "Restarting…" : `Exit code ${status.code}. Restarting…`,
      };
    case "failed":
      return { tone: "attention", label: "Engine failed", detail: status.message };
    case "running":
      if (error !== null)
        return { tone: "attention", label: "Engine not responding", detail: error };
      if (ping === null) return { tone: "neutral", label: "Connecting", detail: null };
      if (ping.protocolVersion !== expectedProtocol) {
        return {
          tone: "attention",
          label: "Engine version mismatch",
          detail: `Engine speaks protocol ${ping.protocolVersion}, this app expects ${expectedProtocol}.`,
        };
      }
      return {
        tone: "ok",
        label: "Engine ready",
        detail: `orzeusd ${ping.engineVersion} · Node ${ping.runtime.node} · ${ping.runtime.platform}/${ping.runtime.arch}`,
      };
  }
}

import { PROTOCOL_VERSION, type RpcHandlers } from "@orzeus/protocol";
import { ENGINE_VERSION } from "./version.js";

export interface EngineInfo {
  readonly startedAt: number;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly arch: string;
}

/** All RPC handlers. Dependencies are passed in so handlers stay testable without a process. */
export function createHandlers(info: EngineInfo): RpcHandlers {
  return {
    "engine.ping": () => ({
      engineVersion: ENGINE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      runtime: { node: info.nodeVersion, platform: info.platform, arch: info.arch },
      startedAt: info.startedAt,
    }),
  };
}

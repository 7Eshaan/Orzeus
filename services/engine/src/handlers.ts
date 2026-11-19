import { PROTOCOL_VERSION, type RpcHandlers } from "@orzeus/protocol";
import { ENGINE_VERSION } from "./version.js";

export interface EngineInfo {
  readonly startedAt: number;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly arch: string;
}

/** Engine-level handlers; the run handlers live in EngineService. */
export function createHandlers(info: EngineInfo): Pick<RpcHandlers, "engine.ping"> {
  return {
    "engine.ping": () => ({
      engineVersion: ENGINE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      runtime: { node: info.nodeVersion, platform: info.platform, arch: info.arch },
      startedAt: info.startedAt,
    }),
  };
}

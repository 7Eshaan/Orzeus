/**
 * Entry point of the packaged engine (a Node single executable application, built by
 * tooling/scripts/build-sidecar.ts). One binary plays three roles, chosen by the first argument:
 *
 *   orzeusd                      the sidecar (default)
 *   orzeusd memory-server …      the orzeus-memory MCP server, which the engine starts per run
 *   orzeusd cli …                the headless CLI
 *
 * Wasm files for the repo map are embedded as SEA assets instead of read from node_modules.
 */
import { getAssetKeys, getRawAsset, isSea } from "node:sea";
import { setWasmSource, WASM_FILES } from "@orzeus/context";

if (isSea()) {
  const embedded = new Set(getAssetKeys());
  setWasmSource({
    read: (name) =>
      name in WASM_FILES && embedded.has(name) ? new Uint8Array(getRawAsset(name)) : null,
  });
}

const ROLES = new Set(["memory-server", "cli"]);
const role = ROLES.has(process.argv[2] ?? "") ? (process.argv[2] as string) : "orzeusd";
// Each role parses process.argv.slice(2), so drop the role name first.
if (role !== "orzeusd") process.argv.splice(2, 1);

if (role === "memory-server") await import("@orzeus/memory-server/main");
else if (role === "cli") await import("./cli.js");
else await import("./main.js");

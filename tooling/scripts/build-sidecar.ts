/**
 * Builds the engine sidecar as one executable (a Node single executable application) for the
 * Tauri bundle: apps/desktop/src-tauri/binaries/orzeusd-<target triple>.
 *
 *   1. esbuild bundles services/engine/dist/sea.js (run `pnpm build` first) into one ES module;
 *   2. the tree-sitter wasm files become SEA assets;
 *   3. `node --build-sea` writes the executable, which is then ad-hoc signed on macOS (the
 *      Tauri bundle re-signs it with your Developer ID when signing is configured).
 *
 * The Claude Agent SDK stays out of the bundle: it ships a 160 MB native binary per platform.
 * In the packaged app that adapter reports itself unavailable (see docs/guide/README.md).
 *
 * The executable needs a Node binary built with SEA support. Homebrew's is not, so by default
 * the official build of the running Node version is downloaded once from nodejs.org, checked
 * against its published SHA-256, and cached in ~/.cache/orzeus/node. Pass --node <path> to use
 * another one.
 *
 * Usage: node tooling/scripts/build-sidecar.ts [--target <rust target triple>] [--node <path>]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { values } = parseArgs({
  options: { target: { type: "string" }, node: { type: "string" } },
});
const target =
  values.target ??
  /host: (\S+)/.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1] ??
  "unknown";
const work = join(root, "services/engine/dist-sea");
const outDir = join(root, "apps/desktop/src-tauri/binaries");
const output = join(outDir, `orzeusd-${target}${target.includes("windows") ? ".exe" : ""}`);

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(outDir, { recursive: true });

const bundle = join(work, "orzeusd.mjs");
await build({
  entryPoints: [join(root, "services/engine/dist/sea.js")],
  outfile: bundle,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node26",
  external: ["@anthropic-ai/claude-agent-sdk"],
  legalComments: "eof",
  // CommonJS dependencies call require(); give the bundle one (it only loads built-ins).
  banner: {
    js: 'import { createRequire as __orzeusRequire } from "node:module"; const require = __orzeusRequire(import.meta.url);',
  },
  logLevel: "warning",
});

// The wasm files the repo map loads, embedded under their file names (see @orzeus/context).
const contextRequire = createRequire(join(root, "packages/context/package.json"));
const { WASM_FILES } = (await import(join(root, "packages/context/dist/index.js"))) as {
  WASM_FILES: Record<string, string>;
};
const assets = Object.fromEntries(
  Object.entries(WASM_FILES).map(([name, path]) => [name, contextRequire.resolve(path)]),
);

/** Node's platform names for the Rust targets Orzeus ships. */
const NODE_PLATFORMS: Readonly<Record<string, string>> = {
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-apple-darwin": "darwin-x64",
  "x86_64-unknown-linux-gnu": "linux-x64",
  "aarch64-unknown-linux-gnu": "linux-arm64",
};

/** The official Node binary for the target, downloaded once and verified against SHASUMS256. */
async function officialNode(): Promise<string> {
  const platform = NODE_PLATFORMS[target];
  if (platform === undefined) throw new Error(`no official Node build known for ${target}`);
  const version = process.version;
  const name = `node-${version}-${platform}`;
  const cache = join(homedir(), ".cache/orzeus/node");
  const binary = join(cache, name, "bin/node");
  if (existsSync(binary)) return binary;
  mkdirSync(cache, { recursive: true });
  const base = `https://nodejs.org/dist/${version}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = new RegExp(`^([0-9a-f]{64})  ${name}\\.tar\\.gz$`, "m").exec(sums)?.[1];
  if (expected === undefined) throw new Error(`${name}.tar.gz is not in SHASUMS256.txt`);
  process.stdout.write(`Downloading ${base}/${name}.tar.gz (once)\n`);
  const archive = Buffer.from(await (await fetch(`${base}/${name}.tar.gz`)).arrayBuffer());
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) throw new Error(`checksum mismatch for ${name}.tar.gz`);
  const file = join(cache, `${name}.tar.gz`);
  writeFileSync(file, archive);
  execFileSync("tar", ["-xzf", file, "-C", cache, `${name}/bin/node`]);
  rmSync(file);
  return binary;
}

const node = values.node ?? (await officialNode());
if (!readFileSync(node).includes("NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"))
  throw new Error(`${node} was built without single-executable support`);

const config = join(work, "sea-config.json");
writeFileSync(
  config,
  JSON.stringify(
    {
      main: bundle,
      mainFormat: "module",
      output,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      assets,
    },
    null,
    2,
  ),
);
execFileSync(node, ["--build-sea", config], { stdio: "inherit" });
if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", "--force", output]);

const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;
process.stdout.write(
  `orzeusd for ${target}: ${output} (${mb(statSync(output).size)}; bundle ${mb(statSync(bundle).size)})\n`,
);

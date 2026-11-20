/**
 * Builds a release of Orzeus and the files for a GitHub Release.
 *
 *   pnpm package:app -- --version 0.1.0 [--notes "What changed"] [--skip-sidecar]
 *
 * 1. sets the version in tauri.conf.json;
 * 2. builds the engine executable (build-sidecar.ts) unless --skip-sidecar;
 * 3. runs `tauri build` with tauri.bundle.conf.json: ad-hoc code signature (or your Developer
 *    ID if APPLE_SIGNING_IDENTITY is set) and update signatures made with your updater key, whose
 *    password comes from TAURI_SIGNING_PRIVATE_KEY_PASSWORD or your Keychain;
 * 4. copies the DMG, the update archive and its signature into release/v<version>/ and writes
 *    latest.json there.
 *
 * Publishing is yours: create a GitHub Release tagged v<version> and upload every file in that
 * folder. Installed copies see the update on their next check.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  APP_CONFIG,
  BUNDLE_CONFIG,
  type BundleConfig,
  githubRepo,
  KEY_PATH,
  KEYCHAIN_SERVICE,
  ROOT,
  readJson,
  writeJson,
} from "./release-common.ts";

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    notes: { type: "string", default: "" },
    "skip-sidecar": { type: "boolean", default: false },
  },
});
const version = values.version;
if (version === undefined || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version))
  throw new Error("give the release version, e.g. --version 0.1.0");

const bundle = readJson<BundleConfig>(BUNDLE_CONFIG);
if (bundle.plugins.updater.pubkey === "" || !existsSync(KEY_PATH))
  throw new Error("no update key yet: run `pnpm updater:key` first");

const password =
  process.env["TAURI_SIGNING_PRIVATE_KEY_PASSWORD"] ??
  execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
    encoding: "utf8",
  }).trim();

const app = readJson<{ version: string; productName: string }>(APP_CONFIG);
app.version = version;
writeJson(APP_CONFIG, app);

if (!values["skip-sidecar"])
  execFileSync("pnpm", ["build:sidecar"], { cwd: ROOT, stdio: "inherit" });

execFileSync(
  "pnpm",
  ["--filter", "@orzeus/desktop", "tauri", "build", "--config", "src-tauri/tauri.bundle.conf.json"],
  {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: readFileSync(KEY_PATH, "utf8"),
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
    },
  },
);

const bundleDir = join(ROOT, "target/release/bundle");
const out = join(ROOT, "release", `v${version}`);
mkdirSync(out, { recursive: true });
const archive = `${app.productName}.app.tar.gz`;
for (const [dir, name] of [
  ["macos", archive],
  ["macos", `${archive}.sig`],
  ...readdirSync(join(bundleDir, "dmg"))
    .filter((f) => f.endsWith(".dmg"))
    .map((f) => ["dmg", f]),
] as const)
  copyFileSync(join(bundleDir, dir, name), join(out, name));

const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
writeJson(join(out, "latest.json"), {
  version,
  notes: values.notes,
  pub_date: new Date().toISOString(),
  platforms: {
    [`darwin-${arch}`]: {
      signature: readFileSync(join(out, `${archive}.sig`), "utf8").trim(),
      url: `https://github.com/${githubRepo()}/releases/download/v${version}/${archive}`,
    },
  },
});
process.stdout.write(
  `\nRelease files are in ${out}.\nCreate a GitHub Release tagged v${version} and upload all of them.\n`,
);

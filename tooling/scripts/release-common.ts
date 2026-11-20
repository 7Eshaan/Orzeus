/** Paths and small helpers shared by the updater-key and package-app scripts. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const BUNDLE_CONFIG = join(ROOT, "apps/desktop/src-tauri/tauri.bundle.conf.json");
export const APP_CONFIG = join(ROOT, "apps/desktop/src-tauri/tauri.conf.json");
/** The update signing key: outside the repository, readable only by you. */
export const KEY_PATH = join(homedir(), ".tauri", "orzeus-updater.key");
/** Keychain item holding the key's password (service name; account is your user name). */
export const KEYCHAIN_SERVICE = "dev.orzeus.updater";

export interface BundleConfig {
  plugins: { updater: { pubkey: string; endpoints: string[] } };
  [key: string]: unknown;
}

export const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
export const writeJson = (path: string, value: unknown): void =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

/** "owner/name" from the origin remote, e.g. "7Eshaan/Orzeus". */
export function githubRepo(): string {
  const url = execFileSync("git", ["remote", "get-url", "origin"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  const match = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(url);
  if (match?.[1] === undefined) throw new Error(`origin is not a GitHub repository: ${url}`);
  return match[1];
}

export const latestJsonUrl = (repo: string) =>
  `https://github.com/${repo}/releases/latest/download/latest.json`;

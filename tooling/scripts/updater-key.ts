/**
 * Creates the key that signs Orzeus updates (once), stores its password in your Keychain, and
 * writes the public key and update URL into tauri.bundle.conf.json.
 *
 *   pnpm updater:key
 *
 * The private key stays in ~/.tauri/orzeus-updater.key (mode 600), encrypted with the password
 * you choose. Back it up somewhere offline: if it is lost, installed copies cannot update and
 * have to be reinstalled by hand once. Never commit it. Running this again keeps an existing key.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  BUNDLE_CONFIG,
  type BundleConfig,
  githubRepo,
  KEY_PATH,
  KEYCHAIN_SERVICE,
  latestJsonUrl,
  ROOT,
  readJson,
  writeJson,
} from "./release-common.ts";

const say = (line: string) => process.stdout.write(`${line}\n`);

if (!existsSync(KEY_PATH)) {
  mkdirSync(dirname(KEY_PATH), { recursive: true, mode: 0o700 });
  say("Creating the update signing key. Choose a strong password; you will need it to publish.");
  // Tauri's own signer asks for the password itself, so it never passes through this script.
  execFileSync(
    "pnpm",
    ["--filter", "@orzeus/desktop", "tauri", "signer", "generate", "-w", KEY_PATH],
    {
      cwd: ROOT,
      stdio: "inherit",
    },
  );
  chmodSync(KEY_PATH, 0o600);
  say("");
  say("Now store the same password in your login Keychain, so packaging can sign without asking.");
  say("macOS will prompt for it (it is not echoed):");
  execFileSync(
    "security",
    [
      "add-generic-password",
      "-U",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      process.env["USER"] ?? "orzeus",
      "-w",
    ],
    { stdio: "inherit" },
  );
} else {
  say(`Keeping the existing key at ${KEY_PATH}.`);
}

const config = readJson<BundleConfig>(BUNDLE_CONFIG);
config.plugins.updater.pubkey = readFileSync(`${KEY_PATH}.pub`, "utf8").trim();
config.plugins.updater.endpoints = [latestJsonUrl(githubRepo())];
writeJson(BUNDLE_CONFIG, config);
say(`Wrote the public key and ${config.plugins.updater.endpoints[0]} to ${BUNDLE_CONFIG}.`);
say("");
say(`Back up ${KEY_PATH} and its password somewhere offline (a password manager is fine).`);

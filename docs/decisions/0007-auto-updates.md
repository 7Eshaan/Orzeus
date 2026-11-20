# 0007. Signed automatic updates from GitHub Releases

Status: Accepted (2026-11-20, Ryu asked for an auto-updater). Supersedes 0006.

## Context

Ryu wants Orzeus to update itself, and has no Apple Developer account for now, so builds are
ad-hoc signed and not notarized. The Tauri 2 updater (`tauri-plugin-updater` 2.14) is
independent of Apple: it verifies each update with its own minisign signature before
installing it. The repository (github.com/7Eshaan/Orzeus) is public, so GitHub Releases can
host updates without any server.

## Decision

- The app checks `https://github.com/7Eshaan/Orzeus/releases/latest/download/latest.json`
  (once a day when Settings opens, or on demand), and offers "Download and install", then
  "Restart now". Nothing is installed without the user's click.
- Every update archive is signed with a private key that exists only on Ryu's Mac
  (`~/.tauri/orzeus-updater.key`, mode 600, encrypted with a password kept in the login Keychain
  under `dev.orzeus.updater`). The public key is built into the app; an update whose signature
  does not match is refused.
- `pnpm updater:key` creates the key once; `pnpm package:app -- --version X.Y.Z` builds, signs
  and writes `release/vX.Y.Z/` (DMG, update archive, signature, `latest.json`); Ryu publishes
  them as a GitHub Release tagged `vX.Y.Z`.
- The updater configuration lives in `tauri.bundle.conf.json`, used only for packaged builds;
  development builds do not load the plugin.

## Key custody

- The key never enters the repository (`~/.tauri` is outside it) and is never uploaded.
- Keep one offline backup of the key file and its password (a password manager entry with the
  file attached is enough).
- Lost key: installed copies cannot verify new updates. Fix: make a new key, and install the next
  version by hand once on each Mac.
- Stolen key: an attacker would also need to publish a GitHub Release in Ryu's repository (or
  take over the update URL) to reach anyone. Fix: make a new key and ship it in an update signed
  with the old one, before the old one is misused; review GitHub account security.

## Consequences

- No hosting costs and no telemetry: the only request is fetching `latest.json` from GitHub.
- Without notarization, macOS warns on the first open of a downloaded DMG (right-click → Open,
  once). Updates installed by the app are not quarantined, so they open without a warning.
- Ad-hoc signatures change with every build, so after an update macOS may ask once whether
  Orzeus may use its Keychain items (the API keys). Choose "Always Allow".
- Ad-hoc builds run without the hardened runtime (it only matters for notarization, and Tauri
  would sign the engine sidecar under it without the JIT entitlement V8 needs).
- When an Apple Developer ID becomes available, signing and notarization add to this without
  changing the updater (docs/guide/release-macos.md).
- Tested 2026-11-20 with a throwaway key: a release build is ad-hoc signed, launches, and starts
  its bundled engine; `tauri build` produced the update archive and its signature. Clicking
  through "Download and install" in a running app is still to be tried on the first real release.

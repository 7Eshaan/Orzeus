# 0006. No automatic updates in v1

Status: Superseded by [0007](0007-auto-updates.md) (2026-11-20): Ryu chose automatic updates.

## Context

Tauri 2 offers `tauri-plugin-updater`: the app downloads a signed update from a manifest URL and
replaces itself. Using it means:

- an update signing key pair (separate from the Apple certificate), whose private key must be
  kept safe forever, because a lost key strands every installed copy;
- somewhere to host the manifest and the update archives (GitHub Releases works);
- a release process that builds, signs, notarizes and publishes on every version.

Orzeus today is one person's tool on one Mac. Some of its adapters run personal subscription
logins that may not be offered to other people (docs/architecture/04-providers.md, rule 5), so
it is not meant for distribution yet.

## Decision

Ship v1 without automatic updates. Releases are built with `pnpm package:app`, signed and
notarized (docs/guide/release-macos.md), and installed by opening the DMG. The sidebar's engine status shows the running engine version.

Revisit when Orzeus is distributed to anyone else: then add `tauri-plugin-updater` with update
signatures, GitHub Releases hosting, and a release workflow in CI.

## Consequences

- No update key to protect and no hosting to run; nothing in the app phones home.
- Updating is manual: build or download the new DMG and replace the app.
- Adding the updater later needs no migration: it is a plugin, a public key in the config and a
  manifest URL.

## Alternative

Adopt the updater now. Choose this if you expect to install Orzeus on more than one machine
soon, or want updates without rebuilding. Cost: about a day of setup, plus key custody.

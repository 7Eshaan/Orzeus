# Releasing Orzeus for macOS

No Apple Developer account is needed. Builds are ad-hoc signed, and updates are signed with
your own update key (ADR 0007). A Developer ID can be added later; see the last section.

## One-time setup

```bash
. "$HOME/.cargo/env"
pnpm install
pnpm updater:key
```

`updater:key` creates the update signing key in `~/.tauri/orzeus-updater.key` (it asks you for
a password), stores that password in your login Keychain as `dev.orzeus.updater` (macOS asks
for it again, hidden), and writes the public key and the update URL into
`apps/desktop/src-tauri/tauri.bundle.conf.json`. Commit that file: the public key is meant to
be public.

Then back up `~/.tauri/orzeus-updater.key` and its password somewhere offline, for example as
a password-manager entry with the file attached. Without them, installed copies cannot update.

The first build also downloads the official Node for your Mac from nodejs.org (about 30 MB,
checked against its published SHA-256) into `~/.cache/orzeus/node`, because Homebrew's Node
cannot build single executables.

## Each release

```bash
. "$HOME/.cargo/env"
pnpm package:app -- --version 0.1.0 --notes "First release"
```

This sets the version, builds the engine as one executable, builds and ad-hoc signs the app,
signs the update archive with your key, and puts everything to publish in `release/v0.1.0/`:

- `Orzeus_0.1.0_aarch64.dmg`: for installing by hand,
- `Orzeus.app.tar.gz` and `Orzeus.app.tar.gz.sig`: the update and its signature,
- `latest.json`: what installed copies check.

Publish: on GitHub, open the repository's Releases, choose "Draft a new release", create the tag
`v0.1.0`, attach all four files, and publish. Installed copies offer the update the next time
they check (Settings → Updates, or automatically once a day). The version must go up every
release; the updater ignores anything not newer than what is installed.

## Installing the first time (no Developer ID)

Copy Orzeus from the DMG to Applications. On a Mac where you built it, it opens normally. A
copy downloaded from GitHub is quarantined, and macOS refuses to open it because it is not
notarized. Clear the quarantine once:

```bash
xattr -dr com.apple.quarantine /Applications/Orzeus.app
```

(or System Settings → Privacy & Security → "Open Anyway" after the first attempt). Updates the
app installs itself are not quarantined, so this is needed only once.

After an update, macOS may ask whether Orzeus may use its Keychain items (your API keys): choose
"Always Allow". Ad-hoc signatures change with each build, so macOS asks again for new builds.

## Checking a build

```bash
APP=target/release/bundle/macos/Orzeus.app
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv "$APP" 2>&1 | grep -E "Signature|flags"     # Signature=adhoc
```

## What is not in the packaged app

- The Claude Agent SDK worker: the SDK brings a 160 MB native binary per platform, so the
  packaged engine leaves it out. The Anthropic API planner and every other worker are included.
  Development builds (`pnpm dev`) have it.

## Later: Developer ID and notarization

Ad-hoc builds run without Apple's hardened runtime (`hardenedRuntime: false` in
`tauri.bundle.conf.json`). Notarization requires it, and then the engine needs the JIT
entitlements in `entitlements.plist`, because V8 compiles JavaScript at run time. Tauri signs
the sidecar without entitlements, so turning on the hardened runtime also needs a step that
re-signs `Contents/MacOS/orzeusd` with them before notarizing. Then add your identity and
notarization credentials when packaging; the updater keeps working unchanged:

```bash
security find-identity -v -p codesigning
APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
APPLE_API_ISSUER="<issuer id>" APPLE_API_KEY="<key id>" APPLE_API_KEY_PATH="$HOME/keys/AuthKey_<key id>.p8" \
pnpm package:app -- --version 0.2.0
spctl --assess --type execute --verbose=4 target/release/bundle/macos/Orzeus.app
```

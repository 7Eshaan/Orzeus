# Building, signing and notarizing the macOS app

Everything here runs on your Mac with your own Apple developer account. Nothing in Orzeus
uploads or signs anything on its own.

## 1. Build the app

```bash
. "$HOME/.cargo/env"
pnpm install
pnpm package:app
```

`package:app` builds the TypeScript packages, turns the engine into one executable
(`tooling/scripts/build-sidecar.ts`) and runs `tauri build` with `tauri.bundle.conf.json`, which
adds the engine as a sidecar, the hardened runtime and the entitlements. The first run downloads
the official Node build for your Mac from nodejs.org (about 30 MB, checked against its published
SHA-256) into `~/.cache/orzeus/node`, because Homebrew's Node cannot build single executables.

Without signing settings the app is ad-hoc signed: it runs on this Mac, and other Macs will
refuse it.

Output: `apps/desktop/src-tauri/target/release/bundle/macos/Orzeus.app` and
`…/bundle/dmg/Orzeus_<version>_aarch64.dmg`.

## 2. Sign with your Developer ID

You need a "Developer ID Application" certificate in your login keychain.

```bash
security find-identity -v -p codesigning
```

Copy the identity name it lists, then build with it:

```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" pnpm package:app
```

## 3. Notarize

Use an App Store Connect API key (recommended) or your Apple ID with an app-specific password.

```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
APPLE_API_ISSUER="<issuer id>" APPLE_API_KEY="<key id>" APPLE_API_KEY_PATH="$HOME/keys/AuthKey_<key id>.p8" \
pnpm package:app
```

Or: `APPLE_ID`, `APPLE_PASSWORD` (app-specific password) and `APPLE_TEAM_ID` instead of the
three `APPLE_API_*` variables.

## 4. Check the result

```bash
APP=apps/desktop/src-tauri/target/release/bundle/macos/Orzeus.app
codesign --verify --deep --strict --verbose=2 "$APP"
codesign --display --entitlements - "$APP/Contents/MacOS/orzeusd"
spctl --assess --type execute --verbose=4 "$APP"
xcrun stapler validate "$APP"
```

`spctl` should say "accepted, source=Notarized Developer ID". The engine (`orzeusd`) must be
signed with the hardened runtime and the JIT entitlements from `entitlements.plist`, because
V8 compiles JavaScript at run time.

## What is not in the packaged app

- The Claude Agent SDK worker. The SDK brings a 160 MB native binary per platform, so the
  packaged engine leaves it out and the adapter reports itself unavailable. The Anthropic API
  planner and every other worker are included. Development builds (`pnpm dev`) have it.
- Automatic updates (ADR 0006). Install a new version by replacing the app.

# 0003. OS keychain instead of Stronghold

Status: Accepted (2026-11-19, approved by Ryu)

## Context

The brief lists `tauri-plugin-stronghold`. Tauri maintainers have said Stronghold is no longer
recommended and will be removed in Tauri v3. Stronghold also needs its own vault password,
which is one more secret for the user to manage.

## Decision

Store API keys and MCP OAuth tokens in the OS credential store (macOS Keychain first) using the
Rust `keyring` crate, exposed through two narrow Tauri commands (`secret_set`, `secret_get`)
plus `secret_delete`. The engine requests a secret over the RPC relay only at the moment it
needs it. SQLite stores only the item name (`secret_ref`). MCP OAuth credentials are keyed by
issuer, as the 2026-07-28 spec requires.

## Consequences

- No migration pain at Tauri v3; secrets are protected by the OS login and Keychain ACLs.
- Behaviour differs slightly per OS (Secret Service availability on Linux); macOS is the
  primary target.
- If Ryu prefers to keep Stronghold, the secret port in `core` makes it a drop-in adapter.

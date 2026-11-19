# 0001. Orchestration engine runs as a Node sidecar

Status: Accepted (2026-11-19, approved by Ryu)

## Context

The engine schedules long runs, supervises many child processes (provider CLIs, MCP servers,
ACP agents, check commands) and must survive the window closing. Key libraries
(`@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/client` v2, `@agentclientprotocol/sdk`)
are Node packages. Options: (a) engine in the webview using `tauri-plugin-shell` and
`tauri-plugin-sql` from JS, (b) engine in Rust, (c) engine as a Node sidecar process.

## Decision

(c). `orzeusd` is a Node 26 process written in TypeScript 7, started and restarted by the Rust
core, speaking JSON-RPC over stdio. Rust relays messages to the webview as Tauri events. The
same engine runs headless as the `orzeus` CLI.

It is packaged as a Tauri sidecar binary built with Node's single executable application
support (fallback: ship the Node runtime alongside a bundled script).

## Consequences

- Runs continue with the window closed; UI reloads are harmless.
- Full access to the official Node SDKs; no Rust re-implementations of fast-moving protocols.
- End-to-end tests run without a UI.
- Cost: a second runtime in the bundle (tens of MB), and a supervised child process to manage.
- `tauri-plugin-shell` is still used, by Rust, to spawn and supervise the sidecar.

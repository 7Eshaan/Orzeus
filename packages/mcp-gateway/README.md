# @orzeus/mcp-gateway

Per-run loopback MCP server (2026-07-28, stateless). Exposes each node's allowlisted tools and packet resources, proxies upstream servers, and runs every call through policy and the trace.

## Rules

Workers never talk to upstream MCP servers directly; they talk to this gateway.

## Status

Implemented in Phase 3. `McpGateway.start({ upstreams })` listens on `127.0.0.1` (random port,
Host/Origin checked), serves MCP 2026-07-28 statelessly via `createMcpHandler`, and maps each
bearer token to one node attempt's `NodeGrant`:

- `orzeus__read_context` tool and `orzeus://context/{index}` resources: the packet's pointers,
  resolved to exact lines in the node's worktree (or memories via the memory server);
- eager grants become `<server>__<tool>` tools with the upstream's own schema;
- lazy grants hide behind `orzeus__find_tools` / `orzeus__call_tool`;
- every upstream call is authorized by the engine's policy (`authorize`) and recorded in the
  trace (`record`).

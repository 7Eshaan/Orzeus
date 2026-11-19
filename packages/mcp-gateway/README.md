# @orzeus/mcp-gateway

Per-run loopback MCP server (2026-07-28, stateless). Exposes each node's allowlisted tools and packet resources, proxies upstream servers, and runs every call through policy and the trace.

## Rules

Workers never talk to upstream MCP servers directly; they talk to this gateway.

## Status

Skeleton (Phase 0). See [docs/plan/phased-plan.md](../../docs/plan/phased-plan.md) for when it gets built.

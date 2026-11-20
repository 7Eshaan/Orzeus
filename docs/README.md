# Orzeus documentation

Using Orzeus: the [user guide](guide/README.md) and
[releasing the app](guide/release-macos.md).

Building Orzeus: start with the [architecture overview](architecture/00-overview.md), then the
[phased plan](plan/phased-plan.md).

- Architecture
  - [00 Overview](architecture/00-overview.md)
  - [01 Monorepo layout and quality gates](architecture/01-monorepo-layout.md)
  - [02 Core schemas](architecture/02-core-schemas.md): `TaskDAG`, `ContextPacket`, `ProviderAdapter`, `TraceEvent`
  - [03 SQLite schema](architecture/03-sqlite-schema.md)
  - [04 Providers, compliance and quota telemetry](architecture/04-providers.md)
  - [05 Policy, approvals, budgets and the MCP gateway](architecture/05-policy-and-safety.md)
- [Decisions (ADRs)](decisions/README.md)
- [Phased plan](plan/phased-plan.md)
- [Verified versions and specs, 2026-11](research/verified-versions-2026-11.md)

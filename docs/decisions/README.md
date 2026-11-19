# Architecture decision records

Short, numbered, never edited after acceptance (a later ADR supersedes an earlier one).
Format: Context, Decision, Consequences, Status.

| #                                       | Decision                                                              | Status   |
| --------------------------------------- | --------------------------------------------------------------------- | -------- |
| [0001](0001-engine-as-node-sidecar.md)  | Orchestration engine runs as a Node sidecar, not in the webview       | Accepted |
| [0002](0002-engine-owns-sqlite.md)      | Engine is the single SQLite writer; UI gets projections over RPC      | Accepted |
| [0003](0003-os-keychain-for-secrets.md) | OS keychain instead of Stronghold for secrets                         | Accepted |
| [0004](0004-event-log-is-the-trace.md)  | One hash-chained event log serves as both state store and audit trace | Accepted |
| [0005](0005-tooling.md)                 | pnpm, TS 7 project references, Biome, Vitest                          | Accepted |

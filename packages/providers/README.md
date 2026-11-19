# @orzeus/providers

The ProviderAdapter contract, one folder per adapter, and the shared conformance suite every adapter must pass.

## Rules

Adapters depend on core ports, never on each other. Official provider interfaces only (see docs/architecture/04-providers.md).

## Status

Implemented in Phase 2: `openai-compatible` (Ollama and friends, with Orzeus's own tool loop) and `codex-app-server`.

Every adapter passes the shared conformance suite in `src/conformance/` against fixtures in `fixtures/`, recorded from real runs and scrubbed of personal data:

```bash
# Re-record (uses the local model / your Codex login):
ORZEUS_RECORD=openai-compatible pnpm vitest run packages/providers
ORZEUS_RECORD=codex-app-server pnpm vitest run packages/providers
node packages/providers/fixtures/codex-app-server/scrub.mjs packages/providers/fixtures/codex-app-server/*.jsonl
```

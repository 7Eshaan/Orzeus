# @orzeus/trace

RFC 8785 canonical JSON, SHA-256 hash chain, chain verifier, JSONL and OTLP exporters.

## Rules

Pure apart from hashing, which is injected through a port.

## Status

Implemented in Phase 1.

Entry points: `canonicalize` (RFC 8785), `sealEvent`, `verifyChain`, `contentHash`, `exportJsonl`. The SHA-256 function is passed in as a `HashFn`.

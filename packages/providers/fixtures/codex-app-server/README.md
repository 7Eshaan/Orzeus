# Codex app-server fixtures

- `hello-session.jsonl`, `probe.jsonl`: recorded from a real `codex app-server` (codex-cli
  0.169) through `record-proxy.mjs`, then scrubbed with `scrub.mjs`.
- `generate-handwritten.jsonl`: written by hand from the protocol types that
  `codex app-server generate-ts` emits, because recording it would spend Codex quota. Replace
  it with a recording when convenient.
- `fake-app-server.mjs`: replays fixtures for the conformance suite.

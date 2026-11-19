# @orzeus/checks

Deterministic check runner for typecheck, lint and test commands, with timeouts, output capture and truncation.

## Rules

Commands are argv arrays, never shell strings.

## Status

Implemented in Phase 2.

Entry points: `runChecks` (always runs the scope guard first), `runCheck`, `runCommand` (argv, own process group, SIGTERM then SIGKILL on timeout), `outOfScope`. Commands get a minimal environment (`checkEnvironment`). `json_schema` checks arrive in Phase 3.

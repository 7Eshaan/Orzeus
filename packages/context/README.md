# @orzeus/context

Turns a repository into something a planner can reason about cheaply, and turns a packet's
pointers back into exact code for a worker.

- `buildRepoMap`: every tracked file, with top-level symbols (classes, functions, methods,
  interfaces, types) and their line ranges, extracted with tree-sitter (WebAssembly grammars,
  no native builds) for TypeScript, TSX, JavaScript and Python.
- `renderRepoMap`: a compact text form within a character budget, for the planner prompt.
- `resolveContextRef`: a packet's `file_range` / `symbol` pointer → the exact lines from the
  node's worktree, refusing paths outside it.

## Rules

Reads files only inside the given root. Grammar packages are used for their `.wasm` files
only; their native install scripts are never needed.

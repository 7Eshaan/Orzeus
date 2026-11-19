# Orzeus user guide

Orzeus plans a change with a frontier model, splits it into small tasks, and has cheaper worker
models build those tasks in parallel, each in its own git worktree. You approve the plan, any
risky action, and the final merge into your branch. Every step is recorded in a tamper-evident
trace.

## Install and run

Requirements: macOS 13 or later, Node 26, pnpm 12, Rust (rustup), Xcode Command Line Tools,
and git.

```bash
pnpm install
pnpm dev          # builds everything and opens the app
```

To build a standalone app instead, see [Building, signing and notarizing](release-macos.md).

Orzeus keeps its data in `~/Library/Application Support/dev.orzeus.desktop` (the database, the
repository memory and the worktrees). Your own checkout and branch are never touched until you
approve a merge.

## Models and accounts

Orzeus only uses official interfaces, and only accounts you turn on.

| Worker or planner | How to turn it on                                                      | Notes                                               |
| ----------------- | ---------------------------------------------------------------------- | --------------------------------------------------- |
| Local models      | Run Ollama (or LM Studio, vLLM) at `http://localhost:11434/v1`         | Default worker; free. Small models cannot plan.     |
| Anthropic API     | Settings → API keys → Anthropic                                        | Default planner when a key is set                   |
| Claude Agent SDK  | Same Anthropic key                                                     | Worker; development builds only (see release guide) |
| OpenAI API        | Settings → API keys → OpenAI                                           | Worker and planner, priced per token                |
| Gemini API        | Settings → API keys → Gemini                                           | Planner                                             |
| Codex             | `ORZEUS_ENABLE_CODEX=1` (CLI: `--enable-codex`); uses your Codex login | Worker and planner; spends your Codex plan          |
| Cursor            | `ORZEUS_ENABLE_CURSOR=1` (CLI: `--enable-cursor`); login or API key    | Worker; token use is estimated                      |
| Any ACP agent     | `ORZEUS_ACP_AGENTS='[{"id":"acp-x","command":["x","--acp"]}]'`         | Worker (CLI: `--acp "acp-x=x --acp"`)               |

Keys live in the macOS Keychain. Orzeus can tell whether a key is set but never shows it again,
and saving one restarts the engine so it takes effect.

## A run, step by step

1. **Describe the change** in Mission Control and pick the repository. Or paste a hand-written
   plan (JSON; see `services/engine/fixtures/calc/plan.json`).
2. **Review the plan.** Each node shows its task, the files it may change, what it waits for,
   its checks, its worker and its tools. Choose **Edit plan** to change any of that, add or
   remove nodes, or set how many workers run at once. Saving records a new plan revision.
3. **Approve and start.** Workers run in parallel where their files do not overlap. The graph
   shows each node's state.
4. **Answer what needs you.** The Approvals screen (⌘2) lists anything the policy asks about:
   a command outside the allowlist, a write outside the plan, a budget threshold, and finally
   the merge. Press `a` to approve or `r` to reject, or write guidance and **Steer**.
5. **Merge.** Orzeus checks the combined result, can ask the frontier model to review it, shows
   you the diff, and fast-forwards your branch only when you approve.

If a worker fails its checks, Orzeus retries it, then asks the frontier model for guidance or a
rewritten task. If the engine stops, **Resume** continues where it left off. Checkpoints let you
roll a run back to an earlier point.

## Usage limits

Settings → **Usage limits** lists every quota window Orzeus has seen (Codex's 5-hour and weekly
windows, Claude rate limits, API rate limits). Set "pause new work at" to stop starting tasks on
an account once a window reaches that share. Running tasks finish; waiting tasks continue when
the window resets. The quota strip at the top marks each limit.

## Tools for workers (MCP)

Workers reach tools only through Orzeus's gateway, which checks every call against the plan.
The repository memory is always there. Add more in Settings → **MCP servers**: a local command
(stdio) or a URL. **Test** connects and lists the tools; the server's default decides what new
plans grant (nothing, read-only tools, or everything, where anything that writes still asks
you). Tokens go in the Keychain.

## The trace

Trace (⌘3) shows every event of a run: model calls with token counts, tool calls, checks,
approvals, packets (exactly what each worker was told) and diffs. **Verify chain** recomputes
the hash chain, so any edit to the history shows up. **Export** writes JSONL or OpenTelemetry
(OTLP JSON). Secrets are redacted from command output, diffs and logs before they are stored.

## Headless use

```bash
pnpm build
node services/engine/dist/cli.js --help
node services/engine/dist/cli.js run --goal "Add a subtract function" --repo ~/code/calc
```

The CLI asks in the terminal where the app would show an approval.

## Safety model, briefly

- Workers write only inside their own worktree; symbolic links that point outside are refused,
  and a change that creates one fails the scope check.
- Each node may change only the files its plan lists; anything else fails verification.
- Commands, network access and tool calls go through a policy: allowed, denied, or asked.
- Nothing reaches your branch without the merge approval.
- Orzeus never reads another tool's credentials and never switches accounts to dodge a limit.

## Troubleshooting

- **"Engine stopped" in the sidebar:** the app restarts it a few times, then gives up. Check
  Console.app for `orzeusd` lines, or run `node services/engine/dist/main.js` to see errors.
- **A node waits and nothing happens:** look at the run's progress line; it says whether it is
  waiting for an approval, a circuit breaker, or a usage limit, and until when.
- **Local model never finishes:** small "thinking" models may spend their budget on hidden
  reasoning; use `--local-reasoning none` (CLI) or a larger model.
- **Start over:** quit the app and delete the data folder above. Your repositories are not
  affected; Orzeus's branches are named `orzeus/<run>/…` and can be deleted with git.

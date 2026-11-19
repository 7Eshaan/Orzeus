#!/usr/bin/env node
// Stands in for `codex exec --json`, printing the documented event stream
// (codex-rs/exec/src/exec_events.rs). Hand-written, not recorded: recording spends Codex quota.
// With the model "hang" it never finishes (cancellation test).
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-cli 0.170.0\n");
  process.exit(0);
}
const cwd = args[args.indexOf("-C") + 1];
const say = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
let prompt = "";
process.stdin.on("data", (c) => (prompt += c));
process.stdin.on("end", () => {
  const resumed = args[1] === "resume";
  say({
    type: "thread.started",
    thread_id: resumed ? args[2] : "0199a213-81c0-7800-8aa1-bbab2a035a53",
  });
  say({ type: "turn.started" });
  if (args[args.indexOf("-m") + 1] === "hang") {
    setInterval(() => {}, 1_000);
    return;
  }
  say({
    type: "item.started",
    item: {
      id: "item_0",
      type: "command_execution",
      command: "bash -lc ls",
      aggregated_output: "",
      exit_code: null,
      status: "in_progress",
    },
  });
  say({
    type: "item.completed",
    item: {
      id: "item_0",
      type: "command_execution",
      command: "bash -lc ls",
      aggregated_output: "README.md\n",
      exit_code: 0,
      status: "completed",
    },
  });
  writeFileSync(join(cwd, "hello.txt"), "hi\n");
  say({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "file_change",
      changes: [{ path: join(cwd, "hello.txt"), kind: "add" }],
      status: "completed",
    },
  });
  say({
    type: "item.completed",
    item: {
      id: "item_2",
      type: "agent_message",
      text: `Created hello.txt (prompt had ${prompt.length} chars).`,
    },
  });
  say({
    type: "turn.completed",
    usage: {
      input_tokens: 2400,
      cached_input_tokens: 1200,
      output_tokens: 90,
      reasoning_output_tokens: 40,
    },
  });
});

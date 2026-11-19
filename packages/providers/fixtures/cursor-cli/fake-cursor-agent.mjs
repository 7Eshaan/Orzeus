#!/usr/bin/env node
// Stands in for `cursor-agent -p --output-format stream-json`, following Cursor's documented
// output format (cursor.com/docs/cli/reference/output-format). Hand-written: the CLI is not
// installed here. With the model "hang" it never finishes.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("2026.11.12-abc1234\n");
  process.exit(0);
}
if (args[0] === "status") {
  process.stdout.write(`${JSON.stringify({ isAuthenticated: true })}\n`);
  process.exit(0);
}
const cwd = args[args.indexOf("--workspace") + 1];
const session_id = "c6b62c6f-7ead-4fd6-9922-e952131177ff";
const say = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
say({
  type: "system",
  subtype: "init",
  apiKeySource: "login",
  cwd,
  session_id,
  model: "Fake",
  permissionMode: "default",
});
say({
  type: "user",
  message: { role: "user", content: [{ type: "text", text: args.at(-1) }] },
  session_id,
});
if (args[args.indexOf("--model") + 1] === "hang") {
  setInterval(() => {}, 1_000);
} else {
  say({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "I'll create hello.txt." }] },
    session_id,
  });
  const path = join(cwd, "hello.txt");
  say({
    type: "tool_call",
    subtype: "started",
    call_id: "toolu_1",
    tool_call: { writeToolCall: { args: { path, fileText: "hi\n", toolCallId: "toolu_1" } } },
    session_id,
  });
  writeFileSync(path, "hi\n");
  say({
    type: "tool_call",
    subtype: "completed",
    call_id: "toolu_1",
    tool_call: {
      writeToolCall: {
        args: { path, fileText: "hi\n", toolCallId: "toolu_1" },
        result: { success: { path, linesCreated: 1, fileSize: 3 } },
      },
    },
    session_id,
  });
  say({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Created hello.txt." }] },
    session_id,
  });
  say({
    type: "result",
    subtype: "success",
    duration_ms: 1234,
    duration_api_ms: 1234,
    is_error: false,
    result: "I'll create hello.txt.Created hello.txt.",
    session_id,
  });
}

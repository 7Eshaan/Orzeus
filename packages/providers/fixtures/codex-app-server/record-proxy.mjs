// Sits between Orzeus and the real `codex app-server`, logging every line in both directions
// to the JSONL file given as the first argument. Used only to record conformance fixtures.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [file] = process.argv.slice(2);
const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "inherit"] });
const log = (dir, line) => {
  try {
    appendFileSync(file, `${JSON.stringify({ dir, msg: JSON.parse(line) })}\n`);
  } catch {
    // not JSON; ignore
  }
};
createInterface({ input: process.stdin }).on("line", (line) => {
  log("client", line);
  child.stdin.write(`${line}\n`);
});
createInterface({ input: child.stdout }).on("line", (line) => {
  log("server", line);
  process.stdout.write(`${line}\n`);
});
process.stdin.on("end", () => child.kill());
process.on("SIGTERM", () => {
  child.kill();
  process.exit(0);
});
child.on("close", (code) => process.exit(code ?? 0));

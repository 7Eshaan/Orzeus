// Replays recorded `codex app-server` conversations for conformance tests.
// Usage: node fake-app-server.mjs [--hang] fixture.jsonl [more.jsonl ...]
// Every fixture is a candidate; each client message narrows the candidates to those whose next
// recorded client message has the same method. With --hang, it goes quiet after answering
// turn/start, so tests can exercise cancellation.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const hang = args.includes("--hang");
let candidates = args
  .filter((a) => a !== "--hang")
  .map((file) => ({
    entries: readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l)),
    pos: 0,
  }));
const idMap = new Map();
let quiet = false;

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

function pump() {
  const current = candidates[0];
  if (current === undefined) return;
  while (
    !quiet &&
    current.pos < current.entries.length &&
    current.entries[current.pos].dir === "server"
  ) {
    const msg = { ...current.entries[current.pos].msg };
    current.pos++;
    if (msg.method === undefined && idMap.has(msg.id)) {
      const recorded = idMap.get(msg.id);
      msg.id = recorded.actual;
      write(msg);
      if (hang && recorded.method === "turn/start") quiet = true;
      continue;
    }
    write(msg);
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const method = msg.method ?? null;
  // Candidates other than the one being replayed may still have unsent server entries; skip them.
  for (const c of candidates) {
    while (c.pos < c.entries.length && c.entries[c.pos].dir === "server") c.pos++;
  }
  const matching = candidates.filter((c) => {
    const next = c.entries[c.pos];
    return next !== undefined && (next.msg.method ?? null) === method;
  });
  if (matching.length === 0) {
    if (method !== null && msg.id !== undefined)
      write({ id: msg.id, error: { code: -32601, message: `${method} not in fixture` } });
    return;
  }
  candidates = matching;
  for (const c of candidates) {
    const recorded = c.entries[c.pos].msg;
    if (method !== null && recorded.id !== undefined)
      idMap.set(recorded.id, { actual: msg.id, method });
    c.pos++;
  }
  pump();
});
process.stdin.on("end", () => process.exit(0));

/**
 * Development-only bridge so the UI can run in an ordinary browser (for testing and design
 * work): spawns the built engine and relays its stdio over loopback HTTP.
 *
 *   GET  /events  Server-Sent Events, one engine stdout line per event
 *   POST /send    one JSON-RPC line to the engine's stdin
 *
 * Usage: node tooling/scripts/dev-bridge.ts [--port 1421] [--data-dir <dir>]
 * Then open http://localhost:1420/?bridge=http://127.0.0.1:1421
 * Never exposed beyond 127.0.0.1, and only accepts requests from the Vite dev origin.
 */
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { port: { type: "string", default: "1421" }, "data-dir": { type: "string" } },
});
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ORIGIN = "http://localhost:1420";

const engine = spawn(process.execPath, [join(root, "services/engine/dist/main.js")], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, ...(values["data-dir"] ? { ORZEUS_DATA_DIR: values["data-dir"] } : {}) },
});
const clients = new Set<ServerResponse>();
createInterface({ input: engine.stdout }).on("line", (line) => {
  for (const client of clients) client.write(`data: ${line}\n\n`);
});
engine.on("exit", (code) => {
  process.stderr.write(`engine exited (${code})\n`);
  process.exit(code ?? 1);
});

createServer((req, res) => {
  res.setHeader("access-control-allow-origin", ORIGIN);
  res.setHeader("access-control-allow-headers", "content-type");
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== ORIGIN) {
    res.writeHead(403).end();
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.method === "GET" && req.url === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(
      `data: ${JSON.stringify({ jsonrpc: "2.0", method: "bridge.status", params: { state: "running", pid: engine.pid } })}\n\n`,
    );
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (req.method === "POST" && req.url === "/send") {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      const line = body.trim();
      if (line.includes("\n")) {
        res.writeHead(400).end();
        return;
      }
      engine.stdin.write(`${line}\n`);
      res.writeHead(204).end();
    });
    return;
  }
  res.writeHead(404).end();
}).listen(Number(values.port), "127.0.0.1", () =>
  process.stderr.write(`Orzeus dev bridge on http://127.0.0.1:${values.port}\n`),
);

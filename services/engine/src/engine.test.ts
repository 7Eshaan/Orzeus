import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { encodeLine, RpcClient, type RpcHandlers } from "@orzeus/protocol";
import { describe, expect, it } from "vitest";
import { createHandlers } from "./handlers.js";
import { createJsonLogger } from "./logger.js";
import { serveStdio } from "./stdio.js";
import { ENGINE_VERSION } from "./version.js";

const info = { startedAt: 42, nodeVersion: "v26.13.0", platform: "darwin", arch: "arm64" };

describe("engine", () => {
  it("keeps ENGINE_VERSION in sync with package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(ENGINE_VERSION).toBe(pkg.version);
  });

  it("answers engine.ping over line-delimited streams", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const logs: string[] = [];
    const served = serveStdio({
      input,
      output,
      handlers: createHandlers(info) as RpcHandlers,
      logger: createJsonLogger((line) => logs.push(line)),
    });

    const client = new RpcClient((line) => {
      input.write(line);
    });
    output.setEncoding("utf8");
    let buffered = "";
    output.on("data", (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        client.receive(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    });

    const result = await client.request("engine.ping", {});
    expect(result).toMatchObject({ engineVersion: ENGINE_VERSION, startedAt: 42 });

    input.end();
    await served;
    expect(logs).toEqual([]);
  });

  it("writes nothing to stdout for notifications", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (chunk: Buffer) => written.push(chunk.toString()));
    const served = serveStdio({
      input,
      output,
      handlers: createHandlers(info) as RpcHandlers,
      logger: createJsonLogger(() => undefined),
    });
    input.end(encodeLine({ jsonrpc: "2.0", method: "ui.hello" }));
    await served;
    expect(written).toEqual([]);
  });
});

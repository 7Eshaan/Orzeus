import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RpcClient } from "./client.js";
import { encodeLine, RpcError, RpcErrorCode, RpcResponseSchema } from "./jsonrpc.js";
import { type EnginePingResult, PROTOCOL_VERSION } from "./methods.js";
import { handleRpcLine, type RpcHandlers } from "./server.js";

const pingResult: EnginePingResult = {
  engineVersion: "0.0.0",
  protocolVersion: PROTOCOL_VERSION,
  runtime: { node: "v26.0.0", platform: "darwin", arch: "arm64" },
  startedAt: 1,
};

/** Only ping is exercised here; the full method set is tested in the engine. */
const handlers = { "engine.ping": () => pingResult } as unknown as RpcHandlers;

/** Wires a client straight to the server, the way the Rust relay does. */
function connectedClient(serverHandlers: RpcHandlers = handlers): RpcClient {
  const client: RpcClient = new RpcClient(async (line) => {
    const reply = await handleRpcLine(serverHandlers, line);
    if (reply !== null) client.receive(reply);
  });
  return client;
}

async function errorOf(line: string): Promise<{ code: number; message: string }> {
  const reply = await handleRpcLine(handlers, line);
  expect(reply).not.toBeNull();
  const parsed = RpcResponseSchema.parse(JSON.parse(reply ?? ""));
  if (!("error" in parsed)) throw new Error("expected an error response");
  return parsed.error;
}

describe("client and server round trip", () => {
  it("returns a validated ping result", async () => {
    const client = connectedClient();
    await expect(client.request("engine.ping", {})).resolves.toEqual(pingResult);
    expect(client.pendingCount).toBe(0);
  });

  it("surfaces handler failures as a generic internal error", async () => {
    const seen: string[] = [];
    const failing = {
      "engine.ping": () => {
        throw new Error("secret detail");
      },
    } as unknown as RpcHandlers;
    const reply = await handleRpcLine(
      failing,
      encodeLine({ jsonrpc: "2.0", id: 7, method: "engine.ping", params: {} }),
      {
        onInternalError: (method) => seen.push(method),
      },
    );
    expect(reply).toContain('"code":-32603');
    expect(reply).not.toContain("secret detail");
    expect(seen).toEqual(["engine.ping"]);
  });

  it("rejects results that do not match the method schema", async () => {
    const bad = { "engine.ping": () => ({ nope: true }) } as unknown as RpcHandlers;
    const client = connectedClient(bad);
    await expect(client.request("engine.ping", {})).rejects.toMatchObject({
      code: RpcErrorCode.InvalidResult,
    });
  });
});

describe("server error handling", () => {
  it("reports parse errors", async () => {
    expect((await errorOf("{not json")).code).toBe(RpcErrorCode.ParseError);
  });

  it("reports invalid requests", async () => {
    expect((await errorOf(JSON.stringify({ jsonrpc: "1.0", id: 1, method: "x" }))).code).toBe(
      RpcErrorCode.InvalidRequest,
    );
  });

  it("reports unknown methods", async () => {
    const line = encodeLine({ jsonrpc: "2.0", id: 1, method: "engine.reboot" });
    expect((await errorOf(line)).code).toBe(RpcErrorCode.MethodNotFound);
  });

  it("reports invalid params", async () => {
    const line = encodeLine({ jsonrpc: "2.0", id: 1, method: "engine.ping", params: { extra: 1 } });
    expect((await errorOf(line)).code).toBe(RpcErrorCode.InvalidParams);
  });

  it("ignores blank lines and notifications", async () => {
    await expect(handleRpcLine(handlers, "   ")).resolves.toBeNull();
    await expect(
      handleRpcLine(handlers, encodeLine({ jsonrpc: "2.0", method: "ui.hello" })),
    ).resolves.toBeNull();
  });

  it("never throws and always answers with valid JSON-RPC, whatever the input", async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.string(), fc.json()), async (input) => {
        const reply = await handleRpcLine(handlers, input);
        if (reply !== null) {
          expect(reply.endsWith("\n")).toBe(true);
          expect(RpcResponseSchema.safeParse(JSON.parse(reply)).success).toBe(true);
        }
      }),
    );
  });
});

describe("client lifecycle", () => {
  it("rejects pending requests on dispose and refuses new ones", async () => {
    const client = new RpcClient(() => undefined);
    const pending = client.request("engine.ping", {});
    client.dispose("engine exited");
    await expect(pending).rejects.toBeInstanceOf(RpcError);
    await expect(client.request("engine.ping", {})).rejects.toMatchObject({
      code: RpcErrorCode.Disposed,
    });
  });

  it("ignores unrelated lines and forwards notifications", () => {
    const seen: string[] = [];
    const client = new RpcClient(
      () => undefined,
      (n) => seen.push(n.method),
    );
    client.receive("garbage");
    client.receive(encodeLine({ jsonrpc: "2.0", id: 999, result: {} }));
    client.receive(encodeLine({ jsonrpc: "2.0", method: "run.updated", params: {} }));
    expect(seen).toEqual(["run.updated"]);
  });
});

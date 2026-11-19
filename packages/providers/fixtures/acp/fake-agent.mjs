#!/usr/bin/env node
// A tiny ACP v1 agent built with the official SDK, for the adapter's tests. It asks permission
// to edit, writes hello.txt through the client's fs/write_text_file, and reports a tool call.
// With FAKE_HANG=1 the prompt never ends until session/cancel.
import { Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

let cancel = () => {};
const app = agent({ name: "fake-agent" })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
    agentInfo: { name: "fake-agent", version: "1.0.0" },
  }))
  .onRequest(methods.agent.session.new, () => ({ sessionId: "sess-1" }))
  .onRequest(methods.agent.session.load, () => ({}))
  .onNotification(methods.agent.session.cancel, () => cancel())
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const update = (u) =>
      client.notify(methods.client.session.update, { sessionId: params.sessionId, update: u });
    if (process.env.FAKE_HANG === "1")
      return new Promise((resolve) => {
        cancel = () => resolve({ stopReason: "cancelled" });
      });
    await update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Creating hello.txt. " },
    });
    await update({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Write hello.txt",
      kind: "edit",
      status: "pending",
      locations: [{ path: "hello.txt" }],
      rawInput: { path: "hello.txt" },
    });
    const answer = await client.request(methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: "t1",
        kind: "edit",
        title: "Write hello.txt",
        locations: [{ path: "hello.txt" }],
      },
      options: [
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    });
    if (answer.outcome.outcome === "selected" && answer.outcome.optionId === "yes") {
      await client.request(methods.client.fs.writeTextFile, {
        sessionId: params.sessionId,
        path: "hello.txt",
        content: "hi\n",
      });
      await update({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        rawOutput: { ok: true },
      });
      await update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Created hello.txt." },
      });
    } else {
      await update({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "failed",
        rawOutput: { denied: true },
      });
      await update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "I was not allowed to write." },
      });
    }
    await update({
      sessionUpdate: "usage_update",
      used: 1000,
      size: 200000,
      cost: { amount: 0.0021, currency: "USD" },
    });
    return { stopReason: "end_turn" };
  });

app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));

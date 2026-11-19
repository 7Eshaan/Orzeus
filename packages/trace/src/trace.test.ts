import { createHash } from "node:crypto";
import {
  type EventDraft,
  parseTraceEvent,
  type RunId,
  type Sha256,
  type TraceEvent,
} from "@orzeus/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CanonicalizationError, canonicalize } from "./canonical-json.js";
import { type HashFn, sealEvent, verifyChain } from "./chain.js";
import { exportJsonl } from "./export.js";

const sha256: HashFn = (text) => createHash("sha256").update(text, "utf8").digest("hex") as Sha256;
const runId = "01JD7Z5K3Q9V8X2M4N6P8R0T2W" as RunId;

function draft(seqHint: number): EventDraft {
  return {
    ts: 1_700_000_000_000 + seqHint,
    type: "run.paused",
    nodeId: null,
    attempt: null,
    actor: { kind: "engine" },
    payload: { reason: `pause ${seqHint}` },
    blobs: [],
    otel: { traceId: `${"0".repeat(31)}1`, spanId: `${"0".repeat(15)}1`, parentSpanId: null },
  };
}

function chainOf(length: number): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (let i = 0; i < length; i++) {
    const prev = events.at(-1);
    events.push(
      sealEvent(runId, draft(i), prev ? { seq: prev.seq, hash: prev.hash } : null, sha256),
    );
  }
  return events;
}

describe("canonicalize (RFC 8785)", () => {
  it("matches the RFC's primitive example", () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
    ) as unknown;
    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it("sorts keys by UTF-16 code units, as in the RFC's sorting example", () => {
    const input = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      דּ: "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      ö: "Latin Small Letter O With Diaeresis",
    };
    const keys = Object.keys(JSON.parse(canonicalize(input)) as object);
    // Integer-like keys come first in JS object order regardless, so compare the canonical text.
    const order = ["\r", "1", "\u0080", "ö", "€", "😀", "דּ"];
    expect(canonicalize(input)).toBe(
      `{${order.map((k) => `${JSON.stringify(k)}:${JSON.stringify(input[k as keyof typeof input])}`).join(",")}}`,
    );
    expect(keys).toHaveLength(7);
  });

  it("is independent of key insertion order", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (record) => {
        const reversed = Object.fromEntries(Object.entries(record).reverse());
        expect(canonicalize(reversed)).toBe(canonicalize(record));
      }),
    );
  });

  it("round-trips any JSON value", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const text = canonicalize(value);
        expect(canonicalize(JSON.parse(text))).toBe(text);
      }),
    );
  });

  it("rejects values that JSON cannot represent faithfully", () => {
    expect(() => canonicalize({ a: Number.NaN })).toThrow(CanonicalizationError);
    expect(() => canonicalize([undefined])).toThrow(CanonicalizationError);
    expect(() => canonicalize(new Date(0))).toThrow(CanonicalizationError);
    expect(() => canonicalize(1n)).toThrow(CanonicalizationError);
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("hash chain", () => {
  it("seals valid, schema-conforming events that verify", () => {
    const events = chainOf(5);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events[0]?.prevHash).toBeNull();
    expect(events[1]?.prevHash).toBe(events[0]?.hash);
    for (const event of events) expect(parseTraceEvent(event).ok).toBe(true);
    expect(verifyChain(events, sha256)).toEqual({
      ok: true,
      head: { seq: 5, hash: events[4]?.hash },
    });
  });

  it("detects any single-character tamper in any event", () => {
    const events = chainOf(6);
    fc.assert(
      fc.property(fc.nat({ max: events.length - 1 }), fc.nat(), (index, offset) => {
        const target = events[index] as TraceEvent;
        const json = JSON.stringify(target);
        const position = offset % json.length;
        const original = json[position] as string;
        const replacement = original === "a" ? "b" : "a";
        let tampered: TraceEvent;
        try {
          tampered = JSON.parse(
            json.slice(0, position) + replacement + json.slice(position + 1),
          ) as TraceEvent;
        } catch {
          return; // not valid JSON any more; a reader would reject it before verifying
        }
        if (JSON.stringify(tampered) === json) return; // tamper landed in insignificant text
        const copy = events.slice();
        copy[index] = tampered;
        expect(verifyChain(copy, sha256).ok).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it("detects removed, reordered and foreign events", () => {
    const events = chainOf(4);
    const [first, second, third, fourth] = events as [
      TraceEvent,
      TraceEvent,
      TraceEvent,
      TraceEvent,
    ];
    expect(verifyChain([first, third, fourth], sha256)).toMatchObject({ ok: false, seq: 3 });
    expect(verifyChain([first, third, second, fourth], sha256).ok).toBe(false);
    const foreign = sealEvent(
      "01JD7Z5K3Q9V8X2M4N6P8R0T2X" as RunId,
      draft(9),
      { seq: 2, hash: second.hash },
      sha256,
    );
    expect(verifyChain([first, second, foreign], sha256)).toMatchObject({
      ok: false,
      reason: "event belongs to another run",
    });
  });

  it("exports canonical JSONL that re-verifies", () => {
    const events = chainOf(3);
    const lines = exportJsonl(events).trimEnd().split("\n");
    const reread = lines.map((line) => JSON.parse(line) as TraceEvent);
    expect(verifyChain(reread, sha256).ok).toBe(true);
  });
});

describe("OTLP export", () => {
  it("emits one span per event with GenAI attributes on model calls", async () => {
    const { exportOtlp } = await import("./otlp.js");
    const prev = chainOf(1)[0] as TraceEvent;
    const call = sealEvent(
      runId,
      {
        ...draft(5),
        type: "model.call",
        payload: {
          model: { provider: "openai", adapter: "codex-app-server", model: "m" },
          tier: "frontier",
          purpose: "plan",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: 5,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
          costMicroUsd: null,
          latencyMs: 250,
        },
      } as never,
      { seq: prev.seq, hash: prev.hash },
      sha256,
    );
    const otlp = JSON.parse(exportOtlp([prev, call])) as {
      resourceSpans: {
        scopeSpans: {
          spans: {
            name: string;
            startTimeUnixNano: string;
            endTimeUnixNano: string;
            attributes: { key: string; value: Record<string, unknown> }[];
          }[];
        }[];
      }[];
    };
    const spans = otlp.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
    expect(spans.map((s) => s.name)).toEqual(["run.paused", "chat m"]);
    const model = spans[1];
    expect(BigInt(model?.endTimeUnixNano ?? 0) - BigInt(model?.startTimeUnixNano ?? 0)).toBe(
      250_000_000n,
    );
    expect(model?.attributes).toContainEqual({
      key: "gen_ai.usage.input_tokens",
      value: { intValue: "15" },
    });
  });
});

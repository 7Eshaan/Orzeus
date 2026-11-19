import type { TraceEvent } from "@orzeus/schema";

type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { boolValue: boolean }
  | { doubleValue: number };
interface KeyValue {
  key: string;
  value: AnyValue;
}

const attr = (key: string, value: string | number | boolean | null | undefined): KeyValue[] => {
  if (value === null || value === undefined) return [];
  if (typeof value === "boolean") return [{ key, value: { boolValue: value } }];
  if (typeof value === "number")
    return [
      {
        key,
        value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value },
      },
    ];
  return [{ key, value: { stringValue: value } }];
};

const nanos = (ms: number): string => `${BigInt(Math.round(ms)) * 1_000_000n}`;

/**
 * OTLP/JSON export (ExportTraceServiceRequest): one span per event, with OpenTelemetry GenAI
 * semantic-convention attributes on model and tool calls. Model calls get a duration from their
 * recorded latency; other events are instants.
 */
export function exportOtlp(events: readonly TraceEvent[], serviceName = "orzeus"): string {
  const spans = events.map((e) => {
    const end = e.ts;
    const start =
      e.type === "model.call"
        ? end - e.payload.latencyMs
        : e.type === "tool.call"
          ? end - e.payload.durationMs
          : end;
    const attributes: KeyValue[] = [
      ...attr("orzeus.run_id", e.runId),
      ...attr("orzeus.seq", e.seq),
      ...attr("orzeus.hash", e.hash),
      ...attr("orzeus.node_id", e.nodeId),
      ...attr("orzeus.attempt", e.attempt),
      ...attr("orzeus.actor", e.actor.kind),
    ];
    if (e.type === "model.call") {
      attributes.push(
        ...attr("gen_ai.operation.name", "chat"),
        ...attr("gen_ai.provider.name", e.payload.model.provider),
        ...attr("gen_ai.request.model", e.payload.model.model),
        ...attr(
          "gen_ai.usage.input_tokens",
          e.payload.usage.inputTokens + e.payload.usage.cacheReadTokens,
        ),
        ...attr("gen_ai.usage.output_tokens", e.payload.usage.outputTokens),
        ...attr("orzeus.tier", e.payload.tier),
        ...attr("orzeus.purpose", e.payload.purpose),
      );
    } else if (e.type === "tool.call") {
      attributes.push(
        ...attr("gen_ai.operation.name", "execute_tool"),
        ...attr("gen_ai.tool.name", `${e.payload.server}/${e.payload.tool}`),
        ...attr("orzeus.decision", e.payload.decision),
        ...attr("error", e.payload.isError),
      );
    }
    return {
      traceId: e.otel.traceId,
      spanId: e.otel.spanId,
      ...(e.otel.parentSpanId === null ? {} : { parentSpanId: e.otel.parentSpanId }),
      name:
        e.type === "model.call"
          ? `chat ${e.payload.model.model}`
          : e.type === "tool.call"
            ? `execute_tool ${e.payload.tool}`
            : e.type,
      kind: e.type === "model.call" ? 3 : 1,
      startTimeUnixNano: nanos(start),
      endTimeUnixNano: nanos(end),
      attributes,
      status: { code: e.type === "node.failed" || e.type === "run.failed" ? 2 : 1 },
    };
  });
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: attr("service.name", serviceName) },
        scopeSpans: [{ scope: { name: "orzeus", version: "0.0.0" }, spans }],
      },
    ],
  });
}

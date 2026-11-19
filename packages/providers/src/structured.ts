import type { MicroUsd, QuotaWindow, TokenUsage } from "@orzeus/schema";

/** A target output shape: JSON Schema for the provider plus a runtime parser (usually Zod). */
export interface OutputSchema<T> {
  readonly name: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  parse(value: unknown): T;
}

export interface GenerateRequest<T> {
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  readonly output: OutputSchema<T>;
  readonly maxOutputTokens: number;
}

export interface GenerateResult<T> {
  readonly value: T;
  readonly usage: TokenUsage;
  readonly costMicroUsd: MicroUsd | null;
  readonly quota: readonly QuotaWindow[];
  readonly latencyMs: number;
}

/** The model answered, but not with JSON that matches the schema. */
export class StructuredOutputError extends Error {
  override readonly name = "StructuredOutputError";
  readonly raw: string;

  constructor(message: string, raw: string) {
    super(message);
    this.raw = raw;
  }
}

/** JSON Schema keywords that strict structured-output modes reject (Anthropic documents these). */
const UNSUPPORTED = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "not",
  "$schema",
]);

/**
 * Rewrites a JSON Schema into the portable strict subset: drops value constraints (Zod still
 * enforces them after parsing), turns oneOf into anyOf, and closes every object with
 * additionalProperties: false.
 */
export function toStrictJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toStrictJsonSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (UNSUPPORTED.has(key)) continue;
    if (key === "oneOf") out["anyOf"] = toStrictJsonSchema(value);
    else if (key === "properties" || key === "$defs" || key === "definitions") {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          toStrictJsonSchema(v),
        ]),
      );
    } else out[key] = toStrictJsonSchema(value);
  }
  if (out["type"] === "object" || out["properties"] !== undefined) {
    out["additionalProperties"] = false;
    if (out["properties"] !== undefined && out["required"] === undefined)
      out["required"] = Object.keys(out["properties"] as object);
  }
  return out;
}

/** Removes line and block comments and trailing commas outside strings (common small-model slips). */
export function stripJsonNoise(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (inString) {
      out += char;
      if (char === "\\") out += text[++i] ?? "";
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += char;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function typesOf(schema: Record<string, unknown>): string[] {
  const type = schema["type"];
  const own = Array.isArray(type) ? (type as string[]) : typeof type === "string" ? [type] : [];
  const variants = (schema["anyOf"] ?? schema["oneOf"]) as Record<string, unknown>[] | undefined;
  return [...own, ...(variants ?? []).flatMap(typesOf)];
}

/**
 * Nudges a near-miss answer towards the schema without inventing content: a lone object where
 * an array is expected becomes a one-item array, and missing nullable or array fields become
 * null or []. Validation still runs afterwards, so anything else is still rejected.
 */
export function coerceToSchema(value: unknown, schema: unknown): unknown {
  if (schema === null || typeof schema !== "object") return value;
  const s = schema as Record<string, unknown>;
  const types = typesOf(s);
  if (types.includes("array") && value !== null && value !== undefined && !Array.isArray(value)) {
    return [coerceToSchema(value, s["items"])];
  }
  if (Array.isArray(value)) return value.map((item) => coerceToSchema(item, s["items"]));
  const properties = s["properties"] as Record<string, unknown> | undefined;
  if (properties !== undefined && value !== null && typeof value === "object") {
    const record = { ...(value as Record<string, Json>) };
    for (const [key, propSchema] of Object.entries(properties)) {
      const propTypes = typesOf(propSchema as Record<string, unknown>);
      if (!(key in record)) {
        if (propTypes.includes("null")) record[key] = null;
        else if (propTypes.includes("array")) record[key] = [];
        continue;
      }
      record[key] = coerceToSchema(record[key], propSchema) as Json;
    }
    return record;
  }
  return value;
}

/**
 * Extracts and parses JSON from a model's text, tolerating a fenced code block, comments and
 * trailing commas, and coercing near-miss shapes; the result is always validated.
 */
export function parseJsonOutput<T>(text: string, output: OutputSchema<T>): T {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)?.[1] ?? trimmed;
  let json: unknown;
  try {
    json = JSON.parse(fenced);
  } catch {
    try {
      json = JSON.parse(stripJsonNoise(fenced));
    } catch {
      throw new StructuredOutputError(`${output.name}: the model did not return valid JSON`, text);
    }
  }
  try {
    return output.parse(json);
  } catch {
    try {
      return output.parse(coerceToSchema(json, output.jsonSchema));
    } catch (error) {
      throw new StructuredOutputError(
        `${output.name}: ${error instanceof Error ? error.message : String(error)}`,
        text,
      );
    }
  }
}

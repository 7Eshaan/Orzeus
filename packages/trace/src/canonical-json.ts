/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * - Object keys sorted by UTF-16 code units (the default JS string order).
 * - Numbers in ECMAScript shortest round-trip form (what JSON.stringify produces).
 * - Strings escaped exactly as JSON.stringify escapes them.
 * - No whitespace.
 *
 * Rejects values JSON cannot represent faithfully (NaN, Infinity, bigint, functions, symbols,
 * undefined array items, non-plain objects) instead of silently changing them, because a hash
 * over a silently changed value proves nothing.
 */
export function canonicalize(value: unknown): string {
  return serialize(value, "$");
}

export class CanonicalizationError extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`Cannot canonicalize ${path}: ${reason}`);
    this.name = "CanonicalizationError";
    this.path = path;
  }
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalizationError(path, "non-finite number");
      return JSON.stringify(value);
    case "object":
      return Array.isArray(value) ? serializeArray(value, path) : serializeObject(value, path);
    default:
      throw new CanonicalizationError(path, `unsupported type ${typeof value}`);
  }
}

function serializeArray(items: readonly unknown[], path: string): string {
  const parts = items.map((item, index) => {
    if (item === undefined)
      throw new CanonicalizationError(`${path}[${index}]`, "undefined array item");
    return serialize(item, `${path}[${index}]`);
  });
  return `[${parts.join(",")}]`;
}

function serializeObject(object: object, path: string): string {
  const prototype = Object.getPrototypeOf(object) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalizationError(path, "only plain objects are allowed");
  }
  const record = object as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${serialize(item, `${path}.${key}`)}`);
  }
  return `{${parts.join(",")}}`;
}

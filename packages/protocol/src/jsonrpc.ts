import { z } from "zod";

/** JSON-RPC 2.0 error codes used by Orzeus. */
export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** The response did not match the method's declared result schema. */
  InvalidResult: -32001,
  /** The client was disposed before the response arrived. */
  Disposed: -32002,
} as const;

export type RpcErrorCode = (typeof RpcErrorCode)[keyof typeof RpcErrorCode];

const RequestId = z.union([z.string(), z.int()]);
export type RequestId = z.infer<typeof RequestId>;

export const RpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: RequestId,
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

export const RpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type RpcNotification = z.infer<typeof RpcNotificationSchema>;

export const RpcErrorObjectSchema = z.object({
  code: z.int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type RpcErrorObject = z.infer<typeof RpcErrorObjectSchema>;

export const RpcResponseSchema = z.union([
  z.object({ jsonrpc: z.literal("2.0"), id: RequestId, result: z.unknown() }),
  z.object({ jsonrpc: z.literal("2.0"), id: RequestId.nullable(), error: RpcErrorObjectSchema }),
]);
export type RpcResponse = z.infer<typeof RpcResponseSchema>;

/** Serializes one message as a single NDJSON line (with trailing newline). */
export function encodeLine(message: RpcRequest | RpcNotification | RpcResponse): string {
  return `${JSON.stringify(message)}\n`;
}

/** Parses one line. Returns undefined for blank lines and for input that is not valid JSON. */
export function parseLine(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** An error carrying a JSON-RPC error object, thrown by RpcClient on failed requests. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: RpcErrorObject) {
    super(error.message);
    this.name = "RpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

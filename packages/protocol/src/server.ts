import { z } from "zod";
import {
  encodeLine,
  parseLine,
  type RequestId,
  RpcErrorCode,
  type RpcErrorObject,
  RpcNotificationSchema,
  RpcRequestSchema,
} from "./jsonrpc.js";
import {
  isMethodName,
  type MethodName,
  type MethodParams,
  type MethodResult,
  methods,
} from "./methods.js";

/** One handler per method. A missing handler is a compile error. */
export type RpcHandlers = {
  readonly [M in MethodName]: (
    params: MethodParams<M>,
  ) => Promise<MethodResult<M>> | MethodResult<M>;
};

export interface HandleOptions {
  /** Called with unexpected handler errors, for logging. The client only sees a generic message. */
  readonly onInternalError?: (method: string, error: unknown) => void;
}

/**
 * Handles one incoming line and returns the response line to write back, or null when nothing
 * should be written (blank lines and notifications).
 */
export async function handleRpcLine(
  handlers: RpcHandlers,
  line: string,
  options: HandleOptions = {},
): Promise<string | null> {
  const message = parseLine(line);
  if (message === undefined) {
    return line.trim() === ""
      ? null
      : errorLine(null, { code: RpcErrorCode.ParseError, message: "Parse error" });
  }

  const request = RpcRequestSchema.safeParse(message);
  if (!request.success) {
    // Notifications from the UI are not used yet; accept and ignore well-formed ones.
    if (RpcNotificationSchema.safeParse(message).success) return null;
    return errorLine(null, { code: RpcErrorCode.InvalidRequest, message: "Invalid request" });
  }

  const { id, method, params } = request.data;
  if (!isMethodName(method)) {
    return errorLine(id, {
      code: RpcErrorCode.MethodNotFound,
      message: `Unknown method: ${method}`,
    });
  }

  const parsedParams = methods[method].params.safeParse(params ?? {});
  if (!parsedParams.success) {
    return errorLine(id, {
      code: RpcErrorCode.InvalidParams,
      message: "Invalid params",
      data: z.prettifyError(parsedParams.error),
    });
  }

  try {
    const result = await dispatch(handlers, method, parsedParams.data);
    return encodeLine({ jsonrpc: "2.0", id, result });
  } catch (error) {
    options.onInternalError?.(method, error);
    return errorLine(id, { code: RpcErrorCode.InternalError, message: "Internal error" });
  }
}

function dispatch<M extends MethodName>(
  handlers: RpcHandlers,
  method: M,
  params: MethodParams<M>,
): Promise<MethodResult<M>> {
  const handler = handlers[method] as (
    p: MethodParams<M>,
  ) => Promise<MethodResult<M>> | MethodResult<M>;
  return Promise.resolve(handler(params));
}

function errorLine(id: RequestId | null, error: RpcErrorObject): string {
  return encodeLine({ jsonrpc: "2.0", id, error });
}

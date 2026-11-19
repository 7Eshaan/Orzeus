/**
 * @orzeus/protocol
 *
 * Typed JSON-RPC 2.0 contract between the orzeusd engine and the desktop UI.
 */
export { RpcClient, type SendLine } from "./client.js";
export {
  encodeLine,
  parseLine,
  RpcError,
  RpcErrorCode,
  type RpcErrorObject,
  type RpcNotification,
  type RpcRequest,
  type RpcResponse,
} from "./jsonrpc.js";
export {
  EnginePingResult,
  isMethodName,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type Methods,
  methods,
  type NotificationName,
  type NotificationParams,
  notifications,
  PROTOCOL_VERSION,
  parseNotification,
} from "./methods.js";
export { type HandleOptions, handleRpcLine, type RpcHandlers } from "./server.js";
export * from "./views.js";

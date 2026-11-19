/**
 * @orzeus/mcp-gateway
 *
 * The per-run loopback MCP gateway: one bearer token per node attempt, exposing only that
 * node's allowlisted upstream tools (eager or behind find/call meta-tools) and its packet
 * context, with every call authorized by policy and recorded in the trace.
 */
export {
  CALL_TOOL,
  CONTEXT_TOOL,
  describeUpstream,
  FIND_TOOLS,
  type GatewayCall,
  type GatewayDecision,
  McpGateway,
  type NodeGrant,
  type Upstream,
  type UpstreamTool,
} from "./gateway.js";
export { isLoopbackRequest } from "./http.js";

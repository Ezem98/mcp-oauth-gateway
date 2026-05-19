import { Hono } from "hono";
import { bearerAuth } from "./auth-middleware.js";
import { forwardToUpstream } from "./forwarder.js";

/**
 * MCP gateway routes — `/:server_id/mcp` for the protocol traffic itself.
 *
 * Per the MCP Streamable HTTP transport (March 2025 spec):
 *   POST   /<server>/mcp    JSON-RPC request, response is JSON or SSE
 *   GET    /<server>/mcp    open server→client SSE stream
 *   DELETE /<server>/mcp    close a session
 *
 * All three need auth and forward to the same upstream.
 */
export const gatewayRoutes = new Hono();

gatewayRoutes.use("/:server_id/mcp", bearerAuth());

gatewayRoutes.post("/:server_id/mcp", forwardToUpstream);
gatewayRoutes.get("/:server_id/mcp", forwardToUpstream);
gatewayRoutes.delete("/:server_id/mcp", forwardToUpstream);

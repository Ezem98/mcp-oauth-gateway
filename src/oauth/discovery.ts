import { Hono } from "hono";
import { getEnv } from "../config/env.js";
import { getPublicJwks } from "./keys.js";
import { ALL_SCOPES } from "./scopes.js";
import { getServer, resourceUriFor } from "./servers.js";

export const discoveryRoutes = new Hono();

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414).
 * Required for MCP spec discovery.
 */
discoveryRoutes.get("/.well-known/oauth-authorization-server", (c) => {
  const base = getEnv().PUBLIC_URL;
  return c.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    jwks_uri: `${base}/.well-known/jwks.json`,
    scopes_supported: [...ALL_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    response_modes_supported: ["query"],
  });
});

discoveryRoutes.get("/.well-known/jwks.json", async (c) => {
  const jwks = await getPublicJwks();
  return c.json(jwks);
});

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * Required by the MCP authorization spec (2025-06-18). Clients discover this
 * via the `resource_metadata` parameter of the `WWW-Authenticate` header
 * returned by the gateway proxy on 401.
 *
 * Path mirrors the resource URI:
 *   resource     = PUBLIC_URL/<server_id>/mcp
 *   metadata URL = PUBLIC_URL/.well-known/oauth-protected-resource/<server_id>/mcp
 */
discoveryRoutes.get(
  "/.well-known/oauth-protected-resource/:server_id/mcp",
  (c) => {
    const serverId = c.req.param("server_id");
    const server = getServer(serverId);
    if (!server) {
      return c.json({ error: "not_found" }, 404);
    }
    const base = getEnv().PUBLIC_URL;
    return c.json({
      resource: resourceUriFor(serverId),
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      scopes_supported: [...ALL_SCOPES],
    });
  }
);

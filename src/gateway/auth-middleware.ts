import type { Context, MiddlewareHandler } from "hono";
import { getEnv } from "../config/env.js";
import { getDb } from "../db/client.js";
import { verifyAccessToken, type AccessTokenClaims } from "../oauth/jwt.js";
import { resourceUriFor } from "../oauth/servers.js";
import { logger } from "../observability/logger.js";

/**
 * MCP authorization spec (2025-06-18) requires 401 responses to advertise the
 * protected-resource metadata URL so the client can discover the AS.
 */
function buildWwwAuthenticate(serverId: string, error?: string): string {
  const base = getEnv().PUBLIC_URL;
  const metadataUrl = `${base}/.well-known/oauth-protected-resource/${serverId}/mcp`;
  const parts = [
    `Bearer realm="mcp"`,
    `resource_metadata="${metadataUrl}"`,
  ];
  if (error) parts.push(`error="${error}"`);
  return parts.join(", ");
}

function unauthorized(
  c: Context,
  serverId: string,
  error: string,
  description: string,
  status: 401 | 403 = 401
) {
  c.header("WWW-Authenticate", buildWwwAuthenticate(serverId, error));
  return c.json({ error, error_description: description }, status);
}

export interface AuthContext {
  claims: AccessTokenClaims;
  serverId: string;
}

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

/**
 * Bearer-token middleware for `/<server_id>/mcp` routes.
 * Validates JWT signature, issuer, audience, and revocation. Attaches the
 * decoded claims to `c.get('auth')` for downstream handlers.
 */
export function bearerAuth(): MiddlewareHandler {
  return async (c, next) => {
    const serverId = c.req.param("server_id");
    if (!serverId) {
      return c.json({ error: "invalid_request" }, 400);
    }

    const authHeader = c.req.header("authorization");
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
      return unauthorized(
        c,
        serverId,
        "invalid_token",
        "missing bearer token"
      );
    }

    const token = authHeader.slice("bearer ".length).trim();
    if (!token) {
      return unauthorized(
        c,
        serverId,
        "invalid_token",
        "empty bearer token"
      );
    }

    const env = getEnv();
    const expectedAud = resourceUriFor(serverId);

    let claims: AccessTokenClaims;
    try {
      claims = await verifyAccessToken(token, env.PUBLIC_URL, expectedAud);
    } catch (err) {
      logger.debug("Token verification failed", {
        server_id: serverId,
        reason: err instanceof Error ? err.message : String(err),
      });
      return unauthorized(
        c,
        serverId,
        "invalid_token",
        "token signature, issuer, audience, or expiry check failed"
      );
    }

    // Revocation lookup. JWTs already encode exp; this catches revoked-jti.
    const revoked = getDb()
      .prepare("SELECT revoked FROM access_tokens WHERE jti = ?")
      .get(claims.jti) as { revoked: number } | undefined;

    if (revoked && revoked.revoked === 1) {
      return unauthorized(c, serverId, "invalid_token", "token revoked");
    }

    c.set("auth", { claims, serverId });
    await next();
  };
}

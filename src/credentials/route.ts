import { Hono } from "hono";
import { bearerAuth } from "../gateway/auth-middleware.js";
import { logger } from "../observability/logger.js";
import {
  freshTokenErrorResponse,
  getFreshGoogleToken,
} from "./google.js";
import { getCredential, type VaultCredential } from "./vault.js";

/**
 * Outbound credential vending.
 *
 *     GET /:server_id/credentials/:provider/token
 *
 * Authenticated with the same Bearer token used for /:server_id/mcp. The
 * `aud` claim ties the call to the same MCP server (RFC 8707), so an MCP
 * server can only vend credentials for users that authorized it.
 *
 * For Google, returns a fresh access token, automatically refreshing expired
 * or expiring tokens. For other providers, returns the vaulted credential.
 */
export const credentialsRoutes = new Hono();

credentialsRoutes.use(
  "/:server_id/credentials/:provider/token",
  bearerAuth()
);

credentialsRoutes.get("/:server_id/credentials/:provider/token", async (c) => {
  const auth = c.get("auth");
  const provider = c.req.param("provider");

  if (!provider) {
    return c.json({ error: "invalid_request", error_description: "provider required" }, 400);
  }

  let credential: VaultCredential | null;
  if (provider === "google") {
    try {
      credential = await getFreshGoogleToken(auth.claims.sub);
    } catch (err) {
      const errRes = freshTokenErrorResponse(err, auth.claims.sub);
      if (!errRes) {
        throw err;
      }
      return c.json(errRes.body, errRes.status);
    }
  } else {
    credential = getCredential(auth.claims.sub, provider);
    if (!credential) {
      return c.json(
        {
          error: "credential_not_found",
          error_description: `No vaulted credential for user='${auth.claims.sub}' provider='${provider}'`,
        },
        404
      );
    }
  }

  // expires_in: seconds from now (best-effort; can be null for non-expiring keys).
  let expiresIn: number | null = null;
  if (credential.expires_at) {
    const ms = new Date(credential.expires_at).getTime() - Date.now();
    expiresIn = Math.max(0, Math.floor(ms / 1000));
  }

  logger.info("Vended downstream credential", {
    server_id: auth.serverId,
    user: auth.claims.sub,
    provider,
    expires_in: expiresIn,
  });

  return c.json({
    access_token: credential.access_token,
    token_type: credential.credential_type === "oauth2" ? "Bearer" : "ApiKey",
    expires_in: expiresIn,
    scope: credential.scope,
    provider: credential.provider,
  });
});

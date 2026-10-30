import type { Context } from "hono";
import { Hono } from "hono";
import { recordAudit } from "../audit/audit.js";
import { bearerAuth } from "../gateway/auth-middleware.js";
import { logger } from "../observability/logger.js";
import {
  freshTokenErrorResponse,
  getFreshGoogleToken,
} from "./google.js";
import { getCredential, type VaultCredential } from "./vault.js";

/**
 * Outbound credential vending handler.
 */
export async function handleVendCredential(c: Context): Promise<Response> {
  const t0 = Date.now();
  const auth = c.get("auth");
  const serverId = auth?.serverId ?? c.req.param("server_id");
  const provider = c.req.param("provider");

  const record = (resStatus: number) => {
    recordAudit({
      user_subject: auth?.claims?.sub ?? null,
      client_id: auth?.claims?.client_id ?? null,
      server_id: serverId ?? null,
      kind: "credential_vend",
      tool_name: null,
      args_summary: { provider: provider ?? null },
      outcome: resStatus === 200 ? "ok" : "error",
      status: resStatus,
      duration_ms: Date.now() - t0,
    });
  };

  if (!provider) {
    record(400);
    return c.json({ error: "invalid_request", error_description: "provider required" }, 400);
  }

  let credential: VaultCredential | null;
  if (provider === "google") {
    try {
      credential = await getFreshGoogleToken(auth.claims.sub);
    } catch (err) {
      const errRes = freshTokenErrorResponse(err, auth.claims.sub);
      if (!errRes) {
        record(500);
        throw err;
      }
      record(errRes.status);
      return c.json(errRes.body, errRes.status);
    }
  } else {
    credential = getCredential(auth.claims.sub, provider);
    if (!credential) {
      record(404);
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
    server_id: serverId,
    user: auth.claims.sub,
    provider,
    expires_in: expiresIn,
  });

  record(200);
  return c.json({
    access_token: credential.access_token,
    token_type: credential.credential_type === "oauth2" ? "Bearer" : "ApiKey",
    expires_in: expiresIn,
    scope: credential.scope,
    provider: credential.provider,
  });
}

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

credentialsRoutes.get(
  "/:server_id/credentials/:provider/token",
  handleVendCredential
);

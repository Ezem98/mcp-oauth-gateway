import { Hono } from "hono";
import { getEnv } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { getClient } from "./clients.js";
import {
  consumeAuthCode,
  getAuthCode,
  isExpired as isCodeExpired,
} from "./codes.js";
import { signAccessToken } from "./jwt.js";
import { verifyPkce } from "./pkce.js";
import {
  consumeRefreshToken,
  createRefreshToken,
  getRefreshToken,
  isRefreshExpired,
} from "./refresh.js";

export const tokenRoutes = new Hono();

function err(c: any, code: string, description?: string, status = 400) {
  const body: Record<string, string> = { error: code };
  if (description) body.error_description = description;
  return c.json(body, status);
}

tokenRoutes.post("/token", async (c) => {
  let body: Record<string, string> = {};

  const ct = c.req.header("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    const form = await c.req.formData();
    for (const [k, v] of form.entries()) body[k] = String(v);
  } else if (ct.includes("application/json")) {
    try {
      body = (await c.req.json()) as Record<string, string>;
    } catch {
      return err(c, "invalid_request", "malformed JSON");
    }
  } else {
    // Be lenient — Claude Desktop sends form-encoded but missing content-type is common.
    try {
      const form = await c.req.formData();
      for (const [k, v] of form.entries()) body[k] = String(v);
    } catch {
      try {
        body = (await c.req.json()) as Record<string, string>;
      } catch {
        return err(c, "invalid_request", "unable to parse body");
      }
    }
  }

  const grantType = body.grant_type;
  if (!grantType) return err(c, "invalid_request", "grant_type required");

  if (grantType === "authorization_code") {
    return handleAuthorizationCode(c, body);
  }
  if (grantType === "refresh_token") {
    return handleRefreshToken(c, body);
  }
  return err(c, "unsupported_grant_type");
});

async function handleAuthorizationCode(
  c: any,
  body: Record<string, string>
): Promise<Response> {
  const code = body.code;
  const verifier = body.code_verifier;
  const clientId = body.client_id;
  const redirectUri = body.redirect_uri;

  if (!code || !verifier || !clientId || !redirectUri) {
    return err(c, "invalid_request", "missing required parameter");
  }

  const client = getClient(clientId);
  if (!client) return err(c, "invalid_client");

  const record = getAuthCode(code);
  if (!record) return err(c, "invalid_grant", "code not found");
  if (record.consumed) return err(c, "invalid_grant", "code already used");
  if (isCodeExpired(record)) return err(c, "invalid_grant", "code expired");
  if (record.client_id !== clientId) return err(c, "invalid_grant", "client mismatch");
  if (record.redirect_uri !== redirectUri) {
    return err(c, "invalid_grant", "redirect_uri mismatch");
  }

  if (!verifyPkce(verifier, record.code_challenge, record.code_challenge_method)) {
    return err(c, "invalid_grant", "PKCE verification failed");
  }

  consumeAuthCode(code);

  const issuer = getEnv().PUBLIC_URL;
  const { token, expiresIn } = await signAccessToken({
    issuer,
    subject: record.user_subject,
    audience: record.resource,
    clientId,
    scope: record.scope ?? "",
  });

  const { token: refreshToken } = createRefreshToken({
    client_id: clientId,
    user_subject: record.user_subject,
    resource: record.resource,
    scope: record.scope,
  });

  logger.info("Issued access token (auth_code)", {
    client_id: clientId,
    sub: record.user_subject,
    resource: record.resource,
    expires_in: expiresIn,
  });

  return c.json({
    access_token: token,
    token_type: "Bearer",
    expires_in: expiresIn,
    refresh_token: refreshToken,
    scope: record.scope ?? "",
  });
}

async function handleRefreshToken(
  c: any,
  body: Record<string, string>
): Promise<Response> {
  const refresh = body.refresh_token;
  const clientId = body.client_id;

  if (!refresh || !clientId) {
    return err(c, "invalid_request", "missing required parameter");
  }

  const client = getClient(clientId);
  if (!client) return err(c, "invalid_client");

  const record = getRefreshToken(refresh);
  if (!record) return err(c, "invalid_grant", "refresh token not found");
  if (record.consumed) return err(c, "invalid_grant", "refresh token reused");
  if (isRefreshExpired(record)) return err(c, "invalid_grant", "refresh token expired");
  if (record.client_id !== clientId) {
    return err(c, "invalid_grant", "client mismatch");
  }

  consumeRefreshToken(refresh);

  const issuer = getEnv().PUBLIC_URL;
  const { token, expiresIn } = await signAccessToken({
    issuer,
    subject: record.user_subject,
    audience: record.resource,
    clientId,
    scope: record.scope ?? "",
  });

  // Rotate: issue a fresh refresh token
  const { token: newRefresh } = createRefreshToken({
    client_id: clientId,
    user_subject: record.user_subject,
    resource: record.resource,
    scope: record.scope,
  });

  logger.info("Issued access token (refresh)", {
    client_id: clientId,
    sub: record.user_subject,
    resource: record.resource,
  });

  return c.json({
    access_token: token,
    token_type: "Bearer",
    expires_in: expiresIn,
    refresh_token: newRefresh,
    scope: record.scope ?? "",
  });
}

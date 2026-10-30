import { Hono } from "hono";
import { recordAudit } from "../audit/audit.js";
import { logger } from "../observability/logger.js";
import { isValidAdminToken } from "./admin-token.js";
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  getGoogleConfig,
  GOOGLE_SCOPES,
  GoogleExchangeError,
} from "./google.js";
import { consumeOutboundState, createOutboundState } from "./states.js";
import { getCredential, upsertCredential } from "./vault.js";

/**
 * Escape HTML characters to prevent XSS when rendering user or error data.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const connectRoutes = new Hono();

/**
 * Initiate an outbound OAuth flow to connect a user's Google account.
 * Creates a PKCE state token and redirects to Google.
 */
connectRoutes.get("/connect/google", (c) => {
  const cfg = getGoogleConfig();
  if (!cfg) {
    return c.json({ error: "google_not_configured" }, 503);
  }

  const admin = c.req.query("admin");
  if (!admin || !isValidAdminToken(admin)) {
    return c.json(
      {
        error: "unauthorized",
        error_description: "valid admin token required",
      },
      401
    );
  }

  const user = c.req.query("user");
  if (!user || user.trim() === "") {
    return c.json(
      {
        error: "invalid_request",
        error_description: "user query parameter is required",
      },
      400
    );
  }

  const { state, codeChallenge } = createOutboundState(user.trim(), "google");
  const authUrl = buildGoogleAuthUrl(cfg, state, codeChallenge);
  return c.redirect(authUrl, 302);
});

/**
 * OAuth redirect callback from Google. Validates state, exchanges the authorization code,
 * preserves existing refresh tokens if not returned, and saves tokens to the vault.
 */
connectRoutes.get("/connect/google/callback", async (c) => {
  const cfg = getGoogleConfig();
  if (!cfg) {
    return c.json({ error: "google_not_configured" }, 503);
  }

  const errorParam = c.req.query("error");
  if (errorParam) {
    return c.html(
      `<!DOCTYPE html><html><body><h1>Error de autenticación</h1><p>${escapeHtml(errorParam)}</p></body></html>`,
      400
    );
  }

  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) {
    return c.html(
      `<!DOCTYPE html><html><body><h1>Error</h1><p>Missing code or state parameter</p></body></html>`,
      400
    );
  }

  const consumed = consumeOutboundState(state, "google");
  if (!consumed) {
    return c.html(
      `<!DOCTYPE html><html><body><h1>Error</h1><p>invalid or expired state</p></body></html>`,
      400
    );
  }

  let tokenResponse;
  try {
    tokenResponse = await exchangeGoogleCode(
      cfg,
      code,
      consumed.code_verifier
    );
  } catch (err) {
    const status =
      err instanceof GoogleExchangeError ? err.status : "unknown";
    logger.error("Failed to exchange Google code", { status });
    return c.html(
      `<!DOCTYPE html><html><body><h1>Error de conexión</h1><p>No se pudo conectar con el proveedor de autenticación.</p></body></html>`,
      502
    );
  }

  // Preserve previously stored refresh_token if Google did not send a new one
  let refreshToken: string | null = tokenResponse.refresh_token ?? null;
  if (!refreshToken) {
    const existing = getCredential(consumed.user_subject, "google");
    if (existing?.refresh_token) {
      refreshToken = existing.refresh_token;
    }
  }

  const grantedScopes = tokenResponse.scope
    ? tokenResponse.scope.split(" ").filter(Boolean)
    : [];
  const missingScopes = GOOGLE_SCOPES.filter((s) => !grantedScopes.includes(s));

  const expiresAt = new Date(
    Date.now() + tokenResponse.expires_in * 1000
  ).toISOString();
  const connectedAt = new Date().toISOString();

  upsertCredential({
    user_subject: consumed.user_subject,
    provider: "google",
    credential_type: "oauth2",
    access_token: tokenResponse.access_token,
    refresh_token: refreshToken,
    scope: tokenResponse.scope,
    expires_at: expiresAt,
    metadata: {
      // Replaces metadata wholesale, clearing needs_reconnect if previously set
      token_type: tokenResponse.token_type,
      granted_scopes: grantedScopes,
      connected_at: connectedAt,
    },
  });

  recordAudit({
    user_subject: consumed.user_subject,
    client_id: null,
    server_id: null,
    kind: "connect",
    tool_name: null,
    args_summary: {
      provider: "google",
      granted_scopes: grantedScopes.length,
      missing_scopes: missingScopes.length,
    },
    outcome: "ok",
    status: 200,
  });

  logger.info("Connected Google account", {
    user: consumed.user_subject,
    provider: "google",
    granted_scopes_count: grantedScopes.length,
    missing_scopes: missingScopes,
  });

  const escapedUser = escapeHtml(consumed.user_subject);
  const grantedItems = grantedScopes
    .map((s) => `<li>${escapeHtml(s)}</li>`)
    .join("");
  const warningHtml =
    missingScopes.length > 0
      ? `<p><strong>Advertencia:</strong> Faltan los siguientes permisos solicitados:</p><ul>${missingScopes
          .map((s) => `<li>${escapeHtml(s)}</li>`)
          .join("")}</ul>`
      : "";

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Cuenta de Google conectada</title>
</head>
<body>
  <h1>Cuenta de Google conectada</h1>
  <p>Usuario: ${escapedUser}</p>
  <h3>Permisos otorgados (${grantedScopes.length}):</h3>
  <ul>${grantedItems}</ul>
  ${warningHtml}
</body>
</html>`;

  return c.html(html, 200);
});

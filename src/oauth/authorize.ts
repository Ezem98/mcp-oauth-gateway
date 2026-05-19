import { Hono } from "hono";
import { logger } from "../observability/logger.js";
import { getClient } from "./clients.js";
import { createAuthCode } from "./codes.js";
import { getIdentityProvider } from "./identity.js";
import {
  listServers,
  resolveResourceToServer,
  resourceUriFor,
} from "./servers.js";
import {
  DEFAULT_SCOPE_STRING,
  filterToValidScopes,
  parseScopeString,
} from "./scopes.js";

export const authorizeRoutes = new Hono();

interface AuthorizeParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope?: string;
  state?: string;
  resource?: string;
}

function parseAuthorizeParams(
  q: Record<string, string | undefined>
): { ok: true; params: AuthorizeParams } | { ok: false; error: string } {
  for (const k of [
    "response_type",
    "client_id",
    "redirect_uri",
    "code_challenge",
    "code_challenge_method",
  ] as const) {
    if (!q[k]) return { ok: false, error: `missing ${k}` };
  }
  if (q.response_type !== "code")
    return { ok: false, error: "unsupported response_type" };
  if (q.code_challenge_method !== "S256")
    return { ok: false, error: "only S256 PKCE supported" };

  return {
    ok: true,
    params: {
      response_type: q.response_type!,
      client_id: q.client_id!,
      redirect_uri: q.redirect_uri!,
      code_challenge: q.code_challenge!,
      code_challenge_method: q.code_challenge_method!,
      scope: q.scope,
      state: q.state,
      resource: q.resource,
    },
  };
}

/**
 * Render the demo consent screen. Intentionally plain — its job is to make
 * the consent step visible, not pretty.
 */
function renderConsentHtml(opts: {
  params: AuthorizeParams;
  clientName: string | null | undefined;
  userEmail: string;
  resourceLabel: string;
  scopes: string[];
}): string {
  const hidden = (k: string, v: string | undefined) =>
    v == null
      ? ""
      : `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Authorize ${escapeHtml(
    opts.clientName ?? opts.params.client_id
  )}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1rem; }
  h1 { font-size: 1.25rem; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 1.25rem; }
  .row { margin: 0.75rem 0; font-size: 0.9rem; color: #555; }
  .scopes { background: #f6f8fa; padding: 0.5rem 0.75rem; border-radius: 6px; font-family: ui-monospace, monospace; font-size: 0.85rem; }
  .actions { margin-top: 1.5rem; display: flex; gap: 0.5rem; }
  button { padding: 0.5rem 1rem; border-radius: 6px; border: 1px solid #ccc; cursor: pointer; font-size: 0.95rem; }
  button.approve { background: #2563eb; color: white; border-color: #2563eb; }
  button.deny { background: white; }
  .note { color: #999; font-size: 0.8rem; margin-top: 1rem; }
</style></head>
<body>
  <h1>Authorize access</h1>
  <div class="card">
    <div class="row"><strong>${escapeHtml(
      opts.clientName ?? opts.params.client_id
    )}</strong> wants to access an MCP server on your behalf.</div>
    <div class="row">Signed in as: <strong>${escapeHtml(opts.userEmail)}</strong></div>
    <div class="row">Resource: <code>${escapeHtml(opts.resourceLabel)}</code></div>
    <div class="row">Requested scopes:</div>
    <div class="scopes">${opts.scopes.map(escapeHtml).join(" ")}</div>
    <form method="post" action="/authorize" class="actions">
      ${hidden("response_type", opts.params.response_type)}
      ${hidden("client_id", opts.params.client_id)}
      ${hidden("redirect_uri", opts.params.redirect_uri)}
      ${hidden("code_challenge", opts.params.code_challenge)}
      ${hidden("code_challenge_method", opts.params.code_challenge_method)}
      ${hidden("scope", opts.scopes.join(" "))}
      ${hidden("state", opts.params.state)}
      ${hidden("resource", opts.params.resource)}
      <button type="submit" name="decision" value="deny" class="deny">Deny</button>
      <button type="submit" name="decision" value="approve" class="approve">Approve</button>
    </form>
    <div class="note">Demo identity provider — production deployments swap in Google / GitHub / Workforce IdP.</div>
  </div>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildRedirect(
  baseUri: string,
  params: Record<string, string | undefined>
): string {
  const u = new URL(baseUri);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) u.searchParams.set(k, v);
  }
  return u.toString();
}

authorizeRoutes.get("/authorize", async (c) => {
  const q = c.req.query();
  const parsed = parseAuthorizeParams(q);
  if (!parsed.ok) {
    return c.json({ error: "invalid_request", error_description: parsed.error }, 400);
  }
  const params = parsed.params;

  const client = getClient(params.client_id);
  if (!client) {
    return c.json({ error: "invalid_client" }, 400);
  }

  if (!client.redirect_uris.includes(params.redirect_uri)) {
    return c.json(
      { error: "invalid_request", error_description: "redirect_uri not registered" },
      400
    );
  }

  // Resolve the resource (MCP server) the client is asking about.
  let resourceUri = params.resource;
  let serverId: string;
  if (resourceUri) {
    const server = resolveResourceToServer(resourceUri);
    if (!server) {
      return c.json(
        { error: "invalid_target", error_description: "unknown resource" },
        400
      );
    }
    serverId = server.server_id;
  } else {
    // Loose default: if only one MCP server is configured, fall back to it.
    const servers = listServers();
    if (servers.length !== 1) {
      return c.json(
        {
          error: "invalid_target",
          error_description: "resource parameter required when multiple servers exist",
        },
        400
      );
    }
    serverId = servers[0].server_id;
    resourceUri = resourceUriFor(serverId);
  }

  const requestedScopes = parseScopeString(params.scope ?? DEFAULT_SCOPE_STRING);
  const grantedScopes = filterToValidScopes(requestedScopes);
  if (grantedScopes.length === 0) {
    return c.json(
      { error: "invalid_scope", error_description: "no valid scopes requested" },
      400
    );
  }

  const user = await getIdentityProvider().resolveUser();

  return c.html(
    renderConsentHtml({
      params: { ...params, resource: resourceUri, scope: grantedScopes.join(" ") },
      clientName: client.client_name,
      userEmail: user.email ?? user.subject,
      resourceLabel: `${serverId} (${resourceUri})`,
      scopes: grantedScopes,
    })
  );
});

authorizeRoutes.post("/authorize", async (c) => {
  const form = await c.req.formData();
  const decision = String(form.get("decision") ?? "");
  const q: Record<string, string | undefined> = {};
  for (const k of [
    "response_type",
    "client_id",
    "redirect_uri",
    "code_challenge",
    "code_challenge_method",
    "scope",
    "state",
    "resource",
  ]) {
    const v = form.get(k);
    q[k] = v == null ? undefined : String(v);
  }

  const parsed = parseAuthorizeParams(q);
  if (!parsed.ok) {
    return c.json({ error: "invalid_request", error_description: parsed.error }, 400);
  }
  const params = parsed.params;

  const client = getClient(params.client_id);
  if (!client || !client.redirect_uris.includes(params.redirect_uri)) {
    return c.json({ error: "invalid_client" }, 400);
  }

  if (decision !== "approve") {
    return c.redirect(
      buildRedirect(params.redirect_uri, {
        error: "access_denied",
        state: params.state,
      })
    );
  }

  if (!params.resource) {
    return c.json({ error: "invalid_target" }, 400);
  }

  const user = await getIdentityProvider().resolveUser();
  const scopeStr = parseScopeString(params.scope).join(" ");

  const { code } = createAuthCode({
    client_id: params.client_id,
    user_subject: user.subject,
    redirect_uri: params.redirect_uri,
    scope: scopeStr || null,
    code_challenge: params.code_challenge,
    code_challenge_method: params.code_challenge_method,
    resource: params.resource,
  });

  logger.info("Issued authorization code", {
    client_id: params.client_id,
    user: user.subject,
    resource: params.resource,
    scope: scopeStr,
  });

  return c.redirect(
    buildRedirect(params.redirect_uri, { code, state: params.state })
  );
});

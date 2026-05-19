import type { Context } from "hono";
import { getEnv } from "../config/env.js";
import { getServer } from "../oauth/servers.js";
import { logger } from "../observability/logger.js";

/**
 * Headers that must NOT be proxied upstream:
 *  - Authorization: replaced by upstream's service credential (or stripped)
 *  - Host: rewritten by fetch automatically
 *  - hop-by-hop headers per RFC 7230 §6.1
 *  - X-Forwarded-* originals (we set our own)
 */
const SKIP_REQUEST_HEADERS = new Set([
  "authorization",
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "content-length", // recomputed by fetch
]);

const SKIP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
]);

/**
 * Forward an MCP request to the upstream server.
 *
 * Stream-aware: the upstream may respond with `text/event-stream` for
 * Streamable HTTP SSE. We return the upstream Response's ReadableStream
 * directly so chunks pass through without buffering.
 *
 * Method passthrough: MCP Streamable HTTP uses POST for client→server,
 * GET to open a server→client SSE stream, and DELETE to close a session.
 */
export async function forwardToUpstream(c: Context): Promise<Response> {
  const auth = c.get("auth");
  const serverId = auth.serverId;
  const server = getServer(serverId);
  if (!server) {
    return c.json({ error: "server_not_found" }, 404);
  }

  const upstreamUrl = server.upstream_url;
  const method = c.req.method;

  // Build upstream headers — strip hop-by-hop + our auth, preserve MCP session.
  const outgoing = new Headers();
  for (const [key, value] of Object.entries(c.req.header())) {
    const lower = key.toLowerCase();
    if (SKIP_REQUEST_HEADERS.has(lower)) continue;
    if (lower.startsWith("x-forwarded-")) continue;
    if (typeof value === "string") outgoing.set(key, value);
  }

  // Apply upstream's service credential if configured.
  if (server.upstream_auth_header) {
    const idx = server.upstream_auth_header.indexOf(":");
    if (idx > 0) {
      const name = server.upstream_auth_header.slice(0, idx).trim();
      const val = server.upstream_auth_header.slice(idx + 1).trim();
      outgoing.set(name, val);
    }
  }

  // Identify the authenticated principal to the upstream so it can implement
  // per-user state without re-doing auth. The MCP spec doesn't define this
  // header; gateways and proxies typically use `X-Forwarded-*` family.
  outgoing.set("X-Forwarded-User", auth.claims.sub);
  outgoing.set("X-Forwarded-Client", auth.claims.client_id);
  outgoing.set("X-Forwarded-Host", new URL(c.req.url).host);

  // Pass the user's access token to the upstream so it can call back into the
  // gateway's outbound credential endpoint (`/:server_id/credentials/:provider/token`)
  // on the user's behalf. The token is already scoped to this same MCP server
  // by its `aud` claim, so the upstream cannot use it against other servers.
  //
  // Phase 1.5 swap: replace this with an explicit RFC 8693 token-exchange step
  // so the upstream gets a downscoped token rather than the user's full one.
  const incomingAuth = c.req.header("authorization") ?? "";
  if (incomingAuth.toLowerCase().startsWith("bearer ")) {
    const userToken = incomingAuth.slice("bearer ".length).trim();
    outgoing.set("X-Gateway-User-Token", userToken);
  }
  outgoing.set("X-Gateway-Url", getEnv().PUBLIC_URL);
  outgoing.set("X-Gateway-Server-Id", serverId);

  // Body passthrough for methods that may carry one.
  let body: BodyInit | undefined;
  if (method !== "GET" && method !== "HEAD" && method !== "DELETE") {
    // c.req.raw.body is a ReadableStream; pipe it directly.
    body = c.req.raw.body ?? undefined;
  }

  const t0 = Date.now();
  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method,
      headers: outgoing,
      body,
      // @ts-expect-error — Node fetch supports `duplex: half` for streamed bodies
      duplex: body ? "half" : undefined,
      redirect: "manual",
    });
  } catch (err) {
    logger.error("Upstream fetch failed", {
      server_id: serverId,
      upstream: upstreamUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "bad_gateway", error_description: "upstream unreachable" }, 502);
  }

  // Mirror response headers, skipping hop-by-hop.
  const respHeaders = new Headers();
  upstreamRes.headers.forEach((value, key) => {
    if (SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) return;
    respHeaders.set(key, value);
  });

  const contentType = upstreamRes.headers.get("content-type") ?? "";
  logger.info("Proxied MCP request", {
    server_id: serverId,
    method,
    upstream_status: upstreamRes.status,
    content_type: contentType,
    elapsed_ms: Date.now() - t0,
    sub: auth.claims.sub,
    client_id: auth.claims.client_id,
  });

  // Stream the body through. For SSE this is critical — buffering would defeat
  // server-pushed events.
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: respHeaders,
  });
}

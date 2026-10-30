import type { Context } from "hono";
import { recordAudit, summarizeArgs } from "../audit/audit.js";
import { getEnv } from "../config/env.js";
import { getServer } from "../oauth/servers.js";
import { logger } from "../observability/logger.js";
import { getToolDecision } from "../policies/policies.js";
import {
  createSseFilter,
  filterJsonBody,
  findEventBoundary,
  mergeBlockedJson,
  parseSseEventData,
  planRequest,
  type ForwardedToolCall,
  type RequestPlan,
} from "./policy-filter.js";

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
 * directly so chunks pass through without buffering unless filtering is required.
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

  let body: BodyInit | undefined;
  let isBatch = false;
  let plan: RequestPlan | null = null;
  const decide = (tool: string) => getToolDecision(serverId, tool);

  if (method === "POST") {
    let rawBody: string;
    try {
      rawBody = await c.req.text();
    } catch {
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        },
        400
      );
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        },
        400
      );
    }

    if (typeof parsedBody !== "object" || parsedBody === null) {
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        },
        400
      );
    }

    isBatch = Array.isArray(parsedBody);
    plan = planRequest(parsedBody, decide);

    // Policy enforcement: denied tools/call never reach the upstream. Log the
    // tool name only — never arguments or tokens.
    for (const blocked of plan.blockedCalls) {
      logger.info("Blocked tool call by policy", {
        server_id: serverId,
        tool: blocked.tool,
        sub: auth.claims.sub,
      });
      recordAudit({
        user_subject: auth.claims.sub,
        client_id: auth.claims.client_id,
        server_id: serverId,
        kind: "policy_block",
        tool_name: blocked.tool,
        args_summary: summarizeArgs(blocked.tool, blocked.args),
        outcome: "blocked",
        status: null,
        duration_ms: 0,
      });
    }

    // Nothing left to forward: answer the blocked calls ourselves.
    if (plan.forwardBody === null) {
      if (!isBatch) {
        if (plan.blockedResponses.length > 0) {
          return c.json(plan.blockedResponses[0], 200);
        }
        return new Response(null, { status: 202 });
      } else {
        if (plan.blockedResponses.length > 0) {
          return c.json(plan.blockedResponses, 200);
        }
        return new Response(null, { status: 202 });
      }
    }

    body = JSON.stringify(plan.forwardBody);
    outgoing.set("content-type", "application/json");
  } else if (method !== "GET" && method !== "HEAD" && method !== "DELETE") {
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
      duplex: body instanceof ReadableStream ? "half" : undefined,
      redirect: "manual",
    });
  } catch (err) {
    logger.error("Upstream fetch failed", {
      server_id: serverId,
      upstream: upstreamUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    if (plan && plan.forwardedCalls.length > 0) {
      const duration = Date.now() - t0;
      for (const call of plan.forwardedCalls) {
        recordAudit({
          user_subject: auth.claims.sub,
          client_id: auth.claims.client_id,
          server_id: serverId,
          kind: "tool_call",
          tool_name: call.tool,
          args_summary: summarizeArgs(call.tool, call.args),
          outcome: "error",
          status: 502,
          duration_ms: duration,
        });
      }
    }
    return c.json(
      { error: "bad_gateway", error_description: "upstream unreachable" },
      502
    );
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

  if (method === "POST" && plan) {
    const auditResponse = (res: Response): Response => {
      return wrapResponseWithAudit(
        res,
        plan.forwardedCalls,
        {
          sub: auth.claims.sub,
          client_id: auth.claims.client_id,
          serverId,
        },
        t0,
        upstreamRes.status
      );
    };

    // Nothing to filter or merge: stream straight through (keeps SSE live).
    if (plan.toolsListIds.size === 0 && plan.blockedResponses.length === 0) {
      return auditResponse(
        new Response(upstreamRes.body, {
          status: upstreamRes.status,
          statusText: upstreamRes.statusText,
          headers: respHeaders,
        })
      );
    }

    // A batch whose forwarded part was only notifications gets an empty 202
    // from the upstream; the blocked calls still need their error responses.
    if (
      plan.blockedResponses.length > 0 &&
      !contentType.toLowerCase().includes("application/json") &&
      !contentType.toLowerCase().includes("text/event-stream")
    ) {
      await upstreamRes.body?.cancel();
      return auditResponse(c.json(plan.blockedResponses, 200));
    }

    if (contentType.toLowerCase().includes("application/json")) {
      const text = await upstreamRes.text();
      const filteredText = filterJsonBody(text, plan.toolsListIds, decide);
      const mergedText = mergeBlockedJson(
        filteredText,
        plan.blockedResponses,
        isBatch
      );

      respHeaders.delete("content-length");
      respHeaders.delete("content-encoding");

      return auditResponse(
        new Response(mergedText, {
          status: upstreamRes.status,
          statusText: upstreamRes.statusText,
          headers: respHeaders,
        })
      );
    }

    if (contentType.toLowerCase().includes("text/event-stream")) {
      respHeaders.delete("content-length");

      if (upstreamRes.body) {
        const sseFilter = createSseFilter(
          plan.toolsListIds,
          decide,
          plan.blockedResponses
        );
        const filteredStream = upstreamRes.body.pipeThrough(sseFilter);

        return auditResponse(
          new Response(filteredStream, {
            status: upstreamRes.status,
            statusText: upstreamRes.statusText,
            headers: respHeaders,
          })
        );
      }

      return auditResponse(
        new Response(null, {
          status: upstreamRes.status,
          statusText: upstreamRes.statusText,
          headers: respHeaders,
        })
      );
    }

    return auditResponse(
      new Response(upstreamRes.body, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: respHeaders,
      })
    );
  }

  // Stream the body through. For SSE this is critical — buffering would defeat
  // server-pushed events.
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: respHeaders,
  });
}

function wrapResponseWithAudit(
  response: Response,
  forwardedCalls: ForwardedToolCall[],
  auth: { sub: string; client_id: string; serverId: string },
  t0: number,
  upstreamStatus: number
): Response {
  if (forwardedCalls.length === 0) {
    return response;
  }

  if (!response.body) {
    const duration = Date.now() - t0;
    for (const call of forwardedCalls) {
      recordAudit({
        user_subject: auth.sub,
        client_id: auth.client_id,
        server_id: auth.serverId,
        kind: "tool_call",
        tool_name: call.tool,
        args_summary: summarizeArgs(call.tool, call.args),
        outcome: "error",
        status: upstreamStatus,
        duration_ms: duration,
      });
    }
    return response;
  }

  const [clientStream, auditStream] = response.body.tee();
  const contentType = response.headers.get("content-type") ?? "";

  consumeAuditStream(
    auditStream,
    contentType,
    forwardedCalls,
    auth,
    t0,
    upstreamStatus
  );

  return new Response(clientStream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function consumeAuditStream(
  auditStream: ReadableStream<Uint8Array>,
  contentType: string,
  forwardedCalls: ForwardedToolCall[],
  auth: { sub: string; client_id: string; serverId: string },
  t0: number,
  upstreamStatus: number
): void {
  (async () => {
    const pending = new Map<string | number, ForwardedToolCall>();
    const unkeyed: ForwardedToolCall[] = [];

    for (const call of forwardedCalls) {
      if (call.id !== undefined && call.id !== null) {
        pending.set(call.id, call);
      } else {
        unkeyed.push(call);
      }
    }

    const recordCall = (
      call: ForwardedToolCall,
      resp?: { result?: unknown; error?: unknown }
    ) => {
      const duration_ms = Date.now() - t0;
      let outcome: "ok" | "error" = "ok";
      if (upstreamStatus < 200 || upstreamStatus >= 300) {
        outcome = "error";
      } else if (!resp) {
        outcome = "error";
      } else if (resp.error !== undefined && resp.error !== null) {
        outcome = "error";
      } else if (
        typeof resp.result === "object" &&
        resp.result !== null &&
        (resp.result as Record<string, unknown>).isError === true
      ) {
        outcome = "error";
      }

      recordAudit({
        user_subject: auth.sub,
        client_id: auth.client_id,
        server_id: auth.serverId,
        kind: "tool_call",
        tool_name: call.tool,
        args_summary: summarizeArgs(call.tool, call.args),
        outcome,
        status: upstreamStatus,
        duration_ms,
      });
    };

    const processMessage = (msg: unknown) => {
      if (typeof msg !== "object" || msg === null) return;
      if (Array.isArray(msg)) {
        for (const item of msg) {
          processMessage(item);
        }
        return;
      }
      const record = msg as Record<string, unknown>;
      const id = record.id;
      if (id !== undefined && id !== null) {
        let matchedKey: string | number | undefined;
        let matchedCall = pending.get(id as string | number);
        if (matchedCall) {
          matchedKey = id as string | number;
        } else {
          for (const [key, call] of pending.entries()) {
            if (String(key) === String(id)) {
              matchedCall = call;
              matchedKey = key;
              break;
            }
          }
        }

        if (matchedCall && matchedKey !== undefined) {
          pending.delete(matchedKey);
          recordCall(matchedCall, record as { result?: unknown; error?: unknown });
        }
      }
    };

    const isSse = contentType.toLowerCase().includes("text/event-stream");
    const reader = auditStream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      if (isSse) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          while (true) {
            const boundary = findEventBoundary(buffer);
            if (!boundary) break;
            const rawEvent = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary.length);

            const parsed = parseSseEventData(rawEvent);
            if (parsed !== null) {
              processMessage(parsed);
            }
          }

          if (pending.size === 0 && unkeyed.length === 0) {
            await reader.cancel().catch(() => {});
            return;
          }
        }

        buffer += decoder.decode();
        while (true) {
          const boundary = findEventBoundary(buffer);
          if (!boundary) break;
          const rawEvent = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          const parsed = parseSseEventData(rawEvent);
          if (parsed !== null) {
            processMessage(parsed);
          }
        }
        if (buffer.trim().length > 0) {
          const parsed = parseSseEventData(buffer);
          if (parsed !== null) {
            processMessage(parsed);
          }
        }
      } else {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
        }
        buffer += decoder.decode();

        try {
          const parsed = JSON.parse(buffer);
          processMessage(parsed);
        } catch {
          // not valid JSON
        }
      }
    } catch {
      logger.warn("Failed to process audit stream");
    } finally {
      // Record any remaining calls that didn't get a matching response
      for (const call of pending.values()) {
        recordCall(call, undefined);
      }
      for (const call of unkeyed) {
        recordCall(call, undefined);
      }
    }
  })().catch(() => {
    logger.warn("Failed to process audit stream");
  });
}

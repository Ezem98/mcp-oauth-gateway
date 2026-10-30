import { serve } from "@hono/node-server";
import { Hono } from "hono";

const PORT = Number(process.env.MOCK_UPSTREAM_PORT ?? 5001);

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "mock-upstream", version: "0.0.1" };

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface CallContext {
  userToken: string;
  gatewayUrl: string;
  serverId: string;
  forwardedUser: string;
}

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function err(
  id: JsonRpcRequest["id"],
  code: number,
  message: string
): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function fetchDownstreamToken(
  ctx: CallContext,
  provider: string
): Promise<{
  access_token: string;
  token_type: string;
  expires_in: number | null;
  scope: string | null;
}> {
  const url = `${ctx.gatewayUrl}/${ctx.serverId}/credentials/${provider}/token`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${ctx.userToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `credential vending failed: status=${res.status} body=${body.slice(0, 200)}`
    );
  }
  return (await res.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number | null;
    scope: string | null;
  };
}

async function handle(
  req: JsonRpcRequest,
  ctx: CallContext
): Promise<JsonRpcResponse> {
  switch (req.method) {
    case "initialize":
      return ok(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      });

    case "tools/list":
      return ok(req.id, {
        tools: [
          {
            name: "echo",
            description: "Echo back the input text.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
          {
            name: "whoami",
            description: "Return the authenticated user as seen by the upstream.",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "send_gmail_via_gateway",
            description:
              "Send an email via Gmail. The upstream has NO OAuth code; it asks the gateway for a token.",
            inputSchema: {
              type: "object",
              properties: {
                to: { type: "string" },
                subject: { type: "string" },
                body: { type: "string" },
              },
              required: ["to", "subject", "body"],
            },
          },
        ],
      });

    case "tools/call": {
      const params = (req.params ?? {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      if (params.name === "echo") {
        const text = String(params.arguments?.text ?? "");
        return ok(req.id, { content: [{ type: "text", text: `echo: ${text}` }] });
      }
      if (params.name === "whoami") {
        return ok(req.id, {
          content: [
            {
              type: "text",
              text: `Upstream sees user: ${ctx.forwardedUser || "(no X-Forwarded-User)"}`,
            },
          ],
        });
      }
      if (params.name === "send_gmail_via_gateway") {
        if (!ctx.userToken || !ctx.gatewayUrl || !ctx.serverId) {
          return err(
            req.id,
            -32000,
            "gateway headers missing — is this server behind the mcp-oauth-gateway?"
          );
        }
        try {
          const cred = await fetchDownstreamToken(ctx, "google");
          const to = String(params.arguments?.to ?? "");
          const subject = String(params.arguments?.subject ?? "");
          const body = String(params.arguments?.body ?? "");
          // We do NOT actually call Gmail in the spike — we only confirm we
          // have a usable token. Phase 1.5 wires the real send.
          return ok(req.id, {
            content: [
              {
                type: "text",
                text:
                  `[mock] Got Google token (scope=${cred.scope}). ` +
                  `Would send email: to='${to}' subject='${subject}' body='${body.slice(0, 60)}…'. ` +
                  `Upstream code did NOT implement OAuth — gateway vended the credential.`,
              },
            ],
          });
        } catch (e) {
          return err(req.id, -32001, e instanceof Error ? e.message : String(e));
        }
      }
      return err(req.id, -32601, `Unknown tool: ${params.name}`);
    }

    case "ping":
      return ok(req.id, {});

    default:
      return err(req.id, -32601, `Method not found: ${req.method}`);
  }
}

function ctxFromHeaders(c: any): CallContext {
  return {
    userToken: c.req.header("x-gateway-user-token") ?? "",
    gatewayUrl: c.req.header("x-gateway-url") ?? "",
    serverId: c.req.header("x-gateway-server-id") ?? "",
    forwardedUser: c.req.header("x-forwarded-user") ?? "",
  };
}

const app = new Hono();

app.get("/mcp", (c) => {
  c.header("content-type", "text/event-stream");
  return c.body(": mock upstream sse open\n\n");
});

app.post("/mcp", async (c) => {
  const ctx = ctxFromHeaders(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(err(null, -32700, "Parse error"), 400);
  }

  if (Array.isArray(body)) {
    const responses = await Promise.all(
      (body as JsonRpcRequest[]).map((r) => handle(r, ctx))
    );
    return c.json(responses);
  }
  return c.json(await handle(body as JsonRpcRequest, ctx));
});

app.delete("/mcp", (c) => c.body(null, 204));
app.get("/health", (c) => c.json({ status: "ok", role: "mock-upstream" }));

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`mock upstream MCP listening on http://localhost:${PORT}/mcp`);
});

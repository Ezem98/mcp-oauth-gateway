import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { type GoogleMcpConfig, SHARED_SECRET_HEADER } from "./config.js";
import { callTool, TOOL_DEFINITIONS } from "./tools.js";

function isAuthorized(
  headerValue: string | undefined,
  expectedSecret: string
): boolean {
  if (!headerValue || typeof headerValue !== "string") {
    return false;
  }
  const candidateDigest = createHash("sha256").update(headerValue).digest();
  const expectedDigest = createHash("sha256").update(expectedSecret).digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

function logAction(data: {
  method: string;
  tool?: string;
  durationMs: number;
  isError: boolean;
}): void {
  const toolStr = data.tool ? ` tool=${data.tool}` : "";
  console.log(
    `[google-mcp] method=${data.method}${toolStr} duration=${data.durationMs}ms isError=${data.isError}`
  );
}

export function createGoogleMcpApp(cfg: GoogleMcpConfig): Hono {
  const app = new Hono();

  // GET /mcp -> 405 Method Not Allowed
  app.get("/mcp", (c) => {
    return c.json({ error: "Method Not Allowed" }, 405);
  });

  app.post("/mcp", async (c) => {
    // 1. Authenticate with shared secret in constant time
    const secretHeader = c.req.header(SHARED_SECRET_HEADER);
    if (!isAuthorized(secretHeader, cfg.sharedSecret)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    // 2. Parse JSON-RPC 2.0 body
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: "Parse error",
          },
        },
        400
      );
    }

    // Body must be a single JSON-RPC 2.0 object (arrays -> error -32600)
    if (Array.isArray(body)) {
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32600,
            message: "Batch requests are not supported",
          },
        },
        400
      );
    }

    if (
      !body ||
      typeof body !== "object" ||
      (body as Record<string, unknown>).jsonrpc !== "2.0" ||
      typeof (body as Record<string, unknown>).method !== "string"
    ) {
      return c.json(
        {
          jsonrpc: "2.0",
          id: (body as Record<string, unknown>)?.id ?? null,
          error: {
            code: -32600,
            message: "Invalid Request",
          },
        },
        400
      );
    }

    const req = body as {
      jsonrpc: "2.0";
      id?: number | string;
      method: string;
      params?: Record<string, unknown>;
    };

    const t0 = Date.now();

    // Messages without id are notifications -> 202 with empty body
    if (!("id" in req) || req.id === undefined) {
      const durationMs = Date.now() - t0;
      logAction({ method: req.method, durationMs, isError: false });
      return c.body(null, 202);
    }

    // Dispatch JSON-RPC methods
    switch (req.method) {
      case "initialize": {
        const durationMs = Date.now() - t0;
        logAction({ method: req.method, durationMs, isError: false });
        return c.json({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            protocolVersion: "2025-06-18",
            serverInfo: { name: "google-mcp", version: "0.1.0" },
            capabilities: { tools: {} },
          },
        });
      }

      case "ping": {
        const durationMs = Date.now() - t0;
        logAction({ method: req.method, durationMs, isError: false });
        return c.json({
          jsonrpc: "2.0",
          id: req.id,
          result: {},
        });
      }

      case "tools/list": {
        const durationMs = Date.now() - t0;
        logAction({ method: req.method, durationMs, isError: false });
        return c.json({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            tools: TOOL_DEFINITIONS,
          },
        });
      }

      case "tools/call": {
        const params = (req.params ?? {}) as {
          name?: string;
          arguments?: Record<string, unknown>;
        };
        const toolName = params.name ?? "";

        const userToken = c.req.header("x-gateway-user-token");
        const serverId = c.req.header("x-gateway-server-id") ?? "";
        if (!userToken || !serverId) {
          const durationMs = Date.now() - t0;
          logAction({
            method: req.method,
            tool: toolName,
            durationMs,
            isError: true,
          });
          return c.json({
            jsonrpc: "2.0",
            id: req.id,
            error: {
              code: -32001,
              message: "missing gateway user token or server id",
            },
          });
        }

        const ctx = {
          gatewayUrl: cfg.gatewayUrl,
          serverId,
          userToken,
          gmailApiBase: cfg.gmailApiBase,
          driveApiBase: cfg.driveApiBase,
        };

        const toolResult = await callTool(toolName, params.arguments, ctx);
        const durationMs = Date.now() - t0;
        logAction({
          method: req.method,
          tool: toolName,
          durationMs,
          isError: Boolean(toolResult.isError),
        });

        return c.json({
          jsonrpc: "2.0",
          id: req.id,
          result: toolResult,
        });
      }

      default: {
        const durationMs = Date.now() - t0;
        logAction({ method: req.method, durationMs, isError: true });
        return c.json({
          jsonrpc: "2.0",
          id: req.id,
          error: {
            code: -32601,
            message: `Method not found: ${req.method}`,
          },
        });
      }
    }
  });

  return app;
}

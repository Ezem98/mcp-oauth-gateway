import { describe, it, expect, afterEach, vi } from "vitest";
import { createGoogleMcpApp } from "../../upstreams/google/app.js";
import { SHARED_SECRET_HEADER } from "../../upstreams/google/config.js";

describe("Google MCP App Auth & JSON-RPC dispatch (app-auth.test.ts)", () => {
  const cfg = {
    port: 0,
    sharedSecret: "s".repeat(40),
    gatewayUrl: "http://gw.test",
    gmailApiBase: "http://gmail.test",
    driveApiBase: "http://drive.test",
  };
  const app = createGoogleMcpApp(cfg);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("no secret header → 401", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "unauthorized" });
  });

  it("wrong secret → 401", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SHARED_SECRET_HEADER]: "wrong-secret-value",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "unauthorized" });
  });

  it("correct secret + ping → 200 with result {}", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SHARED_SECRET_HEADER]: cfg.sharedSecret,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
  });

  it("notification (no id) → 202", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SHARED_SECRET_HEADER]: cfg.sharedSecret,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
    expect(res.status).toBe(202);
    const text = await res.text();
    expect(text).toBe("");
  });

  it("tools/list → exactly the 5 names gmail_search, gmail_read, gmail_create_draft, drive_search, drive_read (and nothing else, e.g. no 'send')", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SHARED_SECRET_HEADER]: cfg.sharedSecret,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: { tools: Array<{ name: string }> };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(2);

    const names = body.result.tools.map((t) => t.name);
    expect(names).toEqual([
      "gmail_search",
      "gmail_read",
      "gmail_create_draft",
      "drive_search",
      "drive_read",
    ]);
    expect(names).toHaveLength(5);
    for (const name of names) {
      expect(name.toLowerCase()).not.toContain("send");
    }
  });

  it("unknown method → JSON-RPC error -32601", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SHARED_SECRET_HEADER]: cfg.sharedSecret,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "unknown_method",
      }),
    });
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      error: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(3);
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32601);
  });

  it("batch array → -32600", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SHARED_SECRET_HEADER]: cfg.sharedSecret,
      },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", id: 2, method: "ping" },
      ]),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: null;
      error: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBeNull();
    expect(body.error?.code).toBe(-32600);
  });

  it("tools/call without X-Gateway-User-Token → error -32001", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SHARED_SECRET_HEADER]: cfg.sharedSecret,
        "x-gateway-server-id": "google",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "gmail_search",
          arguments: { query: "test" },
        },
      }),
    });
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      error: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(4);
    expect(body.error?.code).toBe(-32001);
    expect(body.error?.message).toContain("missing gateway user token or server id");
  });
});

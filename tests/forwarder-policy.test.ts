import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

describe("forwarder tool policy enforcement", () => {
  let tempDir: string;
  let app: any;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(os.tmpdir(), "mcp-forwarder-policy-test-"));
    process.env.DB_PATH = join(tempDir, "test.db");
    process.env.VAULT_KEY_FILE = join(tempDir, "vault.key");

    const { Hono } = await import("hono");
    const { forwardToUpstream } = await import("../src/gateway/forwarder.js");
    const { upsertServers } = await import("../src/db/servers-file.js");
    const { upsertPolicies } = await import("../src/policies/policies.js");

    upsertServers([
      {
        server_id: "srv",
        upstream_url: "http://upstream.test/mcp",
      },
    ]);

    upsertPolicies({
      srv: {
        echo: "allow",
        whoami: "allow",
        secret_tool: "deny",
      },
    });

    app = new Hono();
    app.all("/:server_id/mcp", async (c: any) => {
      c.set("auth", {
        serverId: "srv",
        claims: {
          sub: "u1",
          client_id: "c1",
          aud: "http://localhost:4000/srv/mcp",
          jti: "jti-1",
          exp: 9999999999,
          iss: "http://localhost:4000",
        },
      });
      return forwardToUpstream(c);
    });
  });

  afterAll(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore errors on Windows file locks
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allowed tools/call reaches upstream", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "echo: hi" }] },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/srv/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hi" } },
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.content[0].text).toBe("echo: hi");
  });

  it("denied tools/call → -32001 and fetch NOT called", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/srv/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "secret_tool", arguments: {} },
      }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.error.code).toBe(-32001);
    expect(data.error.message).toContain("secret_tool");
  });

  it("tools/list JSON response filtered", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          result: {
            tools: [
              { name: "echo" },
              { name: "secret_tool" },
              { name: "unlisted_tool" },
            ],
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/srv/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.tools).toEqual([{ name: "echo" }]);
  });

  it("tools/list SSE response filtered", async () => {
    const sseData =
      'event: message\ndata: {"jsonrpc":"2.0","id":4,"result":{"tools":[{"name":"echo"},{"name":"secret_tool"}]}}\n\n';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(sseData, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/srv/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/list",
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const bodyText = await res.text();
    expect(bodyText).toContain('"name":"echo"');
    expect(bodyText).not.toContain('"name":"secret_tool"');
  });

  it("broken JSON body → 400 and fetch not called", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/srv/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-valid-json",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe(-32700);
    expect(data.error.message).toBe("Parse error");
    expect(data.id).toBeNull();
  });

  it("mixed batch → upstream receives only the allowed items and the client gets upstream results plus the blocked error", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const sentBody = JSON.parse(String(init.body));
      expect(Array.isArray(sentBody)).toBe(true);
      expect(sentBody).toHaveLength(1);
      expect(sentBody[0].id).toBe(10);
      expect(sentBody[0].params.name).toBe("echo");

      return new Response(
        JSON.stringify([
          {
            jsonrpc: "2.0",
            id: 10,
            result: { content: [{ type: "text", text: "echo result" }] },
          },
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/srv/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        {
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: { name: "echo", arguments: { text: "ok" } },
        },
        {
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: { name: "secret_tool", arguments: {} },
        },
      ]),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(2);

    const item1 = data.find((d: any) => d.id === 10);
    const item2 = data.find((d: any) => d.id === 11);
    expect(item1.result.content[0].text).toBe("echo result");
    expect(item2.error.code).toBe(-32001);
    expect(item2.error.message).toContain("secret_tool");
  });

  it("batch of a notification + a denied call → blocked error still returned when upstream answers 202", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.request("/srv/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", method: "notifications/initialized" },
        {
          jsonrpc: "2.0",
          id: 20,
          method: "tools/call",
          params: { name: "secret_tool", arguments: {} },
        },
      ]),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual([
      expect.objectContaining({ id: 20, error: expect.objectContaining({ code: -32001 }) }),
    ]);
  });
});

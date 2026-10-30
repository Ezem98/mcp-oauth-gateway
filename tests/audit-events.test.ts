import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

describe("audit events across forwarder, credentials, and connect", () => {
  let tempDir: string;
  let forwarderApp: any;
  let vendApp: any;
  let connectRoutes: any;
  let adminToken: string;
  let queryAudit: any;
  let upsertCredential: any;
  let updateCredentialMetadata: any;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(os.tmpdir(), "mcp-audit-events-test-"));
    process.env.DB_PATH = join(tempDir, "test.db");
    process.env.VAULT_KEY_FILE = join(tempDir, "vault.key");
    process.env.CONNECT_ADMIN_TOKEN_FILE = join(tempDir, "connect-admin.token");
    process.env.GOOGLE_CLIENT_ID = "fake-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "fake-client-secret";
    process.env.GOOGLE_REDIRECT_URI = "http://localhost:4000/connect/google/callback";

    const { Hono } = await import("hono");
    const { forwardToUpstream } = await import("../src/gateway/forwarder.js");
    const { handleVendCredential } = await import("../src/credentials/route.js");
    const { upsertServers } = await import("../src/db/servers-file.js");
    const { upsertPolicies } = await import("../src/policies/policies.js");
    const { getConnectAdminToken } = await import("../src/credentials/admin-token.js");
    const connectMod = await import("../src/credentials/connect-route.js");
    const vaultMod = await import("../src/credentials/vault.js");
    const auditMod = await import("../src/audit/audit.js");

    connectRoutes = connectMod.connectRoutes;
    queryAudit = auditMod.queryAudit;
    upsertCredential = vaultMod.upsertCredential;
    updateCredentialMetadata = vaultMod.updateCredentialMetadata;
    adminToken = getConnectAdminToken();

    upsertServers([
      {
        server_id: "srv",
        upstream_url: "http://upstream.test/mcp",
      },
    ]);

    upsertPolicies({
      srv: {
        echo: "allow",
        fail_tool: "allow",
        echo_stream: "allow",
        args_tool: "allow",
        secret_tool: "deny",
      },
    });

    forwarderApp = new Hono();
    forwarderApp.all("/:server_id/mcp", async (c: any) => {
      c.set("auth", {
        serverId: "srv",
        claims: {
          sub: "user-123",
          client_id: "client-abc",
          aud: "http://localhost:4000/srv/mcp",
          jti: "jti-1",
          exp: 9999999999,
          iss: "http://localhost:4000",
        },
      });
      return forwardToUpstream(c);
    });

    vendApp = new Hono();
    vendApp.get("/:server_id/credentials/:provider/token", async (c: any) => {
      c.set("auth", {
        serverId: "srv",
        claims: {
          sub: "user-vend",
          client_id: "client-vend",
        },
      });
      return handleVendCredential(c);
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

  it("allowed tools/call with JSON response -> one tool_call row outcome ok with status 200 and a duration", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 101,
          result: { content: [{ type: "text", text: "echo: hi" }] },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await forwarderApp.request("/srv/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 101,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hi" } },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.content[0].text).toBe("echo: hi");

    let row: any;
    await vi.waitFor(() => {
      const rows = queryAudit({ serverId: "srv" });
      row = rows.find((r: any) => r.kind === "tool_call" && r.tool_name === "echo");
      expect(row).toBeDefined();
    });

    expect(row.outcome).toBe("ok");
    expect(row.status).toBe(200);
    expect(typeof row.duration_ms).toBe("number");
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    expect(row.user_subject).toBe("user-123");
    expect(row.client_id).toBe("client-abc");
    expect(row.server_id).toBe("srv");
  });

  it("tools/call whose response has result.isError true -> outcome error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 102,
          result: { isError: true, content: [{ type: "text", text: "Something failed" }] },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await forwarderApp.request("/srv/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 102,
        method: "tools/call",
        params: { name: "fail_tool", arguments: { text: "trigger error" } },
      }),
    });

    expect(res.status).toBe(200);
    await res.json();

    let row: any;
    await vi.waitFor(() => {
      const rows = queryAudit({ serverId: "srv" });
      row = rows.find(
        (r: any) =>
          r.kind === "tool_call" &&
          r.tool_name === "fail_tool" &&
          r.outcome === "error"
      );
      expect(row).toBeDefined();
    });

    expect(row.outcome).toBe("error");
    expect(row.status).toBe(200);
  });

  it("SSE response -> row recorded after the stream is consumed by the client", async () => {
    const sseEvent =
      'event: message\ndata: {"jsonrpc":"2.0","id":103,"result":{"content":[{"type":"text","text":"streamed echo"}]}}\n\n';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(sseEvent, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await forwarderApp.request("/srv/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 103,
        method: "tools/call",
        params: { name: "echo_stream", arguments: { text: "sse test" } },
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Client consumes the stream
    const bodyText = await res.text();
    expect(bodyText).toContain("streamed echo");

    let row: any;
    await vi.waitFor(() => {
      const rows = queryAudit({ serverId: "srv" });
      row = rows.find(
        (r: any) =>
          r.kind === "tool_call" &&
          r.tool_name === "echo_stream" &&
          r.outcome === "ok"
      );
      expect(row).toBeDefined();
    });

    expect(row.outcome).toBe("ok");
    expect(row.status).toBe(200);
  });

  it("denied call -> policy_block row with outcome blocked and status null", async () => {
    const res = await forwarderApp.request("/srv/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 104,
        method: "tools/call",
        params: { name: "secret_tool", arguments: { secretKey: "secret-val" } },
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.error.code).toBe(-32001);

    const rows = queryAudit({ serverId: "srv", blockedOnly: true });
    const blockedRow = rows.find((r: any) => r.tool_name === "secret_tool");
    expect(blockedRow).toBeDefined();
    expect(blockedRow.kind).toBe("policy_block");
    expect(blockedRow.outcome).toBe("blocked");
    expect(blockedRow.status).toBeNull();
    expect(blockedRow.duration_ms).toBe(0);
    expect(blockedRow.user_subject).toBe("user-123");
    expect(blockedRow.client_id).toBe("client-abc");
  });

  it("args values never appear in the row (e.g. body argument 'texto secreto')", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 105,
          result: { content: [{ type: "text", text: "ok" }] },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const secretBody = "texto secreto";
    const secretPassword = "ultra-secret-password-123";

    const res = await forwarderApp.request("/srv/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 105,
        method: "tools/call",
        params: {
          name: "args_tool",
          arguments: {
            body: secretBody,
            password: secretPassword,
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    await res.json();

    let row: any;
    await vi.waitFor(() => {
      const rows = queryAudit({ serverId: "srv" });
      row = rows.find(
        (r: any) =>
          r.kind === "tool_call" &&
          r.tool_name === "args_tool"
      );
      expect(row).toBeDefined();
    });

    expect(row.args_summary).not.toContain(secretBody);
    expect(row.args_summary).not.toContain(secretPassword);
    expect(row.args_summary).toContain(
      `"body":{"type":"string","length":${secretBody.length}}`
    );
    expect(row.args_summary).toContain(
      `"password":{"type":"string","length":${secretPassword.length}}`
    );
  });

  it("vending via handleVendCredential records credential_vend rows with status 200 and 409", async () => {
    upsertCredential({
      user_subject: "user-vend",
      provider: "google",
      credential_type: "oauth2",
      access_token: "mock-google-token",
      refresh_token: "mock-refresh-token",
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    });

    // 200 OK vending
    const res200 = await vendApp.request("/srv/credentials/google/token");
    expect(res200.status).toBe(200);

    let row200: any;
    await vi.waitFor(() => {
      const rows = queryAudit({ serverId: "srv" });
      row200 = rows.find(
        (r: any) =>
          r.kind === "credential_vend" &&
          r.status === 200 &&
          r.outcome === "ok"
      );
      expect(row200).toBeDefined();
    });

    expect(row200.tool_name).toBeNull();
    expect(row200.args_summary).toBe(JSON.stringify({ provider: "google" }));
    expect(row200.user_subject).toBe("user-vend");
    expect(typeof row200.duration_ms).toBe("number");

    // 409 Reconnect required vending
    updateCredentialMetadata("user-vend", "google", { needs_reconnect: true });

    const res409 = await vendApp.request("/srv/credentials/google/token");
    expect(res409.status).toBe(409);

    let row409: any;
    await vi.waitFor(() => {
      const rows = queryAudit({ serverId: "srv" });
      row409 = rows.find(
        (r: any) =>
          r.kind === "credential_vend" &&
          r.status === 409 &&
          r.outcome === "error"
      );
      expect(row409).toBeDefined();
    });

    expect(row409.tool_name).toBeNull();
    expect(row409.args_summary).toBe(JSON.stringify({ provider: "google" }));
    expect(row409.outcome).toBe("error");
  });

  it("connect callback records one 'connect' row with scope counts and status 200", async () => {
    const initRes = await connectRoutes.request(
      `/connect/google?user=user-connect&admin=${adminToken}`
    );
    expect(initRes.status).toBe(302);
    const redirectUrl = new URL(initRes.headers.get("location")!);
    const state = redirectUrl.searchParams.get("state")!;
    expect(state).toBeTruthy();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "at-connect-1",
          refresh_token: "rt-connect-1",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.readonly",
          token_type: "Bearer",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const cbRes = await connectRoutes.request(
      `/connect/google/callback?code=connect_code&state=${state}`
    );
    expect(cbRes.status).toBe(200);

    const rows = queryAudit({ limit: 100 });
    const connectRow = rows.find(
      (r: any) => r.kind === "connect" && r.user_subject === "user-connect"
    );
    expect(connectRow).toBeDefined();
    expect(connectRow.outcome).toBe("ok");
    expect(connectRow.status).toBe(200);
    expect(connectRow.server_id).toBeNull();
    expect(connectRow.tool_name).toBeNull();

    const summary = JSON.parse(connectRow.args_summary);
    expect(summary.provider).toBe("google");
    expect(summary.granted_scopes).toBe(1);
    expect(summary.missing_scopes).toBe(2);
  });
});

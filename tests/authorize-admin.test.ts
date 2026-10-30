import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

describe("POST /authorize admin token requirement", () => {
  let tempDir: string;
  let tokenFile: string;
  let dbFile: string;
  let vaultKeyFile: string;
  let token: string;
  let app: any;
  let clientId: string;
  let resourceUri: string;
  let resetConnectAdminTokenForTests: () => void;
  let getDb: () => any;

  const REDIRECT_URI = "http://localhost:9999/callback";

  function base64url(buf: Buffer): string {
    return buf
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  function makePkce() {
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    return { verifier, challenge };
  }

  beforeAll(async () => {
    tempDir = await mkdtemp(join(os.tmpdir(), "mcp-authorize-admin-test-"));
    dbFile = join(tempDir, "gateway.db");
    vaultKeyFile = join(tempDir, "vault.key");
    tokenFile = join(tempDir, "connect-admin.token");

    process.env.DB_PATH = dbFile;
    process.env.VAULT_KEY_FILE = vaultKeyFile;
    process.env.CONNECT_ADMIN_TOKEN_FILE = tokenFile;

    const { Hono } = await import("hono");
    const { oauthRoutes } = await import("../src/oauth/router.js");
    const adminTokenMod = await import("../src/credentials/admin-token.js");
    const dbMod = await import("../src/db/client.js");
    const { registerClient } = await import("../src/oauth/clients.js");
    const { resourceUriFor } = await import("../src/oauth/servers.js");

    resetConnectAdminTokenForTests = adminTokenMod.resetConnectAdminTokenForTests;
    resetConnectAdminTokenForTests();
    token = adminTokenMod.getConnectAdminToken();

    getDb = dbMod.getDb;
    getDb();
    dbMod.seedDemoServer();

    const client = registerClient({
      redirect_uris: [REDIRECT_URI],
      client_name: "test-client",
    });
    clientId = client.client_id;
    resourceUri = resourceUriFor("memory-demo");

    app = new Hono();
    app.route("/", oauthRoutes);
  });

  afterAll(async () => {
    resetConnectAdminTokenForTests?.();
    try {
      getDb()?.close();
    } catch {
      // ignore
    }
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("GET consent page contains the admin_token field and not the token value", async () => {
    const { challenge } = makePkce();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp:read mcp:write",
      state: "state-get-test",
      resource: resourceUri,
    });

    const res = await app.request(`/authorize?${query.toString()}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="admin_token"');
    expect(html).toContain('type="password"');
    expect(html).toContain('autocomplete="off"');
    expect(html).toContain("Token de administrador (el de data/connect-admin.token)");
    expect(html).not.toContain(token);
  });

  it("POST approve without token -> 401 and no Location header", async () => {
    const { challenge } = makePkce();
    const body = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp:read mcp:write",
      state: "state-no-token",
      resource: resourceUri,
      decision: "approve",
    });

    const res = await app.request("/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain("Token de administrador inválido");
    expect(html).toContain('name="admin_token"');
    expect(html).not.toContain(token);
  });

  it("POST approve with wrong token -> 401 and no Location header", async () => {
    const { challenge } = makePkce();
    const body = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp:read mcp:write",
      state: "state-wrong-token",
      resource: resourceUri,
      decision: "approve",
      admin_token: "invalid-token-1234567890abcdef",
    });

    const res = await app.request("/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain("Token de administrador inválido");
    expect(html).toContain('name="admin_token"');
    expect(html).not.toContain("invalid-token-1234567890abcdef");
    expect(html).not.toContain(token);
  });

  it("POST approve with correct token -> 302 to redirect_uri with code", async () => {
    const { challenge } = makePkce();
    const state = "state-correct-token";
    const body = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp:read mcp:write",
      state,
      resource: resourceUri,
      decision: "approve",
      admin_token: token,
    });

    const res = await app.request("/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const redirectUrl = new URL(location!);
    expect(redirectUrl.origin + redirectUrl.pathname).toBe(REDIRECT_URI);
    const code = redirectUrl.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(redirectUrl.searchParams.get("state")).toBe(state);
  });

  it("POST deny without token -> 302 with error=access_denied", async () => {
    const { challenge } = makePkce();
    const state = "state-deny-test";
    const body = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp:read mcp:write",
      state,
      resource: resourceUri,
      decision: "deny",
    });

    const res = await app.request("/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const redirectUrl = new URL(location!);
    expect(redirectUrl.origin + redirectUrl.pathname).toBe(REDIRECT_URI);
    expect(redirectUrl.searchParams.get("error")).toBe("access_denied");
    expect(redirectUrl.searchParams.get("state")).toBe(state);
    expect(redirectUrl.searchParams.get("code")).toBeNull();
  });
});

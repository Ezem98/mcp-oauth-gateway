import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

describe("Google OAuth connect and callback", () => {
  let tempDir: string;
  let connectRoutes: any;
  let getCredential: any;
  let getDb: any;
  let GOOGLE_SCOPES: string[];
  let sharedState: string;
  let adminToken: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(os.tmpdir(), "mcp-google-test-"));
    process.env.DB_PATH = join(tempDir, "test.db");
    process.env.VAULT_KEY_FILE = join(tempDir, "vault.key");
    process.env.CONNECT_ADMIN_TOKEN_FILE = join(tempDir, "connect-admin.token");
    process.env.GOOGLE_CLIENT_ID = "fake-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "fake-client-secret";
    process.env.GOOGLE_REDIRECT_URI = "http://localhost:4000/connect/google/callback";

    const adminTokenMod = await import("../src/credentials/admin-token.js");
    adminToken = adminTokenMod.getConnectAdminToken();

    const googleMod = await import("../src/credentials/google.js");
    GOOGLE_SCOPES = googleMod.GOOGLE_SCOPES;
    const connectMod = await import("../src/credentials/connect-route.js");
    connectRoutes = connectMod.connectRoutes;
    const vaultMod = await import("../src/credentials/vault.js");
    getCredential = vaultMod.getCredential;
    const dbMod = await import("../src/db/client.js");
    getDb = dbMod.getDb;
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

  it("GET /connect/google without admin param → 401", async () => {
    const res = await connectRoutes.request("/connect/google?user=u1");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({
      error: "unauthorized",
      error_description: "valid admin token required",
    });
  });

  it("GET /connect/google with wrong admin token → 401", async () => {
    const res = await connectRoutes.request(
      "/connect/google?user=u1&admin=wrong-token"
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({
      error: "unauthorized",
      error_description: "valid admin token required",
    });
  });

  it("(b) GET /connect/google?user=u1 redirects with all required query parameters", async () => {
    const res = await connectRoutes.request(
      `/connect/google?user=u1&admin=${adminToken}`
    );
    expect(res.status).toBe(302);

    const location = res.headers.get("location");
    expect(location).toBeDefined();

    const url = new URL(location!);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.pathname).toBe("/o/oauth2/v2/auth");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("fake-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:4000/connect/google/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("include_granted_scopes")).toBe("false");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("code_challenge")).toBeTruthy();

    const scopeParam = url.searchParams.get("scope") ?? "";
    for (const scope of GOOGLE_SCOPES) {
      expect(scopeParam).toContain(scope);
    }
  });

  it("(c) full callback exchanges code, saves credential encrypted, and renders HTML with missing scope warning", async () => {
    const initRes = await connectRoutes.request(
      `/connect/google?user=u1&admin=${adminToken}`
    );
    expect(initRes.status).toBe(302);
    const redirectUrl = new URL(initRes.headers.get("location")!);
    sharedState = redirectUrl.searchParams.get("state")!;
    expect(sharedState).toBeTruthy();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.readonly",
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
      `/connect/google/callback?code=c1&state=${sharedState}`
    );
    expect(cbRes.status).toBe(200);

    const html = await cbRes.text();
    expect(html).toContain("conectada");
    expect(html).toContain("gmail.compose");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [tokenUrl, tokenOptions] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe("https://oauth2.googleapis.com/token");
    const body = String(tokenOptions?.body ?? "");
    expect(body).toContain("code_verifier=");
    expect(body).toContain("client_secret=");
    expect(body).toContain("code=c1");

    const cred = getCredential("u1", "google");
    expect(cred).not.toBeNull();
    expect(cred?.access_token).toBe("at-1");
    expect(cred?.refresh_token).toBe("rt-1");

    const rawRow = getDb()
      .prepare(
        "SELECT access_token FROM credential_vault WHERE user_subject = ? AND provider = ?"
      )
      .get("u1", "google") as { access_token: string } | undefined;
    expect(rawRow).toBeDefined();
    expect(rawRow!.access_token.startsWith("v1:")).toBe(true);
    expect(rawRow!.access_token).not.toBe("at-1");
  });

  it("(d) reusing the same state → 400", async () => {
    const reuseRes = await connectRoutes.request(
      `/connect/google/callback?code=c2&state=${sharedState}`
    );
    expect(reuseRes.status).toBe(400);
    const text = await reuseRes.text();
    expect(text).toContain("invalid or expired state");
  });

  it("(e) callback with ?error=access_denied → 400", async () => {
    const errRes = await connectRoutes.request(
      "/connect/google/callback?error=access_denied"
    );
    expect(errRes.status).toBe(400);
    const text = await errRes.text();
    expect(text).toContain("access_denied");
  });

  it("(f) token endpoint returning 400 {error:\"invalid_grant\"} → 502 for a fresh state", async () => {
    const startRes = await connectRoutes.request(
      `/connect/google?user=u2&admin=${adminToken}`
    );
    expect(startRes.status).toBe(302);
    const startUrl = new URL(startRes.headers.get("location")!);
    const freshState = startUrl.searchParams.get("state")!;

    const fetchFailMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchFailMock);

    const failRes = await connectRoutes.request(
      `/connect/google/callback?code=c_bad&state=${freshState}`
    );
    expect(failRes.status).toBe(502);
  });
});

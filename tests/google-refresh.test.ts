import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

describe("automatic Google access-token refresh", () => {
  let tempDir: string;
  let upsertCredential: any;
  let getCredential: any;
  let getFreshGoogleToken: any;
  let freshTokenErrorResponse: any;
  let CredentialNotFoundError: any;
  let ReconnectRequiredError: any;
  let GoogleNotConfiguredError: any;
  let GoogleRefreshError: any;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(os.tmpdir(), "mcp-google-refresh-test-"));
    process.env.DB_PATH = join(tempDir, "test.db");
    process.env.VAULT_KEY_FILE = join(tempDir, "vault.key");
    process.env.CONNECT_ADMIN_TOKEN_FILE = join(tempDir, "connect-admin.token");
    process.env.GOOGLE_CLIENT_ID = "fake-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "fake-client-secret";
    process.env.GOOGLE_REDIRECT_URI = "http://localhost:4000/connect/google/callback";

    const vaultMod = await import("../src/credentials/vault.js");
    upsertCredential = vaultMod.upsertCredential;
    getCredential = vaultMod.getCredential;

    const googleMod = await import("../src/credentials/google.js");
    getFreshGoogleToken = googleMod.getFreshGoogleToken;
    freshTokenErrorResponse = googleMod.freshTokenErrorResponse;
    CredentialNotFoundError = googleMod.CredentialNotFoundError;
    ReconnectRequiredError = googleMod.ReconnectRequiredError;
    GoogleNotConfiguredError = googleMod.GoogleNotConfiguredError;
    GoogleRefreshError = googleMod.GoogleRefreshError;
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

  it("(a) expires in 30 min → returns cred, fetch not called", async () => {
    const user = "user-a";
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    upsertCredential({
      user_subject: user,
      provider: "google",
      credential_type: "oauth2",
      access_token: "token-a",
      refresh_token: "rt-a",
      scope: "scope-a",
      expires_at: expiresAt,
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const cred = await getFreshGoogleToken(user);
    expect(cred.access_token).toBe("token-a");
    expect(cred.user_subject).toBe(user);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("(b) expires in 2 min → fetch called once with grant_type=refresh_token and stored refresh token; returned and stored access_token is new; expires_at moved forward", async () => {
    const user = "user-b";
    const initialExpiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    upsertCredential({
      user_subject: user,
      provider: "google",
      credential_type: "oauth2",
      access_token: "old-token-b",
      refresh_token: "rt-b",
      scope: "scope-b",
      expires_at: initialExpiresAt,
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "new-token-b",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const cred = await getFreshGoogleToken(user);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [tokenUrl, tokenOptions] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(tokenOptions?.method).toBe("POST");
    expect(tokenOptions?.headers?.["content-type"]).toBe(
      "application/x-www-form-urlencoded"
    );
    const bodyParams = new URLSearchParams(String(tokenOptions?.body ?? ""));
    expect(bodyParams.get("grant_type")).toBe("refresh_token");
    expect(bodyParams.get("refresh_token")).toBe("rt-b");
    expect(bodyParams.get("client_id")).toBe("fake-client-id");
    expect(bodyParams.get("client_secret")).toBe("fake-client-secret");

    expect(cred.access_token).toBe("new-token-b");
    expect(new Date(cred.expires_at!).getTime()).toBeGreaterThan(
      new Date(initialExpiresAt).getTime()
    );

    const stored = getCredential(user, "google");
    expect(stored).not.toBeNull();
    expect(stored?.access_token).toBe("new-token-b");
    expect(new Date(stored!.expires_at!).getTime()).toBeGreaterThan(
      new Date(initialExpiresAt).getTime()
    );
  });

  it("(c) Google response without refresh_token → stored refresh_token unchanged", async () => {
    const user = "user-c";
    upsertCredential({
      user_subject: user,
      provider: "google",
      credential_type: "oauth2",
      access_token: "old-token-c",
      refresh_token: "original-rt-c",
      scope: "scope-c",
      expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "new-token-c",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const cred = await getFreshGoogleToken(user);
    expect(cred.refresh_token).toBe("original-rt-c");

    const stored = getCredential(user, "google");
    expect(stored?.refresh_token).toBe("original-rt-c");
  });

  it("(d) Google response with a new refresh_token → stored refresh_token rotated", async () => {
    const user = "user-d";
    upsertCredential({
      user_subject: user,
      provider: "google",
      credential_type: "oauth2",
      access_token: "old-token-d",
      refresh_token: "original-rt-d",
      scope: "scope-d",
      expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "new-token-d",
          refresh_token: "rotated-rt-d",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const cred = await getFreshGoogleToken(user);
    expect(cred.refresh_token).toBe("rotated-rt-d");

    const stored = getCredential(user, "google");
    expect(stored?.refresh_token).toBe("rotated-rt-d");
  });

  it("(e) two concurrent getFreshGoogleToken calls for the same user (Promise.all) → fetch called exactly once and both get the same new access_token", async () => {
    const user = "user-e";
    upsertCredential({
      user_subject: user,
      provider: "google",
      credential_type: "oauth2",
      access_token: "old-token-e",
      refresh_token: "rt-e",
      scope: "scope-e",
      expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
    });

    const fetchMock = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response(
        JSON.stringify({
          access_token: "concurrent-new-token-e",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const [res1, res2] = await Promise.all([
      getFreshGoogleToken(user),
      getFreshGoogleToken(user),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res1.access_token).toBe("concurrent-new-token-e");
    expect(res2.access_token).toBe("concurrent-new-token-e");
  });

  it("(f) Google 400 {error:\"invalid_grant\"} → rejects with ReconnectRequiredError, marks needs_reconnect, second call throws without fetch, freshTokenErrorResponse gives 409", async () => {
    const user = "user-f";
    upsertCredential({
      user_subject: user,
      provider: "google",
      credential_type: "oauth2",
      access_token: "old-token-f",
      refresh_token: "rt-f",
      scope: "scope-f",
      expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    let err1: any;
    try {
      await getFreshGoogleToken(user);
    } catch (err) {
      err1 = err;
    }
    expect(err1).toBeInstanceOf(ReconnectRequiredError);
    expect(err1.userSubject).toBe(user);

    const stored = getCredential(user, "google");
    expect(stored?.metadata?.needs_reconnect).toBe(true);
    expect(stored?.metadata?.needs_reconnect_since).toBeTruthy();

    fetchMock.mockClear();
    let err2: any;
    try {
      await getFreshGoogleToken(user);
    } catch (err) {
      err2 = err;
    }
    expect(err2).toBeInstanceOf(ReconnectRequiredError);
    expect(err2.userSubject).toBe(user);
    expect(fetchMock).not.toHaveBeenCalled();

    const errResponse = freshTokenErrorResponse(err1, user);
    expect(errResponse).toEqual({
      status: 409,
      body: {
        error: "reconnect_required",
        connect_hint: `npm run connect-url -- ${user}`,
      },
    });
  });

  it("(g) after (f), upsertCredential with fresh metadata → getFreshGoogleToken works again", async () => {
    const user = "user-f";
    upsertCredential({
      user_subject: user,
      provider: "google",
      credential_type: "oauth2",
      access_token: "reconnected-token-f",
      refresh_token: "new-rt-f",
      scope: "scope-f",
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      metadata: {
        token_type: "Bearer",
        granted_scopes: ["scope-f"],
        connected_at: new Date().toISOString(),
      },
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const cred = await getFreshGoogleToken(user);
    expect(cred.access_token).toBe("reconnected-token-f");
    expect(cred.metadata?.needs_reconnect).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("(h) Google 500 → rejects with GoogleRefreshError and freshTokenErrorResponse gives 502; credential not marked needs_reconnect", async () => {
    const user = "user-h";
    upsertCredential({
      user_subject: user,
      provider: "google",
      credential_type: "oauth2",
      access_token: "old-token-h",
      refresh_token: "rt-h",
      scope: "scope-h",
      expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
    });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response("Internal Server Error", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    let errH: any;
    try {
      await getFreshGoogleToken(user);
    } catch (err) {
      errH = err;
    }
    expect(errH).toBeInstanceOf(GoogleRefreshError);
    expect(errH.status).toBe(500);

    const errResponseH = freshTokenErrorResponse(errH, user);
    expect(errResponseH).toEqual({
      status: 502,
      body: {
        error: "upstream_refresh_failed",
      },
    });

    const stored = getCredential(user, "google");
    expect(stored?.metadata?.needs_reconnect).toBeFalsy();
  });

  it("handles CredentialNotFoundError when no credential exists", async () => {
    const user = "user-unknown";
    let err: any;
    try {
      await getFreshGoogleToken(user);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CredentialNotFoundError);
    const resp = freshTokenErrorResponse(err, user);
    expect(resp?.status).toBe(404);
    expect(resp?.body.error).toBe("credential_not_found");
  });

  it("marks needs_reconnect and throws ReconnectRequiredError when refresh_token is missing", async () => {
    const user = "user-no-rt";
    upsertCredential({
      user_subject: user,
      provider: "google",
      credential_type: "oauth2",
      access_token: "old-token",
      refresh_token: null,
      scope: "scope",
      expires_at: new Date(Date.now() + 60 * 1000).toISOString(),
    });

    let err: any;
    try {
      await getFreshGoogleToken(user);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ReconnectRequiredError);
    const stored = getCredential(user, "google");
    expect(stored?.metadata?.needs_reconnect).toBe(true);
  });
});

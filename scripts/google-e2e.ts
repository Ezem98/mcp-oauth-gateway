/**
 * End-to-end test for Google MCP upstream behind the gateway.
 *
 * Prereq (in a separate terminal):
 *     npm run dev               # gateway on :4000
 *
 * Then:
 *     npm run google-e2e
 *
 * This script:
 *  1. Starts an in-process fake Google API on 127.0.0.1:5003 implementing Gmail & Drive endpoints.
 *  2. Starts an in-process Google MCP upstream on 127.0.0.1:5002 with a random 64-hex shared secret.
 *  3. Seeds server 'google-e2e' and a stub Google credential into the gateway DB.
 *  4. Executes the OAuth 2.1 authorization code flow with PKCE against the gateway.
 *  5. Runs all 9 end-to-end steps through the gateway with Bearer authentication.
 *  6. Cleans up in-process servers and restores the credential in the gateway database.
 */

import { createHash, randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getEnv } from "../src/config/env.js";
import {
  updateCredentialMetadata,
  upsertCredential,
} from "../src/credentials/vault.js";
import { upsertServers } from "../src/db/servers-file.js";
import { createGoogleMcpApp } from "../upstreams/google/app.js";

const GATEWAY = process.env.GATEWAY ?? "http://localhost:4000";
const SERVER_ID = "google-e2e";
const REDIRECT_URI = "http://localhost:9999/callback";
const MCP_URL = `${GATEWAY}/${SERVER_ID}/mcp`;

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

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error("ASSERT: " + message);
}

async function expectJson(res: Response, label: string): Promise<any> {
  const text = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    throw new Error(
      `${label}: expected JSON, got ${ct}. Body: ${text.slice(0, 200)}`
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}: malformed JSON. Body: ${text.slice(0, 200)}`);
  }
}

let rpcId = 0;
async function rpc(
  method: string,
  params: Record<string, unknown> | undefined,
  token: string
): Promise<any> {
  const id = ++rpcId;
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`rpc(${method}) status ${res.status}: ${body.slice(0, 200)}`);
  }
  const payload = (await res.json()) as any;
  assert(payload.jsonrpc === "2.0", `rpc(${method}) bad jsonrpc envelope`);
  assert(payload.id === id, `rpc(${method}) id mismatch`);
  if (payload.error) {
    throw new Error(`rpc(${method}) error: ${JSON.stringify(payload.error)}`);
  }
  return payload.result;
}

async function step(label: string, fn: () => Promise<void>) {
  process.stdout.write(`\n▶ ${label}\n`);
  await fn();
  console.log("  ✓");
}

async function startServer(
  options: Parameters<typeof serve>[0]
): Promise<ReturnType<typeof serve>> {
  return new Promise((resolve) => {
    const server = serve(options, () => {
      resolve(server);
    });
  });
}

async function closeServer(server: any): Promise<void> {
  if (!server) return;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), 2000);
    try {
      server.closeAllConnections?.();
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

interface RecordedRequest {
  method: string;
  path: string;
  url: string;
  query: Record<string, string>;
  authHeader: string | undefined;
  body: any;
}

async function main(): Promise<void> {
  let fakeGoogleServer: any;
  let mcpServer: any;

  try {
    console.log(`▶ Gateway: ${GATEWAY}`);
    console.log(`▶ MCP URL: ${MCP_URL}`);

    // ─── 1. Build and start Fake Google API on 127.0.0.1:5003 ─────────────────
    const recordedRequests: RecordedRequest[] = [];
    const fakeGoogleApp = new Hono();

    fakeGoogleApp.use("*", async (c, next) => {
      let body: any = null;
      const method = c.req.method;
      if (method !== "GET" && method !== "HEAD") {
        try {
          const cloned = c.req.raw.clone();
          const ct = c.req.header("content-type") ?? "";
          if (ct.includes("application/json")) {
            body = await cloned.json();
          } else {
            body = await cloned.text();
          }
        } catch {
          // Body not parseable
        }
      }

      const urlObj = new URL(c.req.url);
      const query: Record<string, string> = {};
      urlObj.searchParams.forEach((val, key) => {
        query[key] = val;
      });

      recordedRequests.push({
        method,
        path: c.req.path,
        url: c.req.url,
        query,
        authHeader: c.req.header("authorization"),
        body,
      });

      await next();
    });

    // Endpoints used by tools:
    // a. Gmail messages list
    fakeGoogleApp.get("/gmail/v1/users/me/messages", (c) => {
      return c.json({
        messages: [{ id: "msg-1", threadId: "thread-1" }],
      });
    });

    // b. Gmail drafts.create (defined before :id to prevent path conflicts)
    fakeGoogleApp.post("/gmail/v1/users/me/drafts", async (c) => {
      const body = (await c.req.json()) as {
        message?: { raw?: string; threadId?: string };
      };
      return c.json({
        id: "draft-1",
        message: {
          id: "draft-msg-1",
          threadId: body?.message?.threadId ?? "thread-1",
        },
      });
    });

    // c. Gmail messages get with format=metadata and format=full
    fakeGoogleApp.get("/gmail/v1/users/me/messages/:id", (c) => {
      const id = c.req.param("id");
      const format = c.req.query("format") ?? "full";

      if (format === "metadata") {
        return c.json({
          id,
          threadId: "thread-1",
          snippet: "Reunión de mañana confirmada",
          payload: {
            headers: [
              { name: "From", value: "remitente@example.com" },
              { name: "To", value: "destinatario@example.com" },
              { name: "Subject", value: "Reunión de mañana" },
              { name: "Date", value: "Thu, 29 Oct 2026 10:00:00 GMT" },
              { name: "Message-ID", value: "<orig-msg-123@example.com>" },
              { name: "References", value: "<prev-ref-456@example.com>" },
            ],
          },
        });
      }

      return c.json({
        id,
        threadId: "thread-1",
        payload: {
          headers: [
            { name: "From", value: "remitente@example.com" },
            { name: "To", value: "destinatario@example.com" },
            { name: "Subject", value: "Reunión de mañana" },
            { name: "Date", value: "Thu, 29 Oct 2026 10:00:00 GMT" },
          ],
          mimeType: "text/plain",
          parts: [
            {
              mimeType: "text/plain",
              body: {
                data: Buffer.from(
                  "Hola, nos vemos en la reunión de mañana.",
                  "utf-8"
                ).toString("base64url"),
              },
            },
          ],
        },
      });
    });

    // d. Drive files.list
    fakeGoogleApp.get("/drive/v3/files", (c) => {
      return c.json({
        files: [
          {
            id: "doc-1",
            name: "Proyecto it's a test",
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2026-10-29T12:00:00Z",
            webViewLink: "https://docs.google.com/document/d/doc-1/view",
          },
        ],
      });
    });

    // e. Drive files.export
    fakeGoogleApp.get("/drive/v3/files/:id/export", (c) => {
      return c.text("Contenido exportado del documento de Google Doc.");
    });

    // f. Drive files.get metadata
    fakeGoogleApp.get("/drive/v3/files/:id", (c) => {
      const id = c.req.param("id");
      return c.json({
        id,
        name: "Proyecto Google Doc",
        mimeType: "application/vnd.google-apps.document",
        modifiedTime: "2026-10-29T12:00:00Z",
        webViewLink: "https://docs.google.com/document/d/doc-1/view",
        size: "1024",
      });
    });

    // Unknown paths → 404
    fakeGoogleApp.notFound((c) => {
      return c.json({ error: "not_found", path: c.req.path }, 404);
    });

    fakeGoogleServer = await startServer({
      fetch: fakeGoogleApp.fetch,
      port: 5003,
      hostname: "127.0.0.1",
    });

    // ─── 2. Build and start Google MCP on 127.0.0.1:5002 ──────────────────────
    const secret = randomBytes(32).toString("hex"); // 64 hex characters
    const mcpApp = createGoogleMcpApp({
      port: 5002,
      sharedSecret: secret,
      gatewayUrl: GATEWAY,
      gmailApiBase: "http://127.0.0.1:5003",
      driveApiBase: "http://127.0.0.1:5003",
    });

    mcpServer = await startServer({
      fetch: mcpApp.fetch,
      port: 5002,
      hostname: "127.0.0.1",
    });

    // ─── 3. Seed server & credential in gateway DB ────────────────────────────
    const env = getEnv();
    const user = env.AUTH_DEFAULT_USER;

    upsertServers([
      {
        server_id: SERVER_ID,
        display_name: "Google MCP (e2e)",
        upstream_url: "http://127.0.0.1:5002/mcp",
        upstream_auth_header: `X-Google-MCP-Secret: ${secret}`,
      },
    ]);

    upsertCredential({
      user_subject: user,
      provider: "google",
      credential_type: "oauth2",
      access_token: "fake-google-access-token",
      refresh_token: null,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      metadata: { stub: true, note: "seeded by google-e2e" },
    });

    // ─── Step [1] Direct POST without secret → 401 ────────────────────────────
    await step(
      "[1] direct POST to http://127.0.0.1:5002/mcp without the secret → 401 (nobody can bypass the gateway)",
      async () => {
        const res = await fetch("http://127.0.0.1:5002/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        });
        assert(res.status === 401, `expected 401, got ${res.status}`);
      }
    );

    // ─── OAuth 2.1 Flow against Gateway ───────────────────────────────────────
    const disco = await expectJson(
      await fetch(`${GATEWAY}/.well-known/oauth-authorization-server`),
      "discovery"
    );
    const reg = await expectJson(
      await fetch(disco.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "google-e2e",
          redirect_uris: [REDIRECT_URI],
        }),
      }),
      "register"
    );
    const clientId = reg.client_id as string;
    const { verifier, challenge } = makePkce();
    const state = base64url(randomBytes(8));

    const authParams = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp:read mcp:write",
      state,
      resource: `${GATEWAY}/${SERVER_ID}/mcp`,
    });

    // Auto-approve via POST
    const form = new URLSearchParams(authParams);
    form.set("decision", "approve");
    const authPost = await fetch(disco.authorization_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    });
    assert(authPost.status === 302, `authorize POST not 302: ${authPost.status}`);
    const location = authPost.headers.get("location") ?? "";
    const code = new URL(location).searchParams.get("code");
    assert(code, "no code in redirect");

    const tok = await expectJson(
      await fetch(disco.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          code_verifier: verifier,
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
        }).toString(),
      }),
      "token"
    );
    const accessToken = tok.access_token as string;

    // ─── Step [2] initialize via gateway ──────────────────────────────────────
    await step(
      "[2] initialize via gateway → serverInfo.name 'google-mcp'",
      async () => {
        const result = await rpc(
          "initialize",
          {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "google-e2e", version: "0.0.1" },
          },
          accessToken
        );
        assert(
          result.serverInfo?.name === "google-mcp",
          `expected serverInfo.name 'google-mcp', got '${result.serverInfo?.name}'`
        );
      }
    );

    // ─── Step [3] tools/list ──────────────────────────────────────────────────
    await step("[3] tools/list → exactly the 5 tools", async () => {
      const result = await rpc("tools/list", undefined, accessToken);
      assert(Array.isArray(result.tools), "tools must be an array");
      const names = result.tools.map((t: any) => t.name).sort();
      const expected = [
        "drive_read",
        "drive_search",
        "gmail_create_draft",
        "gmail_read",
        "gmail_search",
      ];
      assert(
        JSON.stringify(names) === JSON.stringify(expected),
        `expected exactly tools ${expected.join(", ")}, got ${names.join(", ")}`
      );
    });

    // ─── Step [4] gmail_search ────────────────────────────────────────────────
    await step(
      "[4] gmail_search → results from the fake API, and the fake API saw Authorization 'Bearer fake-google-access-token'",
      async () => {
        const result = await rpc(
          "tools/call",
          { name: "gmail_search", arguments: { query: "is:unread" } },
          accessToken
        );
        assert(!result.isError, `unexpected tool error: ${JSON.stringify(result)}`);
        const parsed = JSON.parse(result.content[0].text);
        assert(
          Array.isArray(parsed) && parsed.length > 0,
          "expected gmail_search results"
        );
        assert(parsed[0].id === "msg-1", `expected msg-1, got ${parsed[0].id}`);

        const msgListReq = recordedRequests.find(
          (r) => r.method === "GET" && r.path === "/gmail/v1/users/me/messages"
        );
        assert(msgListReq, "fake API never received messages list request");
        assert(
          msgListReq.authHeader === "Bearer fake-google-access-token",
          `expected Bearer fake-google-access-token, got ${msgListReq.authHeader}`
        );
      }
    );

    // ─── Step [5] gmail_read ──────────────────────────────────────────────────
    await step("[5] gmail_read → body text present", async () => {
      const result = await rpc(
        "tools/call",
        { name: "gmail_read", arguments: { message_id: "msg-1" } },
        accessToken
      );
      assert(!result.isError, `unexpected tool error: ${JSON.stringify(result)}`);
      const parsed = JSON.parse(result.content[0].text);
      assert(
        typeof parsed.body === "string" && parsed.body.length > 0,
        "expected body text in gmail_read"
      );
    });

    // ─── Step [6] gmail_create_draft reply ────────────────────────────────────
    await step(
      "[6] gmail_create_draft with subject 'Reunión de mañana' as a reply → fake API received drafts.create with RFC 2047 Subject and threadId, sent: false, no /send",
      async () => {
        const result = await rpc(
          "tools/call",
          {
            name: "gmail_create_draft",
            arguments: {
              to: "destinatario@example.com",
              subject: "Reunión de mañana",
              body: "Confirmado para mañana a las 10.",
              reply_to_message_id: "msg-1",
            },
          },
          accessToken
        );
        assert(!result.isError, `unexpected tool error: ${JSON.stringify(result)}`);
        const parsed = JSON.parse(result.content[0].text);
        assert(parsed.sent === false, `expected sent: false, got ${parsed.sent}`);

        const draftReq = recordedRequests.find(
          (r) => r.method === "POST" && r.path === "/gmail/v1/users/me/drafts"
        );
        assert(draftReq, "fake API never received drafts.create request");
        assert(
          draftReq.body?.message?.threadId === "thread-1",
          `expected threadId 'thread-1', got ${draftReq.body?.message?.threadId}`
        );

        const raw = draftReq.body?.message?.raw;
        assert(typeof raw === "string", "raw mime must be string");
        const decodedRaw = Buffer.from(raw, "base64url").toString("utf-8");
        assert(
          decodedRaw.includes("Subject: =?UTF-8?B?"),
          `expected RFC 2047 encoded subject in raw MIME, got: ${decodedRaw}`
        );
        assert(
          !recordedRequests.some((r) => r.path.includes("/send")),
          "fake API saw a request containing /send"
        );
      }
    );

    // ─── Step [7] drive_search ────────────────────────────────────────────────
    await step(
      "[7] drive_search with query \"it's\" → fake API saw the escaped q",
      async () => {
        const result = await rpc(
          "tools/call",
          { name: "drive_search", arguments: { query: "it's" } },
          accessToken
        );
        assert(!result.isError, `unexpected tool error: ${JSON.stringify(result)}`);
        const searchReq = recordedRequests.find(
          (r) => r.method === "GET" && r.path === "/drive/v3/files" && r.query.q
        );
        assert(searchReq, "fake API never received drive search request");
        assert(
          searchReq.query.q === "fullText contains 'it\\'s' and trashed = false",
          `expected escaped q, got '${searchReq.query.q}'`
        );
      }
    );

    // ─── Step [8] drive_read ──────────────────────────────────────────────────
    await step(
      "[8] drive_read of a Google Doc → content from the export endpoint",
      async () => {
        const result = await rpc(
          "tools/call",
          { name: "drive_read", arguments: { file_id: "doc-1" } },
          accessToken
        );
        assert(!result.isError, `unexpected tool error: ${JSON.stringify(result)}`);
        const parsed = JSON.parse(result.content[0].text);
        assert(
          typeof parsed.content === "string" &&
            parsed.content.includes("Contenido exportado"),
          `expected content from export endpoint, got: ${parsed.content}`
        );

        const exportReq = recordedRequests.find(
          (r) => r.method === "GET" && r.path === "/drive/v3/files/doc-1/export"
        );
        assert(exportReq, "fake API never received export request");
        assert(
          exportReq.query.mimeType === "text/plain",
          `expected export mimeType 'text/plain', got '${exportReq.query.mimeType}'`
        );
      }
    );

    // ─── Step [9] updateCredentialMetadata & restore ──────────────────────────
    await step(
      "[9] updateCredentialMetadata(user, 'google', { needs_reconnect: true }) → tools/call returns isError with text starting 'Hay que reconectar la cuenta de Google:'; then restore credential",
      async () => {
        updateCredentialMetadata(user, "google", { needs_reconnect: true });

        try {
          const result = await rpc(
            "tools/call",
            { name: "gmail_search", arguments: { query: "test" } },
            accessToken
          );
          assert(result.isError === true, "expected result.isError to be true");
          const errText = result.content?.[0]?.text ?? "";
          assert(
            errText.startsWith("Hay que reconectar la cuenta de Google:"),
            `expected error text starting with 'Hay que reconectar la cuenta de Google:', got: '${errText}'`
          );
        } finally {
          // Restore credential with fresh metadata so later runs work
          upsertCredential({
            user_subject: user,
            provider: "google",
            credential_type: "oauth2",
            access_token: "fake-google-access-token",
            refresh_token: null,
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            metadata: { stub: true, note: "restored by google-e2e" },
          });
        }
      }
    );

    console.log("\n✓ Google MCP end-to-end test passed successfully.");
  } finally {
    await Promise.all([closeServer(mcpServer), closeServer(fakeGoogleServer)]);
  }
}

main().catch((err) => {
  console.error(
    "\n✗ Google e2e failed:",
    err instanceof Error ? err.message : String(err)
  );
  process.exit(1);
});

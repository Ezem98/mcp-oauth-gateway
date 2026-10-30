/**
 * Full end-to-end: OAuth flow + authenticated MCP call through the gateway.
 *
 * Prereqs (in separate terminals):
 *     npm run dev               # gateway on :4000
 *     npm run mock-upstream     # mock upstream MCP on :5001
 *
 * Then:
 *     npm run full-e2e
 *
 * What it asserts:
 *  1. Unauthenticated POST /memory-demo/mcp → 401 with WWW-Authenticate
 *     containing resource_metadata URL.
 *  2. The metadata URL itself returns the AS + scopes.
 *  3. Full OAuth: discovery → DCR → /authorize approve → /token.
 *  4. Authenticated `initialize`, `tools/list`, `tools/call:echo`,
 *     `tools/call:whoami` all succeed and the upstream sees the right user.
 *
 * Note: The script seeds its own stub Google credential into the gateway DB
 * before running outbound credential vending steps [8] and [9].
 */

import { createHash, randomBytes } from "node:crypto";
import { getEnv } from "../src/config/env.js";
import { upsertCredential } from "../src/credentials/vault.js";
import { upsertPolicies } from "../src/policies/policies.js";

const GATEWAY = process.env.GATEWAY ?? "http://localhost:4000";
const SERVER_ID = process.env.SERVER_ID ?? "memory-demo";
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

async function main() {
  console.log(`▶ Gateway: ${GATEWAY}`);
  console.log(`▶ MCP URL: ${MCP_URL}`);

  await step("[1] Unauthenticated request → 401 with resource_metadata", async () => {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
      }),
    });
    assert(res.status === 401, `expected 401, got ${res.status}`);
    const wwwAuth = res.headers.get("www-authenticate") ?? "";
    assert(
      wwwAuth.toLowerCase().startsWith("bearer"),
      `WWW-Authenticate missing or wrong: ${wwwAuth}`
    );
    assert(
      wwwAuth.includes("resource_metadata="),
      `WWW-Authenticate missing resource_metadata: ${wwwAuth}`
    );
    console.log(`     WWW-Authenticate: ${wwwAuth}`);
  });

  let metadataUrl: string;
  await step("[2] Fetch protected-resource metadata", async () => {
    const wwwAuth =
      (
        await fetch(MCP_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).headers.get("www-authenticate") ?? "";
    const m = /resource_metadata="([^"]+)"/.exec(wwwAuth);
    assert(m, "no resource_metadata in WWW-Authenticate");
    metadataUrl = m[1];
    const meta = await expectJson(await fetch(metadataUrl), "metadata");
    assert(
      meta.resource && meta.authorization_servers?.length > 0,
      "metadata document malformed"
    );
    console.log(`     resource = ${meta.resource}`);
    console.log(`     authorization_servers = ${meta.authorization_servers.join(", ")}`);
  });

  // OAuth flow — abridged version of e2e.ts
  const disco = await expectJson(
    await fetch(`${GATEWAY}/.well-known/oauth-authorization-server`),
    "discovery"
  );
  const reg = await expectJson(
    await fetch(disco.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "full-e2e",
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
  console.log(`\n▶ Got access token. Proceeding to authenticated MCP calls.`);

  const env = getEnv();
  upsertCredential({
    user_subject: env.AUTH_DEFAULT_USER,
    provider: "google",
    credential_type: "oauth2",
    access_token: `e2e-stub-google-token-${randomBytes(8).toString("hex")}`,
    refresh_token: null,
    scope: "https://www.googleapis.com/auth/gmail.send",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    metadata: { stub: true, note: "seeded by full-e2e" },
  });
  console.log("▶ Seeded e2e stub Google credential");

  upsertPolicies({
    [SERVER_ID]: {
      echo: "allow",
      whoami: "allow",
      send_gmail_via_gateway: "allow",
    },
  });
  console.log("▶ Seeded e2e tool policies");

  await step("[3] Authenticated initialize", async () => {
    const result = await rpc(
      "initialize",
      { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "full-e2e", version: "0.0.1" } },
      accessToken
    );
    assert(result.protocolVersion, "no protocolVersion");
    assert(result.serverInfo?.name === "mock-upstream", "wrong serverInfo");
    console.log(`     protocolVersion=${result.protocolVersion} serverInfo=${result.serverInfo.name}`);
  });

  await step("[4] tools/list", async () => {
    const result = await rpc("tools/list", undefined, accessToken);
    assert(Array.isArray(result.tools) && result.tools.length >= 2, "no tools listed");
    console.log(`     tools=${result.tools.map((t: any) => t.name).join(", ")}`);
  });

  await step("[5] tools/call echo", async () => {
    const result = await rpc(
      "tools/call",
      { name: "echo", arguments: { text: "hola mundo" } },
      accessToken
    );
    const txt = result.content?.[0]?.text;
    assert(txt === "echo: hola mundo", `unexpected echo: ${txt}`);
  });

  await step("[6] tools/call whoami (verifies X-Forwarded-User propagation)", async () => {
    const result = await rpc("tools/call", { name: "whoami", arguments: {} }, accessToken);
    const txt = String(result.content?.[0]?.text ?? "");
    assert(
      txt.includes("demo-user@local"),
      `upstream did not see authenticated user: ${txt}`
    );
    console.log(`     upstream saw: ${txt}`);
  });

  await step("[7] Bad token → 401", async () => {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer not-a-real-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" }),
    });
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  // ─── Outbound credential vending (Phase 1 sketch) ────────────────────
  // The upstream mock has a tool that asks the gateway for a Google token
  // and "sends" a Gmail without implementing OAuth itself.
  await step("[8] tools/call send_gmail_via_gateway — outbound vending", async () => {
    const result = await rpc(
      "tools/call",
      {
        name: "send_gmail_via_gateway",
        arguments: {
          to: "friend@example.com",
          subject: "Hello from a serverless MCP",
          body: "This email was sent by an MCP server that does not implement OAuth.",
        },
      },
      accessToken
    );
    const txt = String(result.content?.[0]?.text ?? "");
    assert(
      txt.includes("Got Google token"),
      `expected report to contain 'Got Google token': ${txt}`
    );
    assert(
      txt.includes("Upstream code did NOT implement OAuth"),
      `expected disruption-narrative line: ${txt}`
    );
    console.log(`     upstream report: ${txt}`);
  });

  // Direct verification of the vending endpoint (bypassing the proxy).
  await step("[9] Direct GET /:server_id/credentials/google/token", async () => {
    const url = `${GATEWAY}/${SERVER_ID}/credentials/google/token`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert(res.ok, `vending endpoint returned ${res.status}`);
    const cred = await expectJson(res, "vending");
    assert(cred.access_token, "no access_token in vending response");
    assert(
      typeof cred.access_token === "string" &&
        cred.access_token.startsWith("e2e-stub-google-token-"),
      `expected access_token to start with 'e2e-stub-google-token-', got ${cred.access_token}`
    );
    assert(
      !("stub" in cred),
      `expected stub not in cred, got ${JSON.stringify(cred)}`
    );
    console.log(`     vended: provider=${cred.provider} scope=${cred.scope} expires_in=${cred.expires_in}`);
  });

  await step("[10] Vending without auth → 401", async () => {
    const url = `${GATEWAY}/${SERVER_ID}/credentials/google/token`;
    const res = await fetch(url);
    assert(res.status === 401, `expected 401, got ${res.status}`);
    const wwwAuth = res.headers.get("www-authenticate") ?? "";
    assert(wwwAuth.toLowerCase().startsWith("bearer"), "missing WWW-Authenticate");
  });

  console.log("\n✓ Full end-to-end (OAuth + proxied MCP + outbound vending) passed.");
}

main().catch((err) => {
  console.error("\n✗ Full e2e failed:", err);
  process.exit(1);
});

/**
 * End-to-end OAuth exercise.
 *
 *   1. Fetch discovery metadata
 *   2. Register a new client via DCR
 *   3. Drive /authorize with auto-approve to obtain a `code`
 *   4. Exchange the code + PKCE verifier for an access token (JWT)
 *   5. Decode the JWT and print its claims
 *   6. Exchange the refresh token for a new access token (rotation)
 *
 * Run while the server is up:
 *     npm run dev
 *     npx tsx scripts/e2e.ts
 */

import { createHash, randomBytes } from "node:crypto";
import { getConnectAdminToken } from "../src/credentials/admin-token.js";

const GATEWAY = process.env.GATEWAY ?? "http://localhost:4000";
const REDIRECT_URI = "http://localhost:9999/callback";

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function expectJson(res: Response, label: string): Promise<any> {
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
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

async function main(): Promise<void> {
  console.log(`▶ Gateway: ${GATEWAY}`);

  // 1. Discovery
  console.log("\n[1] GET /.well-known/oauth-authorization-server");
  const discoRes = await fetch(
    `${GATEWAY}/.well-known/oauth-authorization-server`
  );
  const disco = await expectJson(discoRes, "discovery");
  console.log(`    issuer = ${disco.issuer}`);
  console.log(`    authorize = ${disco.authorization_endpoint}`);
  console.log(`    token = ${disco.token_endpoint}`);
  console.log(`    register = ${disco.registration_endpoint}`);

  // 2. DCR
  console.log("\n[2] POST /register (DCR)");
  const regRes = await fetch(disco.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "mcp-e2e-test",
      redirect_uris: [REDIRECT_URI],
    }),
  });
  const reg = await expectJson(regRes, "register");
  console.log(`    client_id = ${reg.client_id}`);
  const clientId = reg.client_id as string;

  // 3. Authorize: GET first to confirm consent renders, then POST to approve
  const { verifier, challenge } = makePkce();
  const state = base64url(randomBytes(8));

  // The server doesn't expose a server-list endpoint to clients yet, so the
  // resource (which MCP server the token is for) is passed explicitly.
  const authQuery = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "mcp:read mcp:write",
    state,
    resource: `${GATEWAY}/${process.env.SERVER_ID ?? "memory-demo"}/mcp`,
  });

  console.log("\n[3a] GET /authorize");
  const authGetRes = await fetch(
    `${disco.authorization_endpoint}?${authQuery.toString()}`
  );
  if (authGetRes.status !== 200) {
    const body = await authGetRes.text();
    throw new Error(`/authorize GET = ${authGetRes.status}: ${body}`);
  }
  const consentHtml = await authGetRes.text();
  if (!consentHtml.includes("Approve")) {
    throw new Error("consent HTML missing Approve button");
  }
  console.log(`    consent screen rendered (${consentHtml.length} bytes)`);

  console.log("\n[3b] POST /authorize { decision: approve }");
  const form = new URLSearchParams(authQuery);
  // The HTML form would also carry the resolved resource. Replicate that.
  const resourceFromConsent =
    consentHtml.match(/Resource:\s*<code>[^(]*\(([^)]+)\)/)?.[1] ?? "";
  if (resourceFromConsent) {
    form.set("resource", resourceFromConsent);
  }
  form.set("decision", "approve");
  form.set("admin_token", getConnectAdminToken());

  const authPostRes = await fetch(disco.authorization_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual",
  });
  if (authPostRes.status !== 302) {
    const body = await authPostRes.text();
    throw new Error(`expected 302 redirect, got ${authPostRes.status}: ${body}`);
  }
  const location = authPostRes.headers.get("location");
  if (!location) throw new Error("no Location header");
  const redirectUrl = new URL(location);
  const code = redirectUrl.searchParams.get("code");
  const stateReturned = redirectUrl.searchParams.get("state");
  if (!code) throw new Error(`no code in redirect: ${location}`);
  if (stateReturned !== state) {
    throw new Error(`state mismatch: sent ${state}, got ${stateReturned}`);
  }
  console.log(`    code = ${code.slice(0, 12)}…  state ok`);

  // 4. Token exchange
  console.log("\n[4] POST /token (authorization_code)");
  const tokRes = await fetch(disco.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    }).toString(),
  });
  const tok = await expectJson(tokRes, "token");
  if (!tok.access_token) {
    throw new Error(`no access_token: ${JSON.stringify(tok)}`);
  }
  console.log(`    access_token  = ${String(tok.access_token).slice(0, 32)}…`);
  console.log(`    token_type    = ${tok.token_type}`);
  console.log(`    expires_in    = ${tok.expires_in}`);
  console.log(`    refresh_token = ${String(tok.refresh_token).slice(0, 16)}…`);
  console.log(`    scope         = ${tok.scope}`);

  // 5. Decode JWT (header + payload)
  const [h, p] = String(tok.access_token).split(".");
  const decode = (s: string) =>
    JSON.parse(
      Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
        "utf-8"
      )
    );
  console.log("\n[5] JWT decode");
  console.log("    header  =", decode(h));
  console.log("    payload =", decode(p));

  // 6. Refresh-token rotation
  console.log("\n[6] POST /token (refresh_token)");
  const refRes = await fetch(disco.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tok.refresh_token,
      client_id: clientId,
    }).toString(),
  });
  const ref = await expectJson(refRes, "refresh");
  if (!ref.access_token) {
    throw new Error(`refresh failed: ${JSON.stringify(ref)}`);
  }
  console.log(`    new access_token  = ${String(ref.access_token).slice(0, 32)}…`);
  console.log(`    new refresh_token = ${String(ref.refresh_token).slice(0, 16)}…`);

  console.log("\n✓ End-to-end OAuth flow passed.");
}

main().catch((err) => {
  console.error("\n✗ E2E failed:", err);
  process.exit(1);
});

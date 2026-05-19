/**
 * Interactive browser flow — emulates an MCP client.
 *
 * Run while the server is up:
 *     npm run dev
 *     npx tsx scripts/browser-flow.ts
 *
 * The script:
 *   1. Registers a new OAuth client via DCR.
 *   2. Starts a local HTTP listener on http://localhost:9999/callback to
 *      catch the redirect.
 *   3. Prints the /authorize URL — open it in your browser, see the consent
 *      screen, click Approve.
 *   4. Catches the redirect, exchanges the code + PKCE verifier, prints the
 *      decoded JWT.
 */

import { exec } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const GATEWAY = process.env.GATEWAY ?? "http://localhost:4000";
const CALLBACK_PORT = 9999;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;

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

function decodeJwt(token: string): { header: unknown; payload: unknown } {
  const [h, p] = token.split(".");
  const dec = (s: string) =>
    JSON.parse(
      Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
        "utf-8"
      )
    );
  return { header: dec(h), payload: dec(p) };
}

function tryOpenInBrowser(url: string): void {
  // Best-effort cross-platform open. Falls back silently — user can copy URL.
  if (process.platform === "win32") {
    exec(`start "" "${url}"`);
  } else if (process.platform === "darwin") {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}

async function waitForCallback(): Promise<{ code: string; state: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400).end("no url");
        return;
      }
      const u = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      if (u.pathname !== "/callback") {
        res.writeHead(404).end("not found");
        return;
      }
      const err = u.searchParams.get("error");
      if (err) {
        res.writeHead(400, { "content-type": "text/html" }).end(
          `<h1>Authorization denied</h1><p>${err}</p><p>You can close this window.</p>`
        );
        server.close();
        reject(new Error(`authorization error: ${err}`));
        return;
      }
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      if (!code || !state) {
        res.writeHead(400).end("missing code or state");
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(
          `<h1>Authorized</h1><p>Code captured. You can close this window and return to the terminal.</p>`
        );
      server.close();
      resolve({ code, state });
    });
    server.listen(CALLBACK_PORT);
    server.on("error", reject);
  });
}

async function main(): Promise<void> {
  console.log(`▶ Gateway: ${GATEWAY}`);
  console.log(`▶ Callback listener: ${REDIRECT_URI}`);

  // 1. Discovery
  const disco = (await (
    await fetch(`${GATEWAY}/.well-known/oauth-authorization-server`)
  ).json()) as Record<string, string>;
  console.log(`\n[1] discovery ok — issuer = ${disco.issuer}`);

  // 2. DCR
  const reg = (await (
    await fetch(disco.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "browser-flow-demo",
        redirect_uris: [REDIRECT_URI],
      }),
    })
  ).json()) as Record<string, string>;
  console.log(`[2] DCR ok — client_id = ${reg.client_id}`);

  // 3. Build /authorize URL
  const { verifier, challenge } = makePkce();
  const state = base64url(randomBytes(8));
  const authUrl = new URL(disco.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", reg.client_id);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("scope", "mcp:read mcp:write");
  authUrl.searchParams.set("state", state);

  console.log("\n[3] Open this URL in your browser:");
  console.log("    " + authUrl.toString());
  console.log("    (attempting to open it for you…)");
  tryOpenInBrowser(authUrl.toString());

  console.log(
    "\n    Waiting for callback on " + REDIRECT_URI + " — click Approve.\n"
  );

  // 4. Catch callback
  const { code, state: returnedState } = await waitForCallback();
  if (returnedState !== state) {
    throw new Error(`state mismatch: sent ${state}, got ${returnedState}`);
  }
  console.log(`[4] callback ok — code = ${code.slice(0, 16)}…`);

  // 5. Exchange code for token
  const tok = (await (
    await fetch(disco.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: reg.client_id,
        redirect_uri: REDIRECT_URI,
      }).toString(),
    })
  ).json()) as Record<string, string>;

  if (!tok.access_token) {
    throw new Error(`token exchange failed: ${JSON.stringify(tok)}`);
  }

  console.log(`\n[5] token exchange ok`);
  console.log(`    access_token  = ${tok.access_token.slice(0, 40)}…`);
  console.log(`    refresh_token = ${String(tok.refresh_token).slice(0, 20)}…`);
  console.log(`    expires_in    = ${tok.expires_in}`);

  const { header, payload } = decodeJwt(tok.access_token);
  console.log("\n[6] decoded JWT:");
  console.log("    header  =", header);
  console.log("    payload =", payload);

  console.log("\n✓ Browser flow complete.");
}

main().catch((err) => {
  console.error("\n✗ Browser flow failed:", err);
  process.exit(1);
});

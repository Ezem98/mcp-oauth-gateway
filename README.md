# mcp-oauth-gateway

**Wrap any MCP server with OAuth 2.1 + PKCE + Dynamic Client Registration without touching the server's code.**

> Status: technical spike. Goal is to validate end-to-end the OAuth flow that the MCP spec requires, and demonstrate that a stock upstream MCP server can sit behind the gateway and only accept authenticated traffic.

## Why this exists

Per the May 2026 MCP ecosystem audit:

- **53% of MCP servers use static API keys.** Only 8.5% implement OAuth 2.1.
- The MCP authorization spec (2025-03-26) **requires** OAuth 2.1 + PKCE for remote servers, plus Dynamic Client Registration (RFC 7591) so clients like Claude Desktop / Cursor can self-onboard.
- Authors of MCP servers consistently report that wiring OAuth takes a weekend and they often shelf it. Static API keys persist by default.
- The hosted offerings (Metorial, Composio, Smithery, Cloudflare) bundle auth into hosting, leaving "I want to keep hosting my server but offload only auth" without a clean solution.

This gateway is the **unbundled auth layer**. The MCP server stays where it is (your machine, a VPS, Cloudflare Workers, anywhere). The gateway sits in front, speaks the MCP authorization spec to the client, and forwards authenticated requests to the upstream with a service credential.

## How this compares to other auth tools

Several adjacent products are also moving toward MCP. We are not competing on the same axis as any of them — the segment of MCP authors we serve is *"I have (or am writing) an MCP server in any language, and I do not want auth to live inside my server's code."*

| Aspect | **mcp-oauth-gateway** | **Better Auth** | **Auth0 / Clerk / WorkOS** | **Metorial / Smithery / Composio** |
|---|---|---|---|---|
| Touch the MCP server's code? | **No** | Yes (`npm install` + 20 lines) | Yes (SDK in your server) | Hosting-bundled — you can't unbundle |
| Works with existing MCP servers? | **Yes**, drop in | Only TS/Node, requires refactor | Only with SDK + code | Only if you migrate hosting there |
| Language of MCP server? | **Any** (proxy is transport-only) | TS/Node only | Any (with SDK) | Any |
| MCP authorization spec (2025-06-18) | **Built-in** (DCR, PKCE, resource indicators, protected-resource metadata) | Library helpers; you assemble | Generic OAuth — you wire to MCP | Built-in only inside their hosting |
| Self-hostable? | **Yes** | Yes (you host your whole app) | No (SaaS) | No (SaaS) |
| Stays alongside your existing hosting? | **Yes** | N/A | N/A | No (replaces it) |
| Open source | Apache-2.0 (planned) | Yes | No | No |
| Outbound credential vending (Gmail, Stripe, … on behalf of users) | **Roadmap** — see "Disruption surface" below | No | Indirect, via APIs | Yes, bundled with hosting |
| Audit log + per-tool replay | **Roadmap** | No | Generic logs, not tool-aware | Varies |

### TL;DR — who should pick what

- Writing a **fresh MCP server in TypeScript**? Use **Better Auth**. Smaller surface, no extra hop.
- Already standardized on **Auth0 / Clerk / WorkOS** at the enterprise level? Keep them. You can federate them as the IdP behind this gateway when that ships.
- Want **hosting + auth + integrations** in one bill? Use **Metorial / Smithery / Composio**.
- Have an **existing MCP server (any language) and don't want to touch its code**, or want **auth and hosting to be different teams' problems** → that's us.

## Architecture (target)

```
┌────────────────┐     OAuth + MCP       ┌──────────────────────────┐
│ MCP client     │ ────────────────────▶ │ mcp-oauth-gateway        │
│ (Claude        │                       │                          │
│  Desktop,      │ ◀─── 401 + WWW-Auth   │  • discovery             │
│  Cursor,       │      header           │  • /register (DCR)       │
│  inspector,    │ ◀─── auth code +      │  • /authorize (PKCE)     │
│  curl)         │      access token     │  • /token                │
│                │                       │  • policy lookup         │
│                │ ────────────────────▶ │  • upstream proxy        │
└────────────────┘                       └────────────┬─────────────┘
                                                      │ service auth
                                                      ▼
                                          ┌──────────────────────────┐
                                          │ Upstream MCP server      │
                                          │ (unchanged code)         │
                                          └──────────────────────────┘
```

## What this spike will prove (or not)

Success criterion: a stock MCP client (Claude Desktop or the official MCP inspector) can connect to a public-URL gateway, complete the OAuth flow with no human-side configuration beyond pasting the gateway URL, and use an upstream MCP server (Anthropic's `@modelcontextprotocol/server-memory`) that does not know auth exists.

If we get that working, the unbundled OAuth-gateway hypothesis is technically validated and customer-development can start with maintainers of popular MCP servers.

## Preview: Outbound credential vending (Phase 1 sketch)

Inbound auth is half the problem. The MCP servers worth deploying almost always need to call third-party APIs (Gmail, Stripe, GitHub, Slack, Notion, …) on the user's behalf — and today **53% of MCP servers ship with static API keys** because implementing OAuth for every downstream is a weekend each.

This gateway includes a **sketch** of the inverse flow: the MCP server *asks the gateway* for a short-lived token instead of doing OAuth itself.

```
MCP client                    Gateway                       MCP server (any lang)
    │                            │                                  │
    │  call tool send_email      │                                  │
    │ ─────────────────────────▶ │                                  │
    │                            │     forward + X-Gateway-User-*   │
    │                            │ ────────────────────────────────▶│
    │                            │                                  │
    │                            │ ◀── GET /credentials/google ──── │
    │                            │     (uses user's bearer token)   │
    │                            │                                  │
    │                            │ ── { access_token, scope } ─────▶│
    │                            │                                  │
    │                            │                                  ├─▶ Gmail API
    │                            │                                  │
    │                            │ ◀── tool result ─────────────────│
    │ ◀────────────────────────  │                                  │
```

The MCP server **never implements OAuth**, **never sees secrets**, **never refreshes tokens**.

### How the spike demonstrates it

The included `mock-upstream` exposes a tool called `send_gmail_via_gateway`. When called, the tool:

1. Reads `X-Gateway-User-Token` and `X-Gateway-Url` from the headers the gateway injected.
2. Calls `GET <gateway>/<server_id>/credentials/google/token` with the user's bearer token.
3. Receives a (stub) Google access token + scope.
4. "Sends" the email and returns a confirmation.

Run the full e2e (`npm run full-e2e`) and look at steps 8–10:

```
▶ [8] tools/call send_gmail_via_gateway — outbound vending
     upstream report: [mock] Got Google token (stub=true, scope=…/gmail.send).
     Upstream code did NOT implement OAuth — gateway vended the credential.

▶ [9] Direct GET /:server_id/credentials/google/token
     vended: provider=google scope=…/gmail.send expires_in=3596

▶ [10] Vending without auth → 401
```

### What's stubbed vs real in the spike

| Concern | Spike state | Phase 1.5 plan |
|---|---|---|
| Credential storage | SQLite `credential_vault` row, seeded on boot | Same table; populated by real OAuth flows |
| Google OAuth flow (gateway → Google) | **Not implemented** — token is a placeholder | PKCE flow + refresh + scope brokering |
| Upstream auth to call /credentials | User's bearer (same `aud`, same server) | RFC 8693 token exchange for a downscoped credential token |
| Audit | Logs only | Per-call row in DB with caller, server, provider, scope, outcome |
| Providers | google only (stub) | google, github, slack, notion (real OAuth each) |

## What's deliberately out of scope (for the spike)

- Multi-tenant admin UI (one demo server, hardcoded in env)
- Production-grade key management (JWT key generated locally, no KMS)
- SSE legacy transport (Streamable HTTP only)
- Billing / marketplace / observability dashboards
- Token revocation flows
- Refresh tokens (acceptable for spike, comes next)
- Anything beyond a single-process Node app + SQLite

## Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 20 + tsx | Fast iteration, matches author's existing toolchain |
| HTTP | Hono | Light, fast, easy SSE/streaming support for MCP |
| Storage | SQLite via `better-sqlite3` | Zero-setup, sufficient for a spike |
| Crypto | `jose` (JWT) | OAuth Authorization Server primitives |
| Validation | Zod | Schema-first endpoints |

`oidc-provider` (the standard OIDC server lib) was considered but rejected for the spike — it's Express-coupled and the MCP authorization spec is small enough to implement directly. Migrating to `oidc-provider` later is reasonable if production demands it.

## Spike plan

| Day | Goal | Verifiable output |
|---|---|---|
| 1 | Scaffold + Hono server + storage schema | `npm run dev` boots, `GET /health` returns OK, DB initialized |
| 2 | OAuth Authorization Server endpoints (discovery, DCR, /authorize, /token) with PKCE | `curl` end-to-end: register a client, get auth code, exchange for token |
| 3 | Gateway proxy with auth check + Streamable HTTP forwarding | Upstream `server-memory` reachable only with a valid Bearer token |
| 4 | End-to-end demo wiring + recorded walkthrough | Claude Desktop or MCP Inspector successfully talks to the gateway, OAuth completes, tools call through |

## Layout

```
mcp-oauth-gateway/
├── src/
│   ├── server.ts                # Hono bootstrap, mounts all sub-routes
│   ├── config/env.ts            # Zod-validated env
│   ├── observability/logger.ts
│   ├── db/
│   │   ├── client.ts
│   │   └── schema.sql           # oauth_clients, authorization_codes, access_tokens,
│   │                            # refresh_tokens, mcp_servers, signing_keys,
│   │                            # credential_vault
│   ├── oauth/
│   │   ├── router.ts            # Hono sub-router that mounts the four endpoints below
│   │   ├── discovery.ts         # /.well-known/oauth-authorization-server, jwks.json,
│   │   │                        # oauth-protected-resource/:server/mcp (RFC 9728)
│   │   ├── register.ts          # POST /register — DCR (RFC 7591)
│   │   ├── authorize.ts         # GET + POST /authorize (HTML consent + PKCE)
│   │   ├── token.ts             # POST /token (auth_code + refresh grants)
│   │   ├── pkce.ts              # S256 verifier
│   │   ├── keys.ts              # ES256 keypair lifecycle
│   │   ├── jwt.ts               # sign + verify access tokens (RFC 9068)
│   │   ├── scopes.ts            # mcp:read, mcp:write
│   │   ├── clients.ts           # DCR storage
│   │   ├── codes.ts             # authorization code storage
│   │   ├── refresh.ts           # opaque refresh tokens (rotating)
│   │   ├── servers.ts           # MCP server registry + resource URI helpers
│   │   └── identity.ts          # IdentityProvider interface + DemoIdentityProvider
│   ├── gateway/
│   │   ├── route.ts             # /:server_id/mcp (POST/GET/DELETE)
│   │   ├── auth-middleware.ts   # Bearer verify + WWW-Authenticate w/ resource_metadata
│   │   └── forwarder.ts         # stream-aware reverse proxy
│   └── credentials/
│       ├── route.ts             # GET /:server_id/credentials/:provider/token  (Phase 1 sketch)
│       └── vault.ts             # credential_vault CRUD + seedDemoCredentials()
├── scripts/
│   ├── e2e.ts                   # OAuth dance only (no MCP traffic)
│   ├── browser-flow.ts          # Interactive — opens the consent screen in your browser
│   ├── mock-upstream.ts         # Mock upstream MCP server (JSON-RPC over HTTP)
│   └── full-e2e.ts              # OAuth + proxy + outbound vending, 10 assertions
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

## How to read this repo

If you're a maintainer of an MCP server and want to evaluate whether wrapping your server with us makes sense:

1. Skim **`scripts/full-e2e.ts`** — that's the demo as a script.
2. Read **`src/gateway/`** (~200 lines) to see how the proxy + auth middleware work.
3. Read **`src/credentials/route.ts`** to see the Phase 1 sketch of outbound vending.
4. Skim **`src/oauth/`** if you want to see the OAuth Authorization Server itself.

The full surface is ~1500 lines of TypeScript across ~20 files. No build step at runtime, no external dependencies beyond Hono, better-sqlite3, and `jose`.

## Running the demo

You'll need three terminals.

```bash
# T1 — the gateway
npm install
npm run dev                  # http://localhost:4000

# T2 — the mock upstream MCP server
npm run mock-upstream        # http://localhost:5001/mcp

# T3 — exercise the full flow programmatically
npm run full-e2e             # asserts 10 things, exits 0 on success
```

To see the OAuth consent screen yourself instead of having the script auto-approve:

```bash
npm run browser-flow         # opens your browser at /authorize
```

### Connecting Anthropic's MCP Inspector

The inspector is the canonical "stock MCP client" — if it works against the gateway, every other client should too.

```bash
# T4 — the inspector (separate process, no install needed)
npx @modelcontextprotocol/inspector
```

In the inspector UI:

- **Transport:** Streamable HTTP
- **URL:** `http://localhost:4000/memory-demo/mcp`

Click *Connect*. The inspector will:

1. Hit the URL → receive `401 WWW-Authenticate: ... resource_metadata=...`
2. Fetch the protected-resource metadata to discover the AS
3. Hit `/.well-known/oauth-authorization-server` → discover endpoints
4. Call `/register` (DCR) → get a `client_id`
5. Open the consent page in your browser → approve
6. Exchange the code at `/token` → cache the access token
7. Re-issue the original `initialize` request with the Bearer token → 200

Once connected, `tools/list` should show `echo`, `whoami`, and `send_gmail_via_gateway`. Calling the last one demonstrates the outbound vending sketch end-to-end.

### Connecting Claude Desktop

Add to `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "memory-demo-via-gateway": {
      "transport": {
        "type": "http",
        "url": "http://localhost:4000/memory-demo/mcp"
      }
    }
  }
}
```

Restart Claude Desktop. The OAuth flow triggers the first time it tries to load the tools.

## Recording the demo

For the maintainer outreach deck we need a ~2 minute screen capture. Suggested script:

1. Show the upstream code: `scripts/mock-upstream.ts`. **Point out: zero auth code, zero OAuth code, zero secrets.** It's just JSON-RPC.
2. Open the inspector. Paste the gateway URL. Click *Connect*.
3. Browser opens at the consent screen. Read the resource line. Click *Approve*.
4. Inspector now lists tools. Call `whoami` first — show the authenticated identity makes it to the upstream.
5. Call `send_gmail_via_gateway` with some args. Show the response: *"Upstream code did NOT implement OAuth — gateway vended the credential."*
6. Switch to the gateway's terminal and scroll through the logs: `Issued authorization code` → `Issued access token` → `Proxied MCP request` → `Vended downstream credential`.
7. Close with the pitch: "Two integration problems — inbound auth and outbound credentials — solved without your MCP server changing a single line."

Capture with OBS or Loom. Sub-3-minute version is the goal; longer cuts can come later.

## License

TBD — likely Apache-2.0 once the prototype matures.

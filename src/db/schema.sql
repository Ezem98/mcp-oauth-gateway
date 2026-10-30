-- OAuth dynamically-registered clients (RFC 7591)
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret TEXT,              -- optional; public clients (PKCE) may have none
  client_name TEXT,
  redirect_uris TEXT NOT NULL,     -- JSON array
  grant_types TEXT NOT NULL,       -- JSON array
  response_types TEXT NOT NULL,    -- JSON array
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  scope TEXT,
  metadata_json TEXT,              -- raw DCR payload, for debugging
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Short-lived authorization codes pending PKCE exchange
CREATE TABLE IF NOT EXISTS authorization_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  user_subject TEXT NOT NULL,      -- 'sub' claim for the eventual access token
  redirect_uri TEXT NOT NULL,
  scope TEXT,
  code_challenge TEXT NOT NULL,    -- PKCE
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  resource TEXT,                   -- RFC 8707: which MCP server this code is scoped to
  expires_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_authorization_codes_expires_at
  ON authorization_codes(expires_at);

-- Issued access tokens — we mostly rely on the JWT itself for validation,
-- but a row here lets us revoke and audit.
CREATE TABLE IF NOT EXISTS access_tokens (
  jti TEXT PRIMARY KEY,            -- JWT ID
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  user_subject TEXT NOT NULL,
  resource TEXT NOT NULL,          -- which MCP server this token grants access to
  scope TEXT,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_access_tokens_user
  ON access_tokens(user_subject, expires_at);

-- Opaque refresh tokens (rotating). Not JWTs.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  user_subject TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT,
  expires_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user
  ON refresh_tokens(user_subject, expires_at);

-- Configured upstream MCP servers (registry).
-- For the spike we seed one row from env on boot; later this becomes admin-managed.
CREATE TABLE IF NOT EXISTS mcp_servers (
  server_id TEXT PRIMARY KEY,
  display_name TEXT,
  upstream_url TEXT NOT NULL,
  upstream_auth_header TEXT,       -- e.g. "Authorization: Bearer xxx" passed to upstream
  required_scope TEXT,             -- optional scope string a token must contain
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- JWT signing keypair (single row, generated on first boot if absent).
CREATE TABLE IF NOT EXISTS signing_keys (
  kid TEXT PRIMARY KEY,
  alg TEXT NOT NULL,
  private_jwk TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Outbound credential vault.
-- The gateway custodies third-party credentials (Google, GitHub, Slack, ...)
-- on behalf of users so an MCP server can ask the gateway for a fresh access
-- token instead of implementing its own OAuth dance for every downstream API.
--
-- This is the spike-level sketch — Phase 1.5 will replace the stub with real
-- OAuth flows (PKCE outbound, token refresh, scope brokering, audit).
CREATE TABLE IF NOT EXISTS credential_vault (
  id TEXT PRIMARY KEY,
  user_subject TEXT NOT NULL,
  provider TEXT NOT NULL,             -- 'google', 'github', 'slack', ...
  credential_type TEXT NOT NULL,      -- 'oauth2' | 'api_key'
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  scope TEXT,
  expires_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_subject, provider)
);
CREATE INDEX IF NOT EXISTS idx_credential_vault_user_provider
  ON credential_vault(user_subject, provider);

-- Outbound OAuth state tokens pending authorization callback (PKCE)
CREATE TABLE IF NOT EXISTS outbound_oauth_states (
  state TEXT PRIMARY KEY,
  user_subject TEXT NOT NULL,
  provider TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_outbound_oauth_states_expires_at
  ON outbound_oauth_states(expires_at);

-- Tool allow/deny policies per MCP server
CREATE TABLE IF NOT EXISTS tool_policies (
  server_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (server_id, tool_name)
);

-- Audit log of gateway actions
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  user_subject TEXT,
  client_id TEXT,
  server_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('tool_call','credential_vend','policy_block','connect')),
  tool_name TEXT,
  args_summary TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','error','blocked')),
  status INTEGER,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);

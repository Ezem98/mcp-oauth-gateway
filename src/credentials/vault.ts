import { nanoid } from "nanoid";
import { getDb } from "../db/client.js";
import { logger } from "../observability/logger.js";

export interface VaultCredential {
  id: string;
  user_subject: string;
  provider: string;
  credential_type: "oauth2" | "api_key";
  access_token: string;
  refresh_token: string | null;
  scope: string | null;
  expires_at: string | null;
  metadata: Record<string, unknown> | null;
}

interface VaultRow {
  id: string;
  user_subject: string;
  provider: string;
  credential_type: "oauth2" | "api_key";
  access_token: string;
  refresh_token: string | null;
  scope: string | null;
  expires_at: string | null;
  metadata_json: string | null;
}

function rowToCredential(row: VaultRow): VaultCredential {
  return {
    id: row.id,
    user_subject: row.user_subject,
    provider: row.provider,
    credential_type: row.credential_type,
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    scope: row.scope,
    expires_at: row.expires_at,
    metadata: row.metadata_json
      ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
      : null,
  };
}

export function getCredential(
  userSubject: string,
  provider: string
): VaultCredential | null {
  const row = getDb()
    .prepare(
      `SELECT id, user_subject, provider, credential_type, access_token,
              refresh_token, scope, expires_at, metadata_json
       FROM credential_vault
       WHERE user_subject = ? AND provider = ?`
    )
    .get(userSubject, provider) as VaultRow | undefined;
  return row ? rowToCredential(row) : null;
}

export interface UpsertCredentialInput {
  user_subject: string;
  provider: string;
  credential_type: "oauth2" | "api_key";
  access_token: string;
  refresh_token?: string | null;
  scope?: string | null;
  expires_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

export function upsertCredential(input: UpsertCredentialInput): VaultCredential {
  const existing = getCredential(input.user_subject, input.provider);
  const id = existing?.id ?? nanoid(16);

  getDb()
    .prepare(
      `INSERT INTO credential_vault (
        id, user_subject, provider, credential_type, access_token,
        refresh_token, scope, expires_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_subject, provider) DO UPDATE SET
        credential_type = excluded.credential_type,
        access_token    = excluded.access_token,
        refresh_token   = excluded.refresh_token,
        scope           = excluded.scope,
        expires_at      = excluded.expires_at,
        metadata_json   = excluded.metadata_json,
        updated_at      = datetime('now')`
    )
    .run(
      id,
      input.user_subject,
      input.provider,
      input.credential_type,
      input.access_token,
      input.refresh_token ?? null,
      input.scope ?? null,
      input.expires_at ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null
    );

  return getCredential(input.user_subject, input.provider)!;
}

/**
 * Seed a stub Google credential for the demo user so the outbound-vending
 * sketch returns something instead of 404. Phase 1.5 replaces this with
 * a real OAuth flow against Google.
 */
export function seedDemoCredentials(demoUserSubject: string): void {
  const existing = getCredential(demoUserSubject, "google");
  if (existing) return;

  upsertCredential({
    user_subject: demoUserSubject,
    provider: "google",
    credential_type: "oauth2",
    access_token: `stub-google-token-${nanoid(8)}`,
    refresh_token: `stub-google-refresh-${nanoid(8)}`,
    scope: "https://www.googleapis.com/auth/gmail.send",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    metadata: {
      note: "Spike stub — not a real Google token. Phase 1.5 replaces this with the real PKCE flow.",
      stub: true,
    },
  });

  logger.info("Seeded stub Google credential for demo user", {
    user: demoUserSubject,
  });
}

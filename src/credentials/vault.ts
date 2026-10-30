import { nanoid } from "nanoid";
import { getDb } from "../db/client.js";
import { decryptSecret, encryptSecret, getVaultKey } from "./crypto.js";

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
  const key = getVaultKey();
  return {
    id: row.id,
    user_subject: row.user_subject,
    provider: row.provider,
    credential_type: row.credential_type,
    access_token: decryptSecret(row.access_token, key),
    refresh_token:
      row.refresh_token != null ? decryptSecret(row.refresh_token, key) : null,
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
  // Look up only the id so a row we can't decrypt (e.g. a legacy plaintext
  // row, or one written with another key) can still be overwritten.
  const existing = getDb()
    .prepare(
      "SELECT id FROM credential_vault WHERE user_subject = ? AND provider = ?"
    )
    .get(input.user_subject, input.provider) as { id: string } | undefined;
  const id = existing?.id ?? nanoid(16);
  const key = getVaultKey();

  const encryptedAccessToken = encryptSecret(input.access_token, key);
  const encryptedRefreshToken =
    input.refresh_token != null
      ? encryptSecret(input.refresh_token, key)
      : null;

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
      encryptedAccessToken,
      encryptedRefreshToken,
      input.scope ?? null,
      input.expires_at ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null
    );

  return getCredential(input.user_subject, input.provider)!;
}

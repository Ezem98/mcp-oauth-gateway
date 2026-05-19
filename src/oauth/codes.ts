import { nanoid } from "nanoid";
import { getDb } from "../db/client.js";

const AUTH_CODE_TTL_SECONDS = 60;

export interface AuthCodeRecord {
  code: string;
  client_id: string;
  user_subject: string;
  redirect_uri: string;
  scope: string | null;
  code_challenge: string;
  code_challenge_method: string;
  resource: string;
  expires_at: string;
  consumed: number;
}

export interface CreateAuthCodeInput {
  client_id: string;
  user_subject: string;
  redirect_uri: string;
  scope: string | null;
  code_challenge: string;
  code_challenge_method: string;
  resource: string;
}

export function createAuthCode(input: CreateAuthCodeInput): {
  code: string;
  expiresInSeconds: number;
} {
  const code = nanoid(32);
  const expiresAt = new Date(
    Date.now() + AUTH_CODE_TTL_SECONDS * 1000
  ).toISOString();

  getDb()
    .prepare(
      `INSERT INTO authorization_codes (
        code, client_id, user_subject, redirect_uri, scope,
        code_challenge, code_challenge_method, resource, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      code,
      input.client_id,
      input.user_subject,
      input.redirect_uri,
      input.scope,
      input.code_challenge,
      input.code_challenge_method,
      input.resource,
      expiresAt
    );

  return { code, expiresInSeconds: AUTH_CODE_TTL_SECONDS };
}

/**
 * Look up an auth code WITHOUT consuming it. The caller is responsible for
 * marking it consumed after PKCE verification + client_id match.
 */
export function getAuthCode(code: string): AuthCodeRecord | null {
  const row = getDb()
    .prepare(
      `SELECT code, client_id, user_subject, redirect_uri, scope,
              code_challenge, code_challenge_method, resource, expires_at, consumed
       FROM authorization_codes WHERE code = ?`
    )
    .get(code) as AuthCodeRecord | undefined;

  return row ?? null;
}

export function consumeAuthCode(code: string): void {
  getDb()
    .prepare("UPDATE authorization_codes SET consumed = 1 WHERE code = ?")
    .run(code);
}

export function isExpired(record: AuthCodeRecord): boolean {
  return new Date(record.expires_at).getTime() < Date.now();
}

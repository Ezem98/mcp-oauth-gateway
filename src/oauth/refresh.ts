import { nanoid } from "nanoid";
import { getDb } from "../db/client.js";

const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface RefreshTokenRecord {
  token: string;
  client_id: string;
  user_subject: string;
  resource: string;
  scope: string | null;
  expires_at: string;
  consumed: number;
}

export interface CreateRefreshTokenInput {
  client_id: string;
  user_subject: string;
  resource: string;
  scope: string | null;
}

export function createRefreshToken(input: CreateRefreshTokenInput): {
  token: string;
  expiresInSeconds: number;
} {
  const token = `rt_${nanoid(40)}`;
  const expiresAt = new Date(
    Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000
  ).toISOString();

  getDb()
    .prepare(
      `INSERT INTO refresh_tokens (
        token, client_id, user_subject, resource, scope, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      token,
      input.client_id,
      input.user_subject,
      input.resource,
      input.scope,
      expiresAt
    );

  return { token, expiresInSeconds: REFRESH_TOKEN_TTL_SECONDS };
}

export function getRefreshToken(token: string): RefreshTokenRecord | null {
  const row = getDb()
    .prepare(
      `SELECT token, client_id, user_subject, resource, scope, expires_at, consumed
       FROM refresh_tokens WHERE token = ?`
    )
    .get(token) as RefreshTokenRecord | undefined;
  return row ?? null;
}

export function consumeRefreshToken(token: string): void {
  getDb()
    .prepare("UPDATE refresh_tokens SET consumed = 1 WHERE token = ?")
    .run(token);
}

export function isRefreshExpired(record: RefreshTokenRecord): boolean {
  return new Date(record.expires_at).getTime() < Date.now();
}

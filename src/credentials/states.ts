import { createHash, randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { getDb } from "../db/client.js";

const OUTBOUND_STATE_TTL_MS = 10 * 60 * 1000;

export interface OutboundStateRecord {
  state: string;
  user_subject: string;
  provider: string;
  code_verifier: string;
  expires_at: string;
  consumed: number;
  created_at: string;
}

/**
 * Generate a new PKCE-protected outbound OAuth state for a user and provider.
 * The state and verifier are recorded in the DB with a 10-minute TTL.
 */
export function createOutboundState(
  userSubject: string,
  provider: string
): { state: string; codeChallenge: string } {
  const state = nanoid(32);
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  const expiresAt = new Date(Date.now() + OUTBOUND_STATE_TTL_MS).toISOString();

  getDb()
    .prepare(
      `INSERT INTO outbound_oauth_states (
        state, user_subject, provider, code_verifier, expires_at
      ) VALUES (?, ?, ?, ?, ?)`
    )
    .run(state, userSubject, provider, codeVerifier, expiresAt);

  return { state, codeChallenge };
}

/**
 * Atomically validate and consume an outbound state token.
 * Single use: marks the state consumed even when expired.
 * Returns null if missing, wrong provider, already consumed, or expired.
 */
export function consumeOutboundState(
  state: string,
  provider: string
): { user_subject: string; code_verifier: string } | null {
  const db = getDb();
  const runTx = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT state, user_subject, provider, code_verifier, expires_at, consumed, created_at
         FROM outbound_oauth_states
         WHERE state = ?`
      )
      .get(state) as OutboundStateRecord | undefined;

    if (!row) {
      return null;
    }

    if (row.consumed !== 0) {
      return null;
    }

    if (row.provider !== provider) {
      return null;
    }

    const isExpired = new Date(row.expires_at).getTime() <= Date.now();
    if (isExpired) {
      db.prepare(
        "UPDATE outbound_oauth_states SET consumed = 1 WHERE state = ?"
      ).run(state);
      return null;
    }

    db.prepare(
      "UPDATE outbound_oauth_states SET consumed = 1 WHERE state = ?"
    ).run(state);

    return {
      user_subject: row.user_subject,
      code_verifier: row.code_verifier,
    };
  });

  return runTx();
}

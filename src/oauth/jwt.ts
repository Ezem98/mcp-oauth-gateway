import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { nanoid } from "nanoid";
import { getDb } from "../db/client.js";
import { getActiveSigningKey } from "./keys.js";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 min

export interface AccessTokenClaims extends JWTPayload {
  iss: string;
  sub: string;
  aud: string;
  client_id: string;
  scope: string;
  jti: string;
  iat: number;
  exp: number;
}

export interface SignAccessTokenInput {
  issuer: string;
  subject: string;
  audience: string;
  clientId: string;
  scope: string;
}

/**
 * Sign a JWT access token and persist a row for revocation/audit.
 */
export async function signAccessToken(
  input: SignAccessTokenInput
): Promise<{ token: string; jti: string; expiresIn: number }> {
  const key = await getActiveSigningKey();
  const jti = nanoid(16);
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ACCESS_TOKEN_TTL_SECONDS;

  const token = await new SignJWT({
    client_id: input.clientId,
    scope: input.scope,
  })
    .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: "at+jwt" })
    .setIssuer(input.issuer)
    .setSubject(input.subject)
    .setAudience(input.audience)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(key.privateKey);

  getDb()
    .prepare(
      `INSERT INTO access_tokens (jti, client_id, user_subject, resource, scope, expires_at)
       VALUES (?, ?, ?, ?, ?, datetime(?, 'unixepoch'))`
    )
    .run(jti, input.clientId, input.subject, input.audience, input.scope, exp);

  return { token, jti, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

export async function verifyAccessToken(
  token: string,
  expectedIssuer: string,
  expectedAudience: string
): Promise<AccessTokenClaims> {
  const key = await getActiveSigningKey();
  const { payload } = await jwtVerify(token, key.publicKey, {
    issuer: expectedIssuer,
    audience: expectedAudience,
    algorithms: ["ES256"],
  });
  return payload as AccessTokenClaims;
}

import { exportJWK, generateKeyPair, importJWK, type JWK } from "jose";
import { nanoid } from "nanoid";
import { getDb } from "../db/client.js";
import { logger } from "../observability/logger.js";

export interface SigningKey {
  kid: string;
  alg: "ES256";
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicJwk: JWK;
}

let _cached: SigningKey | null = null;

interface SigningKeyRow {
  kid: string;
  alg: string;
  private_jwk: string;
  public_jwk: string;
}

/**
 * Loads the active signing key from DB, generating one on first run.
 * Singleton — keys are immutable for the life of the process.
 */
export async function getActiveSigningKey(): Promise<SigningKey> {
  if (_cached) return _cached;

  const db = getDb();
  const existing = db
    .prepare(
      "SELECT kid, alg, private_jwk, public_jwk FROM signing_keys WHERE active = 1 ORDER BY created_at DESC LIMIT 1"
    )
    .get() as SigningKeyRow | undefined;

  if (existing) {
    const privateJwk = JSON.parse(existing.private_jwk) as JWK;
    const publicJwk = JSON.parse(existing.public_jwk) as JWK;
    const privateKey = (await importJWK(privateJwk, existing.alg)) as CryptoKey;
    const publicKey = (await importJWK(publicJwk, existing.alg)) as CryptoKey;
    _cached = {
      kid: existing.kid,
      alg: "ES256",
      privateKey,
      publicKey,
      publicJwk: { ...publicJwk, kid: existing.kid, alg: existing.alg },
    };
    logger.debug("Loaded signing key", { kid: existing.kid });
    return _cached;
  }

  // Generate a new ES256 keypair
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const kid = nanoid(12);
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);

  db.prepare(
    `INSERT INTO signing_keys (kid, alg, private_jwk, public_jwk, active)
     VALUES (?, 'ES256', ?, ?, 1)`
  ).run(kid, JSON.stringify(privateJwk), JSON.stringify(publicJwk));

  logger.info("Generated new ES256 signing key", { kid });

  _cached = {
    kid,
    alg: "ES256",
    privateKey,
    publicKey,
    publicJwk: { ...publicJwk, kid, alg: "ES256" },
  };
  return _cached;
}

export async function getPublicJwks(): Promise<{ keys: JWK[] }> {
  const key = await getActiveSigningKey();
  return {
    keys: [{ ...key.publicJwk, use: "sig", kid: key.kid, alg: key.alg }],
  };
}

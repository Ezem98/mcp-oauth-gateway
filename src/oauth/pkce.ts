import { createHash } from "node:crypto";

/**
 * Verify a PKCE code_verifier against a previously issued code_challenge.
 * We require S256 — plain is not supported.
 *
 * S256: base64url(sha256(verifier)) === challenge
 */
export function verifyPkce(
  verifier: string,
  challenge: string,
  method: string
): boolean {
  if (method !== "S256") return false;
  if (!verifier || verifier.length < 43 || verifier.length > 128) return false;
  const hash = createHash("sha256").update(verifier).digest();
  const computed = base64url(hash);
  return constantTimeEquals(computed, challenge);
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

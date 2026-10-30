import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getEnv } from "../config/env.js";
import { logger } from "../observability/logger.js";

const MIN_TOKEN_LENGTH = 32;

/**
 * Load an admin token from file, or generate and save one if missing.
 * Throws if an existing token is shorter than 32 characters.
 */
export function loadOrCreateAdminToken(path: string): string {
  if (existsSync(path)) {
    const token = readFileSync(path, "utf8").trim();
    if (token.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `Admin token in '${path}' must be at least ${MIN_TOKEN_LENGTH} characters (got ${token.length})`
      );
    }
    return token;
  }

  const dir = dirname(path);
  if (dir) {
    mkdirSync(dir, { recursive: true });
  }

  const token = randomBytes(32).toString("base64url");
  try {
    writeFileSync(path, token, { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return loadOrCreateAdminToken(path);
    }
    throw err;
  }
  logger.info("Created connect admin token", { path });
  return token;
}

let cachedAdminToken: string | null = null;

/**
 * Lazily load and cache the connect admin token from the configured path.
 */
export function getConnectAdminToken(): string {
  if (cachedAdminToken) {
    return cachedAdminToken;
  }
  const env = getEnv();
  cachedAdminToken = loadOrCreateAdminToken(env.CONNECT_ADMIN_TOKEN_FILE);
  return cachedAdminToken;
}

/**
 * Clear the cached connect admin token (for tests).
 */
export function resetConnectAdminTokenForTests(): void {
  cachedAdminToken = null;
}

/**
 * Constant-time comparison of a candidate admin token against the configured token.
 * Returns false for empty or missing candidate tokens.
 */
export function isValidAdminToken(
  candidate: string | undefined | null
): boolean {
  if (!candidate || typeof candidate !== "string") {
    return false;
  }

  const expected = getConnectAdminToken();
  const candidateDigest = createHash("sha256").update(candidate).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();

  return timingSafeEqual(candidateDigest, expectedDigest);
}

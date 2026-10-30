import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getEnv } from "../config/env.js";
import { logger } from "../observability/logger.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * Encrypt a plaintext secret using AES-256-GCM.
 * Serialized format: v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
    throw new Error(`Vault key must be a ${KEY_LENGTH}-byte Buffer`);
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

/**
 * Decrypt a secret payload using AES-256-GCM.
 * Throws on wrong prefix/format, wrong key, or tampered tag/ciphertext.
 */
export function decryptSecret(payload: string, key: Buffer): string {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
    throw new Error(`Vault key must be a ${KEY_LENGTH}-byte Buffer`);
  }

  if (typeof payload !== "string") {
    throw new Error("Payload must be a string");
  }

  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Invalid payload format or unsupported version");
  }

  const [, ivB64, tagB64, ciphertextB64] = parts;
  if (!ivB64 || !tagB64) {
    throw new Error("Invalid payload: missing IV or auth tag");
  }

  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");

  if (iv.length !== IV_LENGTH) {
    throw new Error(`Invalid IV length: expected ${IV_LENGTH} bytes`);
  }
  if (tag.length !== TAG_LENGTH) {
    throw new Error(`Invalid auth tag length: expected ${TAG_LENGTH} bytes`);
  }

  const ciphertext = Buffer.from(ciphertextB64, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/**
 * Load a 32-byte vault key from file, or generate and save one if missing.
 */
export function loadOrCreateVaultKey(path: string): Buffer {
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8").trim();
    const key = Buffer.from(raw, "base64");
    if (key.length !== KEY_LENGTH) {
      throw new Error(
        `Vault key in '${path}' must be exactly ${KEY_LENGTH} bytes (got ${key.length})`
      );
    }
    return key;
  }

  const dir = dirname(path);
  if (dir) {
    mkdirSync(dir, { recursive: true });
  }

  const key = randomBytes(KEY_LENGTH);
  try {
    // "wx": never overwrite an existing key — losing it makes every vaulted
    // token unreadable. If another process won the race, use its key.
    writeFileSync(path, key.toString("base64"), { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return loadOrCreateVaultKey(path);
    }
    throw err;
  }
  logger.info("Created vault key", { path });
  return key;
}

let cachedVaultKey: Buffer | null = null;

/**
 * Lazily load and cache the vault key from the configured path.
 */
export function getVaultKey(): Buffer {
  if (cachedVaultKey) {
    return cachedVaultKey;
  }
  const env = getEnv();
  cachedVaultKey = loadOrCreateVaultKey(env.VAULT_KEY_FILE);
  return cachedVaultKey;
}

/**
 * Clear the cached vault key (for tests).
 */
export function resetVaultKeyForTests(): void {
  cachedVaultKey = null;
}

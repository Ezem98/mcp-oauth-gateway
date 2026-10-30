import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  loadOrCreateVaultKey,
} from "../src/credentials/crypto.js";

describe("crypto module", () => {
  it("round-trip", () => {
    const key = randomBytes(32);
    const plaintext = "super-secret-access-token-12345";
    const encrypted = encryptSecret(plaintext, key);

    expect(encrypted.startsWith("v1:")).toBe(true);
    const decrypted = decryptSecret(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it("two encryptions of the same plaintext differ", () => {
    const key = randomBytes(32);
    const plaintext = "identical-secret-text";
    const enc1 = encryptSecret(plaintext, key);
    const enc2 = encryptSecret(plaintext, key);

    expect(enc1).not.toBe(enc2);
    expect(decryptSecret(enc1, key)).toBe(plaintext);
    expect(decryptSecret(enc2, key)).toBe(plaintext);
  });

  it("altering one char of the tag fails to decrypt", () => {
    const key = randomBytes(32);
    const plaintext = "confidential-credentials";
    const encrypted = encryptSecret(plaintext, key);

    const parts = encrypted.split(":");
    expect(parts.length).toBe(4);
    const [version, iv, tag, ct] = parts;

    // Mutate one character of the tag
    const firstChar = tag[0];
    const alteredChar = firstChar === "A" ? "B" : "A";
    const tamperedTag = alteredChar + tag.slice(1);
    const tamperedPayload = `${version}:${iv}:${tamperedTag}:${ct}`;

    expect(() => decryptSecret(tamperedPayload, key)).toThrow();
  });

  it("wrong key fails", () => {
    const key1 = randomBytes(32);
    const key2 = randomBytes(32);
    const plaintext = "confidential-data";
    const encrypted = encryptSecret(plaintext, key1);

    expect(() => decryptSecret(encrypted, key2)).toThrow();
  });

  it("malformed payload fails", () => {
    const key = randomBytes(32);

    expect(() => decryptSecret("", key)).toThrow();
    expect(() => decryptSecret("not-a-payload", key)).toThrow();
    expect(() => decryptSecret("v2:iv:tag:ct", key)).toThrow();
    expect(() => decryptSecret("v1:only:three", key)).toThrow();
    expect(() => decryptSecret("v1:a:b:c:d", key)).toThrow();
    expect(() => decryptSecret("v1::tag:ct", key)).toThrow();
    expect(() => decryptSecret("v1:iv::ct", key)).toThrow();
  });

  it("loadOrCreateVaultKey creates a 32-byte key in a temp dir (os.tmpdir + mkdtemp) and returns the same key on the second call, and rejects a file whose content is not 32 bytes", async () => {
    const tempDir = await mkdtemp(join(os.tmpdir(), "vault-key-test-"));
    try {
      const keyPath = join(tempDir, "subdir", "vault.key");

      // Creates a 32-byte key in a temp dir
      const key1 = loadOrCreateVaultKey(keyPath);
      expect(Buffer.isBuffer(key1)).toBe(true);
      expect(key1.length).toBe(32);
      expect(existsSync(keyPath)).toBe(true);

      // Returns the same key on the second call
      const key2 = loadOrCreateVaultKey(keyPath);
      expect(key2).toEqual(key1);

      // Rejects a file whose content is not 32 bytes (base64-encoded short string)
      const badKeyPath = join(tempDir, "bad.key");
      writeFileSync(badKeyPath, Buffer.from("short-key").toString("base64"));
      expect(() => loadOrCreateVaultKey(badKeyPath)).toThrow();

      // Rejects a file whose content is not valid 32 bytes
      const badKeyPath2 = join(tempDir, "bad2.key");
      writeFileSync(badKeyPath2, "invalid-not-32-bytes");
      expect(() => loadOrCreateVaultKey(badKeyPath2)).toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

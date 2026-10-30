import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

describe("admin token module", () => {
  let tempDir: string;
  let tokenFile: string;
  let loadOrCreateAdminToken: (path: string) => string;
  let getConnectAdminToken: () => string;
  let resetConnectAdminTokenForTests: () => void;
  let isValidAdminToken: (candidate: string | undefined | null) => boolean;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(os.tmpdir(), "mcp-admin-token-test-"));
    tokenFile = join(tempDir, "connect-admin.token");
    process.env.CONNECT_ADMIN_TOKEN_FILE = tokenFile;

    const mod = await import("../src/credentials/admin-token.js");
    loadOrCreateAdminToken = mod.loadOrCreateAdminToken;
    getConnectAdminToken = mod.getConnectAdminToken;
    resetConnectAdminTokenForTests = mod.resetConnectAdminTokenForTests;
    isValidAdminToken = mod.isValidAdminToken;
  });

  afterAll(async () => {
    resetConnectAdminTokenForTests();
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("creates a token file (>=32 chars) in a temp dir", () => {
    const standalonePath = join(tempDir, "standalone.token");
    const token = loadOrCreateAdminToken(standalonePath);

    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(existsSync(standalonePath)).toBe(true);
    expect(readFileSync(standalonePath, "utf8").trim()).toBe(token);
  });

  it("returns the same token on second call", () => {
    const standalonePath = join(tempDir, "second-call.token");
    const token1 = loadOrCreateAdminToken(standalonePath);
    const token2 = loadOrCreateAdminToken(standalonePath);

    expect(token2).toBe(token1);
  });

  it("rejects a too-short existing file", () => {
    const shortPath = join(tempDir, "short.token");
    writeFileSync(shortPath, "short");
    expect(() => loadOrCreateAdminToken(shortPath)).toThrow(/at least 32 characters/);

    const short31Path = join(tempDir, "short31.token");
    writeFileSync(short31Path, "a".repeat(31));
    expect(() => loadOrCreateAdminToken(short31Path)).toThrow(/at least 32 characters/);
  });

  it("getConnectAdminToken returns the configured token and creates file", () => {
    resetConnectAdminTokenForTests();
    const token1 = getConnectAdminToken();
    expect(typeof token1).toBe("string");
    expect(token1.length).toBeGreaterThanOrEqual(32);
    expect(existsSync(tokenFile)).toBe(true);

    const token2 = getConnectAdminToken();
    expect(token2).toBe(token1);
  });

  it("isValidAdminToken true for the right token and false for wrong/empty/undefined", () => {
    const expected = getConnectAdminToken();

    expect(isValidAdminToken(expected)).toBe(true);
    expect(isValidAdminToken("wrong-admin-token")).toBe(false);
    expect(isValidAdminToken("")).toBe(false);
    expect(isValidAdminToken(undefined)).toBe(false);
    expect(isValidAdminToken(null)).toBe(false);
  });
});

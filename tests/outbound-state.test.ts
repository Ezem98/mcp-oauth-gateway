import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

describe("outbound oauth states", () => {
  let tempDir: string;
  let createOutboundState: (
    userSubject: string,
    provider: string
  ) => { state: string; codeChallenge: string };
  let consumeOutboundState: (
    state: string,
    provider: string
  ) => { user_subject: string; code_verifier: string } | null;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(os.tmpdir(), "mcp-outbound-state-test-"));
    process.env.DB_PATH = join(tempDir, "test.db");
    process.env.VAULT_KEY_FILE = join(tempDir, "vault.key");

    const mod = await import("../src/credentials/states.js");
    createOutboundState = mod.createOutboundState;
    consumeOutboundState = mod.consumeOutboundState;
  });

  afterAll(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore errors on Windows file locks
    }
  });

  it("create+consume returns user and verifier, and the challenge equals base64url(sha256(verifier))", () => {
    const { state, codeChallenge } = createOutboundState("alice", "google");
    expect(state).toBeDefined();
    expect(codeChallenge).toBeDefined();

    const consumed = consumeOutboundState(state, "google");
    expect(consumed).not.toBeNull();
    expect(consumed?.user_subject).toBe("alice");
    expect(consumed?.code_verifier).toBeDefined();

    const expectedChallenge = createHash("sha256")
      .update(consumed!.code_verifier)
      .digest("base64url");
    expect(codeChallenge).toBe(expectedChallenge);
  });

  it("second consume of the same state returns null (single use)", () => {
    const { state } = createOutboundState("bob", "google");
    const first = consumeOutboundState(state, "google");
    expect(first).not.toBeNull();

    const second = consumeOutboundState(state, "google");
    expect(second).toBeNull();
  });

  it("wrong provider returns null", () => {
    const { state } = createOutboundState("charlie", "google");
    const consumed = consumeOutboundState(state, "github");
    expect(consumed).toBeNull();
  });

  it("after vi.setSystemTime(now + 11 minutes) consume returns null (expired)", () => {
    try {
      vi.useFakeTimers();
      const now = new Date("2026-01-01T12:00:00.000Z");
      vi.setSystemTime(now);

      const { state } = createOutboundState("dave", "google");

      // Advance clock past the 10-minute TTL
      vi.setSystemTime(new Date(now.getTime() + 11 * 60 * 1000));

      const consumed = consumeOutboundState(state, "google");
      expect(consumed).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

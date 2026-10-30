import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerFileEntry } from "../src/db/servers-file.js";
import type { McpServerRecord } from "../src/oauth/servers.js";

describe("servers-file loader and upsert", () => {
  let tempDir: string;
  let loadServersFile: (path: string) => ServerFileEntry[];
  let upsertServers: (entries: ServerFileEntry[]) => void;
  let getServer: (serverId: string) => McpServerRecord | null;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(os.tmpdir(), "mcp-servers-file-test-"));
    process.env.DB_PATH = join(tempDir, "test.db");
    process.env.VAULT_KEY_FILE = join(tempDir, "vault.key");

    const serversFileMod = await import("../src/db/servers-file.js");
    loadServersFile = serversFileMod.loadServersFile;
    upsertServers = serversFileMod.upsertServers;

    const serversMod = await import("../src/oauth/servers.js");
    getServer = serversMod.getServer;
  });

  afterAll(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore errors on Windows file locks
    }
  });

  it("valid file with two servers -> both returned by getServer() with the right fields", async () => {
    const validFile = join(tempDir, "valid-servers.json");
    const data = [
      {
        server_id: "server-one",
        display_name: "Server One",
        upstream_url: "https://server1.example.com/mcp",
        upstream_auth_header: "Authorization: Bearer secret-token-1",
      },
      {
        server_id: "server-two",
        upstream_url: "https://server2.example.com/mcp",
      },
    ];
    await writeFile(validFile, JSON.stringify(data, null, 2), "utf-8");

    const entries = loadServersFile(validFile);
    expect(entries).toHaveLength(2);

    upsertServers(entries);

    const s1 = getServer("server-one");
    expect(s1).not.toBeNull();
    expect(s1).toEqual({
      server_id: "server-one",
      display_name: "Server One",
      upstream_url: "https://server1.example.com/mcp",
      upstream_auth_header: "Authorization: Bearer secret-token-1",
      required_scope: null,
      enabled: 1,
    });

    const s2 = getServer("server-two");
    expect(s2).not.toBeNull();
    expect(s2).toEqual({
      server_id: "server-two",
      display_name: null,
      upstream_url: "https://server2.example.com/mcp",
      upstream_auth_header: null,
      required_scope: null,
      enabled: 1,
    });
  });

  it("running upsertServers again with a changed upstream_url updates it", () => {
    const updatedEntries: ServerFileEntry[] = [
      {
        server_id: "server-one",
        display_name: "Server One (Updated)",
        upstream_url: "https://server1-updated.example.com/mcp",
        upstream_auth_header: "Authorization: Bearer secret-token-updated",
      },
    ];

    upsertServers(updatedEntries);

    const s1 = getServer("server-one");
    expect(s1).not.toBeNull();
    expect(s1?.upstream_url).toBe("https://server1-updated.example.com/mcp");
    expect(s1?.display_name).toBe("Server One (Updated)");
    expect(s1?.upstream_auth_header).toBe(
      "Authorization: Bearer secret-token-updated"
    );
  });

  it("invalid server_id makes loadServersFile throw and does not leak header value", async () => {
    const invalidFile = join(tempDir, "invalid-server-id.json");
    const secretValue = "s3cr3t-value";
    const data = [
      {
        server_id: "INVALID_UPPERCASE_AND_BAD!",
        upstream_url: "https://example.com/mcp",
        upstream_auth_header: `X-Secret: ${secretValue}`,
      },
    ];
    await writeFile(invalidFile, JSON.stringify(data), "utf-8");

    expect(() => loadServersFile(invalidFile)).toThrow();
    try {
      loadServersFile(invalidFile);
    } catch (err: any) {
      expect(err.message).toContain("invalid-server-id.json");
      expect(err.message).not.toContain(secretValue);
    }
  });

  it("invalid URL makes loadServersFile throw and does not leak header value", async () => {
    const invalidFile = join(tempDir, "invalid-url.json");
    const secretValue = "s3cr3t-value";
    const data = [
      {
        server_id: "valid-server",
        upstream_url: "not-a-valid-url",
        upstream_auth_header: `X-Secret: ${secretValue}`,
      },
    ];
    await writeFile(invalidFile, JSON.stringify(data), "utf-8");

    expect(() => loadServersFile(invalidFile)).toThrow();
    try {
      loadServersFile(invalidFile);
    } catch (err: any) {
      expect(err.message).toContain("invalid-url.json");
      expect(err.message).not.toContain(secretValue);
    }
  });

  it("header without ':' makes loadServersFile throw and does not leak header value", async () => {
    const invalidFile = join(tempDir, "invalid-header.json");
    const secretValue = "s3cr3t-value";
    const data = [
      {
        server_id: "valid-server",
        upstream_url: "https://example.com/mcp",
        upstream_auth_header: secretValue,
      },
    ];
    await writeFile(invalidFile, JSON.stringify(data), "utf-8");

    expect(() => loadServersFile(invalidFile)).toThrow();
    try {
      loadServersFile(invalidFile);
    } catch (err: any) {
      expect(err.message).toContain("invalid-header.json");
      expect(err.message).not.toContain(secretValue);
    }
  });

  it("duplicate server_id makes loadServersFile throw and does not leak header value", async () => {
    const invalidFile = join(tempDir, "duplicate-server-id.json");
    const secretValue = "s3cr3t-value";
    const data = [
      {
        server_id: "duplicate-id",
        upstream_url: "https://one.example.com/mcp",
        upstream_auth_header: `X-Secret: ${secretValue}`,
      },
      {
        server_id: "duplicate-id",
        upstream_url: "https://two.example.com/mcp",
        upstream_auth_header: `X-Secret: ${secretValue}`,
      },
    ];
    await writeFile(invalidFile, JSON.stringify(data), "utf-8");

    expect(() => loadServersFile(invalidFile)).toThrow();
    try {
      loadServersFile(invalidFile);
    } catch (err: any) {
      expect(err.message).toContain("duplicate-server-id.json");
      expect(err.message).not.toContain(secretValue);
    }
  });
});

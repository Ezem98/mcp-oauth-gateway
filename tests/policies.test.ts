import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type {
  PoliciesMap,
  PolicyRecord,
  ToolDecision,
} from "../src/policies/policies.js";

describe("policies storage and file loader", () => {
  let tempDir: string;
  let getToolDecision: (serverId: string, toolName: string) => ToolDecision;
  let upsertPolicies: (map: PoliciesMap) => void;
  let listPolicies: (serverId?: string) => PolicyRecord[];
  let loadPoliciesFile: (filePath: string) => PoliciesMap;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(os.tmpdir(), "mcp-policies-test-"));
    process.env.DB_PATH = join(tempDir, "test.db");
    process.env.VAULT_KEY_FILE = join(tempDir, "vault.key");

    const policiesMod = await import("../src/policies/policies.js");
    getToolDecision = policiesMod.getToolDecision;
    upsertPolicies = policiesMod.upsertPolicies;
    listPolicies = policiesMod.listPolicies;
    loadPoliciesFile = policiesMod.loadPoliciesFile;
  });

  afterAll(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore errors on Windows file locks
    }
  });

  it("default deny: any unknown server or tool returns deny", () => {
    expect(getToolDecision("nonexistent-server", "any-tool")).toBe("deny");
    expect(getToolDecision("srv-1", "echo")).toBe("deny");
  });

  it("upsertPolicies then allow: explicit allow returns allow, unlisted returns deny", () => {
    upsertPolicies({
      "srv-1": {
        echo: "allow",
        delete_all: "deny",
      },
    });

    expect(getToolDecision("srv-1", "echo")).toBe("allow");
    expect(getToolDecision("srv-1", "delete_all")).toBe("deny");
    expect(getToolDecision("srv-1", "unlisted_tool")).toBe("deny");
    expect(getToolDecision("srv-2", "echo")).toBe("deny");
  });

  it("change allow → deny: upserting with deny updates decision", () => {
    expect(getToolDecision("srv-1", "echo")).toBe("allow");

    upsertPolicies({
      "srv-1": {
        echo: "deny",
      },
    });

    expect(getToolDecision("srv-1", "echo")).toBe("deny");
  });

  it("listPolicies returns policies filtered by server or all", () => {
    upsertPolicies({
      "srv-1": {
        tool_a: "allow",
      },
      "srv-2": {
        tool_b: "allow",
      },
    });

    const srv1Policies = listPolicies("srv-1");
    expect(srv1Policies.some((p) => p.tool_name === "tool_a")).toBe(true);
    expect(srv1Policies.every((p) => p.server_id === "srv-1")).toBe(true);

    const allPolicies = listPolicies();
    expect(allPolicies.some((p) => p.server_id === "srv-1")).toBe(true);
    expect(allPolicies.some((p) => p.server_id === "srv-2")).toBe(true);
  });

  it("loadPoliciesFile parses valid file correctly", async () => {
    const validPath = join(tempDir, "valid-policies.json");
    const data = {
      "google-server": {
        gmail_search: "allow",
        gmail_read: "allow",
        danger_tool: "deny",
      },
    };
    await writeFile(validPath, JSON.stringify(data, null, 2), "utf-8");

    const result = loadPoliciesFile(validPath);
    expect(result).toEqual(data);
  });

  it("loadPoliciesFile throws on invalid JSON", async () => {
    const brokenJsonPath = join(tempDir, "broken.json");
    await writeFile(brokenJsonPath, "{not-json", "utf-8");

    expect(() => loadPoliciesFile(brokenJsonPath)).toThrow(
      "Failed to parse JSON"
    );
  });

  it("loadPoliciesFile throws on invalid server_id", async () => {
    const invalidServerPath = join(tempDir, "invalid-server.json");
    const data = {
      "INVALID_UPPERCASE!": {
        echo: "allow",
      },
    };
    await writeFile(invalidServerPath, JSON.stringify(data), "utf-8");

    expect(() => loadPoliciesFile(invalidServerPath)).toThrow(
      "Invalid server_id format"
    );
  });

  it("loadPoliciesFile throws on invalid tool name (empty or too long)", async () => {
    const emptyToolPath = join(tempDir, "empty-tool.json");
    await writeFile(
      emptyToolPath,
      JSON.stringify({ "server-a": { "": "allow" } }),
      "utf-8"
    );
    expect(() => loadPoliciesFile(emptyToolPath)).toThrow("Tool name");

    const tooLongToolPath = join(tempDir, "too-long-tool.json");
    const longName = "a".repeat(129);
    await writeFile(
      tooLongToolPath,
      JSON.stringify({ "server-a": { [longName]: "allow" } }),
      "utf-8"
    );
    expect(() => loadPoliciesFile(tooLongToolPath)).toThrow("Tool name");
  });

  it("loadPoliciesFile throws on invalid decision (not allow/deny)", async () => {
    const invalidDecisionPath = join(tempDir, "invalid-decision.json");
    await writeFile(
      invalidDecisionPath,
      JSON.stringify({ "server-a": { echo: "maybe" } }),
      "utf-8"
    );
    expect(() => loadPoliciesFile(invalidDecisionPath)).toThrow();
  });
});

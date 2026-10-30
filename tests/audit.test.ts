import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

describe("audit module", () => {
  let tempDir: string;
  let getDb: any;
  let recordAudit: any;
  let summarizeArgs: any;
  let queryAudit: any;
  let purgeOldAudit: any;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(os.tmpdir(), "mcp-audit-test-"));
    process.env.DB_PATH = join(tempDir, "test.db");

    const dbMod = await import("../src/db/client.js");
    getDb = dbMod.getDb;

    const auditMod = await import("../src/audit/audit.js");
    recordAudit = auditMod.recordAudit;
    summarizeArgs = auditMod.summarizeArgs;
    queryAudit = auditMod.queryAudit;
    purgeOldAudit = auditMod.purgeOldAudit;
  });

  afterAll(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore errors on Windows file locks
    }
  });

  describe("summarizeArgs", () => {
    it("returns null for non-object args", () => {
      expect(summarizeArgs("tool", null)).toBeNull();
      expect(summarizeArgs("tool", undefined)).toBeNull();
      expect(summarizeArgs("tool", "string")).toBeNull();
      expect(summarizeArgs("tool", 123)).toBeNull();
      expect(summarizeArgs("tool", [1, 2, 3])).toBeNull();
    });

    it("keeps only lengths for body/content-like args", () => {
      const summary = summarizeArgs("edit_document", {
        body: "lorem ipsum dolor sit amet",
        content: "something",
        limit: 50,
        active: true,
      });

      expect(summary).toEqual({
        body: { type: "string", length: 26 },
        content: { type: "string", length: 9 },
        limit: { type: "number" },
        active: { type: "boolean" },
      });
      const str = JSON.stringify(summary);
      expect(str).not.toContain("lorem ipsum");
      expect(str).not.toContain("something");
    });

    it("keeps query for *search* tools cut to 120 chars", () => {
      const shortQuery = "from:colleague@example.com is:unread";
      const shortSummary = summarizeArgs("gmail_search", { query: shortQuery });
      expect(shortSummary).toEqual({
        query: shortQuery,
      });

      const longQuery = "q".repeat(150);
      const longSummary = summarizeArgs("drive_search_files", { query: longQuery });
      expect(longSummary?.query).toBe("q".repeat(120));

      // Non-search tools should NOT preserve query value
      const otherSummary = summarizeArgs("other_tool", { query: "secret-query" });
      expect(otherSummary).toEqual({
        query: { type: "string", length: 12 },
      });
      expect(JSON.stringify(otherSummary)).not.toContain("secret-query");
    });

    it("keeps to and subject for *draft* tools cut to 120 chars", () => {
      const draftSummary = summarizeArgs("gmail_create_draft", {
        to: "recipient@example.com",
        subject: "Meeting Tomorrow",
        body: "Super secret proposal body text that must never leak",
      });

      expect(draftSummary).toEqual({
        to: "recipient@example.com",
        subject: "Meeting Tomorrow",
        body: { type: "string", length: 52 },
      });

      const serialized = JSON.stringify(draftSummary);
      expect(serialized).toContain("recipient@example.com");
      expect(serialized).toContain("Meeting Tomorrow");
      expect(serialized).not.toContain("Super secret proposal body");

      const longSummary = summarizeArgs("quick_draft", {
        to: "t".repeat(140),
        subject: "s".repeat(140),
      });
      expect(longSummary?.to).toBe("t".repeat(120));
      expect(longSummary?.subject).toBe("s".repeat(120));

      // Non-draft tools should NOT preserve to/subject values
      const emailSummary = summarizeArgs("send_message", {
        to: "recipient@example.com",
        subject: "Hello",
      });
      expect(emailSummary).toEqual({
        to: { type: "string", length: 21 },
        subject: { type: "string", length: 5 },
      });
      expect(JSON.stringify(emailSummary)).not.toContain("recipient@example.com");
    });

    it("never leaks a token-looking value passed as any other argument", () => {
      const summary = summarizeArgs("some_api_tool", {
        token: "ya29.secret",
        body: "hola",
        apiKey: "sk-1234567890abcdef",
      });

      const serialized = JSON.stringify(summary);
      expect(serialized).not.toContain("ya29.secret");
      expect(serialized).not.toContain("hola");
      expect(serialized).not.toContain("sk-1234567890abcdef");

      expect(summary).toEqual({
        token: { type: "string", length: 11 },
        body: { type: "string", length: 4 },
        apiKey: { type: "string", length: 19 },
      });
    });

    it("summarizes nested objects and arrays as only type and length", () => {
      const summary = summarizeArgs("complex_tool", {
        nested: { innerKey: "secret_value" },
        list: ["item1", "item2", "item3"],
        emptyList: [],
      });

      expect(summary).toEqual({
        nested: { type: "object" },
        list: { type: "array", length: 3 },
        emptyList: { type: "array", length: 0 },
      });

      const serialized = JSON.stringify(summary);
      expect(serialized).not.toContain("innerKey");
      expect(serialized).not.toContain("secret_value");
      expect(serialized).not.toContain("item1");
    });
  });

  describe("purgeOldAudit and queryAudit", () => {
    it("purgeOldAudit deletes rows older than 90 days and keeps newer ones", () => {
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;

      const oldTs1 = new Date(now - 100 * dayMs).toISOString();
      const oldTs2 = new Date(now - 95 * dayMs).toISOString();
      const newTs1 = new Date(now - 30 * dayMs).toISOString();
      const newTs2 = new Date(now - 1 * dayMs).toISOString();

      recordAudit({
        ts: oldTs1,
        server_id: "s1",
        kind: "tool_call",
        tool_name: "old_tool_1",
        outcome: "ok",
      });

      recordAudit({
        ts: oldTs2,
        server_id: "s1",
        kind: "tool_call",
        tool_name: "old_tool_2",
        outcome: "ok",
      });

      recordAudit({
        ts: newTs1,
        server_id: "s1",
        kind: "tool_call",
        tool_name: "new_tool_1",
        outcome: "ok",
      });

      recordAudit({
        ts: newTs2,
        server_id: "s2",
        kind: "policy_block",
        tool_name: "new_tool_2",
        outcome: "blocked",
      });

      const deletedCount = purgeOldAudit(90);
      expect(deletedCount).toBe(2);

      const remaining = queryAudit({ limit: 100 });
      const tools = remaining.map((r: any) => r.tool_name);
      expect(tools).toContain("new_tool_1");
      expect(tools).toContain("new_tool_2");
      expect(tools).not.toContain("old_tool_1");
      expect(tools).not.toContain("old_tool_2");
    });

    it("queryAudit filters by serverId, blockedOnly, and limit", () => {
      const allRows = queryAudit({ limit: 10 });
      expect(allRows.length).toBeGreaterThan(0);

      const s2Rows = queryAudit({ serverId: "s2" });
      expect(s2Rows.every((r: any) => r.server_id === "s2")).toBe(true);

      const blockedRows = queryAudit({ blockedOnly: true });
      expect(blockedRows.every((r: any) => r.outcome === "blocked")).toBe(true);

      const limited = queryAudit({ limit: 1 });
      expect(limited).toHaveLength(1);
    });

    it("recordAudit never throws even on invalid input", () => {
      expect(() => {
        // @ts-expect-error test invalid kind
        recordAudit({ kind: "invalid_kind", outcome: "invalid_outcome" });
      }).not.toThrow();
    });
  });
});

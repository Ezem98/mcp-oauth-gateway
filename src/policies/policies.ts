import { readFileSync } from "node:fs";
import { z } from "zod";
import { getEnv } from "../config/env.js";
import { getDb } from "../db/client.js";
import { logger } from "../observability/logger.js";

const serverIdRegex = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const toolDecisionSchema = z.enum(["allow", "deny"]);

export const toolPoliciesSchema = z.record(
  z
    .string()
    .min(1, "Tool name cannot be empty")
    .max(128, "Tool name cannot exceed 128 characters"),
  toolDecisionSchema
);

export const policiesFileSchema = z.record(
  z.string().regex(serverIdRegex, "Invalid server_id format"),
  toolPoliciesSchema
);

export type ToolDecision = z.infer<typeof toolDecisionSchema>;
export type PoliciesMap = Record<string, Record<string, ToolDecision>>;

export interface PolicyRecord {
  server_id: string;
  tool_name: string;
  decision: ToolDecision;
  updated_at: string;
}

/**
 * Check if a tool call is allowed for a given server.
 * Returns "allow" only if an explicit row exists with decision 'allow'.
 * Everything else (no row, unknown tool, server without policy) returns "deny".
 */
export function getToolDecision(
  serverId: string,
  toolName: string
): ToolDecision {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT decision FROM tool_policies WHERE server_id = ? AND tool_name = ?"
    )
    .get(serverId, toolName) as { decision: string } | undefined;

  return row?.decision === "allow" ? "allow" : "deny";
}

/**
 * Upsert tool policies for one or more servers in a single transaction.
 * Updates decision and updated_at on conflict.
 */
export function upsertPolicies(map: PoliciesMap): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO tool_policies (server_id, tool_name, decision, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(server_id, tool_name) DO UPDATE SET
      decision = excluded.decision,
      updated_at = datetime('now')
  `);

  const runAll = db.transaction(
    (
      entries: Array<{
        serverId: string;
        toolName: string;
        decision: ToolDecision;
      }>
    ) => {
      for (const entry of entries) {
        stmt.run(entry.serverId, entry.toolName, entry.decision);
      }
    }
  );

  const entries: Array<{
    serverId: string;
    toolName: string;
    decision: ToolDecision;
  }> = [];

  for (const [serverId, tools] of Object.entries(map)) {
    if (!tools || typeof tools !== "object") continue;
    for (const [toolName, decision] of Object.entries(tools)) {
      entries.push({ serverId, toolName, decision });
    }
  }

  runAll(entries);
}

/**
 * List stored policies, optionally filtered by serverId.
 */
export function listPolicies(serverId?: string): PolicyRecord[] {
  const db = getDb();
  if (serverId !== undefined) {
    return db
      .prepare(
        "SELECT server_id, tool_name, decision, updated_at FROM tool_policies WHERE server_id = ? ORDER BY tool_name ASC"
      )
      .all(serverId) as PolicyRecord[];
  }
  return db
    .prepare(
      "SELECT server_id, tool_name, decision, updated_at FROM tool_policies ORDER BY server_id ASC, tool_name ASC"
    )
    .all() as PolicyRecord[];
}

/**
 * Load and validate a JSON file containing tool policies.
 */
export function loadPoliciesFile(filePath: string): PoliciesMap {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read policies file at ${filePath}: ${(err as Error).message}`
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse JSON in policies file at ${filePath}`);
  }

  const result = policiesFileSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const issuePath = issue.path.length > 0 ? issue.path.join(".") : "root";
        // zod v4 nests record-key errors (bad server_id / tool name) under
        // "invalid_key"; surface the inner messages instead of the generic one.
        const message =
          issue.code === "invalid_key"
            ? issue.issues.map((inner) => inner.message).join(", ")
            : issue.message;
        return `${issuePath}: ${message}`;
      })
      .join("; ");
    throw new Error(`Invalid policies file at ${filePath}: ${issues}`);
  }

  return result.data;
}

/**
 * Seed tool policies from POLICIES_FILE env var if configured.
 * Boot fails if the file is invalid.
 */
export function seedPoliciesFromFile(): void {
  const env = getEnv();
  if (!env.POLICIES_FILE) return;

  const policies = loadPoliciesFile(env.POLICIES_FILE);
  upsertPolicies(policies);

  logger.info("Seeded tool policies from file", {
    path: env.POLICIES_FILE,
    server_count: Object.keys(policies).length,
  });
}

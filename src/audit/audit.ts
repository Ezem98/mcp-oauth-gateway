import { getDb } from "../db/client.js";
import { logger } from "../observability/logger.js";

export type AuditKind = "tool_call" | "credential_vend" | "policy_block" | "connect";
export type AuditOutcome = "ok" | "error" | "blocked";

export interface AuditEvent {
  ts?: string;
  user_subject?: string | null;
  client_id?: string | null;
  server_id?: string | null;
  kind: AuditKind;
  tool_name?: string | null;
  args_summary?: Record<string, unknown> | null;
  outcome: AuditOutcome;
  status?: number | null;
  duration_ms?: number | null;
}

export interface AuditRow {
  id: number;
  ts: string;
  user_subject: string | null;
  client_id: string | null;
  server_id: string | null;
  kind: AuditKind;
  tool_name: string | null;
  args_summary: string | null;
  outcome: AuditOutcome;
  status: number | null;
  duration_ms: number | null;
}

export interface QueryAuditOptions {
  limit?: number;
  serverId?: string;
  blockedOnly?: boolean;
}

/**
 * Inserts one audit row. ts defaults to current ISO string.
 * Must NEVER throw — wrapped in try/catch and logs warning without event contents.
 */
export function recordAudit(event: AuditEvent): void {
  try {
    const db = getDb();
    const ts = event.ts ?? new Date().toISOString();
    const argsSummaryJson =
      event.args_summary !== undefined && event.args_summary !== null
        ? JSON.stringify(event.args_summary)
        : null;

    db.prepare(`
      INSERT INTO audit_log (
        ts, user_subject, client_id, server_id, kind,
        tool_name, args_summary, outcome, status, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ts,
      event.user_subject ?? null,
      event.client_id ?? null,
      event.server_id ?? null,
      event.kind,
      event.tool_name ?? null,
      argsSummaryJson,
      event.outcome,
      event.status ?? null,
      event.duration_ms ?? null
    );
  } catch {
    logger.warn("Failed to record audit log");
  }
}

/**
 * Summarize arguments without leaking sensitive values.
 * Returns only argument names and, for strings, their lengths:
 * e.g. { body: { type: "string", length: 532 }, max_results: { type: "number" } }
 *
 * Exceptions (value kept, cut to 120 chars):
 * - key 'query' when toolName contains 'search'
 * - keys 'to' and 'subject' when toolName contains 'draft'
 *
 * Non-object args -> null.
 * Nested objects/arrays -> only { type: "object" } / { type: "array", length }.
 */
export function summarizeArgs(
  toolName: string,
  args: unknown
): Record<string, unknown> | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return null;
  }

  const isSearch = toolName.toLowerCase().includes("search");
  const isDraft = toolName.toLowerCase().includes("draft");

  const summary: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(args)) {
    const isException =
      (isSearch && key === "query") ||
      (isDraft && (key === "to" || key === "subject"));

    if (isException) {
      if (typeof val === "string") {
        summary[key] = val.slice(0, 120);
      } else if (val === null) {
        summary[key] = { type: "null" };
      } else if (typeof val === "object") {
        summary[key] = Array.isArray(val)
          ? { type: "array", length: val.length }
          : { type: "object" };
      } else {
        summary[key] = String(val).slice(0, 120);
      }
      continue;
    }

    if (val === null) {
      summary[key] = { type: "null" };
    } else if (typeof val === "string") {
      summary[key] = { type: "string", length: val.length };
    } else if (Array.isArray(val)) {
      summary[key] = { type: "array", length: val.length };
    } else if (typeof val === "object") {
      summary[key] = { type: "object" };
    } else {
      summary[key] = { type: typeof val };
    }
  }

  return summary;
}

/**
 * Query audit log, newest first.
 */
export function queryAudit(options?: QueryAuditOptions): AuditRow[] {
  try {
    const db = getDb();
    const limit = options?.limit ?? 50;
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options?.serverId) {
      conditions.push("server_id = ?");
      params.push(options.serverId);
    }
    if (options?.blockedOnly) {
      conditions.push("outcome = 'blocked'");
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    const sql = `SELECT id, ts, user_subject, client_id, server_id, kind, tool_name, args_summary, outcome, status, duration_ms
                 FROM audit_log
                 ${where}
                 ORDER BY ts DESC, id DESC
                 LIMIT ?`;

    return db.prepare(sql).all(...params) as AuditRow[];
  } catch {
    logger.warn("Failed to query audit log");
    return [];
  }
}

/**
 * Delete rows with ts older than now - days (comparing ISO strings computed in JS).
 * Returns the count of deleted rows.
 */
export function purgeOldAudit(days: number = 90): number {
  try {
    const db = getDb();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const info = db.prepare("DELETE FROM audit_log WHERE ts < ?").run(cutoff);
    return info.changes;
  } catch {
    logger.warn("Failed to purge old audit logs");
    return 0;
  }
}

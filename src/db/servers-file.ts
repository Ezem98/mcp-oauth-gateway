import { readFileSync } from "node:fs";
import { z } from "zod";
import { getEnv } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { getDb } from "./client.js";

function isValidAuthHeader(header: string): boolean {
  const colonIndex = header.indexOf(":");
  return colonIndex > 0 && header.slice(0, colonIndex).trim().length > 0;
}

export const serverEntrySchema = z.object({
  server_id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "Invalid server_id format"),
  display_name: z.string().optional(),
  upstream_url: z.string().url("Invalid upstream_url"),
  upstream_auth_header: z
    .string()
    .refine(
      isValidAuthHeader,
      "upstream_auth_header must contain ':' with a non-empty header name before it"
    )
    .optional(),
});

export type ServerFileEntry = z.infer<typeof serverEntrySchema>;

export const serversFileSchema = z
  .array(serverEntrySchema)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry?.server_id) {
        if (seen.has(entry.server_id)) {
          ctx.addIssue({
            code: "custom",
            message: `Duplicate server_id '${entry.server_id}' found in servers file`,
            path: [i, "server_id"],
          });
        } else {
          seen.add(entry.server_id);
        }
      }
    }
  });

export function loadServersFile(filePath: string): ServerFileEntry[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read servers file at ${filePath}: ${(err as Error).message}`
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse JSON in servers file at ${filePath}`);
  }

  const result = serversFileSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const issuePath = issue.path.length > 0 ? issue.path.join(".") : "root";
        let message = issue.message;
        // Never include upstream_auth_header values in errors or logs
        if (issue.path.includes("upstream_auth_header")) {
          message =
            "upstream_auth_header must contain ':' with a non-empty header name before it";
        }
        return `${issuePath}: ${message}`;
      })
      .join("; ");
    throw new Error(`Invalid servers file at ${filePath}: ${issues}`);
  }

  return result.data;
}

export function upsertServers(entries: ServerFileEntry[]): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO mcp_servers (
      server_id, display_name, upstream_url, upstream_auth_header, enabled, updated_at
    ) VALUES (
      ?, ?, ?, ?, 1, datetime('now')
    )
    ON CONFLICT(server_id) DO UPDATE SET
      display_name = excluded.display_name,
      upstream_url = excluded.upstream_url,
      upstream_auth_header = excluded.upstream_auth_header,
      enabled = 1,
      updated_at = datetime('now')
  `);

  const runAll = db.transaction((rows: ServerFileEntry[]) => {
    for (const row of rows) {
      stmt.run(
        row.server_id,
        row.display_name ?? null,
        row.upstream_url,
        row.upstream_auth_header ?? null
      );
    }
  });

  runAll(entries);
}

export function seedServersFromFile(): void {
  const env = getEnv();
  if (!env.SERVERS_FILE) return;

  const entries = loadServersFile(env.SERVERS_FILE);
  upsertServers(entries);

  logger.info("Seeded MCP servers from file", {
    path: env.SERVERS_FILE,
    server_ids: entries.map((e) => e.server_id),
  });
}

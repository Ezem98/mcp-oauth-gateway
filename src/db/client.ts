import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getEnv } from "../config/env.js";
import { logger } from "../observability/logger.js";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const env = getEnv();
  const dbPath = resolve(env.DB_PATH);
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const schemaPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "./schema.sql"
  );
  const schema = readFileSync(schemaPath, "utf-8");
  db.exec(schema);

  logger.info("DB initialized", { path: dbPath });
  _db = db;
  return db;
}

export function seedDemoServer(): void {
  const env = getEnv();
  const db = getDb();
  const existing = db
    .prepare("SELECT server_id FROM mcp_servers WHERE server_id = ?")
    .get(env.DEMO_SERVER_ID);

  if (existing) return;

  db.prepare(
    `INSERT INTO mcp_servers (server_id, display_name, upstream_url, upstream_auth_header)
     VALUES (?, ?, ?, ?)`
  ).run(
    env.DEMO_SERVER_ID,
    "Demo Memory MCP",
    env.DEMO_SERVER_UPSTREAM_URL,
    env.DEMO_SERVER_UPSTREAM_AUTH_HEADER ?? null
  );

  logger.info("Seeded demo MCP server", {
    server_id: env.DEMO_SERVER_ID,
    upstream: env.DEMO_SERVER_UPSTREAM_URL,
  });
}

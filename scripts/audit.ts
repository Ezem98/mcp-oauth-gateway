/**
 * View gateway audit log.
 *
 * NOTE: `npm audit` is a built-in npm command that checks packages for security vulnerabilities.
 * This gateway audit tool is a custom script invoked via:
 *     npm run audit -- [--limit 50] [--server <id>] [--blocked]
 * or directly:
 *     tsx scripts/audit.ts [--limit 50] [--server <id>] [--blocked]
 */

import { queryAudit } from "../src/audit/audit.js";
import { getDb } from "../src/db/client.js";

function printUsageAndExit(): never {
  process.stderr.write(
    "Usage: npm run audit -- [--limit <n>] [--server <id>] [--blocked]\n"
  );
  process.exit(1);
}

function parseArgs() {
  const rawArgs = process.argv.slice(2);
  let limit = 50;
  let serverId: string | undefined;
  let blockedOnly = false;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];

    if (arg === "--limit") {
      const next = rawArgs[++i];
      if (!next || isNaN(Number(next)) || Number(next) <= 0) {
        printUsageAndExit();
      }
      limit = Number(next);
    } else if (arg.startsWith("--limit=")) {
      const val = arg.slice("--limit=".length);
      if (!val || isNaN(Number(val)) || Number(val) <= 0) {
        printUsageAndExit();
      }
      limit = Number(val);
    } else if (arg === "--server") {
      const next = rawArgs[++i];
      if (!next) {
        printUsageAndExit();
      }
      serverId = next;
    } else if (arg.startsWith("--server=")) {
      const val = arg.slice("--server=".length);
      if (!val) {
        printUsageAndExit();
      }
      serverId = val;
    } else if (arg === "--blocked") {
      blockedOnly = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: npm run audit -- [--limit <n>] [--server <id>] [--blocked]\n"
      );
      process.exit(0);
    } else {
      process.stderr.write(`Unknown option: ${arg}\n`);
      printUsageAndExit();
    }
  }

  return { limit, serverId, blockedOnly };
}

function formatLocalTime(isoStr: string): string {
  const d = new Date(isoStr);
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const mins = pad(d.getMinutes());
  const secs = pad(d.getSeconds());
  return `${year}-${month}-${day} ${hours}:${mins}:${secs}`;
}

function formatArgsSummary(raw: string | null): string {
  if (!raw) return "-";
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (typeof parsed !== "object" || parsed === null) return "-";

  const parts: string[] = [];
  for (const [key, val] of Object.entries(parsed)) {
    if (typeof val === "string") {
      parts.push(`${key}="${val}"`);
    } else if (typeof val === "object" && val !== null) {
      const v = val as Record<string, unknown>;
      if (v.type === "string" && typeof v.length === "number") {
        parts.push(`${key}(${v.length})`);
      } else if (v.type === "array" && typeof v.length === "number") {
        parts.push(`${key}[${v.length}]`);
      } else if (v.type) {
        parts.push(key);
      } else {
        parts.push(key);
      }
    } else if (typeof val === "number" || typeof val === "boolean") {
      parts.push(`${key}=${val}`);
    } else {
      parts.push(key);
    }
  }

  return parts.length > 0 ? parts.join(" ") : "-";
}

async function main() {
  const { limit, serverId, blockedOnly } = parseArgs();

  // Ensure DB is open and schema initialized
  getDb();

  const rows = queryAudit({ limit, serverId, blockedOnly });

  const headers = [
    "ts",
    "kind",
    "server",
    "tool",
    "user",
    "outcome",
    "status",
    "ms",
    "args",
  ];

  const formattedRows = rows.map((r) => ({
    ts: formatLocalTime(r.ts),
    kind: r.kind,
    server: r.server_id ?? "-",
    tool: r.tool_name ?? "-",
    user: r.user_subject ?? "-",
    outcome: r.outcome,
    status: r.status !== null && r.status !== undefined ? String(r.status) : "-",
    ms: r.duration_ms !== null && r.duration_ms !== undefined ? String(r.duration_ms) : "-",
    args: formatArgsSummary(r.args_summary),
  }));

  const colWidths = headers.map((header) => {
    const key = header as keyof (typeof formattedRows)[0];
    const maxValLen = formattedRows.reduce(
      (max, row) => Math.max(max, row[key].length),
      0
    );
    return Math.max(header.length, maxValLen);
  });

  const headerLine = headers
    .map((h, i) => h.padEnd(colWidths[i]))
    .join("  ");
  const separatorLine = colWidths
    .map((w) => "-".repeat(w))
    .join("  ");

  console.log(headerLine);
  console.log(separatorLine);

  for (const row of formattedRows) {
    const line = headers
      .map((h, i) => {
        const val = row[h as keyof typeof row];
        return val.padEnd(colWidths[i]);
      })
      .join("  ");
    console.log(line);
  }

  console.log(`\nTotal: ${rows.length} row${rows.length === 1 ? "" : "s"}`);
}

main().catch((err) => {
  console.error("Audit CLI error:", err);
  process.exit(1);
});

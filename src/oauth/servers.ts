import { getDb } from "../db/client.js";
import { getEnv } from "../config/env.js";

export interface McpServerRecord {
  server_id: string;
  display_name: string | null;
  upstream_url: string;
  upstream_auth_header: string | null;
  required_scope: string | null;
  enabled: number;
}

export function getServer(serverId: string): McpServerRecord | null {
  const row = getDb()
    .prepare(
      `SELECT server_id, display_name, upstream_url, upstream_auth_header,
              required_scope, enabled
       FROM mcp_servers WHERE server_id = ? AND enabled = 1`
    )
    .get(serverId) as McpServerRecord | undefined;
  return row ?? null;
}

export function listServers(): McpServerRecord[] {
  return getDb()
    .prepare(
      `SELECT server_id, display_name, upstream_url, upstream_auth_header,
              required_scope, enabled
       FROM mcp_servers WHERE enabled = 1`
    )
    .all() as McpServerRecord[];
}

/**
 * Canonical resource URI for an MCP server: PUBLIC_URL/<server-id>/mcp.
 * Tokens are bound to this string in their `aud` claim.
 */
export function resourceUriFor(serverId: string): string {
  return `${getEnv().PUBLIC_URL}/${serverId}/mcp`;
}

/**
 * Resolve a `resource` URI parameter back to a server record.
 * Returns null if it doesn't match any enabled server.
 */
export function resolveResourceToServer(
  resource: string
): McpServerRecord | null {
  const base = getEnv().PUBLIC_URL;
  if (!resource.startsWith(base + "/")) return null;
  const rest = resource.slice(base.length + 1);
  const [serverId, suffix] = rest.split("/", 2);
  if (!serverId || suffix !== "mcp") return null;
  return getServer(serverId);
}

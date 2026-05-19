/**
 * Coarse-grained MCP scopes.
 *
 * Eventual direction is fine-grained (`mcp:tools.<tool_name>`) but for the spike
 * we ship two scopes and bind tokens to a specific resource (MCP server) via
 * the `aud` claim per RFC 8707. When fine-grained scopes ship, the names live
 * here so migrations are mechanical.
 */
export const SCOPES = {
  READ: "mcp:read",
  WRITE: "mcp:write",
} as const;

export const ALL_SCOPES = [SCOPES.READ, SCOPES.WRITE] as const;
export const DEFAULT_SCOPE_STRING = ALL_SCOPES.join(" ");

export function parseScopeString(s: string | undefined | null): string[] {
  if (!s) return [];
  return s
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function isValidScope(scope: string): boolean {
  return (ALL_SCOPES as readonly string[]).includes(scope);
}

export function filterToValidScopes(requested: string[]): string[] {
  return requested.filter(isValidScope);
}

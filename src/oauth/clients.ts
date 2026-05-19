import { nanoid } from "nanoid";
import { getDb } from "../db/client.js";

export interface ClientRecord {
  client_id: string;
  client_secret: string | null;
  client_name: string | null;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope: string | null;
}

interface ClientRow {
  client_id: string;
  client_secret: string | null;
  client_name: string | null;
  redirect_uris: string;
  grant_types: string;
  response_types: string;
  token_endpoint_auth_method: string;
  scope: string | null;
}

export interface RegisterClientInput {
  redirect_uris: string[];
  client_name?: string;
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  scope?: string;
  metadata?: Record<string, unknown>;
}

export function registerClient(input: RegisterClientInput): ClientRecord {
  const client_id = `mcp_${nanoid(20)}`;
  const grants = input.grant_types ?? ["authorization_code", "refresh_token"];
  const responses = input.response_types ?? ["code"];
  const authMethod = input.token_endpoint_auth_method ?? "none";

  getDb()
    .prepare(
      `INSERT INTO oauth_clients (
        client_id, client_secret, client_name, redirect_uris,
        grant_types, response_types, token_endpoint_auth_method, scope, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      client_id,
      null, // public clients only for the spike (PKCE)
      input.client_name ?? null,
      JSON.stringify(input.redirect_uris),
      JSON.stringify(grants),
      JSON.stringify(responses),
      authMethod,
      input.scope ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null
    );

  return {
    client_id,
    client_secret: null,
    client_name: input.client_name ?? null,
    redirect_uris: input.redirect_uris,
    grant_types: grants,
    response_types: responses,
    token_endpoint_auth_method: authMethod,
    scope: input.scope ?? null,
  };
}

export function getClient(clientId: string): ClientRecord | null {
  const row = getDb()
    .prepare(
      `SELECT client_id, client_secret, client_name, redirect_uris,
              grant_types, response_types, token_endpoint_auth_method, scope
       FROM oauth_clients WHERE client_id = ?`
    )
    .get(clientId) as ClientRow | undefined;

  if (!row) return null;
  return {
    client_id: row.client_id,
    client_secret: row.client_secret,
    client_name: row.client_name,
    redirect_uris: JSON.parse(row.redirect_uris) as string[],
    grant_types: JSON.parse(row.grant_types) as string[],
    response_types: JSON.parse(row.response_types) as string[],
    token_endpoint_auth_method: row.token_endpoint_auth_method,
    scope: row.scope,
  };
}

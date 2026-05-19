import { Hono } from "hono";
import { z } from "zod";
import { logger } from "../observability/logger.js";
import { registerClient } from "./clients.js";

export const registerRoutes = new Hono();

const dcrSchema = z.object({
  redirect_uris: z.array(z.string().url()).min(1),
  client_name: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
  scope: z.string().optional(),
});

/**
 * Dynamic Client Registration (RFC 7591).
 *
 * Public clients only for the spike — no client_secret is issued; PKCE is
 * mandatory at /authorize.
 */
registerRoutes.post("/register", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_client_metadata" }, 400);
  }

  const parsed = dcrSchema.safeParse(body);
  if (!parsed.success) {
    logger.warn("DCR validation failed", { issues: parsed.error.issues });
    return c.json(
      {
        error: "invalid_client_metadata",
        error_description: parsed.error.issues[0]?.message,
      },
      400
    );
  }

  const record = registerClient({
    redirect_uris: parsed.data.redirect_uris,
    client_name: parsed.data.client_name,
    grant_types: parsed.data.grant_types,
    response_types: parsed.data.response_types,
    token_endpoint_auth_method: parsed.data.token_endpoint_auth_method,
    scope: parsed.data.scope,
    metadata: body as Record<string, unknown>,
  });

  logger.info("Registered new OAuth client", {
    client_id: record.client_id,
    client_name: record.client_name ?? null,
  });

  return c.json(
    {
      client_id: record.client_id,
      client_name: record.client_name,
      redirect_uris: record.redirect_uris,
      grant_types: record.grant_types,
      response_types: record.response_types,
      token_endpoint_auth_method: record.token_endpoint_auth_method,
      scope: record.scope,
    },
    201
  );
});

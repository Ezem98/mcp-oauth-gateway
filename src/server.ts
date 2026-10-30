import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getEnv } from "./config/env.js";
import { connectRoutes } from "./credentials/connect-route.js";
import { getConnectAdminToken } from "./credentials/admin-token.js";
import { getVaultKey } from "./credentials/crypto.js";
import { credentialsRoutes } from "./credentials/route.js";
import { getDb, seedDemoServer } from "./db/client.js";
import { gatewayRoutes } from "./gateway/route.js";
import { getActiveSigningKey } from "./oauth/keys.js";
import { oauthRoutes } from "./oauth/router.js";
import { logger } from "./observability/logger.js";

function buildApp(): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      ts: new Date().toISOString(),
    });
  });

  app.route("/", oauthRoutes);
  app.route("/", credentialsRoutes);
  app.route("/", connectRoutes);
  app.route("/", gatewayRoutes);

  app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));

  return app;
}

async function main(): Promise<void> {
  const env = getEnv();
  logger.info("Booting mcp-oauth-gateway", {
    public_url: env.PUBLIC_URL,
    log_level: env.LOG_LEVEL,
  });

  // Initialize DB + seed demo server config from env.
  getDb();
  seedDemoServer();

  // Load (or create) the vault key up front so a bad key file fails at boot.
  getVaultKey();
  getConnectAdminToken();

  // Materialize the active signing keypair (generates on first run).
  await getActiveSigningKey();

  const app = buildApp();

  serve(
    { fetch: app.fetch, port: env.PORT },
    () => {
      logger.info(`HTTP listening`, { url: env.PUBLIC_URL });
      logger.info("Endpoints:");
      logger.info("  GET  /health");
      logger.info("  GET  /.well-known/oauth-authorization-server");
      logger.info("  GET  /.well-known/jwks.json");
      logger.info("  POST /register");
      logger.info("  GET  /authorize");
      logger.info("  POST /authorize");
      logger.info("  POST /token");
      logger.info("  GET  /.well-known/oauth-protected-resource/:server_id/mcp");
      logger.info("  GET  /:server_id/credentials/:provider/token (outbound vending, auth required)");
      logger.info("  GET  /connect/google");
      logger.info("  GET  /connect/google/callback");
      logger.info("  ANY  /:server_id/mcp                       (proxied, auth required)");
    }
  );
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});

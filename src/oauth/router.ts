import { Hono } from "hono";
import { authorizeRoutes } from "./authorize.js";
import { discoveryRoutes } from "./discovery.js";
import { registerRoutes } from "./register.js";
import { tokenRoutes } from "./token.js";

/**
 * OAuth Authorization Server routes mounted at root.
 * - /.well-known/oauth-authorization-server  (RFC 8414)
 * - /.well-known/jwks.json
 * - POST /register                            (RFC 7591 DCR)
 * - GET  /authorize                           (consent page)
 * - POST /authorize                           (consent submit)
 * - POST /token                               (code + refresh exchange)
 */
export const oauthRoutes = new Hono();
oauthRoutes.route("/", discoveryRoutes);
oauthRoutes.route("/", registerRoutes);
oauthRoutes.route("/", authorizeRoutes);
oauthRoutes.route("/", tokenRoutes);

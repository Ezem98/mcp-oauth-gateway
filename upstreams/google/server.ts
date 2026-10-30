import { serve } from "@hono/node-server";
import { config } from "dotenv";
import { createGoogleMcpApp } from "./app.js";
import { loadGoogleMcpConfig } from "./config.js";

// Same .env as the gateway; real environment variables win.
config({ quiet: true });

const cfg = loadGoogleMcpConfig();
const app = createGoogleMcpApp(cfg);

serve(
  {
    fetch: app.fetch,
    port: cfg.port,
    hostname: "127.0.0.1",
  },
  () => {
    console.log(`google-mcp listening on http://127.0.0.1:${cfg.port}/mcp`);
  }
);

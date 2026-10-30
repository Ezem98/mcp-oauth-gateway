import { config } from "dotenv";
import { z } from "zod";

if (!process.env.VITEST) config({ override: true });

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  PUBLIC_URL: z.string().url().default("http://localhost:4000"),
  DB_PATH: z.string().default("./data/gateway.db"),
  JWT_PRIVATE_KEY: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DEMO_SERVER_ID: z.string().default("memory-demo"),
  DEMO_SERVER_UPSTREAM_URL: z
    .string()
    .url()
    .default("http://localhost:5001/mcp"),
  DEMO_SERVER_UPSTREAM_AUTH_HEADER: z.string().optional(),
  AUTH_DEFAULT_USER: z.string().default("demo-user@local"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  VAULT_KEY_FILE: z.string().default("./data/vault.key"),
  CONNECT_ADMIN_TOKEN_FILE: z.string().default("./data/connect-admin.token"),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (_env) return _env;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid environment:");
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  _env = result.data;
  return _env;
}

import { z } from "zod";

export const SHARED_SECRET_HEADER = "x-google-mcp-secret";

export interface GoogleMcpConfig {
  port: number;
  sharedSecret: string;
  gatewayUrl: string;
  gmailApiBase: string;
  driveApiBase: string;
}

const configSchema = z.object({
  GOOGLE_MCP_PORT: z
    .preprocess(
      (val) => (val === "" || val === undefined ? 5002 : val),
      z.coerce.number()
    )
    .default(5002),
  GOOGLE_MCP_SHARED_SECRET: z
    .string({ error: "GOOGLE_MCP_SHARED_SECRET is required" })
    .min(32, "GOOGLE_MCP_SHARED_SECRET must be at least 32 characters long"),
  GOOGLE_MCP_GATEWAY_URL: z
    .preprocess(
      (val) =>
        val === "" || val === undefined ? "http://localhost:4000" : val,
      z.string().url()
    )
    .default("http://localhost:4000"),
  GOOGLE_GMAIL_API_BASE: z
    .preprocess(
      (val) =>
        val === "" || val === undefined
          ? "https://gmail.googleapis.com"
          : val,
      z.string().url()
    )
    .default("https://gmail.googleapis.com"),
  GOOGLE_DRIVE_API_BASE: z
    .preprocess(
      (val) =>
        val === "" || val === undefined ? "https://www.googleapis.com" : val,
      z.string().url()
    )
    .default("https://www.googleapis.com"),
});

export function loadGoogleMcpConfig(
  env: Record<string, string | undefined> = process.env
): GoogleMcpConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const secretIssue = result.error.issues.find(
      (i) => i.path[0] === "GOOGLE_MCP_SHARED_SECRET"
    );
    if (secretIssue) {
      throw new Error(
        "Invalid configuration: GOOGLE_MCP_SHARED_SECRET is required and must be at least 32 characters long."
      );
    }
    const otherIssues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join(", ");
    throw new Error(`Invalid configuration: ${otherIssues}`);
  }

  return {
    port: result.data.GOOGLE_MCP_PORT,
    sharedSecret: result.data.GOOGLE_MCP_SHARED_SECRET,
    gatewayUrl: result.data.GOOGLE_MCP_GATEWAY_URL,
    gmailApiBase: result.data.GOOGLE_GMAIL_API_BASE,
    driveApiBase: result.data.GOOGLE_DRIVE_API_BASE,
  };
}

import { z } from "zod";
import { getEnv } from "../config/env.js";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/drive.readonly",
];

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export class GoogleExchangeError extends Error {
  readonly status: number;
  readonly googleError: string;

  constructor(status: number, googleError: string) {
    super(`Google token exchange failed (${status}): ${googleError}`);
    this.name = "GoogleExchangeError";
    this.status = status;
    this.googleError = googleError;
  }
}

const googleTokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string(),
  token_type: z.string(),
});

export type GoogleTokenResponse = z.infer<typeof googleTokenResponseSchema>;

/**
 * Retrieve Google OAuth credentials from environment configuration.
 * Returns null unless all three GOOGLE_* variables are defined.
 */
export function getGoogleConfig(): GoogleConfig | null {
  const env = getEnv();
  if (
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.GOOGLE_REDIRECT_URI
  ) {
    return null;
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI,
  };
}

/**
 * Build the Google authorization redirect URL with required PKCE and offline scopes.
 */
export function buildGoogleAuthUrl(
  cfg: GoogleConfig,
  state: string,
  codeChallenge: string
): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  return url.toString();
}

/**
 * Exchange an authorization code for Google access and refresh tokens.
 * Throws on non-2xx status, exposing only HTTP status and Google's error field.
 */
export async function exchangeGoogleCode(
  cfg: GoogleConfig,
  code: string,
  codeVerifier: string
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    let googleError = "unknown";
    try {
      const errJson = (await response.json()) as Record<string, unknown>;
      if (typeof errJson.error === "string") {
        googleError = errJson.error;
      }
    } catch {
      // Body was not JSON
    }
    throw new GoogleExchangeError(response.status, googleError);
  }

  const data = await response.json();
  return googleTokenResponseSchema.parse(data);
}

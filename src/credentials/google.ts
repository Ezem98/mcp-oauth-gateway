import { z } from "zod";
import { getEnv } from "../config/env.js";
import { logger } from "../observability/logger.js";
import {
  getCredential,
  updateCredentialMetadata,
  upsertCredential,
  type VaultCredential,
} from "./vault.js";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/drive.readonly",
];

export const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export class CredentialNotFoundError extends Error {
  constructor(message = "Credential not found") {
    super(message);
    this.name = "CredentialNotFoundError";
  }
}

export class ReconnectRequiredError extends Error {
  readonly userSubject: string;

  constructor(userSubject: string, message = "Reconnect required") {
    super(message);
    this.name = "ReconnectRequiredError";
    this.userSubject = userSubject;
  }
}

export class GoogleNotConfiguredError extends Error {
  constructor(message = "Google OAuth is not configured") {
    super(message);
    this.name = "GoogleNotConfiguredError";
  }
}

export class GoogleRefreshError extends Error {
  readonly status: number;

  constructor(status: number, message = `Google token refresh failed (${status})`) {
    super(message);
    this.name = "GoogleRefreshError";
    this.status = status;
  }
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

const googleRefreshTokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string(),
});

export type GoogleRefreshTokenResponse = z.infer<
  typeof googleRefreshTokenResponseSchema
>;

/**
 * Request a fresh access token from Google using a refresh token.
 */
async function refreshGoogleToken(
  cfg: GoogleConfig,
  refreshToken: string
): Promise<GoogleRefreshTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
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
  return googleRefreshTokenResponseSchema.parse(data);
}

const inFlightRefreshes = new Map<string, Promise<VaultCredential>>();

/**
 * Return a valid, fresh Google access token for the given user, refreshing
 * automatically if expired or nearing expiration.
 */
export async function getFreshGoogleToken(
  userSubject: string
): Promise<VaultCredential> {
  const inFlight = inFlightRefreshes.get(userSubject);
  if (inFlight) {
    return await inFlight;
  }

  const cred = getCredential(userSubject, "google");
  if (!cred) {
    throw new CredentialNotFoundError(
      `No vaulted credential for user='${userSubject}' provider='google'`
    );
  }

  if (cred.metadata?.needs_reconnect === true) {
    throw new ReconnectRequiredError(userSubject);
  }

  if (
    cred.expires_at === null ||
    new Date(cred.expires_at).getTime() - Date.now() > REFRESH_SKEW_MS
  ) {
    return cred;
  }

  if (!cred.refresh_token) {
    updateCredentialMetadata(userSubject, "google", {
      ...(cred.metadata ?? {}),
      needs_reconnect: true,
      needs_reconnect_since: new Date().toISOString(),
    });
    logger.warn("Google credential missing refresh token; reconnect required", {
      user: userSubject,
    });
    throw new ReconnectRequiredError(userSubject);
  }

  const cfg = getGoogleConfig();
  if (!cfg) {
    throw new GoogleNotConfiguredError();
  }

  const refreshPromise = (async () => {
    try {
      const tokenResponse = await refreshGoogleToken(cfg, cred.refresh_token!);
      const expiresAt = new Date(
        Date.now() + tokenResponse.expires_in * 1000
      ).toISOString();

      const nextMetadata: Record<string, unknown> = {
        ...(cred.metadata ?? {}),
        token_type: tokenResponse.token_type,
        refreshed_at: new Date().toISOString(),
      };
      delete nextMetadata.needs_reconnect;
      delete nextMetadata.needs_reconnect_since;

      const updated = upsertCredential({
        user_subject: userSubject,
        provider: "google",
        credential_type: "oauth2",
        access_token: tokenResponse.access_token,
        refresh_token: tokenResponse.refresh_token ?? cred.refresh_token,
        scope: tokenResponse.scope ?? cred.scope,
        expires_at: expiresAt,
        metadata: nextMetadata,
      });

      logger.info("Refreshed Google token", {
        user: userSubject,
        rotated_refresh_token: Boolean(tokenResponse.refresh_token),
      });

      return updated;
    } catch (err) {
      if (
        err instanceof GoogleExchangeError &&
        err.googleError === "invalid_grant"
      ) {
        updateCredentialMetadata(userSubject, "google", {
          ...(cred.metadata ?? {}),
          needs_reconnect: true,
          needs_reconnect_since: new Date().toISOString(),
        });
        logger.warn("Google refresh token rejected with invalid_grant", {
          user: userSubject,
        });
        throw new ReconnectRequiredError(userSubject);
      }
      const status = err instanceof GoogleExchangeError ? err.status : 0;
      throw new GoogleRefreshError(
        status,
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      inFlightRefreshes.delete(userSubject);
    }
  })();

  inFlightRefreshes.set(userSubject, refreshPromise);
  return await refreshPromise;
}

/**
 * Map errors from getFreshGoogleToken into HTTP error responses.
 */
export function freshTokenErrorResponse(
  err: unknown,
  userSubject: string
): { status: 404 | 409 | 502 | 503; body: Record<string, unknown> } | null {
  if (err instanceof CredentialNotFoundError) {
    return {
      status: 404,
      body: {
        error: "credential_not_found",
        error_description: err.message,
      },
    };
  }
  if (err instanceof ReconnectRequiredError) {
    return {
      status: 409,
      body: {
        error: "reconnect_required",
        connect_hint: `npm run connect-url -- ${err.userSubject || userSubject}`,
      },
    };
  }
  if (err instanceof GoogleNotConfiguredError) {
    return {
      status: 503,
      body: {
        error: "google_not_configured",
      },
    };
  }
  if (err instanceof GoogleRefreshError) {
    return {
      status: 502,
      body: {
        error: "upstream_refresh_failed",
      },
    };
  }
  return null;
}

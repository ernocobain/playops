/**
 * Google authentication boundary for PlayOps (Phase 1.1).
 *
 * Owns exactly one responsibility: turn the already-validated
 * ServiceAccountCredentials (Phase 0.7) into an authenticated Google client
 * able to obtain OAuth2 access tokens for explicitly supplied scopes.
 *
 * This module MUST NOT read credential files, parse credential JSON, read
 * credential env vars, or resolve credential paths — that is Phase 0's job.
 *
 * Uses the official google-auth-library for all JWT/OAuth/token mechanics.
 * Tokens are never persisted, logged, audited, or printed by this module.
 */
import { JWT } from "google-auth-library";
import type { ServiceAccountCredentials } from "../../config/index.js";

/** Google Play Developer API v3 (Android Publisher) scope. */
export const ANDROID_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";

/** Play Developer Reporting API scope. */
export const PLAY_DEVELOPER_REPORTING_SCOPE =
  "https://www.googleapis.com/auth/playdeveloperreporting";

export type AuthErrorCode =
  "INVALID_SCOPE" | "AUTH_CLIENT_CREATION_FAILED" | "ACCESS_TOKEN_FAILED" | "ACCESS_TOKEN_MISSING";

/**
 * Typed auth error. Carries only safe diagnostics: code, operation, and
 * (already non-secret) client_email. Never the private key, never an access
 * token, never the raw credentials object. The original error is preserved
 * via `cause` without serializing secret-bearing data into the message.
 */
export class AuthError extends Error {
  override readonly name = "AuthError";

  constructor(
    message: string,
    readonly code: AuthErrorCode,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Minimal structural view of the official client's token response.
 * google-auth-library's JWT.getAccessToken() resolves to an object shaped
 * like { token?: string | null }; the exact type is an internal detail, so
 * we adapt at the boundary rather than depending on it.
 */
export interface AccessTokenResponseLike {
  token?: string | null;
}

/** Narrow interface PlayOps needs from the official client (JWT satisfies it). */
export interface GoogleAuthClient {
  getAccessToken(): Promise<AccessTokenResponseLike>;
}

/**
 * Factory for the underlying google-auth-library client. Injectable at this
 * boundary so tests can observe construction without network access.
 * Not part of the minimal public workflow surface — exported for tests.
 */
export type JwtFactory = (options: {
  email: string;
  key: string;
  scopes: string[];
}) => GoogleAuthClient;

const defaultJwtFactory: JwtFactory = (options) =>
  new JWT({
    email: options.email,
    key: options.key,
    scopes: options.scopes,
  });

/**
 * Normalize requested scopes: reject empty input, reject blank entries,
 * de-duplicate, and return a deterministic (sorted) order. Extra scopes are
 * never added implicitly.
 */
export function normalizeScopes(scopes: readonly string[]): string[] {
  if (scopes.length === 0) {
    throw new AuthError("At least one Google API scope is required", "INVALID_SCOPE");
  }
  for (const scope of scopes) {
    if (typeof scope !== "string" || scope.trim() === "") {
      throw new AuthError(
        `Scope entries must be non-blank strings (received ${JSON.stringify(scope)})`,
        "INVALID_SCOPE",
      );
    }
  }
  return [...new Set(scopes)].sort();
}

/**
 * Create an authenticated Google client from validated in-memory
 * service-account credentials. Never touches the filesystem.
 */
export function createGoogleAuthClient(
  credentials: ServiceAccountCredentials,
  scopes: readonly string[],
  jwtFactory: JwtFactory = defaultJwtFactory,
): GoogleAuthClient {
  const normalized = normalizeScopes(scopes);
  try {
    return jwtFactory({
      email: credentials.clientEmail,
      key: credentials.privateKey,
      scopes: normalized,
    });
  } catch (cause) {
    throw new AuthError(
      `Failed to create Google auth client for ${credentials.clientEmail}`,
      "AUTH_CLIENT_CREATION_FAILED",
      { cause },
    );
  }
}

/**
 * Obtain a non-empty OAuth2 access token from the client.
 *
 * The token value is returned to the caller for immediate use and is never
 * included in error text. Underlying library failures are wrapped in a typed
 * AuthError whose message contains no secret material.
 */
export async function getGoogleAccessToken(client: GoogleAuthClient): Promise<string> {
  let response: AccessTokenResponseLike;
  try {
    response = await client.getAccessToken();
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AuthError(`Failed to obtain Google access token: ${reason}`, "ACCESS_TOKEN_FAILED", {
      cause,
    });
  }
  const token = response.token;
  if (token === null || token === undefined || token === "") {
    throw new AuthError("Google auth client returned no access token", "ACCESS_TOKEN_MISSING");
  }
  return token;
}

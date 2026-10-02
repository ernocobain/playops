/**
 * Credential locator / loader for the Google service-account JSON (Phase 0.7).
 *
 * Scope: locate the configured file, validate it is a readable regular file,
 * parse it as JSON, and check the minimal service-account shape. This module
 * does NOT authenticate with Google, does NOT request OAuth tokens, and does
 * NOT cryptographically validate the private key.
 *
 * Architecture: env/config precedence is owned entirely by the Phase 0.5
 * config loader. This module consumes the effective PlayOpsConfig only — it
 * never reads environment variables or config files itself.
 *
 * Security: private_key and the raw credential JSON are never included in
 * error messages, never logged, and never written to the audit log.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { PlayOpsConfig } from "./types.js";

/** Minimal validated service-account credential shape. */
export interface ServiceAccountCredentials {
  /** Always "service_account" (validated). */
  type: "service_account";
  clientEmail: string;
  /** PEM private key. Never printed, logged, or included in errors. */
  privateKey: string;
  tokenUri: string;
  /** Resolved absolute path the credentials were loaded from (safe metadata). */
  sourcePath: string;
}

export type CredentialErrorCode =
  | "CREDENTIAL_PATH_NOT_CONFIGURED"
  | "CREDENTIAL_FILE_NOT_FOUND"
  | "CREDENTIAL_NOT_A_FILE"
  | "CREDENTIAL_NOT_READABLE"
  | "CREDENTIAL_MALFORMED_JSON"
  | "CREDENTIAL_ROOT_NOT_OBJECT"
  | "CREDENTIAL_INVALID_SHAPE";

/**
 * Typed credential error. Messages contain only safe metadata: the resolved
 * path, the error code, and (where already validated) client_email. Never the
 * private key, never the raw JSON.
 */
export class CredentialError extends Error {
  override readonly name = "CredentialError";

  constructor(
    message: string,
    readonly code: CredentialErrorCode,
    /** Resolved absolute path involved in the failure (safe). */
    readonly path?: string,
  ) {
    super(message);
  }
}

/**
 * Resolve the configured credential path to an absolute path.
 *
 * Relative paths resolve against process.cwd() — predictable, no hidden
 * search paths. Returns undefined when no path is configured.
 */
export function resolveCredentialPath(config: PlayOpsConfig): string | undefined {
  const configured = config.googlePlay.serviceAccountJson;
  if (configured === "") return undefined;
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(doc: Record<string, unknown>, field: string, path: string): string {
  const value = doc[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new CredentialError(
      `Credential at ${path} is missing a valid "${field}" (expected non-empty string)`,
      "CREDENTIAL_INVALID_SHAPE",
      path,
    );
  }
  return value;
}

/**
 * Locate, read, parse, and minimally validate the service-account credential
 * configured on `config.googlePlay.serviceAccountJson`.
 *
 * @throws CredentialError with a typed code on every failure mode.
 */
export function loadServiceAccountCredentials(config: PlayOpsConfig): ServiceAccountCredentials {
  const path = resolveCredentialPath(config);
  if (path === undefined) {
    throw new CredentialError(
      "No service-account credential path configured (google_play.service_account_json is empty)",
      "CREDENTIAL_PATH_NOT_CONFIGURED",
    );
  }

  let stat;
  try {
    stat = statSync(path);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new CredentialError(
        `Credential file not found: ${path}`,
        "CREDENTIAL_FILE_NOT_FOUND",
        path,
      );
    }
    if (code === "EACCES") {
      throw new CredentialError(
        `Credential file is not accessible: ${path}`,
        "CREDENTIAL_NOT_READABLE",
        path,
      );
    }
    throw cause;
  }
  if (!stat.isFile()) {
    throw new CredentialError(
      `Credential path is not a regular file: ${path}`,
      "CREDENTIAL_NOT_A_FILE",
      path,
    );
  }

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new CredentialError(
      `Credential file is not readable: ${path} (${cause instanceof Error ? ((cause as NodeJS.ErrnoException).code ?? cause.message) : String(cause)})`,
      "CREDENTIAL_NOT_READABLE",
      path,
    );
  }

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new CredentialError(
      `Credential file is not valid JSON: ${path}`,
      "CREDENTIAL_MALFORMED_JSON",
      path,
    );
  }
  if (!isPlainObject(doc)) {
    throw new CredentialError(
      `Credential JSON root must be an object: ${path}`,
      "CREDENTIAL_ROOT_NOT_OBJECT",
      path,
    );
  }

  const type = doc.type;
  if (type !== "service_account") {
    throw new CredentialError(
      `Credential at ${path} has type ${JSON.stringify(type) ?? "undefined"}; expected "service_account"`,
      "CREDENTIAL_INVALID_SHAPE",
      path,
    );
  }

  const clientEmail = requireNonEmptyString(doc, "client_email", path);
  const privateKey = requireNonEmptyString(doc, "private_key", path);
  const tokenUri = requireNonEmptyString(doc, "token_uri", path);

  return {
    type: "service_account",
    clientEmail,
    privateKey,
    tokenUri,
    sourcePath: path,
  };
}

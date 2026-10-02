/**
 * PlayOps doctor — read-only connectivity diagnostics (Phase 1.4).
 *
 * Verifies, in order: config → credentials → auth → Android Publisher →
 * Play Developer Reporting. All Google operations are read-only (GET/list).
 * A failed check marks all later checks as skipped — no partial guessing.
 *
 * Secrets discipline: output never contains access tokens, private keys,
 * Authorization headers, credential objects, or raw Google/Gaxios errors.
 */
import type { PlayOpsConfig } from "../config/index.js";
import type { ServiceAccountCredentials } from "../config/index.js";
import type { GoogleAuthClient } from "../googleplay/auth/index.js";

export type DoctorCheckName =
  "CONFIG" | "CREDENTIALS" | "AUTH" | "ANDROID_PUBLISHER" | "PLAY_DEVELOPER_REPORTING";

export type DoctorCheckStatus = "pass" | "fail" | "skip";

export interface DoctorCheck {
  name: DoctorCheckName;
  status: DoctorCheckStatus;
  message: string;
  /** Non-secret diagnostic details (e.g. packageName, client_email, path). */
  safeDetails?: Record<string, string>;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** READY only when every required check passed. */
  status: "READY" | "NOT READY";
  /** Process exit code mapping: 0 = READY, 1 = NOT READY. */
  exitCode: 0 | 1;
}

/** Injectable live boundaries — unit tests fake these with zero network. */
export interface DoctorDeps {
  loadConfig(): PlayOpsConfig;
  loadCredentials(config: PlayOpsConfig): ServiceAccountCredentials;
  /** Acquires a token without exposing it, then returns the same auth client for both APIs. */
  authenticate(credentials: ServiceAccountCredentials): Promise<GoogleAuthClient>;
  /** Minimal read-only Publisher call (listReviews maxResults:1). Returns review count. */
  checkAndroidPublisher(
    config: PlayOpsConfig,
    auth: GoogleAuthClient,
  ): Promise<{ reviewsRead: number }>;
  /** Minimal read-only Reporting call (ANR metric-set get). */
  checkPlayDeveloperReporting(config: PlayOpsConfig, auth: GoogleAuthClient): Promise<void>;
}

/** Machine-readable classification attached to failure messages where safely inferable. */
export type DoctorFailureClass =
  | "CONFIG_INVALID"
  | "CREDENTIAL_FILE_MISSING"
  | "CREDENTIAL_INVALID"
  | "AUTH_FAILED"
  | "API_UNAUTHORIZED"
  | "PACKAGE_ACCESS_DENIED"
  | "PACKAGE_NOT_FOUND"
  | "REPORTING_ACCESS_DENIED"
  | "API_UNAVAILABLE"
  | "UNKNOWN_REMOTE_ERROR";

/** Extract ONLY a numeric HTTP status; never render a raw code, message, or response. */
function httpStatusOf(cause: unknown): number | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const wrapped = cause as { code?: unknown; cause?: unknown };
  const inner = wrapped.cause;
  const candidate =
    typeof inner === "object" && inner !== null && "code" in inner ? inner.code : wrapped.code;
  const value =
    typeof candidate === "string" && /^\d{3}$/.test(candidate) ? Number(candidate) : candidate;
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599
    ? value
    : undefined;
}

function classifyCredentialFailure(cause: unknown): DoctorFailureClass {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
  if (code === "CREDENTIAL_PATH_NOT_CONFIGURED" || code === "CREDENTIAL_FILE_NOT_FOUND") {
    return "CREDENTIAL_FILE_MISSING";
  }
  return "CREDENTIAL_INVALID";
}

function classifyApiFailure(cause: unknown, api: "publisher" | "reporting"): DoctorFailureClass {
  const status = httpStatusOf(cause);
  if (status === 401) return "API_UNAUTHORIZED";
  if (status === 403)
    return api === "publisher" ? "PACKAGE_ACCESS_DENIED" : "REPORTING_ACCESS_DENIED";
  if (status === 404 && api === "publisher") return "PACKAGE_NOT_FOUND";
  if (status === 503 || status === 502) return "API_UNAVAILABLE";
  return "UNKNOWN_REMOTE_ERROR";
}

const FAILURE_GUIDANCE: Record<DoctorFailureClass, string> = {
  CONFIG_INVALID:
    "Configure a non-blank Google Play package name and service-account path in config/playops.yaml or PLAYOPS_* environment variables.",
  CREDENTIAL_FILE_MISSING:
    "Point google_play.service_account_json at an existing service-account JSON file outside the repo.",
  CREDENTIAL_INVALID:
    "The credential file is not a valid Google service-account JSON (type/client_email/private_key/token_uri required).",
  AUTH_FAILED:
    "OAuth token acquisition failed — check the service-account key validity and network access to Google.",
  API_UNAUTHORIZED:
    "API rejected authentication; check the service-account identity, scope and token. Token acquisition alone does not prove API authorization.",
  PACKAGE_ACCESS_DENIED:
    "Response is ambiguous: check Google Play Developer API enablement, Play Console → Users and permissions, and read access for this app. Do not assume the API is disabled.",
  PACKAGE_NOT_FOUND:
    "Check the configured package name and app access; a 404 does not by itself prove the app is absent.",
  REPORTING_ACCESS_DENIED:
    "Response is ambiguous: check Play Developer Reporting API enablement and the service account's app-quality/vitals access in Play Console.",
  API_UNAVAILABLE: "Google API returned a temporary server error — retry later.",
  UNKNOWN_REMOTE_ERROR:
    "Google API request failed; check the numeric HTTP status (if present), package access, and API enablement.",
};

function pass(
  name: DoctorCheckName,
  message: string,
  safeDetails?: Record<string, string>,
): DoctorCheck {
  return { name, status: "pass", message, ...(safeDetails ? { safeDetails } : {}) };
}

function fail(
  name: DoctorCheckName,
  classification: DoctorFailureClass,
  cause: unknown,
  safeDetails?: Record<string, string>,
): DoctorCheck {
  const status = httpStatusOf(cause);
  return {
    name,
    status: "fail",
    message: `[${classification}] ${status === undefined ? "" : `HTTP ${status} — `}${FAILURE_GUIDANCE[classification]}`,
    ...(safeDetails ? { safeDetails } : {}),
  };
}

function skip(name: DoctorCheckName, reason: string): DoctorCheck {
  return { name, status: "skip", message: `skipped — ${reason}` };
}

const ORDER: DoctorCheckName[] = [
  "CONFIG",
  "CREDENTIALS",
  "AUTH",
  "ANDROID_PUBLISHER",
  "PLAY_DEVELOPER_REPORTING",
];

/**
 * Run all doctor checks in order. First failure skips the rest.
 * Read-only: the injected boundaries must only perform GET/list operations.
 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const checks = new Map<DoctorCheckName, DoctorCheck>();

  // CHECK 1 — CONFIG
  let config: PlayOpsConfig;
  try {
    config = deps.loadConfig();
    const problems: string[] = [];
    if (config.googlePlay.packageName.trim() === "") {
      problems.push("google_play.package_name is not configured");
    } else if (
      !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(config.googlePlay.packageName)
    ) {
      problems.push("google_play.package_name is not a valid package identifier");
    }
    if (config.googlePlay.serviceAccountJson.trim() === "") {
      problems.push("google_play.service_account_json is not configured");
    }
    if (problems.length > 0) {
      checks.set("CONFIG", {
        ...fail("CONFIG", "CONFIG_INVALID", undefined),
        message: `[CONFIG_INVALID] ${problems.join("; ")}. ${FAILURE_GUIDANCE.CONFIG_INVALID}`,
      });
      return finalize(checks, "config invalid");
    }
    checks.set(
      "CONFIG",
      pass("CONFIG", "effective configuration loaded", {
        packageName: config.googlePlay.packageName,
      }),
    );
  } catch (cause) {
    checks.set("CONFIG", fail("CONFIG", "CONFIG_INVALID", cause));
    return finalize(checks, "config failed to load");
  }

  // CHECK 2 — CREDENTIALS
  let credentials: ServiceAccountCredentials;
  let safeClientEmail: string;
  try {
    const creds = deps.loadCredentials(config);
    credentials = creds;
    safeClientEmail = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+$/.test(creds.clientEmail)
      ? creds.clientEmail
      : "(invalid email format — omitted)";
    checks.set(
      "CREDENTIALS",
      pass("CREDENTIALS", "service-account credential validated", {
        clientEmail: safeClientEmail,
      }),
    );
  } catch (cause) {
    checks.set("CREDENTIALS", fail("CREDENTIALS", classifyCredentialFailure(cause), cause));
    return finalize(checks, "credentials invalid");
  }

  // CHECK 3 — AUTH
  let auth: GoogleAuthClient;
  try {
    auth = await deps.authenticate(credentials);
    checks.set("AUTH", pass("AUTH", "access token acquired (not stored or printed)"));
  } catch (cause) {
    checks.set("AUTH", fail("AUTH", "AUTH_FAILED", cause, { clientEmail: safeClientEmail }));
    return finalize(checks, "authentication failed");
  }

  // CHECK 4 — ANDROID PUBLISHER (read-only)
  let publisherOk = false;
  try {
    const { reviewsRead } = await deps.checkAndroidPublisher(config, auth);
    publisherOk = true;
    checks.set(
      "ANDROID_PUBLISHER",
      pass(
        "ANDROID_PUBLISHER",
        `read-only reviews.list succeeded (${reviewsRead} review(s) read)`,
        { packageName: config.googlePlay.packageName },
      ),
    );
  } catch (cause) {
    checks.set(
      "ANDROID_PUBLISHER",
      fail("ANDROID_PUBLISHER", classifyApiFailure(cause, "publisher"), cause, {
        packageName: config.googlePlay.packageName,
      }),
    );
  }

  // CHECK 5 — PLAY DEVELOPER REPORTING (read-only)
  if (!publisherOk) {
    checks.set(
      "PLAY_DEVELOPER_REPORTING",
      skip("PLAY_DEVELOPER_REPORTING", "package access failed"),
    );
  } else {
    try {
      await deps.checkPlayDeveloperReporting(config, auth);
      checks.set(
        "PLAY_DEVELOPER_REPORTING",
        pass("PLAY_DEVELOPER_REPORTING", "read-only metric-set get succeeded"),
      );
    } catch (cause) {
      checks.set(
        "PLAY_DEVELOPER_REPORTING",
        fail("PLAY_DEVELOPER_REPORTING", classifyApiFailure(cause, "reporting"), cause),
      );
    }
  }

  return finalize(checks, null);
}

function finalize(
  checks: Map<DoctorCheckName, DoctorCheck>,
  skipReason: string | null,
): DoctorReport {
  const ordered: DoctorCheck[] = [];
  let skipping = skipReason !== null;
  for (const name of ORDER) {
    const existing = checks.get(name);
    if (existing !== undefined) {
      if (existing.status === "fail") skipping = true;
      ordered.push(existing);
      continue;
    }
    ordered.push(skip(name, skipping ? (skipReason ?? "earlier check failed") : "not run"));
  }
  const ready = ordered.every((check) => check.status === "pass");
  return { checks: ordered, status: ready ? "READY" : "NOT READY", exitCode: ready ? 0 : 1 };
}

/** Render a concise human-readable report. Safe fields only. */
export function formatDoctorReport(report: DoctorReport): string {
  const MARK: Record<DoctorCheckStatus, string> = { pass: "✓", fail: "✗", skip: "-" };
  const lines: string[] = ["PlayOps Doctor", ""];
  for (const check of report.checks) {
    lines.push(`${MARK[check.status]} ${check.name}`);
    if (check.status !== "pass") {
      lines.push(`  ${check.message}`);
    }
    if (check.safeDetails) {
      for (const [key, value] of Object.entries(check.safeDetails)) {
        lines.push(`  ${key}: ${value}`);
      }
    }
  }
  lines.push("", `Status: ${report.status}`);
  return lines.join("\n");
}

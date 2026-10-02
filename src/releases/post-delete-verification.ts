/**
 * Phase 4.15 / Blocker B4 — narrow, CONTEXTUAL post-delete edit-inactivity classifier.
 *
 * WHY CONTEXTUAL AND NOT GLOBAL: one controlled live observation on
 * `com.dhikrama.driver` (2026-10-02) showed that an `edits.get` for an edit that
 * had just been deleted fails with HTTP 400 / `FAILED_PRECONDITION` /
 * `failedPrecondition`. That observation is evidence, NOT a Google API contract:
 * `FAILED_PRECONDITION` is a generic precondition code that can accompany other
 * situations, and 400 can be produced by unrelated request problems. A bare
 * `400` / `FAILED_PRECONDITION` / `failedPrecondition` therefore NEVER proves
 * inactivity on its own (see the `400 alone ⇒ UNKNOWN` tests).
 *
 * This classifier proves inactivity ONLY when the complete trusted workflow
 * context is present: the same exact package and edit identity was read
 * successfully BEFORE the delete, the delete was acknowledged with exactly one
 * attempt and retry disabled, and the post-delete read of that same exact
 * identity failed with the observed structured tuple. Any missing, mismatched or
 * unexpected element yields UNKNOWN.
 *
 * Pure and total: it performs no I/O, reads no credential, holds no Google SDK
 * type, and never throws — hostile or malformed input simply yields UNKNOWN.
 */
import { parseGooglePlayEditSession } from "./index.js";

export const POST_DELETE_EDIT_VERDICTS = Object.freeze(["REMOTE_INACTIVE", "UNKNOWN"] as const);
export type PostDeleteEditVerdict = (typeof POST_DELETE_EDIT_VERDICTS)[number];

/** Closed reason enum; safe to surface, never free-form upstream text. */
export const POST_DELETE_EDIT_VERDICT_REASONS = Object.freeze([
  "verified_post_delete_inactivity",
  "context_incomplete",
  "pre_delete_read_not_succeeded",
  "delete_not_acknowledged",
  "delete_attempt_count_not_exactly_one",
  "delete_retry_not_disabled",
  "post_delete_read_unexpected_success",
  "identity_mismatch",
  "error_code_mismatch",
  "http_status_mismatch",
  "google_status_mismatch",
  "google_reason_mismatch",
] as const);
export type PostDeleteEditVerdictReason = (typeof POST_DELETE_EDIT_VERDICT_REASONS)[number];

/**
 * The exact structured tuple observed in the controlled live evidence. It is
 * required, never sufficient: `classifyPostDeleteEditRead` still demands the
 * full confirmed-delete context before returning REMOTE_INACTIVE.
 */
export const POST_DELETE_EDIT_OBSERVED_FAILURE = Object.freeze({
  code: "API_REQUEST_FAILED",
  status: 400,
  googleStatus: "FAILED_PRECONDITION",
  googleReason: "failedPrecondition",
} as const);

export interface PostDeleteEditIdentity {
  readonly packageName: string;
  readonly editId: string;
}

/** Evidence that the exact pre-delete read of this identity succeeded. */
export interface PreDeleteEditReadEvidence extends PostDeleteEditIdentity {
  readonly succeeded: boolean;
}

/** Evidence that the exact delete was acknowledged with one retry-disabled attempt. */
export interface AcknowledgedEditDeleteEvidence extends PostDeleteEditIdentity {
  readonly acknowledged: boolean;
  readonly attempts: number;
  readonly retryDisabled: boolean;
}

/** Evidence from the post-delete read of the same exact identity. */
export interface PostDeleteEditReadEvidence extends PostDeleteEditIdentity {
  readonly failed: boolean;
  /** PublisherError code, e.g. `API_REQUEST_FAILED`. */
  readonly code?: string;
  readonly status?: number;
  readonly googleStatus?: string;
  readonly googleReasons?: readonly string[];
}

export interface PostDeleteEditReadContext {
  readonly preDeleteRead: PreDeleteEditReadEvidence;
  readonly delete: AcknowledgedEditDeleteEvidence;
  readonly postDeleteRead: PostDeleteEditReadEvidence;
}

export interface PostDeleteEditVerdictResult {
  readonly verdict: PostDeleteEditVerdict;
  readonly reason: PostDeleteEditVerdictReason;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownReason(reason: PostDeleteEditVerdictReason): PostDeleteEditVerdictResult {
  return Object.freeze({ verdict: "UNKNOWN" as const, reason });
}

/** Reuse the production identity rule instead of duplicating it. */
function identityOf(value: unknown): PostDeleteEditIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const packageName = value.packageName;
  if (typeof packageName !== "string") return undefined;
  try {
    const session = parseGooglePlayEditSession({ packageName, editId: value.editId }, packageName);
    return { packageName: session.packageName, editId: session.editId };
  } catch {
    return undefined;
  }
}

function sameIdentity(left: PostDeleteEditIdentity, right: PostDeleteEditIdentity): boolean {
  return left.packageName === right.packageName && left.editId === right.editId;
}

/**
 * Classify one post-delete edit read. Returns REMOTE_INACTIVE only when every
 * trusted workflow-context condition holds simultaneously; otherwise UNKNOWN.
 */
export function classifyPostDeleteEditRead(context: unknown): PostDeleteEditVerdictResult {
  try {
    return classifyConfirmedDeleteContext(context);
  } catch {
    // A hostile or broken getter must never escape: an unreadable context is UNKNOWN.
    return unknownReason("context_incomplete");
  }
}

function classifyConfirmedDeleteContext(context: unknown): PostDeleteEditVerdictResult {
  if (!isRecord(context)) return unknownReason("context_incomplete");
  const preDeleteRead = context.preDeleteRead;
  const deletion = context.delete;
  const postDeleteRead = context.postDeleteRead;

  const preIdentity = identityOf(preDeleteRead);
  const deleteIdentity = identityOf(deletion);
  const postIdentity = identityOf(postDeleteRead);
  if (preIdentity === undefined || deleteIdentity === undefined || postIdentity === undefined) {
    return unknownReason("context_incomplete");
  }

  // 1. The exact pre-delete read must have succeeded.
  if (!isRecord(preDeleteRead) || preDeleteRead.succeeded !== true) {
    return unknownReason("pre_delete_read_not_succeeded");
  }
  // 2. The delete must have been acknowledged, once, with retry disabled.
  if (!isRecord(deletion) || deletion.acknowledged !== true) {
    return unknownReason("delete_not_acknowledged");
  }
  if (deletion.attempts !== 1) return unknownReason("delete_attempt_count_not_exactly_one");
  if (deletion.retryDisabled !== true) return unknownReason("delete_retry_not_disabled");
  // 3. The post-delete read must have failed (a success means the delete did not take effect).
  if (!isRecord(postDeleteRead) || postDeleteRead.failed !== true) {
    return unknownReason("post_delete_read_unexpected_success");
  }
  // 4. All three must refer to the same exact identity.
  if (!sameIdentity(preIdentity, deleteIdentity) || !sameIdentity(deleteIdentity, postIdentity)) {
    return unknownReason("identity_mismatch");
  }

  // 5. The exact observed structured tuple is required (and still not sufficient alone).
  if (postDeleteRead.code !== POST_DELETE_EDIT_OBSERVED_FAILURE.code) {
    return unknownReason("error_code_mismatch");
  }
  if (postDeleteRead.status !== POST_DELETE_EDIT_OBSERVED_FAILURE.status) {
    return unknownReason("http_status_mismatch");
  }
  if (postDeleteRead.googleStatus !== POST_DELETE_EDIT_OBSERVED_FAILURE.googleStatus) {
    return unknownReason("google_status_mismatch");
  }
  const reasons = Array.isArray(postDeleteRead.googleReasons) ? postDeleteRead.googleReasons : [];
  if (!reasons.includes(POST_DELETE_EDIT_OBSERVED_FAILURE.googleReason)) {
    return unknownReason("google_reason_mismatch");
  }

  return Object.freeze({
    verdict: "REMOTE_INACTIVE" as const,
    reason: "verified_post_delete_inactivity" as const,
  });
}

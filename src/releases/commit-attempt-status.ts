/**
 * Pure status of a PRODUCTION-PARSED commit-attempt record, never a second parser.
 *
 * Journal/schema/state-graph authority stays in commit-attempt-journal.ts. The
 * terminal/unresolved predicates below preserve its current private rule; real
 * public prepare() parity tests pin that contract without modifying the journal.
 */
import type { ReleaseCommitAttemptJournalRecord } from "./commit-attempt-journal.js";

export function isCommitAttemptTerminal(record: ReleaseCommitAttemptJournalRecord): boolean {
  return record.state === "RECONCILED_COMMITTED" || record.state === "RECONCILED_NOT_COMMITTED";
}

export function isCommitAttemptUnresolved(record: ReleaseCommitAttemptJournalRecord): boolean {
  return (
    !isCommitAttemptTerminal(record) ||
    (record.verificationInsertAttempted === true && record.verificationCleanupVerified !== true)
  );
}

/** Durable verification lifecycle only; commit acknowledgement is not a prefix. */
export function hasVerificationPrefix(record: ReleaseCommitAttemptJournalRecord): boolean {
  return (
    record.verificationInsertAttempted === true ||
    record.verificationEditId !== undefined ||
    record.verificationEditExpiryTimeSeconds !== undefined ||
    record.verificationObservedStateDigest !== undefined ||
    record.verificationObservedAtUtc !== undefined ||
    record.verificationPreDeleteReadVerified === true ||
    record.verificationDeleteAttempted === true ||
    record.verificationDeleteAcknowledged === true ||
    record.verificationCleanupVerified === true
  );
}

/** All actual Stage-3E proof markers, not just digest equality plus cleanup. */
export function hasCompleteVerifiedProof(record: ReleaseCommitAttemptJournalRecord): boolean {
  return (
    record.verificationInsertAttempted === true &&
    record.verificationEditId !== undefined &&
    record.verificationEditExpiryTimeSeconds !== undefined &&
    record.verificationObservedStateDigest !== undefined &&
    record.verificationObservedStateDigest === record.expectedStateDigest &&
    record.verificationObservedAtUtc !== undefined &&
    record.verificationPreDeleteReadVerified === true &&
    record.verificationDeleteAttempted === true &&
    record.verificationDeleteAcknowledged === true &&
    record.verificationCleanupVerified === true
  );
}

/**
 * Eligibility for the NEW local finalizer's specific continuation only. This
 * does NOT mean the existing production reconcile tool is zero-Google; it keeps
 * its original probe/expiry/approval gates. Session absence and exact current
 * snapshot rechecks remain imperative caller/finalizer checks, not this predicate.
 */
export function isVerifiedCommitLocallyFinalizable(
  record: ReleaseCommitAttemptJournalRecord,
): boolean {
  return record.state === "REMOTE_VERIFIED" && hasCompleteVerifiedProof(record);
}

/**
 * Which durable verification prefix an `ACKNOWLEDGED` attempt already carries.
 *
 * Routing classification only: it reads trusted persisted journal fields, uses
 * no timestamp or ordering heuristic, and decides which authority may continue
 * the record. It is not a parser and not a state machine.
 *
 *  - `none`               no verification lifecycle started (Stage 3E's own
 *                         fresh-verification territory).
 *  - `identity_unavailable` an insert was attempted but its handle is unknown.
 *                         The bridge may only report incomplete proof; production
 *                         recovery must not guess an identity or insert again.
 *  - `no_observation`     a temporary identity exists but no observed digest is
 *                         durable yet. The bridge-first policy is retained and
 *                         no observation may be fabricated.
 *  - `observation_unavailable` cleanup has advanced without a durable observation.
 *                         This is allowed by production recovery, not the ordered
 *                         success-proof bridge. Only signed recovery may use it.
 *  - `expected_observed`  the observed digest equals the expected one, so the
 *                         success-proof bridge may continue it.
 *  - `prior_observed`     the observed digest equals the persisted prior digest:
 *                         the SUCCESS-only bridge must reject it, and the
 *                         existing production reconciliation tool is the
 *                         recovery authority.
 *  - `unrelated_observed` some other digest was observed: the same recovery
 *                         authority, and it must never be reinterpreted as a
 *                         negative terminal outcome.
 */
export type CommitAttemptAckVerificationPrefixKind =
  | "none"
  | "identity_unavailable"
  | "no_observation"
  | "observation_unavailable"
  | "expected_observed"
  | "prior_observed"
  | "unrelated_observed";

export function classifyAcknowledgedVerificationPrefix(
  record: ReleaseCommitAttemptJournalRecord,
): CommitAttemptAckVerificationPrefixKind {
  if (!hasVerificationPrefix(record)) return "none";
  const observed = record.verificationObservedStateDigest;
  // No successful observation is durable yet: nothing may be inferred from the
  // other prefix markers, and no observation may be invented.
  if (observed === undefined) {
    if (record.verificationEditId === undefined) return "identity_unavailable";
    if (record.verificationPreDeleteReadVerified === true) return "observation_unavailable";
    return "no_observation";
  }
  if (observed === record.expectedStateDigest) return "expected_observed";
  if (record.priorStateDigest !== undefined && observed === record.priorStateDigest)
    return "prior_observed";
  return "unrelated_observed";
}

/**
 * True only for prefix kinds eligible for the existing bridge-first proof check,
 * which can report incomplete evidence without fabricating identity/observation.
 * Prior/unrelated observations are deliberately excluded: they are a
 * legitimate interrupted reconciliation, and the production reconciliation tool
 * owns their recovery semantics.
 */
export function isSuccessProofResumableAckPrefix(
  kind: CommitAttemptAckVerificationPrefixKind,
): boolean {
  return (
    kind === "identity_unavailable" || kind === "no_observation" || kind === "expected_observed"
  );
}

/**
 * Stage 3F.1: local continuation of complete, independent Stage-3E proof.
 *
 * CALLER CONTRACT: hold the SAME shared package-operation lease across candidate
 * rereads, both session-absence checks, transition, audit and receipt settlement.
 * This helper neither constructs nor owns a coordinator or a second lock. The
 * existing serialized single-daemon/store contract remains required: rechecks
 * cannot exclude an independent privileged writer after the last read.
 *
 * No gateway, original-edit probe, expiry gate, approval binding or model tool.
 * ACK continuation and partial-prefix recovery remain with their existing owners.
 */
import type { NewAuditEntry } from "../audit/index.js";
import {
  parseReleaseCommitAttemptJournalRecord,
  type ReleaseCommitAttemptJournal,
  type ReleaseCommitAttemptJournalRecord,
} from "./commit-attempt-journal.js";
import type { ReleaseEditSessionStore } from "./session-store.js";
import { hasCompleteVerifiedProof } from "./commit-attempt-status.js";
import { ReleaseError } from "./index.js";

export interface FinalizeVerifiedCommitOptions {
  readonly journal: Pick<ReleaseCommitAttemptJournal, "list" | "transition">;
  readonly sessionStore: Pick<ReleaseEditSessionStore, "load">;
  readonly candidate: ReleaseCommitAttemptJournalRecord;
  /** Required: every new terminal transition must have an append-only audit receipt. */
  readonly auditLedger: { append(entry: NewAuditEntry): Promise<void> };
  readonly now?: () => Date;
}

export type FinalizeVerifiedCommitRefusalCode =
  | "INVALID_ARGUMENT"
  | "COMMIT_STATE_CHANGED"
  | "COMMIT_STATE_NOT_FINALIZABLE"
  | "COMMIT_ALREADY_RECONCILED_NOT_COMMITTED"
  | "COMMIT_ATTEMPT_JOURNAL_INVALID"
  | "VERIFICATION_EVIDENCE_INCOMPLETE"
  | "MANAGED_EDIT_ALREADY_OPEN"
  | "MANAGED_EDIT_UNREADABLE";

export type FinalizeVerifiedCommitPersistenceCode =
  | "COMMIT_FINALIZATION_CLOCK_INVALID"
  | "COMMIT_FINALIZATION_TRANSITION_FAILED"
  | "COMMIT_FINALIZATION_RECEIPT_UNCONFIRMED"
  | "COMMIT_FINALIZATION_AUDIT_FAILED";

export type FinalizeVerifiedCommitResult =
  | { readonly outcome: "finalized" | "already_finalized"; readonly attemptId: string }
  | { readonly outcome: "refused"; readonly code: FinalizeVerifiedCommitRefusalCode }
  | {
      readonly outcome: "local_state_failure";
      readonly code: FinalizeVerifiedCommitPersistenceCode;
      /** Confirmed write-contract state; unavailable never implies rollback. */
      readonly durableState: "REMOTE_VERIFIED" | "RECONCILED_COMMITTED" | "unavailable";
      /** A visible rename is not proof that a failed persistence barrier completed. */
      readonly observedState?: "REMOTE_VERIFIED" | "RECONCILED_COMMITTED";
    };

function refused(code: FinalizeVerifiedCommitRefusalCode): FinalizeVerifiedCommitResult {
  return Object.freeze({ outcome: "refused", code });
}

function localFailure(
  code: FinalizeVerifiedCommitPersistenceCode,
  durableState: "REMOTE_VERIFIED" | "RECONCILED_COMMITTED" | "unavailable",
  observedState?: "REMOTE_VERIFIED" | "RECONCILED_COMMITTED",
): FinalizeVerifiedCommitResult {
  return Object.freeze({
    outcome: "local_state_failure",
    code,
    durableState,
    ...(observedState === undefined ? {} : { observedState }),
  });
}

/** Both operands have the production parser's fixed, flat canonical projection. */
function sameSnapshot(
  left: ReleaseCommitAttemptJournalRecord,
  right: ReleaseCommitAttemptJournalRecord,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Only the terminal transition's state/time may differ for idempotent lineage. */
function sameLineage(
  left: ReleaseCommitAttemptJournalRecord,
  right: ReleaseCommitAttemptJournalRecord,
): boolean {
  const { state: _leftState, updatedAtUtc: _leftTime, ...leftIdentityAndProof } = left;
  const { state: _rightState, updatedAtUtc: _rightTime, ...rightIdentityAndProof } = right;
  return JSON.stringify(leftIdentityAndProof) === JSON.stringify(rightIdentityAndProof);
}

type ExactRead =
  | { readonly ok: true; readonly record: ReleaseCommitAttemptJournalRecord }
  | { readonly ok: false; readonly result: FinalizeVerifiedCommitResult };

async function readExact(
  options: FinalizeVerifiedCommitOptions,
  candidate: ReleaseCommitAttemptJournalRecord,
): Promise<ExactRead> {
  try {
    const matches = (await options.journal.list()).filter(
      (record) => record.attemptId === candidate.attemptId,
    );
    if (matches.length !== 1) return { ok: false, result: refused("COMMIT_STATE_CHANGED") };
    return {
      ok: true,
      record: parseReleaseCommitAttemptJournalRecord(matches[0], candidate.packageName),
    };
  } catch {
    return { ok: false, result: refused("COMMIT_ATTEMPT_JOURNAL_INVALID") };
  }
}

async function sessionRefusal(
  options: FinalizeVerifiedCommitOptions,
): Promise<FinalizeVerifiedCommitResult | undefined> {
  try {
    return (await options.sessionStore.load()) === undefined
      ? undefined
      : refused("MANAGED_EDIT_ALREADY_OPEN");
  } catch {
    return refused("MANAGED_EDIT_UNREADABLE");
  }
}

/** Internal local continuation only; no gateway, approval binding or model tool. */
export async function finalizeVerifiedCommit(
  options: FinalizeVerifiedCommitOptions,
): Promise<FinalizeVerifiedCommitResult> {
  if (
    typeof options?.journal?.list !== "function" ||
    typeof options.journal.transition !== "function" ||
    typeof options.sessionStore?.load !== "function" ||
    typeof options.auditLedger?.append !== "function" ||
    (options.now !== undefined && typeof options.now !== "function")
  )
    return refused("INVALID_ARGUMENT");
  let candidate: ReleaseCommitAttemptJournalRecord;
  try {
    candidate = parseReleaseCommitAttemptJournalRecord(
      options.candidate,
      options.candidate.packageName,
    );
  } catch {
    return refused("COMMIT_ATTEMPT_JOURNAL_INVALID");
  }
  if (candidate.state === "RECONCILED_NOT_COMMITTED")
    return refused("COMMIT_ALREADY_RECONCILED_NOT_COMMITTED");
  if (candidate.state !== "REMOTE_VERIFIED" && candidate.state !== "RECONCILED_COMMITTED")
    return refused("COMMIT_STATE_NOT_FINALIZABLE");
  if (!hasCompleteVerifiedProof(candidate)) return refused("VERIFICATION_EVIDENCE_INCOMPLETE");
  const firstRead = await readExact(options, candidate);
  if (!firstRead.ok) return firstRead.result;
  const first = firstRead.record;
  const alreadyFinalized = first.state === "RECONCILED_COMMITTED";
  if (!(alreadyFinalized ? sameLineage(first, candidate) : sameSnapshot(first, candidate)))
    return refused("COMMIT_STATE_CHANGED");
  if (!hasCompleteVerifiedProof(first)) return refused("VERIFICATION_EVIDENCE_INCOMPLETE");
  const firstSession = await sessionRefusal(options);
  if (firstSession !== undefined) return firstSession;
  // Compute time before the FINAL recheck, never insert a clock callback between
  // that recheck and transition. Idempotent recognition consumes no new time.
  let updatedAtUtc = first.updatedAtUtc;
  if (!alreadyFinalized) {
    try {
      updatedAtUtc = (options.now ?? (() => new Date()))().toISOString();
    } catch {
      return localFailure("COMMIT_FINALIZATION_CLOCK_INVALID", "REMOTE_VERIFIED");
    }
  }
  const finalRead = await readExact(options, candidate);
  if (!finalRead.ok) return finalRead.result;
  if (!sameSnapshot(finalRead.record, first)) return refused("COMMIT_STATE_CHANGED");
  if (!hasCompleteVerifiedProof(finalRead.record))
    return refused("VERIFICATION_EVIDENCE_INCOMPLETE");
  const finalSession = await sessionRefusal(options);
  if (finalSession !== undefined) return finalSession;
  if (alreadyFinalized)
    return Object.freeze({ outcome: "already_finalized", attemptId: candidate.attemptId });
  let transitionResponseFailed = false;
  let transitionPersistenceFailed = false;
  try {
    await options.journal.transition(
      candidate.attemptId,
      "REMOTE_VERIFIED",
      "RECONCILED_COMMITTED",
      updatedAtUtc,
    );
  } catch (cause) {
    // Response loss AFTER the journal fulfilled its write contract may be
    // recovered by readback. The file journal's explicit persistence failure
    // (including directory-fsync after rename) must NOT be upgraded by visibility.
    transitionResponseFailed = true;
    transitionPersistenceFailed =
      cause instanceof ReleaseError && cause.code === "COMMIT_ATTEMPT_JOURNAL_INVALID";
  }
  const receipt = await readExact(options, candidate);
  if (!receipt.ok) return localFailure("COMMIT_FINALIZATION_RECEIPT_UNCONFIRMED", "unavailable");
  if (receipt.record.state === "REMOTE_VERIFIED" && sameSnapshot(receipt.record, first)) {
    return localFailure(
      transitionResponseFailed
        ? "COMMIT_FINALIZATION_TRANSITION_FAILED"
        : "COMMIT_FINALIZATION_RECEIPT_UNCONFIRMED",
      "REMOTE_VERIFIED",
    );
  }
  if (
    receipt.record.state !== "RECONCILED_COMMITTED" ||
    !sameLineage(receipt.record, candidate) ||
    !hasCompleteVerifiedProof(receipt.record)
  ) {
    return localFailure("COMMIT_FINALIZATION_RECEIPT_UNCONFIRMED", "unavailable");
  }
  if (transitionPersistenceFailed) {
    return localFailure(
      "COMMIT_FINALIZATION_TRANSITION_FAILED",
      "unavailable",
      "RECONCILED_COMMITTED",
    );
  }
  try {
    await options.auditLedger.append({
      type: "release.commit.local_finalization.completed",
      actor: "agent",
      action: "release.commit.local_finalization",
      status: "success",
      timestamp: receipt.record.updatedAtUtc,
      metadata: {
        attemptId: candidate.attemptId,
        packageName: candidate.packageName,
        sourceState: "REMOTE_VERIFIED",
        targetState: "RECONCILED_COMMITTED",
        expectedObservedDigestEqual: true,
        local_finalization: true,
        googleCalls: 0,
      },
    });
  } catch {
    // Terminal journal authority survived. A later invocation recognizes it
    // without another transition/audit; this failure never fabricates rollback.
    return localFailure("COMMIT_FINALIZATION_AUDIT_FAILED", "RECONCILED_COMMITTED");
  }
  return Object.freeze({ outcome: "finalized", attemptId: candidate.attemptId });
}

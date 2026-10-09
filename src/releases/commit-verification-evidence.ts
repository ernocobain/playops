/** Local, releases-domain consumer of trusted verification lifecycle evidence. */
import {
  parseReleaseCommitAttemptJournalRecord,
  type ReleaseCommitAttemptJournal,
  type ReleaseCommitAttemptJournalRecord,
} from "./commit-attempt-journal.js";
import { ReleaseError, validateReleasePackageName } from "./index.js";
import type {
  ReleaseVerificationEvidenceEvent,
  ReleaseVerificationEvidenceSink,
} from "./verification-evidence.js";

export interface CommitVerificationEvidenceJournalOptions {
  readonly journal: ReleaseCommitAttemptJournal;
  readonly attemptId: string;
  readonly packageName: string;
  readonly expectedStateDigest: string;
  readonly now?: () => Date;
}

function bind(
  options: CommitVerificationEvidenceJournalOptions,
): Required<CommitVerificationEvidenceJournalOptions> {
  const { journal, attemptId, expectedStateDigest } = options;
  const packageName = validateReleasePackageName(options.packageName);
  const now = options.now ?? (() => new Date());
  if (
    !journal ||
    [journal.list, journal.updateVerification, journal.transition].some(
      (method) => typeof method !== "function",
    ) ||
    typeof now !== "function" ||
    typeof attemptId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(attemptId) ||
    typeof expectedStateDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(expectedStateDigest)
  ) {
    throw new ReleaseError(
      "INVALID_ARGUMENT",
      "Verification evidence journal dependencies or identity are invalid.",
      { externalStateUncertain: false },
    );
  }
  return Object.freeze({ journal, attemptId, packageName, expectedStateDigest, now });
}

function conflict(): never {
  throw new ReleaseError(
    "VERIFICATION_STATE_MISMATCH",
    "Verification evidence conflicts with durable proof.",
    {
      externalStateUncertain: false,
    },
  );
}

function outOfOrder(): never {
  throw new ReleaseError(
    "VERIFICATION_STATE_MISMATCH",
    "Verification lifecycle order is invalid.",
    {
      externalStateUncertain: false,
    },
  );
}

function cleanupReady(record: ReleaseCommitAttemptJournalRecord): boolean {
  return (
    record.verificationInsertAttempted === true &&
    record.verificationEditId !== undefined &&
    record.verificationEditExpiryTimeSeconds !== undefined &&
    record.verificationObservedStateDigest === record.expectedStateDigest &&
    record.verificationObservedAtUtc !== undefined &&
    record.verificationPreDeleteReadVerified === true &&
    record.verificationDeleteAttempted === true &&
    record.verificationDeleteAcknowledged === true
  );
}

function complete(record: ReleaseCommitAttemptJournalRecord): boolean {
  return cleanupReady(record) && record.verificationCleanupVerified === true;
}

/** The journal permits weaker prefixes; this successful-evidence adapter does not. */
function assertMonotonicPrefix(record: ReleaseCommitAttemptJournalRecord): void {
  if (
    record.verificationObservedStateDigest !== undefined &&
    record.verificationObservedStateDigest !== record.expectedStateDigest
  )
    conflict();
  const present = [
    record.verificationInsertAttempted === true,
    record.verificationEditId !== undefined &&
      record.verificationEditExpiryTimeSeconds !== undefined,
    record.verificationObservedStateDigest !== undefined &&
      record.verificationObservedAtUtc !== undefined,
    record.verificationPreDeleteReadVerified === true,
    record.verificationDeleteAttempted === true,
    record.verificationDeleteAcknowledged === true,
    record.verificationCleanupVerified === true,
  ];
  const missing = present.indexOf(false);
  if (missing !== -1 && present.slice(missing + 1).some(Boolean)) outOfOrder();
}

// Shared only by local bridge calls on the same journal object, not a package
// lease or distributed lock. External writers retain the journal's serialized
// single-operator contract. A failed call never poisons the next queued call.
const pending = new WeakMap<ReleaseCommitAttemptJournal, Promise<void>>();
function serialized<T>(
  journal: ReleaseCommitAttemptJournal,
  operation: () => Promise<T>,
): Promise<T> {
  const result = (pending.get(journal) ?? Promise.resolve()).then(operation);
  pending.set(
    journal,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

async function loadExact(
  options: CommitVerificationEvidenceJournalOptions,
): Promise<ReleaseCommitAttemptJournalRecord> {
  const matches = (await options.journal.list()).filter(
    (record) => record.attemptId === options.attemptId,
  );
  const [match] = matches;
  if (
    matches.length !== 1 ||
    match === undefined ||
    match.packageName !== options.packageName ||
    match.expectedStateDigest !== options.expectedStateDigest
  ) {
    throw new ReleaseError(
      "COMMIT_STATE_CHANGED",
      "The bound commit attempt does not match the journal.",
      {
        externalStateUncertain: false,
      },
    );
  }
  const record = parseReleaseCommitAttemptJournalRecord(match, options.packageName);
  assertMonotonicPrefix(record);
  return record;
}

export function createCommitVerificationEvidenceJournalSink(
  options: CommitVerificationEvidenceJournalOptions,
): ReleaseVerificationEvidenceSink {
  const bound = bind(options);
  const { journal, attemptId, expectedStateDigest, now } = bound;
  return Object.freeze({
    async record(event: ReleaseVerificationEvidenceEvent) {
      const snapshot = Object.freeze({ ...event });
      return serialized(journal, async () => {
        event = snapshot;
        const record = await loadExact(bound);
        // Terminal cleanup replay is not permission to start another verification.
        if (record.state === "REMOTE_VERIFIED" && event.type === "verification_cleanup_verified") {
          if (!complete(record)) conflict();
          return;
        }
        if (record.state !== "ACKNOWLEDGED") {
          throw new ReleaseError(
            "COMMIT_STATE_CHANGED",
            "Verification evidence requires an acknowledged commit attempt.",
            {
              externalStateUncertain: false,
            },
          );
        }
        if (event.type === "verification_insert_attempted") {
          if (record.verificationInsertAttempted === true) return;
          await journal.updateVerification(attemptId, "ACKNOWLEDGED", now().toISOString(), {
            verificationInsertAttempted: true,
          });
          return;
        }
        if (event.type === "verification_edit_identified") {
          if (record.verificationInsertAttempted !== true) outOfOrder();
          if (
            record.verificationEditId !== undefined ||
            record.verificationEditExpiryTimeSeconds !== undefined
          ) {
            if (
              record.verificationEditId !== event.editId ||
              record.verificationEditExpiryTimeSeconds !== event.expiryTimeSeconds
            )
              conflict();
            return;
          }
          await journal.updateVerification(attemptId, "ACKNOWLEDGED", now().toISOString(), {
            verificationEditId: event.editId,
            verificationEditExpiryTimeSeconds: event.expiryTimeSeconds,
          });
          return;
        }
        if (event.type === "verification_state_observed") {
          if (
            record.verificationEditId === undefined ||
            record.verificationEditExpiryTimeSeconds === undefined
          )
            outOfOrder();
          if (event.observedStateDigest !== expectedStateDigest) conflict();
          if (
            record.verificationObservedStateDigest !== undefined ||
            record.verificationObservedAtUtc !== undefined
          ) {
            if (
              record.verificationObservedStateDigest !== event.observedStateDigest ||
              record.verificationObservedAtUtc !== event.observedAtUtc
            )
              conflict();
            return;
          }
          await journal.updateVerification(attemptId, "ACKNOWLEDGED", now().toISOString(), {
            verificationObservedStateDigest: event.observedStateDigest,
            verificationObservedAtUtc: event.observedAtUtc,
          });
          return;
        }
        if (event.type === "verification_pre_delete_read_verified") {
          if (
            record.verificationObservedStateDigest !== expectedStateDigest ||
            record.verificationObservedAtUtc === undefined
          )
            outOfOrder();
          if (record.verificationPreDeleteReadVerified === true) return;
          await journal.updateVerification(attemptId, "ACKNOWLEDGED", now().toISOString(), {
            verificationPreDeleteReadVerified: true,
          });
          return;
        }
        if (event.type === "verification_delete_attempted") {
          if (record.verificationPreDeleteReadVerified !== true) outOfOrder();
          if (record.verificationDeleteAttempted === true) return;
          await journal.updateVerification(attemptId, "ACKNOWLEDGED", now().toISOString(), {
            verificationDeleteAttempted: true,
          });
          return;
        }
        if (event.type === "verification_delete_acknowledged") {
          if (record.verificationDeleteAttempted !== true) outOfOrder();
          if (record.verificationDeleteAcknowledged === true) return;
          await journal.updateVerification(attemptId, "ACKNOWLEDGED", now().toISOString(), {
            verificationDeleteAcknowledged: true,
          });
          return;
        }
        if (event.type === "verification_cleanup_verified") {
          if (!cleanupReady(record)) outOfOrder();
          if (record.verificationCleanupVerified !== true) {
            await journal.updateVerification(attemptId, "ACKNOWLEDGED", now().toISOString(), {
              verificationCleanupVerified: true,
            });
          }
          const durable = await loadExact(bound);
          if (durable.state !== "ACKNOWLEDGED" || !complete(durable)) conflict();
          await journal.transition(
            attemptId,
            "ACKNOWLEDGED",
            "REMOTE_VERIFIED",
            now().toISOString(),
          );
          const verified = await loadExact(bound);
          if (verified.state !== "REMOTE_VERIFIED" || !complete(verified)) conflict();
          return;
        }
        outOfOrder();
      });
    },
  });
}

/** Continue only already-durable local proof; never execute another verifier. */
export type CommitVerificationEvidenceResumeResult =
  "verified" | "already_verified" | "verification_evidence_incomplete";

export async function resumeCommitVerificationEvidence(
  options: CommitVerificationEvidenceJournalOptions,
): Promise<CommitVerificationEvidenceResumeResult> {
  const bound = bind(options);
  const { journal, attemptId, now } = bound;
  return serialized(journal, async () => {
    const record = await loadExact(bound);
    if (record.state === "REMOTE_VERIFIED") {
      if (!complete(record)) conflict();
      return "already_verified";
    }
    if (record.state !== "ACKNOWLEDGED") {
      throw new ReleaseError(
        "COMMIT_STATE_CHANGED",
        "Verification evidence requires an acknowledged commit attempt.",
        {
          externalStateUncertain: false,
        },
      );
    }
    if (!complete(record)) return "verification_evidence_incomplete";
    await journal.transition(attemptId, "ACKNOWLEDGED", "REMOTE_VERIFIED", now().toISOString());
    const verified = await loadExact(bound);
    if (verified.state !== "REMOTE_VERIFIED" || !complete(verified)) conflict();
    return "verified";
  });
}

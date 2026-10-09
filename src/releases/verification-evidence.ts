/**
 * Trusted, internal Stage-3E.2A lifecycle evidence for exact committed-release
 * verification. This is not tool input, a public result, an audit projection,
 * a wire message, or a commit-attempt journal writer.
 *
 * One execution emits an immutable, awaited prefix of these events. No later
 * event is emitted after a mismatch or sink failure. Exact-ID failure cleanup
 * still runs outside that proof prefix; its recovery authority is the existing
 * temporary-edit cleanup journal, not this sink.
 */
import { ReleaseError } from "./index.js";

export type ReleaseVerificationEvidenceEvent =
  | { readonly type: "verification_insert_attempted" }
  | {
      readonly type: "verification_edit_identified";
      readonly editId: string;
      readonly expiryTimeSeconds: string;
    }
  | {
      readonly type: "verification_state_observed";
      readonly observedStateDigest: string;
      readonly observedAtUtc: string;
    }
  | { readonly type: "verification_pre_delete_read_verified" }
  | { readonly type: "verification_delete_attempted" }
  | { readonly type: "verification_delete_acknowledged" }
  | { readonly type: "verification_cleanup_verified" };

/**
 * Composition-only consumer. A durable consumer must resolve record() only
 * after persistence. Rejections abort normal verification; events are never
 * retried. Optional today for non-daemon compatibility; no no-op sink is wired.
 */
export interface ReleaseVerificationEvidenceSink {
  record(event: ReleaseVerificationEvidenceEvent): Promise<void>;
}

/** Internal failure facts, deliberately excluding temporary edit identity. */
export interface ReleaseVerificationEvidenceFailureFacts {
  readonly committedStateObserved: boolean;
  readonly temporaryEditCleanupSucceeded: boolean;
  readonly verificationCleanupVerified: boolean;
  readonly externalStateUncertain: boolean;
  readonly cause?: unknown;
  readonly auditPersistenceFailed?: boolean;
}

/** Local evidence failure stays distinct from a digest mismatch or remote failure. */
export class ReleaseVerificationEvidencePersistenceError extends ReleaseError {
  readonly failureDomain = "local_evidence_persistence" as const;
  readonly committedStateObserved: boolean;
  readonly temporaryEditCleanupSucceeded: boolean;
  readonly verificationCleanupVerified: boolean;
  readonly auditPersistenceFailed: boolean;

  constructor(
    readonly failedEvent: ReleaseVerificationEvidenceEvent["type"],
    facts: ReleaseVerificationEvidenceFailureFacts,
  ) {
    super(
      "VERIFICATION_EVIDENCE_PERSISTENCE_FAILED",
      "Local verification lifecycle evidence could not be persisted." +
        (facts.committedStateObserved ? " The approved committed state was observed." : "") +
        (facts.externalStateUncertain
          ? " Temporary edit deletion could not be confirmed; external state may be uncertain."
          : facts.temporaryEditCleanupSucceeded
            ? " The exact temporary edit was deleted."
            : " No temporary edit insert was attempted.") +
        (facts.auditPersistenceFailed ? " The failure audit could not be persisted either." : ""),
      { cause: facts.cause, externalStateUncertain: facts.externalStateUncertain },
    );
    this.committedStateObserved = facts.committedStateObserved;
    this.temporaryEditCleanupSucceeded = facts.temporaryEditCleanupSucceeded;
    this.verificationCleanupVerified = facts.verificationCleanupVerified;
    this.auditPersistenceFailed = facts.auditPersistenceFailed === true;
  }
}

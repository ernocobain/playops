/**
 * Stage 3E.3 — daemon `prepare_verify_committed` / `execute_verify_committed`.
 *
 * This module owns the destructive post-commit verification ORCHESTRATION only.
 * The verification algorithm itself stays where it already was:
 *
 *   daemon -> executeOneTool -> runAgent -> releases.verify_committed_release
 *          -> production Layer A -> one temporary verification edit
 *          -> createReleaseCommitStateDigest -> Stage-3E.2A evidence sink
 *          -> Stage-3E.2B strict commit-attempt journal bridge -> REMOTE_VERIFIED
 *
 * Nothing here calls the release gateway, a tool implementation, or any Google
 * method directly. There is no second digest, intent, approval, claim, cleanup
 * or verification model in this file: each of them is imported from the
 * production module that already owns it.
 *
 * Authority rules (this stage is deliberately stricter than the journal):
 *
 *  - The package's REAL commit-attempt journal is the only source of the
 *    verification expectation. Selection is bound to one exact durable identity
 *    (`packageName` + `targetTrack` + `versionCode`) plus the journal's own
 *    structural invariant that at most one record is non-reconciled — never to
 *    first/last/newest/timestamp ordering.
 *  - A fresh destructive verification is eligible only for an `ACKNOWLEDGED`
 *    record with NO verification evidence yet. Any existing verification prefix
 *    is continued LOCALLY through `resumeCommitVerificationEvidence` and can
 *    never trigger a second Google verification: the temporary verification
 *    identity is immutable and a second temporary edit would conflict with the
 *    durable evidence chain.
 *  - A completed commit pending record with exactly matching durable provenance
 *    must exist before a NEW destructive approval is offered.
 *  - `REMOTE_VERIFIED` is terminal here. Stage 3F owns reconciliation; no path
 *    in this module reaches `RECONCILED_COMMITTED` / `RECONCILED_NOT_COMMITTED`.
 *
 * The shared package-operation coordinator (Stage 3E.2D) is acquired before any
 * journal-mutating or remotely-mutating step and is released LAST, after the
 * daemon pending settlement and the request-claim release.
 */
import { epochSecondsFromDate, normalizeReleaseVersionCode } from "../releases/index.js";
import {
  createCommitVerificationEvidenceJournalSink,
  resumeCommitVerificationEvidence,
  type CommitVerificationEvidenceResumeResult,
} from "../releases/commit-verification-evidence.js";
import type {
  ReleaseCommitAttemptJournal,
  ReleaseCommitAttemptJournalRecord,
} from "../releases/commit-attempt-journal.js";
import type { ReleaseEditCleanupJournal } from "../releases/cleanup-journal.js";
import type {
  ReleaseSummaryGateway,
  ReleaseTemporaryEditVerificationGateway,
} from "../releases/gateway.js";
import {
  createReleaseStateVerificationApprovalBinding,
  createReleaseStateVerificationIntent,
  RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME,
  type ReleaseStateVerificationIntent,
} from "../releases/readback-approval.js";
import { loadReleaseEditSessionState } from "../releases/session-store.js";
import type { ReleaseEditSessionStore } from "../releases/session-store.js";
import {
  createReleaseExactVerificationTool,
  type ReleaseExactVerificationAuditLedger,
} from "../releases/verify-committed-release-tool.js";
import { executeOneTool } from "../runtime/agent/execute-one-tool.js";
import type { AgentLedger, AgentRunResult } from "../runtime/agent/index.js";
import type { ApprovalLedger } from "../runtime/approvals/index.js";
import type { OperatorApprovalVerifier } from "../runtime/approvals/operator-signature.js";
import { ToolRegistry } from "../runtime/tools/index.js";
import type { VerificationLedger } from "../runtime/verification/index.js";
import { createOperatorSignatureApprovalResolver } from "./approval-resolver.js";
import { journalBlockResponse } from "./commit-operations.js";
import {
  PACKAGE_OPERATION_BUSY_CODE,
  type PackageOperationCoordinator,
} from "./package-operation-singleflight.js";
import type {
  PendingCommitIntent,
  PendingOperationRecord,
  PendingOperationStore,
  PendingVerifyCommittedIntent,
} from "./pending-store.js";
import {
  approvalChallengeFor,
  approvalPayloadFor,
  envelope,
  outcomeForNonPendingState,
} from "./pending-view.js";
import {
  acquireRequestClaim,
  releaseRequestClaim,
  RequestClaimError,
  type RequestClaim,
} from "./request-claim.js";
import type { DaemonResponseEnvelope, DaemonResponseOutcome } from "./protocol.js";

/** `prepare_verify_committed` carries the protocol v4 track-scoped shape only. */
export interface DaemonVerifyCommittedRequest {
  readonly track: string;
  readonly versionCode: string;
}

/**
 * Stage 3E.3 dependency surface.
 *
 * The two gateways are the NARROW production boundaries the verifier already
 * consumes: a read-only deployed-release summary gateway and the temporary-edit
 * verification gateway (create / read / delete of one temporary edit). No
 * broader release gateway is reachable here, so this module cannot commit,
 * upload, update a track, or touch release notes even by mistake.
 */
export interface DaemonVerifyCommittedDependencies {
  /** Trusted package identity. The client can never supply or override it. */
  readonly packageName: string;
  readonly pendingStore: PendingOperationStore;
  /** Directory holding exclusive request-claim files. */
  readonly claimRoot: string;
  readonly managedSessionStore: ReleaseEditSessionStore;
  readonly summaryGateway: ReleaseSummaryGateway;
  readonly temporaryEditGateway: ReleaseTemporaryEditVerificationGateway;
  /** Durable temporary-edit cleanup journal; its records are evidence, not policy. */
  readonly cleanupJournal: ReleaseEditCleanupJournal;
  /** The verification tool's own audit ledger. */
  readonly verifyAuditLedger: ReleaseExactVerificationAuditLedger;
  /**
   * Re-opens the real package commit-attempt journal FOR READ. Every call must
   * observe current durable state; a cached instance would let a stale read
   * defeat the mandatory post-acquisition recheck.
   */
  readonly openCommitAttemptJournal: () => ReleaseCommitAttemptJournal;
  readonly operatorVerifier: OperatorApprovalVerifier;
  readonly ledger: AgentLedger;
  readonly approvalLedger: ApprovalLedger;
  readonly verificationLedger: VerificationLedger;
  readonly now?: () => Date;
}

function failure(
  correlationId: string,
  outcome: DaemonResponseOutcome,
  code: string,
  message: string,
): DaemonResponseEnvelope {
  return envelope(correlationId, outcome, { error: { code, message } });
}

function clockOf(deps: DaemonVerifyCommittedDependencies): () => Date {
  return deps.now ?? ((): Date => new Date());
}

/**
 * The tool's own failure code, surfaced faithfully.
 *
 * `runAgent` reports a thrown tool error as `EXECUTION_FAILED` and keeps the
 * real error as `cause`; the operator-facing code must be the tool's, not the
 * runtime's wrapper, otherwise a local evidence-persistence failure would be
 * indistinguishable from any other tool error.
 */
function toolFailureCode(result: AgentRunResult): string {
  const cause = result.cause;
  if (typeof cause === "object" && cause !== null) {
    const code: unknown = Reflect.get(cause, "code");
    if (typeof code === "string" && code.length > 0) return code;
  }
  return result.code;
}

/**
 * True when the record carries ANY Stage-3E verification evidence.
 *
 * The journal deliberately permits weaker prefixes; this module treats every one
 * of them as "a temporary verification identity may already exist", which is why
 * such a record can never start a fresh destructive verification.
 */
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

/** Reconciliation is the only terminal state a commit attempt can reach. */
export function isReconciledTerminalState(record: ReleaseCommitAttemptJournalRecord): boolean {
  return record.state === "RECONCILED_COMMITTED" || record.state === "RECONCILED_NOT_COMMITTED";
}

/** The exact durable identity a verification request may bind to. */
export interface VerificationAttemptIdentity {
  readonly packageName: string;
  readonly targetTrack: string;
  readonly versionCode: string;
}

function matchesIdentity(
  record: ReleaseCommitAttemptJournalRecord,
  identity: VerificationAttemptIdentity,
): boolean {
  return (
    record.packageName === identity.packageName &&
    record.targetTrack === identity.targetTrack &&
    record.versionCode === identity.versionCode
  );
}

export type VerifyAuthorityMode = "fresh" | "recover" | "already_verified";

/**
 * Why a verification request cannot proceed, in the narrowest truthful terms.
 *
 * `blocked` carries the record the journal's own ruled mapping should describe;
 * `ambiguous` means the journal's structural invariant is violated for this
 * identity (more than one non-reconciled record), so nothing may be assumed.
 */
export type VerifyRefusal =
  | { readonly kind: "no_attempt" }
  | { readonly kind: "blocked"; readonly record: ReleaseCommitAttemptJournalRecord }
  | { readonly kind: "ambiguous" };

export type VerifyAuthority =
  | {
      readonly ok: true;
      readonly mode: VerifyAuthorityMode;
      readonly record: ReleaseCommitAttemptJournalRecord;
    }
  | { readonly ok: false; readonly refusal: VerifyRefusal };

/**
 * Decide, from durable journal state only, whether this request may start a fresh
 * destructive verification, must continue an existing one locally, or must not
 * verify at all.
 *
 * No timestamp or first/last heuristic is used to pick the attempt: candidates
 * are bound to the exact durable identity, and among them the journal's OWN
 * invariant decides. More than one non-reconciled candidate is not something
 * this module will guess about.
 */
export function selectVerificationAttempt(
  records: readonly ReleaseCommitAttemptJournalRecord[],
  identity: VerificationAttemptIdentity,
): VerifyAuthority {
  const candidates = records.filter((record) => matchesIdentity(record, identity));
  if (candidates.length === 0) return { ok: false, refusal: { kind: "no_attempt" } };
  const open = candidates.filter((record) => !isReconciledTerminalState(record));
  if (open.length === 0) {
    const last = candidates[candidates.length - 1];
    if (last === undefined) return { ok: false, refusal: { kind: "no_attempt" } };
    // Already reconciled: no new verification may be started.
    return { ok: false, refusal: { kind: "blocked", record: last } };
  }
  if (open.length > 1) return { ok: false, refusal: { kind: "ambiguous" } };
  const record = open[0] as ReleaseCommitAttemptJournalRecord;
  if (record.state === "REMOTE_VERIFIED") {
    return { ok: true, mode: "already_verified", record };
  }
  if (record.state === "ACKNOWLEDGED") {
    return { ok: true, mode: hasVerificationPrefix(record) ? "recover" : "fresh", record };
  }
  // PREPARED / TRANSPORT_ATTEMPTED / AMBIGUOUS: the journal's own narrowest
  // verdict applies, so the caller maps it with the single shared mapping.
  return { ok: false, refusal: { kind: "blocked", record } };
}

/**
 * The exact completed-commit provenance the Stage-3D pending store must still
 * prove before a NEW destructive approval may be offered.
 *
 * Every durable value persisted in both structures is compared; nothing is
 * matched by time or order, and the verifier expectation still comes from the
 * ACK journal itself. `requestDigest` may legitimately repeat across time for an
 * identical commit intent, so more than one match is fine as long as every match
 * is semantically identical — which the field-for-field filter guarantees.
 */
export function completedCommitProvenanceMatches(
  pendingRecords: readonly PendingOperationRecord[],
  journalRecord: ReleaseCommitAttemptJournalRecord,
): readonly PendingOperationRecord[] {
  return pendingRecords.filter((record) => {
    if (record.operation !== "commit" || record.state !== "COMPLETED") return false;
    if (record.packageName !== journalRecord.packageName) return false;
    if (record.requestDigest !== journalRecord.requestDigest) return false;
    const intent = record.intent;
    if (intent.kind !== "commit") return false;
    const commit: PendingCommitIntent = intent;
    return (
      commit.targetTrack === journalRecord.targetTrack &&
      commit.versionCode === journalRecord.versionCode &&
      commit.editId === journalRecord.editId &&
      commit.stateDigest === journalRecord.expectedStateDigest &&
      commit.validationExpiryTimeSeconds === journalRecord.validationExpiryTimeSeconds &&
      commit.releaseName === journalRecord.releaseName &&
      commit.releaseStatus === journalRecord.releaseStatus
    );
  });
}

/** The Stage-3E.1 Layer-B expectation, derived from durable journal fields only. */
export function verificationIntentFromJournal(
  journalRecord: ReleaseCommitAttemptJournalRecord,
): ReleaseStateVerificationIntent {
  return createReleaseStateVerificationIntent({
    packageName: journalRecord.packageName,
    targetTrack: journalRecord.targetTrack,
    versionCode: journalRecord.versionCode,
    expectedReleaseName: journalRecord.releaseName,
    expectedStateDigest: journalRecord.expectedStateDigest,
  });
}

function pendingVerifyIntent(
  journalRecord: ReleaseCommitAttemptJournalRecord,
): PendingVerifyCommittedIntent {
  return Object.freeze({
    kind: "verify_committed",
    targetTrack: journalRecord.targetTrack,
    versionCode: journalRecord.versionCode,
    expectedStateDigest: journalRecord.expectedStateDigest,
  });
}

/** Field names are reported so a drift failure can name the exact binding. */
function verifyIntentDrift(
  approved: PendingVerifyCommittedIntent,
  journalRecord: ReleaseCommitAttemptJournalRecord,
  approvedRequestDigest: string,
  freshRequestDigest: string,
): string | undefined {
  if (approved.targetTrack !== journalRecord.targetTrack) return "TARGET_TRACK";
  if (approved.versionCode !== journalRecord.versionCode) return "VERSION_CODE";
  if (approved.expectedStateDigest !== journalRecord.expectedStateDigest) return "STATE_DIGEST";
  if (approvedRequestDigest !== freshRequestDigest) return "REQUEST_DIGEST";
  return undefined;
}

type AuthorityRead =
  | { readonly ok: true; readonly authority: VerifyAuthority }
  | { readonly ok: false; readonly response: DaemonResponseEnvelope };

/**
 * Read the package journal and interpret it. Read-only: the journal's durable
 * bytes are never altered here, and no Google call is reachable.
 */
async function readVerifyAuthority(
  deps: DaemonVerifyCommittedDependencies,
  correlationId: string,
  request: DaemonVerifyCommittedRequest,
): Promise<AuthorityRead> {
  let records: readonly ReleaseCommitAttemptJournalRecord[];
  try {
    records = await deps.openCommitAttemptJournal().list();
  } catch {
    // The journal exists but cannot be read: an unresolved remote effect cannot
    // be ruled out, so this is never treated as "nothing to verify".
    return {
      ok: false,
      response: failure(
        correlationId,
        "external_state_ambiguous",
        "COMMIT_JOURNAL_UNREADABLE",
        "The package commit-attempt journal could not be read; operator recovery is required.",
      ),
    };
  }
  let versionCode: string;
  try {
    versionCode = normalizeReleaseVersionCode(request.versionCode);
  } catch {
    return {
      ok: false,
      response: failure(
        correlationId,
        "local_state_failure",
        "VERIFICATION_VERSION_INVALID",
        "The requested version code is not a valid release identity.",
      ),
    };
  }
  const authority = selectVerificationAttempt(records, {
    packageName: deps.packageName,
    targetTrack: request.track,
    versionCode,
  });
  if (authority.ok) return { ok: true, authority };
  switch (authority.refusal.kind) {
    case "no_attempt":
      return {
        ok: false,
        response: failure(
          correlationId,
          "local_state_failure",
          "VERIFICATION_NO_ACKNOWLEDGED_ATTEMPT",
          "No acknowledged commit attempt matches this track and version; no verification approval was created.",
        ),
      };
    case "blocked":
      return { ok: false, response: journalBlockResponse(correlationId, authority.refusal.record) };
    case "ambiguous":
      return {
        ok: false,
        response: failure(
          correlationId,
          "external_state_ambiguous",
          "VERIFICATION_ATTEMPT_AMBIGUOUS",
          "More than one unresolved commit attempt matches this release identity; operator recovery is required.",
        ),
      };
  }
}

type ProvenanceCheck =
  { readonly ok: true } | { readonly ok: false; readonly response: DaemonResponseEnvelope };

async function checkCommitProvenance(
  deps: DaemonVerifyCommittedDependencies,
  correlationId: string,
  journalRecord: ReleaseCommitAttemptJournalRecord,
): Promise<ProvenanceCheck> {
  let records: readonly PendingOperationRecord[];
  try {
    records = await deps.pendingStore.list();
  } catch {
    return {
      ok: false,
      response: failure(
        correlationId,
        "local_state_failure",
        "PENDING_LIST_FAILED",
        "The durable pending-operation store could not be read; no verification approval was created.",
      ),
    };
  }
  if (completedCommitProvenanceMatches(records, journalRecord).length === 0) {
    return {
      ok: false,
      response: failure(
        correlationId,
        "local_state_failure",
        "VERIFICATION_PROVENANCE_MISSING",
        "No completed commit record proves this acknowledged commit attempt; operator recovery is required.",
      ),
    };
  }
  return { ok: true };
}

type LocalGuard =
  { readonly ok: true } | { readonly ok: false; readonly response: DaemonResponseEnvelope };

/** The verifier itself refuses to create a temporary edit while one is tracked. */
async function checkManagedSessionAbsent(
  deps: DaemonVerifyCommittedDependencies,
  correlationId: string,
): Promise<LocalGuard> {
  const nowSeconds = epochSecondsFromDate(clockOf(deps));
  try {
    const state = await loadReleaseEditSessionState(deps.managedSessionStore, nowSeconds);
    if (state.status === "none") return { ok: true };
  } catch {
    return {
      ok: false,
      response: failure(
        correlationId,
        "local_state_failure",
        "MANAGED_EDIT_UNREADABLE",
        "The tracked Google Play edit could not be read; nothing was verified.",
      ),
    };
  }
  return {
    ok: false,
    response: failure(
      correlationId,
      "local_state_failure",
      "MANAGED_EDIT_ALREADY_OPEN",
      "A normal managed Play edit session is tracked; exact verification will not create a temporary edit.",
    ),
  };
}

/**
 * A lingering cleanup record means an earlier temporary verification edit was
 * not confirmed removed. This module never expects a second temporary edit to
 * clear that up, so a fresh destructive verification is refused and the existing
 * cleanup evidence stays the recovery authority.
 */
async function checkNoUnresolvedCleanup(
  deps: DaemonVerifyCommittedDependencies,
  correlationId: string,
): Promise<LocalGuard> {
  try {
    const records = await deps.cleanupJournal.list();
    if (records.length === 0) return { ok: true };
  } catch {
    return {
      ok: false,
      response: failure(
        correlationId,
        "local_state_failure",
        "VERIFICATION_CLEANUP_UNREADABLE",
        "The temporary-edit cleanup journal could not be read; nothing was verified.",
      ),
    };
  }
  return {
    ok: false,
    response: failure(
      correlationId,
      "cleanup_pending",
      "VERIFICATION_CLEANUP_UNRESOLVED",
      "An earlier temporary verification edit is still awaiting confirmed cleanup; operator recovery is required.",
    ),
  };
}

async function transitionQuietly(
  store: PendingOperationStore,
  requestId: string,
  from: "PENDING" | "CLAIMED" | "CONSUMED",
  to: "COMPLETED" | "RECOVERY_REQUIRED",
): Promise<boolean> {
  try {
    await store.transition(requestId, from, to);
    return true;
  } catch {
    return false;
  }
}

/**
 * Continue an existing verification locally, under the package lease.
 *
 * The Stage-3E.2B bridge is the only thing that may advance the journal here, and
 * it performs zero Google operations. It is called exactly once per attempt.
 */
async function resumeOnce(
  deps: DaemonVerifyCommittedDependencies,
  journalRecord: ReleaseCommitAttemptJournalRecord,
): Promise<CommitVerificationEvidenceResumeResult | "conflict"> {
  try {
    return await resumeCommitVerificationEvidence({
      journal: deps.openCommitAttemptJournal(),
      attemptId: journalRecord.attemptId,
      packageName: journalRecord.packageName,
      expectedStateDigest: journalRecord.expectedStateDigest,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
  } catch {
    return "conflict";
  }
}

/** Re-read the exact attempt and require the complete Stage-3E proof. */
async function journalProvesRemoteVerified(
  deps: DaemonVerifyCommittedDependencies,
  journalRecord: ReleaseCommitAttemptJournalRecord,
): Promise<boolean> {
  try {
    const matches = (await deps.openCommitAttemptJournal().list()).filter(
      (record) => record.attemptId === journalRecord.attemptId,
    );
    const [match] = matches;
    return (
      matches.length === 1 &&
      match !== undefined &&
      match.packageName === journalRecord.packageName &&
      match.state === "REMOTE_VERIFIED" &&
      match.verificationObservedStateDigest === match.expectedStateDigest &&
      match.verificationObservedStateDigest === journalRecord.expectedStateDigest &&
      match.verificationCleanupVerified === true
    );
  } catch {
    return false;
  }
}

/**
 * The durable goal state already holds and this request must never run a
 * destructive verification.
 *
 * The approval is deliberately NOT consumed and no claim is taken, because no
 * destructive grant was used. The request is retired to `RECOVERY_REQUIRED`
 * (the only honest representation of "never execute this prepared request
 * normally again"); it is never reported as a completed destructive
 * verification.
 */
async function settleAlreadyVerified(
  deps: DaemonVerifyCommittedDependencies,
  correlationId: string,
  requestId: string,
): Promise<DaemonResponseEnvelope> {
  const retired = await transitionQuietly(
    deps.pendingStore,
    requestId,
    "PENDING",
    "RECOVERY_REQUIRED",
  );
  if (!retired) {
    return failure(
      correlationId,
      "local_state_failure",
      "VERIFICATION_REQUEST_RETIRE_FAILED",
      "The durable journal already proves this release verified, but the unused request could not be retired.",
    );
  }
  return envelope(correlationId, "success", {
    summary:
      "The durable commit-attempt journal already proves this committed release verified; no new destructive verification was performed and this request was not consumed.",
  });
}

/**
 * Prepare one signed destructive verification approval.
 *
 * Zero Google operations: the expectation comes from the durable commit-attempt
 * journal, the provenance from the durable pending store, and the approval from
 * the Stage-3E.1 verification binding. No claim and no approval consumption.
 */
export async function prepareVerifyCommitted(
  deps: DaemonVerifyCommittedDependencies,
  packageOperations: PackageOperationCoordinator,
  correlationId: string,
  request: DaemonVerifyCommittedRequest,
): Promise<DaemonResponseEnvelope> {
  const read = await readVerifyAuthority(deps, correlationId, request);
  if (!read.ok) return read.response;
  const authority = read.authority;
  if (!authority.ok) {
    // Unreachable today (readVerifyAuthority already mapped refusals), but the
    // type keeps this exhaustive rather than silently permissive.
    return failure(
      correlationId,
      "local_state_failure",
      "VERIFICATION_AUTHORITY_UNRESOLVED",
      "The durable verification authority could not be resolved.",
    );
  }

  if (authority.mode === "already_verified") {
    if (!(await journalProvesRemoteVerified(deps, authority.record))) {
      return failure(
        correlationId,
        "external_state_ambiguous",
        "VERIFICATION_JOURNAL_NOT_CONFIRMED",
        "The commit attempt claims remote verification but its complete proof could not be re-read.",
      );
    }
    return envelope(correlationId, "success", {
      summary:
        "The durable commit-attempt journal already proves this committed release verified; no verification approval was created.",
    });
  }

  if (authority.mode === "recover") {
    // Local continuation mutates the journal, so it MUST hold package exclusion.
    const acquisition = packageOperations.tryAcquirePackageOperation(deps.packageName);
    if (!acquisition.acquired) {
      return failure(
        correlationId,
        "operation_in_progress",
        PACKAGE_OPERATION_BUSY_CODE,
        "Another mutating execution is in progress for this package; no verification approval was created.",
      );
    }
    const lease = acquisition.lease;
    try {
      const resumed = await resumeOnce(deps, authority.record);
      if (resumed === "verification_evidence_incomplete" || resumed === "conflict") {
        return failure(
          correlationId,
          "external_state_ambiguous",
          "VERIFICATION_EVIDENCE_INCOMPLETE",
          "A partial verification evidence prefix is durable; operator recovery is required and no second Google verification was started.",
        );
      }
      if (!(await journalProvesRemoteVerified(deps, authority.record))) {
        return failure(
          correlationId,
          "external_state_ambiguous",
          "VERIFICATION_JOURNAL_NOT_CONFIRMED",
          "Local verification continuation did not produce the complete durable proof.",
        );
      }
      return envelope(correlationId, "success", {
        summary:
          "Local durable evidence already proved this committed release verified; no Google verification and no new approval were required.",
      });
    } finally {
      packageOperations.releasePackageOperation(lease);
    }
  }

  const provenance = await checkCommitProvenance(deps, correlationId, authority.record);
  if (!provenance.ok) return provenance.response;

  let intent: ReleaseStateVerificationIntent;
  try {
    intent = verificationIntentFromJournal(authority.record);
  } catch (cause) {
    return failure(
      correlationId,
      "local_state_failure",
      (cause as { code?: string }).code ?? "VERIFICATION_INTENT_INVALID",
      "A valid verification intent could not be built from the durable commit evidence.",
    );
  }

  const binding = createReleaseStateVerificationApprovalBinding(intent);
  let record: PendingOperationRecord;
  try {
    record = await deps.pendingStore.prepare({
      operation: "verify_committed",
      toolName: RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME,
      permission: binding.permission,
      packageName: deps.packageName,
      requestDigest: binding.createRequestDigest({}),
      intent: pendingVerifyIntent(authority.record),
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "PendingStoreError") {
      return failure(
        correlationId,
        "config_invalid",
        "PENDING_PREPARE_FAILED",
        "The daemon could not derive a valid verification approval challenge.",
      );
    }
    throw cause;
  }

  return envelope(correlationId, "approval_required", {
    summary: binding.createSafeSummary({}),
    approval: approvalChallengeFor(record),
  });
}

/**
 * Execute one signed destructive verification approval.
 *
 * At most one temporary verification edit can result from one request: there is
 * no retry path in this module, and the package lease plus the exclusive request
 * claim make a concurrent double execution impossible.
 */
export async function executeVerifyCommitted(
  deps: DaemonVerifyCommittedDependencies,
  packageOperations: PackageOperationCoordinator,
  correlationId: string,
  requestId: string,
  signature: string,
): Promise<DaemonResponseEnvelope> {
  // ---------- pre-lease validation: zero mutation, zero claim, zero Google ----------
  const record = await deps.pendingStore.load(requestId);
  if (record === undefined) {
    return envelope(correlationId, "request_not_found", { requestId });
  }
  const state = await deps.pendingStore.state(requestId);
  const shortCircuit = outcomeForNonPendingState(state, correlationId, requestId);
  if (shortCircuit !== undefined) return shortCircuit;

  if (record.operation !== "verify_committed") {
    return failure(
      correlationId,
      "approval_mismatch",
      "OPERATION_MISMATCH",
      "The signed request is not a commit-verification approval request.",
    );
  }
  if (record.permission !== "destructive") {
    return failure(
      correlationId,
      "approval_mismatch",
      "PERMISSION_MISMATCH",
      "The signed request does not carry the destructive verification permission.",
    );
  }
  if (record.packageName !== deps.packageName) {
    return failure(
      correlationId,
      "approval_mismatch",
      "PACKAGE_DRIFT",
      "The configured package no longer matches the signed request.",
    );
  }
  if (record.intent.kind !== "verify_committed") {
    return failure(
      correlationId,
      "approval_mismatch",
      "INTENT_MISMATCH",
      "The signed request does not carry a commit-verification intent.",
    );
  }
  const approved = record.intent;
  const payload = approvalPayloadFor(record);
  if (!deps.operatorVerifier.verify(payload, signature)) {
    return failure(
      correlationId,
      "approval_mismatch",
      "SIGNATURE_INVALID",
      "The operator signature did not verify for this request.",
    );
  }

  // ---------- one destructive lifecycle per package, for this whole request ----------
  const acquisition = packageOperations.tryAcquirePackageOperation(deps.packageName);
  if (!acquisition.acquired) {
    // Zero claim, zero approval consumption, zero Google, zero journal mutation.
    return failure(
      correlationId,
      "operation_in_progress",
      PACKAGE_OPERATION_BUSY_CODE,
      "Another mutating execution is in progress for this package; nothing was verified.",
    );
  }
  const lease = acquisition.lease;

  try {
    // ---------- authoritative recheck under the package lease ----------
    const read = await readVerifyAuthority(deps, correlationId, {
      track: approved.targetTrack,
      versionCode: approved.versionCode,
    });
    if (!read.ok) return read.response;
    const authority = read.authority;
    if (!authority.ok) {
      return failure(
        correlationId,
        "local_state_failure",
        "VERIFICATION_AUTHORITY_UNRESOLVED",
        "The durable verification authority could not be resolved.",
      );
    }

    if (authority.mode === "already_verified") {
      if (!(await journalProvesRemoteVerified(deps, authority.record))) {
        return failure(
          correlationId,
          "external_state_ambiguous",
          "VERIFICATION_JOURNAL_NOT_CONFIRMED",
          "The commit attempt claims remote verification but its complete proof could not be re-read.",
        );
      }
      // The approval is older than the durable proof. Nothing destructive runs,
      // and the unused request is retired rather than consumed.
      return await settleAlreadyVerified(deps, correlationId, requestId);
    }

    if (authority.mode === "recover") {
      const resumed = await resumeOnce(deps, authority.record);
      if (resumed === "verification_evidence_incomplete" || resumed === "conflict") {
        await transitionQuietly(deps.pendingStore, requestId, "PENDING", "RECOVERY_REQUIRED");
        return failure(
          correlationId,
          "external_state_ambiguous",
          "VERIFICATION_EVIDENCE_INCOMPLETE",
          "A partial verification evidence prefix is durable; operator recovery is required and no second Google verification was started.",
        );
      }
      if (!(await journalProvesRemoteVerified(deps, authority.record))) {
        await transitionQuietly(deps.pendingStore, requestId, "PENDING", "RECOVERY_REQUIRED");
        return failure(
          correlationId,
          "external_state_ambiguous",
          "VERIFICATION_JOURNAL_NOT_CONFIRMED",
          "Local verification continuation did not produce the complete durable proof.",
        );
      }
      return await settleAlreadyVerified(deps, correlationId, requestId);
    }

    const journalRecord = authority.record;

    // ---------- durable provenance, re-proved while holding the lease ----------
    const provenance = await checkCommitProvenance(deps, correlationId, journalRecord);
    if (!provenance.ok) return provenance.response;

    // ---------- the approval must still describe the exact durable attempt ----------
    let freshDigest: string;
    try {
      freshDigest = createReleaseStateVerificationApprovalBinding(
        verificationIntentFromJournal(journalRecord),
      ).createRequestDigest({});
    } catch (cause) {
      return failure(
        correlationId,
        "local_state_failure",
        (cause as { code?: string }).code ?? "VERIFICATION_INTENT_INVALID",
        "The verification intent could not be rebuilt from durable evidence.",
      );
    }
    const drifted = verifyIntentDrift(approved, journalRecord, record.requestDigest, freshDigest);
    if (drifted !== undefined) {
      return failure(
        correlationId,
        "local_state_failure",
        `VERIFICATION_INTENT_DRIFT_${drifted}`,
        "Trusted verification state changed after approval; a new prepare and signature are required.",
      );
    }

    // ---------- local safety guards, still before any claim ----------
    const session = await checkManagedSessionAbsent(deps, correlationId);
    if (!session.ok) return session.response;
    const cleanup = await checkNoUnresolvedCleanup(deps, correlationId);
    if (!cleanup.ok) return cleanup.response;

    // ---------- exclusive claim ----------
    let claim: RequestClaim;
    try {
      claim = await acquireRequestClaim(
        deps.claimRoot,
        requestId,
        deps.now === undefined ? {} : { now: deps.now },
      );
    } catch (cause) {
      if (cause instanceof RequestClaimError && cause.code === "CLAIM_ALREADY_HELD") {
        return envelope(correlationId, "request_claim_held");
      }
      throw cause;
    }

    // ---------- durable PENDING -> CLAIMED before anything may be consumed ----------
    try {
      await deps.pendingStore.transition(requestId, "PENDING", "CLAIMED");
    } catch {
      await normalizeToRecovery(deps.pendingStore, requestId);
      return failure(
        correlationId,
        "external_state_ambiguous",
        "CLAIM_RECORD_UNSYNCHRONIZED",
        "An exclusive claim was acquired but the durable state could not be advanced safely.",
      );
    }

    // ---------- the production verifier, with the strict journal bridge ----------
    const built = createReleaseExactVerificationTool({
      packageName: deps.packageName,
      intent: verificationIntentFromJournal(journalRecord),
      summaryGateway: deps.summaryGateway,
      temporaryEditGateway: deps.temporaryEditGateway,
      sessionStore: deps.managedSessionStore,
      cleanupJournal: deps.cleanupJournal,
      auditLedger: deps.verifyAuditLedger,
      evidenceSink: createCommitVerificationEvidenceJournalSink({
        journal: deps.openCommitAttemptJournal(),
        attemptId: journalRecord.attemptId,
        packageName: journalRecord.packageName,
        expectedStateDigest: journalRecord.expectedStateDigest,
        ...(deps.now === undefined ? {} : { now: deps.now }),
      }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });

    let consumptionFailed = false;
    const resolver = createOperatorSignatureApprovalResolver({
      verifier: deps.operatorVerifier,
      pending: record,
      payload,
      signature,
      ledger: deps.approvalLedger,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      onApprovalConsumed: async (): Promise<void> => {
        try {
          await deps.pendingStore.transition(requestId, "CLAIMED", "CONSUMED");
        } catch (cause) {
          consumptionFailed = true;
          throw cause;
        }
      },
    });

    const registry = new ToolRegistry();
    registry.register(built.tool);

    // The package lease is still held and stays held until request completion.
    const execution = await executeOneTool({
      registry,
      binding: built.binding,
      input: {},
      ledger: deps.ledger,
      approvalResolver: resolver,
      approvalLedger: deps.approvalLedger,
      verificationLedger: deps.verificationLedger,
    });

    // ---------- terminal mapping ----------
    if (execution.result.ok) {
      // The tool return is never trusted alone: the journal must prove it.
      if (!(await journalProvesRemoteVerified(deps, journalRecord))) {
        const resumed = await resumeOnce(deps, journalRecord);
        if (resumed !== "verified" && resumed !== "already_verified") {
          await normalizeToRecovery(deps.pendingStore, requestId);
          return failure(
            correlationId,
            "external_state_ambiguous",
            "VERIFICATION_JOURNAL_NOT_CONFIRMED",
            "Verification reported success but the durable journal does not prove it; operator recovery is required.",
          );
        }
      }
      const settled = await transitionQuietly(
        deps.pendingStore,
        requestId,
        "CONSUMED",
        "COMPLETED",
      );
      if (!settled) {
        await normalizeToRecovery(deps.pendingStore, requestId);
        return failure(
          correlationId,
          "external_state_ambiguous",
          "TERMINAL_TRANSITION_FAILED",
          "The verified release could not be recorded as safely terminal.",
        );
      }
      await releaseRequestClaim(claim).catch(() => undefined);
      // REMOTE_VERIFIED is terminal for Stage 3E.3. Stage 3F owns reconciliation,
      // so the journal is deliberately left un-reconciled here.
      return envelope(correlationId, "success", {
        summary: "Committed release state verified and recorded as REMOTE_VERIFIED.",
      });
    }

    // Any non-success outcome is terminal-non-reusable. Retaining the claim can
    // never cause a second remote mutation; releasing it could.
    const code = toolFailureCode(execution.result);
    if (consumptionFailed) {
      await normalizeToRecovery(deps.pendingStore, requestId);
      return failure(
        correlationId,
        "local_state_failure",
        "APPROVAL_CONSUMPTION_PERSIST_FAILED",
        "Required local approval-consumption state could not be persisted; no verification transport began.",
      );
    }
    if (code === "VERIFICATION_EVIDENCE_PERSISTENCE_FAILED") {
      // The destructive verification already ran and its approval was consumed;
      // only the LOCAL evidence write failed. Continue already-durable proof,
      // exactly once, and never re-run the verifier.
      if (!(await journalProvesRemoteVerified(deps, journalRecord))) {
        await resumeOnce(deps, journalRecord);
      }
      if (await journalProvesRemoteVerified(deps, journalRecord)) {
        const settled = await transitionQuietly(
          deps.pendingStore,
          requestId,
          "CONSUMED",
          "COMPLETED",
        );
        if (settled) {
          await releaseRequestClaim(claim).catch(() => undefined);
          return envelope(correlationId, "success", {
            summary:
              "Local durable evidence completed the verification after a local persistence failure; no second Google verification was performed.",
          });
        }
      }
      await normalizeToRecovery(deps.pendingStore, requestId);
      if (execution.result.externalStateUncertain) {
        return failure(
          correlationId,
          "external_state_ambiguous",
          code,
          "Local verification evidence could not be persisted and temporary edit cleanup is unconfirmed; operator recovery is required.",
        );
      }
      return failure(
        correlationId,
        "local_state_failure",
        code,
        "Local verification evidence could not be persisted; the durable prefix is retained and operator recovery is required.",
      );
    }
    await normalizeToRecovery(deps.pendingStore, requestId);
    if (execution.result.externalStateUncertain) {
      return failure(
        correlationId,
        "external_state_ambiguous",
        code,
        "The verification outcome is ambiguous; operator recovery is required.",
      );
    }
    if (code === "APPROVAL_DENIED" || code === "APPROVAL_REQUIRED") {
      return failure(
        correlationId,
        "approval_mismatch",
        code,
        "The runtime approval could not be resolved for this request.",
      );
    }
    // Definite failure with confirmed cleanup: the request is burned (its
    // approval was consumed) but nothing remote is ambiguous. An observed
    // committed-state mismatch is reported exactly as that, never as ambiguity.
    return failure(
      correlationId,
      "remote_failure",
      code,
      "Committed-release verification did not succeed; the request must not be reused and a new prepare is required.",
    );
  } finally {
    // Released LAST: after the journal/provenance/session/cleanup rechecks, the
    // claim, the approval lifecycle, the temporary edit, the deep read, the
    // evidence bridge, the transition and the daemon pending settlement.
    packageOperations.releasePackageOperation(lease);
  }
}

/** Fail-closed normalization after a durable inconsistency while holding the claim. */
async function normalizeToRecovery(store: PendingOperationStore, requestId: string): Promise<void> {
  const current = (await store.load(requestId))?.state;
  if (current !== "PENDING" && current !== "CLAIMED" && current !== "CONSUMED") return;
  await store.transition(requestId, current, "RECOVERY_REQUIRED").catch(() => undefined);
}

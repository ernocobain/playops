/**
 * Stage 3D — `prepare_commit` and `execute_commit` daemon operations.
 *
 * This module ORCHESTRATES the existing production commit path. It contains no
 * commit algorithm of its own: the authoritative mutation remains
 * `releases.commit_edit` (Phase 4.10) executed through
 * `executeOneTool -> runAgent -> registry/permission -> approval -> tool.execute
 * -> mandatory verifier -> audit`.
 *
 * Ordering, end to end (`prepare_commit`):
 *
 *   managed edit session (required, never created here)
 *     -> package commit-attempt journal recheck      (unresolved => refuse, no challenge)
 *     -> release write-intent gate recheck           (held => refuse, no challenge)
 *     -> trusted intent derivation: fresh getEdit, getTrack, validateEdit
 *        -> the SAME `createReleaseCommitIntent`, then the SAME production
 *           `createReleaseCommitTool` (whose binding owns
 *           `createRequestDigest` / `createSafeSummary` for that intent)
 *     -> durable private pending record (schema v2 `commit` intent)
 *     -> safe challenge for the operator to sign      (zero Google mutation)
 *
 * Ordering, end to end (`execute_commit`):
 *
 *   pre-claim: load -> schema -> must be PENDING -> commit operation -> package
 *              -> canonical payload -> signature verify            (zero mutation)
 *   acquire the SHARED package-scoped commit single-flight
 *   journal recheck WHILE HOLDING the package lease
 *   release write-intent recheck WHILE HOLDING the package lease
 *   re-derive trusted commit state and compare it field-for-field with the
 *     private prepared intent (drift => zero commit, no claim, no consumption)
 *   exclusive per-request O_EXCL claim
 *   durable PENDING -> CLAIMED
 *   approval: exact three-way match -> signature -> CLAIMED -> CONSUMED
 *             -> ONLY THEN the approved grant exists -> tool may run
 *   executeOneTool -> runAgent -> releases.commit_edit (authoritative)
 *     -> journal PREPARED -> journal TRANSPORT_ATTEMPTED -> exactly one
 *        `edits.commit` -> durable ACK/AMBIGUOUS -> managed-session settlement
 *   terminal: CONSUMED -> COMPLETED, or (CLAIMED|CONSUMED) -> RECOVERY_REQUIRED
 *   release the package lease only at request completion
 *
 * Two invariants are deliberate and load-bearing:
 *
 *   1. The package single-flight coordinator is CONSTRUCTED ONCE at daemon
 *      composition scope and injected here. This module never creates one, so
 *      every commit request handled by one daemon shares the same exclusion map;
 *      a per-request coordinator would serialize nothing.
 *   2. ACKNOWLEDGED is not remote verification. The journal's own semantics stay
 *      authoritative: a successful Python-free commit leaves the journal
 *      unresolved until the separate Stage-3E verification transition, so later
 *      commits for the same package remain blocked by the journal recheck.
 */
import type { AgentLedger } from "../runtime/agent/index.js";
import { executeOneTool } from "../runtime/agent/execute-one-tool.js";
import type { ApprovalLedger } from "../runtime/approvals/index.js";
import { type OperatorApprovalVerifier } from "../runtime/approvals/operator-signature.js";
import { ToolRegistry } from "../runtime/tools/index.js";
import type { VerificationLedger } from "../runtime/verification/index.js";
import {
  createReleaseCommitIntent,
  type ReleaseCommitApprovalBinding,
  type ReleaseCommitIntent,
} from "../releases/commit-approval.js";
import type {
  ReleaseCommitAttemptJournal,
  ReleaseCommitAttemptJournalRecord,
} from "../releases/commit-attempt-journal.js";
import {
  createReleaseCommitTool,
  type ReleaseCommitAuditLedger,
} from "../releases/commit-edit-tool.js";
import type { ReleaseCommitGateway } from "../releases/gateway.js";
import {
  epochSecondsFromDate,
  normalizeReleaseTracks,
  toGooglePlayEditSession,
  type ReleaseEditSession,
} from "../releases/index.js";
import type {
  ReleaseWriteIntentGate,
  ReleaseWriteIntentStore,
} from "../releases/release-write-intent-store.js";
import {
  loadReleaseEditSessionState,
  type ReleaseEditSessionStore,
} from "../releases/session-store.js";
import {
  ensureRemoteEditMatches,
  normalizeValidationResponse,
} from "../releases/validate-edit-tool.js";
import { createOperatorSignatureApprovalResolver } from "./approval-resolver.js";
import {
  PACKAGE_OPERATION_BUSY_CODE,
  type PackageOperationCoordinator,
} from "./package-operation-singleflight.js";
import { approvalChallengeFor, approvalPayloadFor, envelope } from "./pending-view.js";
import { outcomeForNonPendingState } from "./pending-view.js";
import type {
  PendingCommitIntent,
  PendingOperationRecord,
  PendingOperationStore,
} from "./pending-store.js";
import type { DaemonResponseEnvelope, DaemonResponseOutcome } from "./protocol.js";
import {
  acquireRequestClaim,
  releaseRequestClaim,
  RequestClaimError,
  type RequestClaim,
} from "./request-claim.js";

export interface DaemonCommitRequest {
  readonly track: string;
  readonly versionCode: string;
}

export interface DaemonCommitDependencies {
  /** Trusted package identity. The client can never supply or override it. */
  readonly packageName: string;
  readonly pendingStore: PendingOperationStore;
  /** Directory holding exclusive request-claim files. */
  readonly claimRoot: string;
  readonly managedSessionStore: ReleaseEditSessionStore;
  readonly releaseGateway: ReleaseCommitGateway;
  readonly writeIntentStore: ReleaseWriteIntentStore;
  /** The commit tool's own audit ledger (`release.commit.*` entries). */
  readonly commitAuditLedger: ReleaseCommitAuditLedger;
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

/** The gate verdict mapping is the write-intent store's own, never a second one. */
function writeGateResponse(
  correlationId: string,
  gate: Extract<ReleaseWriteIntentGate, { status: "held" }>,
): DaemonResponseEnvelope {
  return failure(
    correlationId,
    gate.outcome,
    `WRITE_INTENT_${gate.state}`,
    "A durable release write gate is held for this managed edit; operator recovery is required.",
  );
}

/**
 * Read-only mirror of the commit-attempt journal's own unresolved rule.
 *
 * The journal exposes no read-only "is preparation blocked?" query, and this
 * stage must not modify its semantics, so the daemon cannot ask it directly
 * without either duplicating its durable state or pre-creating a record (which
 * would violate the required ordering). The mirror is therefore expressed as a
 * predicate over the records the journal itself parsed, mirroring its private
 * rule exactly:
 *
 *   unresolved = state is not a reconciled terminal state, OR an insert was
 *                attempted without verified cleanup.
 *
 * `commit-journal-blocks-preparation.test.ts` pins this mirror against the REAL
 * journal's own behavior for every constructible state, so the two cannot drift
 * apart silently.
 */
export function journalBlockingRecord(
  records: readonly ReleaseCommitAttemptJournalRecord[],
): ReleaseCommitAttemptJournalRecord | undefined {
  // The journal's own file invariant permits at most one unresolved record, and
  // only as the last record, so the last record is the only candidate.
  const last = records.at(-1);
  if (last === undefined) return undefined;
  const reconciled =
    last.state === "RECONCILED_COMMITTED" || last.state === "RECONCILED_NOT_COMMITTED";
  const cleanupPending =
    last.verificationInsertAttempted === true && last.verificationCleanupVerified !== true;
  return !reconciled || cleanupPending ? last : undefined;
}

/**
 * Narrowest truthful outcome for a blocking journal record.
 *
 * A `PREPARED` record is a durable commit attempt that has NOT reached the
 * transport, so blaming remote ambiguity would be a false claim: the package
 * gate is simply owned. A transport-phase state (or a verified-but-unreconciled
 * record) may correspond to a real remote effect and is reported ambiguous. An
 * externally settled record awaiting local cleanup is reported as exactly that.
 */
export function journalBlockResponse(
  correlationId: string,
  record: ReleaseCommitAttemptJournalRecord,
): DaemonResponseEnvelope {
  switch (record.state) {
    case "PREPARED":
      return failure(
        correlationId,
        "operation_in_progress",
        "COMMIT_JOURNAL_PREPARED_UNRESOLVED",
        "A durable commit attempt owns this package's commit path; operator recovery is required before a new commit.",
      );
    case "RECONCILED_COMMITTED":
    case "RECONCILED_NOT_COMMITTED":
      return failure(
        correlationId,
        "cleanup_pending",
        "COMMIT_JOURNAL_CLEANUP_PENDING",
        "The previous commit attempt is externally settled; only local cleanup remains.",
      );
    case "TRANSPORT_ATTEMPTED":
    case "ACKNOWLEDGED":
    case "AMBIGUOUS":
    case "REMOTE_VERIFIED":
      return failure(
        correlationId,
        "external_state_ambiguous",
        "COMMIT_JOURNAL_UNRESOLVED",
        "An unresolved commit attempt exists for this package; the outcome must be verified before another commit.",
      );
  }
}

type JournalCheck =
  { readonly ok: true } | { readonly ok: false; readonly response: DaemonResponseEnvelope };

/**
 * The mandatory journal recheck. Read and interpretation only: the journal's
 * durable bytes are never altered, overwritten or reconciled from here.
 */
async function recheckCommitJournal(
  deps: DaemonCommitDependencies,
  correlationId: string,
): Promise<JournalCheck> {
  try {
    const records = await deps.openCommitAttemptJournal().list();
    const blocking = journalBlockingRecord(records);
    if (blocking === undefined) return { ok: true };
    return { ok: false, response: journalBlockResponse(correlationId, blocking) };
  } catch {
    // The journal exists but cannot be read: an unresolved remote effect cannot
    // be ruled out, so this is never treated as "empty".
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
}

type DerivedIntent =
  | { readonly ok: true; readonly intent: ReleaseCommitIntent }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Trusted server-side commit intent derivation.
 *
 * Uses only the production helpers: one fresh `getEdit` identity read, one exact
 * `getTrack` read, one `validateEdit` call, and then the SAME
 * `createReleaseCommitIntent` the production commit boundary uses. No second
 * digest, equality or intent model exists here.
 */
async function deriveCommitIntent(
  deps: DaemonCommitDependencies,
  session: ReleaseEditSession,
  request: DaemonCommitRequest,
): Promise<DerivedIntent> {
  const nowSeconds = epochSecondsFromDate(deps.now ?? ((): Date => new Date()));
  const googleSession = toGooglePlayEditSession(session);
  try {
    const remoteEdit = await deps.releaseGateway.getEdit(googleSession);
    ensureRemoteEditMatches(remoteEdit, session.editId, session.expiryTimeSeconds, nowSeconds);

    const rawTrack: unknown = await deps.releaseGateway.getTrack(googleSession, request.track);
    const [track] = normalizeReleaseTracks([rawTrack]);
    if (track === undefined || track.track !== request.track) {
      return {
        ok: false,
        code: "TARGET_TRACK_MISMATCH",
        message: "Google Play returned a different track than the requested target.",
      };
    }

    const validation = normalizeValidationResponse(
      await deps.releaseGateway.validateEdit(googleSession),
      session.editId,
      nowSeconds,
    );

    return {
      ok: true,
      intent: createReleaseCommitIntent({
        packageName: deps.packageName,
        editId: session.editId,
        targetTrack: request.track,
        versionCode: request.versionCode,
        targetTrackState: track,
        validatedEdit: validation,
      }),
    };
  } catch (cause) {
    return {
      ok: false,
      code: (cause as { code?: string }).code ?? "COMMIT_DERIVATION_FAILED",
      message: "Trusted commit state could not be derived; no commit was attempted.",
    };
  }
}

/** Build the authoritative production commit tool for one trusted intent. */
function buildCommitTool(deps: DaemonCommitDependencies, intent: ReleaseCommitIntent) {
  return createReleaseCommitTool({
    packageName: deps.packageName,
    intent,
    gateway: deps.releaseGateway,
    sessionStore: deps.managedSessionStore,
    auditLedger: deps.commitAuditLedger,
    commitAttemptJournal: deps.openCommitAttemptJournal(),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
}

function pendingCommitIntent(intent: ReleaseCommitIntent): PendingCommitIntent {
  return Object.freeze({
    kind: "commit",
    targetTrack: intent.targetTrack,
    versionCode: intent.versionCode,
    editId: intent.editId,
    stateDigest: intent.stateDigest,
    validationExpiryTimeSeconds: intent.validationExpiryTimeSeconds,
    releaseName: intent.releaseName,
    releaseStatus: intent.releaseStatus,
  });
}

/**
 * Field-for-field comparison of the private prepared intent against freshly
 * derived trusted state. `requestDigest` equality is the strongest single check
 * because the production digest covers track, version, release identity, notes
 * languages, policy and validation expiry; the explicit fields are compared too
 * so a failure can name the exact drifted binding.
 */
function intentDrift(
  approved: PendingCommitIntent,
  fresh: ReleaseCommitIntent,
  approvedRequestDigest: string,
): string | undefined {
  if (fresh.editId !== approved.editId) return "EDIT_ID";
  if (fresh.targetTrack !== approved.targetTrack) return "TARGET_TRACK";
  if (fresh.versionCode !== approved.versionCode) return "VERSION_CODE";
  if (fresh.releaseName !== approved.releaseName) return "RELEASE_NAME";
  if (fresh.releaseStatus !== approved.releaseStatus) return "RELEASE_STATUS";
  if (fresh.stateDigest !== approved.stateDigest) return "STATE_DIGEST";
  if (fresh.validationExpiryTimeSeconds !== approved.validationExpiryTimeSeconds) {
    return "VALIDATION_EXPIRY";
  }
  if (fresh.requestDigest !== approvedRequestDigest) return "REQUEST_DIGEST";
  return undefined;
}

async function loadActiveSession(
  deps: DaemonCommitDependencies,
): Promise<
  | { readonly ok: true; readonly session: ReleaseEditSession }
  | { readonly ok: false; readonly code: string; readonly message: string }
> {
  const nowSeconds = epochSecondsFromDate(deps.now ?? ((): Date => new Date()));
  try {
    const state = await loadReleaseEditSessionState(deps.managedSessionStore, nowSeconds);
    if (state.status === "none") {
      return {
        ok: false,
        code: "NO_MANAGED_EDIT",
        message: "No managed Google Play edit is tracked; nothing was committed.",
      };
    }
    if (state.status === "expired") {
      return {
        ok: false,
        code: "MANAGED_EDIT_EXPIRED",
        message: "The tracked Google Play edit expired; nothing was committed.",
      };
    }
    return { ok: true, session: state.session };
  } catch {
    return {
      ok: false,
      code: "MANAGED_EDIT_UNREADABLE",
      message: "The tracked Google Play edit could not be read; nothing was committed.",
    };
  }
}

/**
 * Prepare one signed commit approval. Read-only remote side effects only
 * (getEdit, getTrack, validateEdit); the caller never gets a commit transport.
 */
export async function prepareCommit(
  deps: DaemonCommitDependencies,
  correlationId: string,
  request: DaemonCommitRequest,
): Promise<DaemonResponseEnvelope> {
  const session = await loadActiveSession(deps);
  if (!session.ok) {
    return failure(correlationId, "local_state_failure", session.code, session.message);
  }

  // Local durable gates first: a blocked package must not even be offered a
  // challenge the operator would waste a signature on.
  const journal = await recheckCommitJournal(deps, correlationId);
  if (!journal.ok) return journal.response;

  const scope = { packageName: deps.packageName, editId: session.session.editId };
  let gate: ReleaseWriteIntentGate;
  try {
    gate = await deps.writeIntentStore.inspect(scope);
  } catch {
    return failure(
      correlationId,
      "local_state_failure",
      "WRITE_INTENT_UNREADABLE",
      "The durable release write gate could not be read; no approval challenge was created.",
    );
  }
  if (gate.status === "held") return writeGateResponse(correlationId, gate);

  const derived = await deriveCommitIntent(deps, session.session, request);
  if (!derived.ok) {
    return failure(correlationId, "local_state_failure", derived.code, derived.message);
  }

  let approval: ReleaseCommitApprovalBinding;
  let toolName: string;
  let summary: string;
  try {
    const built = buildCommitTool(deps, derived.intent);
    approval = built.binding.approval as ReleaseCommitApprovalBinding;
    toolName = built.binding.toolName;
    summary = approval.createSafeSummary({});
  } catch (cause) {
    return failure(
      correlationId,
      "local_state_failure",
      (cause as { code?: string }).code ?? "COMMIT_INTENT_INVALID",
      "A valid commit approval intent could not be built; no challenge was created.",
    );
  }

  let record: PendingOperationRecord;
  try {
    record = await deps.pendingStore.prepare({
      operation: "commit",
      toolName,
      permission: approval.permission,
      packageName: deps.packageName,
      requestDigest: approval.createRequestDigest({}),
      intent: pendingCommitIntent(derived.intent),
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "PendingStoreError") {
      return failure(
        correlationId,
        "config_invalid",
        "PENDING_PREPARE_FAILED",
        "The daemon could not derive a valid approval challenge.",
      );
    }
    throw cause;
  }

  return envelope(correlationId, "approval_required", {
    summary,
    approval: approvalChallengeFor(record),
  });
}

/**
 * Execute one signed commit approval. At most one `edits.commit` can result from
 * one request, and no path in this module retries a transport.
 *
 * `packageOperations` MUST be the daemon's ONE shared package-scoped
 * coordinator instance (Stage 3E.2D): it is passed in rather than carried in
 * `deps` so open_edit, attach_notes and commit structurally cannot end up with
 * different coordinators, and so no copy of the daemon graph can hold two.
 */
export async function executeCommit(
  deps: DaemonCommitDependencies,
  packageOperations: PackageOperationCoordinator,
  correlationId: string,
  requestId: string,
  signature: string,
): Promise<DaemonResponseEnvelope> {
  // ---------- pre-claim validation: zero mutation, zero Google calls ----------
  const record = await deps.pendingStore.load(requestId);
  if (record === undefined) {
    return envelope(correlationId, "request_not_found", { requestId });
  }
  const state = await deps.pendingStore.state(requestId);
  const shortCircuit = outcomeForNonPendingState(state, correlationId, requestId);
  if (shortCircuit !== undefined) return shortCircuit;

  if (record.operation !== "commit") {
    return failure(
      correlationId,
      "approval_mismatch",
      "OPERATION_MISMATCH",
      "The signed request is not a commit approval request.",
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
  if (record.intent.kind !== "commit") {
    return failure(
      correlationId,
      "approval_mismatch",
      "INTENT_MISMATCH",
      "The signed request does not carry a commit intent.",
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

  // ---------- one mutating execution per package, for this whole request ----------
  const acquisition = packageOperations.tryAcquirePackageOperation(deps.packageName);
  if (!acquisition.acquired) {
    // Zero claim, zero approval consumption, zero edit transport. The holder may
    // be an open_edit or attach_notes execution, so the code names the package
    // operation boundary rather than commit specifically.
    return failure(
      correlationId,
      "operation_in_progress",
      PACKAGE_OPERATION_BUSY_CODE,
      "Another mutating execution is in progress for this package; nothing was committed.",
    );
  }
  const lease = acquisition.lease;

  try {
    // ---------- mandatory durable rechecks, all under the package lease ----------
    const journal = await recheckCommitJournal(deps, correlationId);
    if (!journal.ok) return journal.response;

    const scope = { packageName: deps.packageName, editId: approved.editId };
    let gate: ReleaseWriteIntentGate;
    try {
      gate = await deps.writeIntentStore.inspect(scope);
    } catch {
      return failure(
        correlationId,
        "local_state_failure",
        "WRITE_INTENT_UNREADABLE",
        "The durable release write gate could not be read; nothing was committed.",
      );
    }
    if (gate.status === "held") return writeGateResponse(correlationId, gate);

    const session = await loadActiveSession(deps);
    if (!session.ok) {
      return failure(correlationId, "local_state_failure", session.code, session.message);
    }
    const fresh = await deriveCommitIntent(deps, session.session, {
      track: approved.targetTrack,
      versionCode: approved.versionCode,
    });
    if (!fresh.ok) {
      return failure(correlationId, "local_state_failure", fresh.code, fresh.message);
    }
    const drifted = intentDrift(approved, fresh.intent, record.requestDigest);
    if (drifted !== undefined) {
      // The approval is bound to the exact approved state. It must never
      // authorize a drifted edit, and nothing has been consumed yet.
      return failure(
        correlationId,
        "local_state_failure",
        `COMMIT_INTENT_DRIFT_${drifted}`,
        "Trusted commit state changed after approval; a new prepare and signature are required.",
      );
    }

    const built = buildCommitTool(deps, fresh.intent);

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
        // A competing or still-in-flight execution: make ZERO state mutation.
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

    // ---------- approval consumption seam ----------
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

    // The package lease is still held here and stays held until request
    // completion, so no other mutating execution can interleave.
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
      try {
        await deps.pendingStore.transition(requestId, "CONSUMED", "COMPLETED");
      } catch {
        await normalizeToRecovery(deps.pendingStore, requestId);
        return failure(
          correlationId,
          "external_state_ambiguous",
          "TERMINAL_TRANSITION_FAILED",
          "The verified commit could not be recorded as safely terminal.",
        );
      }
      await releaseRequestClaim(claim).catch(() => undefined);
      // ACKNOWLEDGED is deliberately NOT remote verification: the journal stays
      // unresolved until the separate Stage-3E transition, so the next commit
      // for this package is still refused by the journal recheck.
      return envelope(correlationId, "success", {
        summary: "Google Play edit committed and acknowledged.",
      });
    }

    // Any non-success outcome is terminal-non-reusable. Retaining the claim can
    // never cause a second remote mutation; releasing it could.
    await normalizeToRecovery(deps.pendingStore, requestId);
    const code = execution.result.code;
    if (consumptionFailed) {
      return failure(
        correlationId,
        "local_state_failure",
        "APPROVAL_CONSUMPTION_PERSIST_FAILED",
        "Required local approval-consumption state could not be persisted; no commit transport began.",
      );
    }
    if (execution.result.externalStateUncertain) {
      return failure(
        correlationId,
        "external_state_ambiguous",
        code,
        "The commit outcome is ambiguous; operator recovery is required.",
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
    // Definite failure with no transport: the request is still burned (its
    // approval was consumed), but nothing remote is ambiguous.
    return failure(
      correlationId,
      "local_state_failure",
      code,
      "The commit did not start; the request must not be reused and a new prepare is required.",
    );
  } finally {
    // Released only now: after the journal check, the write-gate check, the
    // trusted state recheck, the claim, the approval lifecycle, the durable
    // journal markers, the transport and the daemon pending settlement.
    packageOperations.releasePackageOperation(lease);
  }
}

/** Fail-closed normalization after a durable inconsistency while holding the claim. */
async function normalizeToRecovery(store: PendingOperationStore, requestId: string): Promise<void> {
  const current = (await store.load(requestId))?.state;
  if (current !== "PENDING" && current !== "CLAIMED" && current !== "CONSUMED") return;
  await store.transition(requestId, current, "RECOVERY_REQUIRED").catch(() => undefined);
}

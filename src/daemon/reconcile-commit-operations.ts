/** Stage 3F.2 — daemon reconciliation orchestration.
 *
 * TWO deliberately separate paths, and no third:
 *
 *  A. LOCAL deterministic continuation (zero Google, zero approval, zero pending):
 *       ACKNOWLEDGED + any durable verification prefix
 *         -> resumeCommitVerificationEvidence -> REMOTE_VERIFIED
 *       REMOTE_VERIFIED + complete Stage-3E proof
 *         -> finalizeVerifiedCommit -> RECONCILED_COMMITTED
 *
 *  B. SIGNED destructive recovery (fresh detached Ed25519 approval), for an
 *     eligible unresolved state, through the UNCHANGED production tool:
 *       pending -> CLAIMED -> CONSUMED -> executeOneTool/runAgent
 *         -> releases.reconcile_commit (mode "verify_expired") -> verifier/audit
 *
 * Policy (deliberate, v0.3.0): `mode = "probe"` is NEVER exposed by the daemon.
 * Probe mode stays untouched inside the production tool for its own contract.
 *
 * This module owns orchestration only: no Google algorithm, digest, permission,
 * approval, journal rule or session rule is re-implemented here. Every one of
 * them is imported from the module that already owns it.
 *
 * Authority rule: the package's REAL commit-attempt journal decides the
 * candidate through `isCommitAttemptUnresolved` and the journal's own
 * structural invariant. There is no first/last/newest/timestamp selection, and
 * an already-reconciled historical attempt is never re-opened.
 */
import type { NewAuditEntry } from "../audit/index.js";
import {
  parseReleaseCommitAttemptJournalRecord,
  type ReleaseCommitAttemptJournal,
  type ReleaseCommitAttemptJournalRecord,
} from "../releases/commit-attempt-journal.js";
import {
  classifyAcknowledgedVerificationPrefix,
  hasCompleteVerifiedProof,
  hasVerificationPrefix,
  isCommitAttemptTerminal,
  isCommitAttemptUnresolved,
  isSuccessProofResumableAckPrefix,
} from "../releases/commit-attempt-status.js";
import { resumeCommitVerificationEvidence } from "../releases/commit-verification-evidence.js";
import { finalizeVerifiedCommit } from "../releases/finalize-verified-commit.js";
import type { ReleaseEditCleanupJournal } from "../releases/cleanup-journal.js";
import {
  createReleaseCommitReconciliationTool,
  RELEASES_RECONCILE_COMMIT_TOOL_NAME,
  type ReleaseCommitReconciliationMode,
  type ReleaseCommitReconciliationResult,
  type ReleaseCommitReconciliationToolOptions,
} from "../releases/reconcile-commit-tool.js";
import type { ReleaseEditSessionStore } from "../releases/session-store.js";
import { executeOneTool } from "../runtime/agent/execute-one-tool.js";
import type { AgentLedger, AgentRunResult } from "../runtime/agent/index.js";
import type { ApprovalLedger } from "../runtime/approvals/index.js";
import type { OperatorApprovalVerifier } from "../runtime/approvals/operator-signature.js";
import { ToolRegistry, type ToolPermissionLevel } from "../runtime/tools/index.js";
import type { VerificationLedger } from "../runtime/verification/index.js";
import { createOperatorSignatureApprovalResolver } from "./approval-resolver.js";
import {
  PACKAGE_OPERATION_BUSY_CODE,
  type PackageOperationCoordinator,
} from "./package-operation-singleflight.js";
import type { PendingOperationRecord, PendingOperationStore } from "./pending-store.js";
import {
  approvalChallengeFor,
  approvalPayloadFor,
  envelope,
  outcomeForNonPendingState,
} from "./pending-view.js";
import type { DaemonResponseEnvelope, DaemonResponseOutcome } from "./protocol.js";
import {
  acquireRequestClaim,
  releaseRequestClaim,
  RequestClaimError,
  type RequestClaim,
} from "./request-claim.js";

/** Dependency surface: the narrow production seams this stage already had. */
export interface DaemonReconcileCommitDependencies {
  readonly packageName: string;
  readonly pendingStore: PendingOperationStore;
  readonly claimRoot: string;
  readonly managedSessionStore: ReleaseEditSessionStore;
  readonly gateway: ReleaseCommitReconciliationToolOptions["gateway"];
  readonly cleanupJournal: ReleaseEditCleanupJournal;
  readonly openCommitAttemptJournal: () => ReleaseCommitAttemptJournal;
  readonly reconcileAuditLedger: { append(entry: NewAuditEntry): Promise<void> };
  readonly finalizationAuditLedger: { append(entry: NewAuditEntry): Promise<void> };
  readonly operatorVerifier: OperatorApprovalVerifier;
  readonly ledger: AgentLedger;
  readonly approvalLedger: ApprovalLedger;
  readonly verificationLedger: VerificationLedger;
  readonly now?: () => Date;
}

/** Exactly one mode is reachable from the daemon. `probe` is deliberately absent. */
export const DAEMON_RECONCILIATION_MODE: ReleaseCommitReconciliationMode = "verify_expired";

function failure(
  correlationId: string,
  outcome: DaemonResponseOutcome,
  code: string,
  message: string,
): DaemonResponseEnvelope {
  return envelope(correlationId, outcome, { error: { code, message } });
}

type Authority =
  | { readonly ok: true; readonly candidate?: ReleaseCommitAttemptJournalRecord }
  | { readonly ok: false; readonly response: DaemonResponseEnvelope };

/** Read the real package journal. Read-only: no Google call is reachable. */
async function readAuthority(
  deps: DaemonReconcileCommitDependencies,
  correlationId: string,
): Promise<Authority> {
  let records: readonly ReleaseCommitAttemptJournalRecord[];
  try {
    records = (await deps.openCommitAttemptJournal().list()).map((record) =>
      parseReleaseCommitAttemptJournalRecord(record, deps.packageName),
    );
  } catch {
    return {
      ok: false,
      response: failure(
        correlationId,
        "external_state_ambiguous",
        "COMMIT_JOURNAL_UNREADABLE",
        "The package commit-attempt journal could not be read safely; no reconciliation was authorized.",
      ),
    };
  }
  if (new Set(records.map((record) => record.attemptId)).size !== records.length) {
    return {
      ok: false,
      response: failure(
        correlationId,
        "external_state_ambiguous",
        "COMMIT_JOURNAL_INVARIANT_FAILED",
        "The package commit-attempt journal has a duplicated attempt identity; no reconciliation was authorized.",
      ),
    };
  }
  const unresolved = records.filter(isCommitAttemptUnresolved);
  if (unresolved.length > 1) {
    return {
      ok: false,
      response: failure(
        correlationId,
        "external_state_ambiguous",
        "COMMIT_JOURNAL_INVARIANT_FAILED",
        "More than one unresolved commit attempt exists; no reconciliation was authorized.",
      ),
    };
  }
  const [candidate] = unresolved;
  return candidate === undefined ? { ok: true } : { ok: true, candidate };
}

/** Re-read one exact attempt and require it to be the unresolved authority. */
async function rereadExact(
  deps: DaemonReconcileCommitDependencies,
  attemptId: string,
): Promise<ReleaseCommitAttemptJournalRecord | undefined> {
  const matches = (await deps.openCommitAttemptJournal().list()).filter(
    (record) => record.attemptId === attemptId,
  );
  const [match] = matches;
  if (matches.length !== 1 || match === undefined) return undefined;
  const parsed = parseReleaseCommitAttemptJournalRecord(match, deps.packageName);
  return isCommitAttemptUnresolved(parsed) ? parsed : undefined;
}

/** The exact durable record, terminal or not. Used for settlement only. */
async function readExactAnyState(
  deps: DaemonReconcileCommitDependencies,
  attemptId: string,
): Promise<ReleaseCommitAttemptJournalRecord | undefined> {
  const matches = (await deps.openCommitAttemptJournal().list()).filter(
    (record) => record.attemptId === attemptId,
  );
  const [match] = matches;
  if (matches.length !== 1 || match === undefined) return undefined;
  return parseReleaseCommitAttemptJournalRecord(match, deps.packageName);
}

/** True when this record has a local continuation this stage may perform. */
function hasLocalContinuation(candidate: ReleaseCommitAttemptJournalRecord): boolean {
  if (isCommitAttemptTerminal(candidate)) return false;
  if (candidate.state === "ACKNOWLEDGED") {
    // Only the prefix kinds the SUCCESS-proof bridge may still continue are a
    // local continuation. A prior/unrelated observation is a legitimate
    // interrupted reconciliation and must be routed to the production recovery
    // authority instead of being handed to the success-only bridge.
    return isSuccessProofResumableAckPrefix(classifyAcknowledgedVerificationPrefix(candidate));
  }
  return candidate.state === "REMOTE_VERIFIED" && hasCompleteVerifiedProof(candidate);
}

type LocalOutcome =
  | { readonly done: true; readonly response: DaemonResponseEnvelope }
  | { readonly done: false; readonly candidate: ReleaseCommitAttemptJournalRecord };

/**
 * Local deterministic continuation. The CALLER holds the shared package lease;
 * every local failure is terminal for this invocation and NEVER falls through to
 * a Google recovery path.
 */
async function continueLocally(
  deps: DaemonReconcileCommitDependencies,
  correlationId: string,
  initial: ReleaseCommitAttemptJournalRecord,
): Promise<LocalOutcome> {
  let candidate = initial;
  if (candidate.state === "ACKNOWLEDGED") {
    const prefix = classifyAcknowledgedVerificationPrefix(candidate);
    // The Stage-3E bridge is a success-proof bridge: it may only advance
    // expected-state evidence. A prior/unrelated observation is production
    // reconciliation's recovery authority, so it is never offered to it.
    if (!isSuccessProofResumableAckPrefix(prefix)) return { done: false, candidate };
    try {
      const resumed = await resumeCommitVerificationEvidence({
        journal: deps.openCommitAttemptJournal(),
        attemptId: candidate.attemptId,
        packageName: deps.packageName,
        expectedStateDigest: candidate.expectedStateDigest,
        ...(deps.now === undefined ? {} : { now: deps.now }),
      });
      // An incomplete prefix is a recovery state: the existing signed production
      // recovery path may be authorized for it, never a second Stage-3E run.
      if (resumed === "verification_evidence_incomplete") return { done: false, candidate };
      const verified = await rereadExact(deps, candidate.attemptId);
      if (
        verified === undefined ||
        verified.state !== "REMOTE_VERIFIED" ||
        !hasCompleteVerifiedProof(verified)
      ) {
        return {
          done: true,
          response: failure(
            correlationId,
            "local_state_failure",
            "RECONCILIATION_LOCAL_PROOF_UNCONFIRMED",
            "Local verification continuation did not confirm the exact complete proof; no remote recovery began.",
          ),
        };
      }
      candidate = verified;
    } catch {
      return {
        done: true,
        response: failure(
          correlationId,
          "local_state_failure",
          "RECONCILIATION_LOCAL_RESUME_FAILED",
          "Required local verification continuation failed; no remote recovery began.",
        ),
      };
    }
  }
  if (candidate.state !== "REMOTE_VERIFIED" || !hasCompleteVerifiedProof(candidate))
    return { done: false, candidate };
  const finalized = await finalizeVerifiedCommit({
    journal: deps.openCommitAttemptJournal(),
    sessionStore: deps.managedSessionStore,
    candidate,
    auditLedger: deps.finalizationAuditLedger,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  if (finalized.outcome === "refused" || finalized.outcome === "local_state_failure") {
    // Truthful local failure: a local persistence/audit failure must never be
    // converted into a Google recovery attempt.
    return {
      done: true,
      response: failure(
        correlationId,
        "local_state_failure",
        finalized.code,
        "Local verified-commit finalization failed; no remote recovery and no destructive approval were used.",
      ),
    };
  }
  const receipt = await readExactAnyState(deps, candidate.attemptId);
  if (
    receipt === undefined ||
    receipt.state !== "RECONCILED_COMMITTED" ||
    !hasCompleteVerifiedProof(receipt)
  ) {
    return {
      done: true,
      response: failure(
        correlationId,
        "local_state_failure",
        "COMMIT_FINALIZATION_RECEIPT_UNCONFIRMED",
        "The exact local terminal receipt could not be confirmed; no remote recovery began.",
      ),
    };
  }
  return {
    done: true,
    response: envelope(correlationId, "success", {
      summary:
        "Committed attempt reconciled locally from complete durable proof; zero Google operations and no destructive approval were used.",
    }),
  };
}

/** The exact production reconciliation binding. Never a daemon-specific digest. */
function reconcileBinding(
  deps: DaemonReconcileCommitDependencies,
  candidate: ReleaseCommitAttemptJournalRecord,
) {
  return createReleaseCommitReconciliationTool({
    packageName: deps.packageName,
    candidate,
    mode: DAEMON_RECONCILIATION_MODE,
    gateway: deps.gateway,
    sessionStore: deps.managedSessionStore,
    journal: deps.openCommitAttemptJournal(),
    auditLedger: deps.reconcileAuditLedger,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
}

/**
 * Absent session, or the exact original managed session. Anything else refuses.
 * Stage-3E's stricter "session must be absent" rule is deliberately NOT imposed
 * here: the production tool settles the exact original session itself.
 */
async function sessionGuard(
  deps: DaemonReconcileCommitDependencies,
  candidate: ReleaseCommitAttemptJournalRecord,
): Promise<"ok" | "conflict" | "unreadable"> {
  try {
    const session = await deps.managedSessionStore.load();
    if (session === undefined) return "ok";
    return session.packageName === deps.packageName &&
      session.editId === candidate.editId &&
      session.expiryTimeSeconds === candidate.expiryTimeSeconds
      ? "ok"
      : "conflict";
  } catch {
    return "unreadable";
  }
}

/**
 * Production reconcile does not consume the independent verification cleanup
 * journal, so an existing unresolved record must never be raced by a new
 * destructive lifecycle. The record is neither deleted nor reinterpreted.
 */
async function cleanupGuard(
  deps: DaemonReconcileCommitDependencies,
  correlationId: string,
): Promise<DaemonResponseEnvelope | undefined> {
  try {
    const records = await deps.cleanupJournal.list();
    if (records.length === 0) return undefined;
  } catch {
    return failure(
      correlationId,
      "local_state_failure",
      "RECONCILIATION_CLEANUP_UNREADABLE",
      "The temporary-edit cleanup journal could not be read; no reconciliation was authorized.",
    );
  }
  return failure(
    correlationId,
    "cleanup_pending",
    "RECONCILIATION_CLEANUP_UNRESOLVED",
    "An earlier temporary verification edit is still awaiting confirmed cleanup; no new recovery approval was created.",
  );
}

/** Caller holds the package lease; claimed executions additionally hold their claim. */
async function settle(
  deps: DaemonReconcileCommitDependencies,
  requestId: string,
  from: "PENDING" | "CLAIMED" | "CONSUMED",
  to: "COMPLETED" | "RECOVERY_REQUIRED",
): Promise<boolean> {
  try {
    await deps.pendingStore.transition(requestId, from, to);
    return true;
  } catch {
    return false;
  }
}

/** An unused grant is never consumed; failed retirement must not be hidden. */
async function retireUnusedRequest(
  deps: DaemonReconcileCommitDependencies,
  correlationId: string,
  requestId: string,
  outcome: DaemonResponseEnvelope,
): Promise<DaemonResponseEnvelope> {
  if (!(await settle(deps, requestId, "PENDING", "RECOVERY_REQUIRED")))
    return failure(
      correlationId,
      "local_state_failure",
      "RECONCILIATION_REQUEST_RETIRE_FAILED",
      "The unused reconciliation request could not be retired; no destructive approval was consumed and no Google recovery began.",
    );
  return outcome;
}

export async function prepareReconcileCommit(
  deps: DaemonReconcileCommitDependencies,
  packageOperations: PackageOperationCoordinator,
  correlationId: string,
): Promise<DaemonResponseEnvelope> {
  const read = await readAuthority(deps, correlationId);
  if (!read.ok) return read.response;
  const selected = read.candidate;
  // Zero unresolved authority: nothing to authorize, and no historical terminal
  // attempt is searched for something to reconcile.
  if (selected === undefined)
    return envelope(correlationId, "success", { summary: "reconciliation_not_required" });
  // A terminal record with unresolved verification cleanup has no recovery path
  // here: it must never authorize another terminal reconciliation.
  if (isCommitAttemptTerminal(selected))
    return failure(
      correlationId,
      "cleanup_pending",
      "RECONCILIATION_TERMINAL_CLEANUP_PENDING",
      "Terminal commit history still carries unresolved verification cleanup; no recovery approval was created.",
    );
  // A fresh acknowledged commit is Stage 3E's authority, not reconciliation's.
  if (selected.state === "ACKNOWLEDGED" && !hasVerificationPrefix(selected))
    return failure(
      correlationId,
      "local_state_failure",
      "VERIFY_COMMITTED_REQUIRED",
      "verify_committed is required first; a fresh acknowledged commit is never remotely reconciled.",
    );

  if (hasLocalContinuation(selected)) {
    const acquisition = packageOperations.tryAcquirePackageOperation(deps.packageName);
    if (!acquisition.acquired)
      return failure(
        correlationId,
        "operation_in_progress",
        PACKAGE_OPERATION_BUSY_CODE,
        "Another package operation is in progress; no reconciliation work began.",
      );
    try {
      const current = await readAuthority(deps, correlationId);
      if (!current.ok) return current.response;
      const again = current.candidate;
      if (again === undefined)
        return envelope(correlationId, "success", { summary: "reconciliation_not_required" });
      if (again.attemptId !== selected.attemptId || isCommitAttemptTerminal(again))
        return failure(
          correlationId,
          "local_state_failure",
          "COMMIT_STATE_CHANGED",
          "The selected commit attempt changed while the package lease was acquired; no reconciliation work began.",
        );
      const outcome = await continueLocally(deps, correlationId, again);
      if (outcome.done) return outcome.response;
    } finally {
      // Released LAST, after every local journal transition and its audit.
      packageOperations.releasePackageOperation(acquisition.lease);
    }
  }

  // ---------- signed recovery preparation: zero Google, zero claim ----------
  let permission: ToolPermissionLevel;
  let approvalHook: NonNullable<ReturnType<typeof reconcileBinding>["binding"]["approval"]>;
  try {
    const built = reconcileBinding(deps, selected);
    // Permission always comes from the production tool definition, never from a
    // daemon-local assumption about what that mode implies.
    permission = built.tool.permission;
    const hook = built.binding.approval;
    if (
      hook === undefined ||
      typeof hook.createRequestDigest !== "function" ||
      typeof hook.createSafeSummary !== "function"
    )
      throw new Error("The production reconciliation binding has no approval hook.");
    approvalHook = hook;
  } catch (cause) {
    return failure(
      correlationId,
      "local_state_failure",
      (cause as { code?: string }).code ?? "RECONCILIATION_INTENT_INVALID",
      "A valid reconciliation approval could not be built from the durable attempt.",
    );
  }
  const cleanup = await cleanupGuard(deps, correlationId);
  if (cleanup !== undefined) return cleanup;
  const session = await sessionGuard(deps, selected);
  if (session === "conflict")
    return failure(
      correlationId,
      "local_state_failure",
      "RECONCILIATION_SESSION_CONFLICT",
      "The tracked Google Play edit does not match the bound commit attempt; no recovery approval was created.",
    );
  if (session === "unreadable")
    return failure(
      correlationId,
      "local_state_failure",
      "MANAGED_EDIT_UNREADABLE",
      "The tracked Google Play edit could not be read; no recovery approval was created.",
    );

  let record: PendingOperationRecord;
  try {
    record = await deps.pendingStore.prepare({
      operation: "reconcile_commit",
      toolName: RELEASES_RECONCILE_COMMIT_TOOL_NAME,
      permission,
      packageName: deps.packageName,
      requestDigest: approvalHook.createRequestDigest({}),
      intent: { kind: "reconcile_commit" },
    });
  } catch {
    return failure(
      correlationId,
      "config_invalid",
      "PENDING_PREPARE_FAILED",
      "The daemon could not derive a valid reconciliation approval challenge.",
    );
  }
  return envelope(correlationId, "approval_required", {
    summary: approvalHook.createSafeSummary({}),
    approval: approvalChallengeFor(record),
  });
}

function caseOf(payload: unknown): ReleaseCommitReconciliationResult["case"] | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = Reflect.get(payload, "case");
  return value === "CASE_1" || value === "CASE_2" || value === "CASE_3" ? value : undefined;
}

function toolFailureCode(result: AgentRunResult, fallback: string | undefined): string {
  const cause = result.cause;
  if (typeof cause === "object" && cause !== null) {
    const code: unknown = Reflect.get(cause, "code");
    if (typeof code === "string" && code.length > 0) return code;
  }
  return fallback ?? result.code;
}

export async function executeReconcileCommit(
  deps: DaemonReconcileCommitDependencies,
  packageOperations: PackageOperationCoordinator,
  correlationId: string,
  requestId: string,
  signature: string,
): Promise<DaemonResponseEnvelope> {
  // ---------- pre-lease validation: strict parse, zero mutation, zero Google ----------
  const record = await deps.pendingStore.load(requestId);
  if (record === undefined) return envelope(correlationId, "request_not_found", { requestId });
  const state = await deps.pendingStore.state(requestId);
  const shortCircuit = outcomeForNonPendingState(state, correlationId, requestId);
  if (shortCircuit !== undefined) return shortCircuit;
  if (record.operation !== "reconcile_commit")
    return failure(
      correlationId,
      "approval_mismatch",
      "OPERATION_MISMATCH",
      "The signed request is not a commit-reconciliation approval request.",
    );
  if (record.permission !== "destructive")
    return failure(
      correlationId,
      "approval_mismatch",
      "PERMISSION_MISMATCH",
      "The signed request does not carry the destructive reconciliation permission.",
    );
  if (record.packageName !== deps.packageName)
    return failure(
      correlationId,
      "approval_mismatch",
      "PACKAGE_DRIFT",
      "The configured package no longer matches the signed request.",
    );
  if (record.intent.kind !== "reconcile_commit")
    return failure(
      correlationId,
      "approval_mismatch",
      "INTENT_MISMATCH",
      "The signed request does not carry a commit-reconciliation intent.",
    );
  const payload = approvalPayloadFor(record);
  if (!deps.operatorVerifier.verify(payload, signature))
    return failure(
      correlationId,
      "approval_mismatch",
      "SIGNATURE_INVALID",
      "The operator signature did not verify for this request.",
    );

  // ---------- one package-scoped operation at a time ----------
  const acquisition = packageOperations.tryAcquirePackageOperation(deps.packageName);
  if (!acquisition.acquired)
    return failure(
      correlationId,
      "operation_in_progress",
      PACKAGE_OPERATION_BUSY_CODE,
      "Another mutating execution is in progress for this package; nothing was reconciled.",
    );
  const lease = acquisition.lease;
  try {
    // ---------- authoritative recheck under the lease ----------
    const read = await readAuthority(deps, correlationId);
    if (!read.ok) return read.response;
    const selected = read.candidate;
    if (selected === undefined) {
      // The durable goal state already holds, or no unresolved work remains: the
      // unused approval is retired, never consumed, and no Google call runs.
      return await retireUnusedRequest(
        deps,
        correlationId,
        requestId,
        envelope(correlationId, "success", { summary: "reconciliation_not_required" }),
      );
    }
    if (isCommitAttemptTerminal(selected)) {
      // readAuthority selects UNRESOLVED records only: a terminal selection is
      // therefore still cleanup-pending, never "nothing left to reconcile".
      return await retireUnusedRequest(
        deps,
        correlationId,
        requestId,
        failure(
          correlationId,
          "cleanup_pending",
          "RECONCILIATION_TERMINAL_CLEANUP_PENDING",
          "Terminal commit history still carries unresolved verification cleanup; no Google recovery began.",
        ),
      );
    }
    if (selected.state === "ACKNOWLEDGED" && !hasVerificationPrefix(selected)) {
      return await retireUnusedRequest(
        deps,
        correlationId,
        requestId,
        failure(
          correlationId,
          "local_state_failure",
          "VERIFY_COMMITTED_REQUIRED",
          "verify_committed is required first; no destructive reconciliation was performed.",
        ),
      );
    }

    // Any safe local continuation runs FIRST, under this same lease.
    const continued = await continueLocally(deps, correlationId, selected);
    if (continued.done) {
      return await retireUnusedRequest(deps, correlationId, requestId, continued.response);
    }
    const candidate = continued.candidate;

    // ---------- exact production binding, re-derived from durable state ----------
    let toolPermission: ToolPermissionLevel;
    let hook: NonNullable<ReturnType<typeof reconcileBinding>["binding"]["approval"]>;
    try {
      const rebuilt = reconcileBinding(deps, candidate);
      toolPermission = rebuilt.tool.permission;
      const candidateHook = rebuilt.binding.approval;
      if (candidateHook === undefined)
        throw new Error("The production reconciliation binding has no approval hook.");
      hook = candidateHook;
    } catch (cause) {
      return failure(
        correlationId,
        "local_state_failure",
        (cause as { code?: string }).code ?? "RECONCILIATION_INTENT_INVALID",
        "The reconciliation intent could not be rebuilt from durable evidence.",
      );
    }
    if (hook.createRequestDigest({}) !== record.requestDigest) {
      // Trusted state moved after approval. The old approval is NOT rebound.
      return failure(
        correlationId,
        "local_state_failure",
        "RECONCILIATION_INTENT_DRIFT_REQUEST_DIGEST",
        "Trusted reconciliation state changed after approval; a new prepare and signature are required.",
      );
    }
    if (toolPermission !== "destructive" || record.toolName !== RELEASES_RECONCILE_COMMIT_TOOL_NAME)
      return failure(
        correlationId,
        "approval_mismatch",
        "RECONCILIATION_BINDING_MISMATCH",
        "The signed request does not match the production reconciliation binding.",
      );

    // ---------- local safety guards, still before any claim ----------
    const cleanup = await cleanupGuard(deps, correlationId);
    if (cleanup !== undefined) return cleanup;
    const session = await sessionGuard(deps, candidate);
    if (session === "conflict")
      return failure(
        correlationId,
        "local_state_failure",
        "RECONCILIATION_SESSION_CONFLICT",
        "The tracked Google Play edit does not match the bound commit attempt; nothing was reconciled.",
      );
    if (session === "unreadable")
      return failure(
        correlationId,
        "local_state_failure",
        "MANAGED_EDIT_UNREADABLE",
        "The tracked Google Play edit could not be read; nothing was reconciled.",
      );

    // ---------- the production tool, from the exact revalidated snapshot ----------
    const built = reconcileBinding(deps, candidate);
    const registry = new ToolRegistry();
    registry.register(built.tool);

    // ---------- exclusive claim, then durable CLAIMED ----------
    let claim: RequestClaim;
    try {
      claim = await acquireRequestClaim(
        deps.claimRoot,
        requestId,
        deps.now === undefined ? {} : { now: deps.now },
      );
    } catch (cause) {
      if (cause instanceof RequestClaimError && cause.code === "CLAIM_ALREADY_HELD")
        return envelope(correlationId, "request_claim_held");
      throw cause;
    }
    try {
      await deps.pendingStore.transition(requestId, "PENDING", "CLAIMED");
    } catch {
      await settle(deps, requestId, "CLAIMED", "RECOVERY_REQUIRED");
      return failure(
        correlationId,
        "external_state_ambiguous",
        "CLAIM_RECORD_UNSYNCHRONIZED",
        "An exclusive claim was acquired but the durable state could not be advanced safely.",
      );
    }

    // ---------- CLAIMED -> CONSUMED strictly before any Google call ----------
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

    const execution = await executeOneTool({
      registry,
      binding: built.binding,
      input: {},
      ledger: deps.ledger,
      approvalResolver: resolver,
      approvalLedger: deps.approvalLedger,
      verificationLedger: deps.verificationLedger,
    });

    // ---------- settlement from durable authority, never from the tool claim ----------
    const durable = await readExactAnyState(deps, candidate.attemptId);
    const terminal =
      durable !== undefined &&
      !isCommitAttemptUnresolved(durable) &&
      (durable.state === "RECONCILED_COMMITTED" || durable.state === "RECONCILED_NOT_COMMITTED");
    const caseValue = caseOf(execution.payload);

    if (consumptionFailed) {
      await settle(deps, requestId, "CLAIMED", "RECOVERY_REQUIRED");
      return failure(
        correlationId,
        "local_state_failure",
        "APPROVAL_CONSUMPTION_PERSIST_FAILED",
        "Required local approval-consumption state could not be persisted; no reconciliation transport began.",
      );
    }

    if (execution.result.ok === true && terminal && durable !== undefined) {
      if (!(await settle(deps, requestId, "CONSUMED", "COMPLETED"))) {
        // The remote/journal reconciliation result is already known and durable,
        // so a failed LOCAL completion is not remote ambiguity. Retire the
        // request if that can be persisted, keep the claim, and never retry.
        const retired = await settle(deps, requestId, "CONSUMED", "RECOVERY_REQUIRED");
        return failure(
          correlationId,
          "local_state_failure",
          "TERMINAL_TRANSITION_FAILED",
          retired
            ? "The reconciled attempt reached a durable terminal state, but this request could not be recorded as completed; it was retired and no retry was attempted."
            : "The reconciled attempt reached a durable terminal state, but neither completion nor retirement could be persisted; no retry was attempted.",
        );
      }
      await releaseRequestClaim(claim).catch(() => undefined);
      // Success carries no `error` field: the protocol reserves it for failures,
      // and the committed/not-committed distinction is already truthful here.
      const summary =
        durable.state === "RECONCILED_COMMITTED"
          ? "reconciliation_committed"
          : "reconciliation_not_committed";
      return envelope(correlationId, "success", { summary });
    }

    // Anything else stays unresolved. No retry, no second readback lifecycle,
    // and the claim is retained because releasing it could admit a second one.
    const retired =
      (await settle(deps, requestId, "CONSUMED", "RECOVERY_REQUIRED")) ||
      (await settle(deps, requestId, "CLAIMED", "RECOVERY_REQUIRED"));
    if (terminal && durable !== undefined) {
      // The exact durable attempt proves the remote outcome, yet the runtime
      // still reported a failure for this execution (typically a local audit or
      // receipt persistence failure inside the production tool, whose own broad
      // catch can also re-label it as an uncertain CASE_3). The remote result is
      // KNOWN, so this is reported as a definite local failure rather than
      // remote ambiguity, and no retry or second lifecycle is attempted.
      return failure(
        correlationId,
        "local_state_failure",
        toolFailureCode(execution.result, undefined),
        "The durable commit attempt reached a reconciled terminal state, but this execution could not confirm its own receipt; operator recovery is required and no retry was attempted.",
      );
    }
    if (!retired) {
      // The remote outcome stays unresolved AND the required retirement could
      // not be persisted. That is a local persistence failure, not evidence of
      // remote success, and it must never trigger a retry.
      return failure(
        correlationId,
        "local_state_failure",
        "RECOVERY_SETTLEMENT_PERSIST_FAILED",
        "The reconciliation outcome remains unresolved and the required recovery-required state could not be persisted; the claim is retained and no retry was attempted.",
      );
    }
    if (
      execution.result.externalStateUncertain === true ||
      caseValue === "CASE_3" ||
      durable === undefined
    )
      return failure(
        correlationId,
        "external_state_ambiguous",
        toolFailureCode(execution.result, caseValue),
        "The reconciliation outcome remains unresolved; operator recovery is required and no retry was attempted.",
      );
    if (caseValue !== undefined)
      return failure(
        correlationId,
        "external_state_ambiguous",
        caseValue,
        "The commit state could not be closed from the observed evidence; operator recovery is required.",
      );
    return failure(
      correlationId,
      "remote_failure",
      toolFailureCode(execution.result, undefined),
      "Commit reconciliation did not succeed; this request must not be reused.",
    );
  } finally {
    // Released LAST: after the journal rechecks, the claim, the approval
    // lifecycle, the temporary edit and the daemon pending settlement.
    packageOperations.releasePackageOperation(lease);
  }
}

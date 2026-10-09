/**
 * Stage 3A daemon operation dispatcher — the `open_edit` vertical slice.
 *
 * This module ORCHESTRATES. It owns no Google logic, no permission logic, no
 * approval logic, no verifier logic and no audit logic. Every mutation still
 * flows through the one authoritative safety path:
 *
 *   dispatcher -> static server-side binding -> executeOneTool -> runAgent
 *              -> registry/permission -> approval -> tool.execute
 *              -> mandatory verifier -> audit
 *
 * Server-owned identities (package, tool name, permission, request digest,
 * expiry, nonce) are derived here from trusted configuration and the existing
 * production binding. The client may only name a semantic operation and, to
 * execute, present a request id plus a detached signature.
 *
 * Ordering invariants enforced here (stage brief §9-§13, §27-§29):
 *
 *   pre-claim:  load -> schema -> operation -> PENDING -> TTL -> package
 *               -> rebuild canonical payload -> verify signature   (no mutation)
 *   package:    ONE package-scoped operation lease (Stage 3E.2D), acquired
 *               BEFORE any authoritative state recheck and held across the
 *               whole remote mutation lifecycle until request settlement
 *   claim:      exclusive O_EXCL claim
 *   durable:    PENDING -> CLAIMED
 *   approval:   three-way identity match -> signature -> CLAIMED -> CONSUMED
 *               -> ONLY THEN return the approved grant -> tool may run
 *   terminal:   CONSUMED -> COMPLETED, or (CLAIMED|CONSUMED) -> RECOVERY_REQUIRED
 *
 * The claim is retained on every path except confirmed success: retaining a
 * claim can never cause a second remote mutation, while releasing it can.
 */
import { executeOneTool } from "../runtime/agent/execute-one-tool.js";
import type { AgentLedger, AgentToolBinding } from "../runtime/agent/index.js";
import type { ApprovalLedger } from "../runtime/approvals/index.js";
import type { OperatorApprovalVerifier } from "../runtime/approvals/operator-signature.js";
import type { ToolPermissionLevel, ToolRegistry } from "../runtime/tools/index.js";
import type { VerificationLedger } from "../runtime/verification/index.js";
import { createOperatorSignatureApprovalResolver } from "./approval-resolver.js";
import {
  attachNotes as attachNotesOperation,
  type DaemonAttachNotesDependencies,
} from "./attach-notes.js";
import {
  executeCommit as executeCommitOperation,
  prepareCommit as prepareCommitOperation,
  type DaemonCommitDependencies,
} from "./commit-operations.js";
import {
  approvalChallengeFor,
  approvalPayloadFor,
  envelope as response,
  outcomeForNonPendingState,
} from "./pending-view.js";
import type {
  PendingOperationRecord,
  PendingOperationStateName,
  PendingOperationStore,
} from "./pending-store.js";
import {
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
  type DaemonRequestEnvelope,
  type DaemonRequestKind,
  type DaemonResponseEnvelope,
} from "./protocol.js";
import {
  acquireRequestClaim,
  releaseRequestClaim,
  RequestClaimError,
  type RequestClaim,
} from "./request-claim.js";
import {
  PACKAGE_OPERATION_BUSY_CODE,
  type PackageOperationCoordinator,
} from "./package-operation-singleflight.js";
import {
  executeVerifyCommitted,
  prepareVerifyCommitted,
  type DaemonVerifyCommittedDependencies,
} from "./verify-committed-operations.js";
import {
  executeReconcileCommit,
  prepareReconcileCommit,
  type DaemonReconcileCommitDependencies,
} from "./reconcile-commit-operations.js";

/**
 * Operations this build actually serves. Every other recognized operation is
 * answered with `operation_unavailable` — never `capability_blocked`, which is
 * reserved for authoritative product capability policy.
 */
export const DAEMON_SERVED_OPERATIONS: readonly DaemonRequestKind[] = Object.freeze([
  "status",
  "prepare_open_edit",
  "execute_open_edit",
  "attach_notes",
  "prepare_commit",
  "execute_commit",
  "prepare_verify_committed",
  "execute_verify_committed",
  "prepare_reconcile_commit",
  "execute_reconcile_commit",
]);

/**
 * Read-only status evidence supplied by the production stores.
 *
 * The daemon never infers these from filenames and never mutates a store in
 * order to answer `status`. A field the caller cannot safely inspect is reported
 * as `unavailable` rather than guessed.
 */
export interface DaemonStatusEvidence {
  /** From the real package-metadata seam. Never hard-coded in this module. */
  readonly packageVersion: string;
  readonly managedSessionPresent: boolean | "unavailable";
  readonly pendingCleanup: boolean | "unavailable";
  readonly unresolvedCommitRecovery: boolean | "unavailable";
}

/**
 * Pending-state counts, keyed exactly as the operator-facing status contract
 * names them. `absent` is deliberately omitted: it is a lookup verdict, not a
 * state a listed record can be in.
 */
const COUNTED_PENDING_STATES: readonly {
  readonly state: PendingOperationStateName;
  readonly key: string;
}[] = Object.freeze([
  { state: "pending", key: "pending" },
  { state: "claimed", key: "claimed" },
  { state: "consumed", key: "consumed" },
  { state: "recovery_required", key: "recoveryRequired" },
  { state: "completed", key: "completed" },
  { state: "expired", key: "expired" },
]);

/** Truthful tri-state: never guess a field that could not be safely read. */
function triState(value: boolean | "unavailable" | undefined): string {
  if (value === undefined || value === "unavailable") return "unavailable";
  return value ? "true" : "false";
}

/**
 * Counts come from the store's own `list()` + `state()` projection, so the
 * schema-v2 TTL/terminal precedence is applied exactly once. A store fault
 * reports `unavailable` rather than a misleading zero.
 */
async function pendingStateCounts(store: PendingOperationStore): Promise<string> {
  try {
    const records = await store.list();
    const counts = new Map<PendingOperationStateName, number>();
    for (const record of records) {
      const state = await store.state(record.requestId);
      counts.set(state, (counts.get(state) ?? 0) + 1);
    }
    return COUNTED_PENDING_STATES.map(
      (entry) => `${entry.key}=${String(counts.get(entry.state) ?? 0)}`,
    ).join(" ");
  } catch {
    return "pendingStateCounts=unavailable";
  }
}

/**
 * Safe status projection.
 *
 * The response envelope has no structured data field, and this stage must not
 * widen the wire protocol, so the payload is a stable, ordered `key=value`
 * summary carried in the existing safe `summary` field. It contains only
 * booleans, counts and the configured package/version — never credentials,
 * identities, digests, note text or raw store records.
 */
async function renderStatusSummary(deps: DaemonOperationDependencies): Promise<string> {
  const evidence =
    deps.readStatusEvidence === undefined ? undefined : await deps.readStatusEvidence();
  const fields = [
    `protocolVersion=${String(PLAYOPS_DAEMON_PROTOCOL_VERSION)}`,
    `packageVersion=${evidence?.packageVersion ?? "unavailable"}`,
    `configuredPackage=${deps.packageName}`,
    `servedOperations=${DAEMON_SERVED_OPERATIONS.join(",")}`,
    `managedSessionPresent=${triState(evidence?.managedSessionPresent)}`,
    `pendingCleanup=${triState(evidence?.pendingCleanup)}`,
    `unresolvedCommitRecovery=${triState(evidence?.unresolvedCommitRecovery)}`,
  ];
  return `${fields.join(" ")} ${await pendingStateCounts(deps.pendingStore)}`;
}

/** Read-only. Requires no approval, no signature, no pending request and no claim. */
async function statusOperation(
  deps: DaemonOperationDependencies,
  correlationId: string,
): Promise<DaemonResponseEnvelope> {
  return response(correlationId, "status", { summary: await renderStatusSummary(deps) });
}

export type DaemonOperationErrorCode = "DAEMON_CONFIG_INVALID";

export class DaemonOperationError extends Error {
  override readonly name = "DaemonOperationError";
  readonly code: DaemonOperationErrorCode = "DAEMON_CONFIG_INVALID";
}

/** The server-side production binding for one operation. Never client-derived. */
export interface DaemonOperationBinding {
  readonly binding: AgentToolBinding;
  /** Pre-derived, server-owned tool input. Never model- or client-controlled. */
  readonly input: unknown;
}

export interface DaemonOperationDependencies {
  /** Trusted package identity. The client can never supply or override it. */
  readonly packageName: string;
  readonly pendingStore: PendingOperationStore;
  /** Directory holding exclusive request-claim files. */
  readonly claimRoot: string;
  /**
   * The ONE shared package-scoped operation coordinator (Stage 3E.2D).
   *
   * Injected, never constructed here and never constructed inside an execute
   * handler: every served mutating operation (`execute_open_edit`,
   * `attach_notes`, `execute_commit`) must use this same instance, because the
   * exclusion domain is the whole package edit lifecycle rather than one
   * operation. A per-operation or per-request coordinator would reintroduce the
   * Stage-3E.2C cross-operation races.
   */
  readonly packageOperations: PackageOperationCoordinator;
  readonly registry: ToolRegistry;
  readonly openEdit: DaemonOperationBinding;
  /**
   * Stage 3C `attach_notes` dependencies (managed session, trusted release
   * gateway, durable write-intent store, ledgers).
   *
   * Optional so the operation stays independently testable. The production
   * wiring always supplies it; when it is absent this build answers
   * `operation_unavailable` rather than pretending the gate exists.
   */
  readonly attachNotes?: DaemonAttachNotesDependencies;
  /**
   * Stage 3D `prepare_commit` / `execute_commit` dependencies (managed session,
   * trusted commit gateway, durable write-intent gate, the real commit-attempt
   * journal, the SHARED package-operation coordinator, the
   * operator verifier and the ledgers).
   *
   * Optional so the slice stays independently testable. The production wiring
   * always supplies it; when it is absent this build answers
   * `operation_unavailable` rather than pretending the commit gate exists.
   */
  readonly commit?: DaemonCommitDependencies;
  /**
   * Stage 3E.3 `prepare_verify_committed` / `execute_verify_committed`
   * dependencies (the real commit-attempt journal as the only expectation
   * source, the durable pending store as the provenance authority, the narrow
   * Layer-A summary and temporary-edit gateways, the durable cleanup journal,
   * the operator verifier and the ledgers).
   *
   * Optional so the slice stays independently testable. The production wiring
   * always supplies it; when it is absent this build answers
   * `operation_unavailable` rather than pretending the verification gate exists.
   */
  readonly verifyCommitted?: DaemonVerifyCommittedDependencies;
  /** Stage 3F.2: local deterministic continuation or signed destructive recovery. */
  readonly reconcileCommit?: DaemonReconcileCommitDependencies;
  readonly operatorVerifier: OperatorApprovalVerifier;
  readonly ledger: AgentLedger;
  readonly approvalLedger: ApprovalLedger;
  readonly verificationLedger: VerificationLedger;
  readonly now?: () => Date;
  /**
   * Optional read-only status evidence. When absent, every field it would supply
   * is reported `unavailable` — the daemon never guesses local safety state.
   */
  readonly readStatusEvidence?: () => Promise<DaemonStatusEvidence>;
}

export interface DaemonOperations {
  /** One envelope in, exactly one envelope out. Never throws for a normal verdict. */
  handle(envelope: DaemonRequestEnvelope): Promise<DaemonResponseEnvelope>;
}

/**
 * Fail-closed normalization after a durable inconsistency.
 *
 * Only ever called by an executor that HOLDS the exclusive claim. It is never
 * called for a competing request that merely observed someone else's claim
 * (brief §28), because that would corrupt a legitimately in-flight execution.
 */
async function normalizeToRecovery(store: PendingOperationStore, requestId: string): Promise<void> {
  const current = (await store.load(requestId))?.state;
  if (current !== "PENDING" && current !== "CLAIMED" && current !== "CONSUMED") return;
  await store.transition(requestId, current, "RECOVERY_REQUIRED").catch(() => undefined);
}

export function createDaemonOperations(deps: DaemonOperationDependencies): DaemonOperations {
  const openBinding = deps.openEdit.binding;
  const approvalHook = openBinding.approval;
  if (
    approvalHook === undefined ||
    typeof approvalHook.createRequestDigest !== "function" ||
    typeof approvalHook.createSafeSummary !== "function"
  ) {
    throw new DaemonOperationError(
      "The production open-edit binding requires approval.createRequestDigest and createSafeSummary.",
    );
  }
  const registered = deps.registry.get(openBinding.toolName);
  const openPermission: ToolPermissionLevel = registered.permission;
  // The ONE exclusion domain is the configured package (brief §2), so every
  // served operation must key its package lease on the SAME trusted value.
  // `attach_notes` and `execute_commit` own a `packageName` slot each, so a
  // composition that filled them with a different value would fragment the
  // lease into independent domains and silently reopen the Stage-3E.2C
  // cross-operation races. Fail closed at construction instead.
  const scopeMismatch =
    (deps.attachNotes !== undefined && deps.attachNotes.packageName !== deps.packageName) ||
    (deps.commit !== undefined && deps.commit.packageName !== deps.packageName) ||
    (deps.verifyCommitted !== undefined && deps.verifyCommitted.packageName !== deps.packageName) ||
    (deps.reconcileCommit !== undefined && deps.reconcileCommit.packageName !== deps.packageName);
  if (scopeMismatch) {
    throw new DaemonOperationError(
      "Every served operation must be configured with the same trusted package name.",
    );
  }
  // Derived locally from the production binding: preparation performs no I/O.
  const openDigest = approvalHook.createRequestDigest(deps.openEdit.input);
  const openSummary = approvalHook.createSafeSummary(deps.openEdit.input);

  async function prepareOpenEdit(correlationId: string): Promise<DaemonResponseEnvelope> {
    let record: PendingOperationRecord;
    try {
      record = await deps.pendingStore.prepare({
        operation: "open_edit",
        toolName: openBinding.toolName,
        permission: openPermission,
        packageName: deps.packageName,
        requestDigest: openDigest,
        // Server-derived only: the open-edit intent carries no client values.
        intent: { kind: "open_edit" },
      });
    } catch (cause) {
      if (cause instanceof Error && cause.name === "PendingStoreError") {
        return response(correlationId, "config_invalid", {
          error: {
            code: "PENDING_PREPARE_FAILED",
            message: "The daemon could not derive a valid approval challenge.",
          },
        });
      }
      throw cause;
    }
    return response(correlationId, "approval_required", {
      summary: openSummary,
      approval: approvalChallengeFor(record),
    });
  }

  async function executeOpenEdit(
    correlationId: string,
    requestId: string,
    signature: string,
  ): Promise<DaemonResponseEnvelope> {
    // ---------- pre-claim validation: strictly zero mutation ----------
    const record = await deps.pendingStore.load(requestId);
    if (record === undefined) {
      return response(correlationId, "request_not_found", { requestId });
    }

    const state = await deps.pendingStore.state(requestId);
    const shortCircuit = outcomeForNonPendingState(state, correlationId, requestId);
    if (shortCircuit !== undefined) return shortCircuit;

    if (record.operation !== "open_edit") {
      return response(correlationId, "approval_mismatch", {
        error: {
          code: "OPERATION_MISMATCH",
          message: "The signed request is not an open-edit approval request.",
        },
      });
    }
    if (record.packageName !== deps.packageName) {
      return response(correlationId, "approval_mismatch", {
        error: {
          code: "PACKAGE_DRIFT",
          message: "The configured package no longer matches the signed request.",
        },
      });
    }
    const payload = approvalPayloadFor(record);
    if (!deps.operatorVerifier.verify(payload, signature)) {
      return response(correlationId, "approval_mismatch", {
        error: {
          code: "SIGNATURE_INVALID",
          message: "The operator signature did not verify for this request.",
        },
      });
    }

    // ---------- one mutating execution per package (Stage 3E.2D) ----------
    // Acquired BEFORE the authoritative "no managed session" recheck, which the
    // production open tool performs inside executeOneTool, and before the
    // exclusive request claim, so a same-package loser takes no claim, consumes
    // no approval and performs zero edits.insert.
    const acquisition = deps.packageOperations.tryAcquirePackageOperation(deps.packageName);
    if (!acquisition.acquired) {
      return response(correlationId, "operation_in_progress", {
        error: {
          code: PACKAGE_OPERATION_BUSY_CODE,
          message:
            "Another mutating execution is in progress for this package; no Play edit was opened.",
        },
      });
    }
    const lease = acquisition.lease;
    try {
      return await performOpenEdit(correlationId, requestId, record, payload, signature);
    } finally {
      // Released only after the claim, the approval lifecycle, the remote
      // insert, the durable managed-session save and the pending settlement.
      deps.packageOperations.releasePackageOperation(lease);
    }
  }

  /**
   * The post-lease open-edit lifecycle. Extracted unchanged from
   * `executeOpenEdit` so the package lease can wrap it without altering any
   * ordering, claim, approval or settlement behaviour.
   */
  async function performOpenEdit(
    correlationId: string,
    requestId: string,
    record: PendingOperationRecord,
    payload: ReturnType<typeof approvalPayloadFor>,
    signature: string,
  ): Promise<DaemonResponseEnvelope> {
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
        // Brief §28/§29: a competing or still-in-flight execution. Make ZERO
        // state mutation — PENDING + existing claim is not proof of a crash
        // window here, so it must not be normalized to RECOVERY_REQUIRED.
        return response(correlationId, "request_claim_held");
      }
      throw cause;
    }

    // ---------- durable PENDING -> CLAIMED before anything may be consumed ----------
    try {
      await deps.pendingStore.transition(requestId, "PENDING", "CLAIMED");
    } catch {
      await normalizeToRecovery(deps.pendingStore, requestId);
      return response(correlationId, "external_state_ambiguous", {
        error: {
          code: "CLAIM_RECORD_UNSYNCHRONIZED",
          message:
            "An exclusive claim was acquired but the durable state could not be advanced safely.",
        },
      });
    }

    // ---------- approval consumption seam ----------
    // The resolver persists CLAIMED -> CONSUMED and only then returns the
    // approved grant, so the durable CONSUMED record strictly precedes the
    // mutating tool invocation. If the persistence fails the resolver denies and
    // runAgent aborts before the tool is called.
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
          // Local durable persistence failed while mutation was still impossible:
          // the resolver will deny, so no mutating tool can begin.
          consumptionFailed = true;
          throw cause;
        }
      },
    });

    const execution = await executeOneTool({
      registry: deps.registry,
      binding: openBinding,
      input: deps.openEdit.input,
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
        return response(correlationId, "external_state_ambiguous", {
          error: {
            code: "TERMINAL_TRANSITION_FAILED",
            message: "The verified operation could not be recorded as safely terminal.",
          },
        });
      }
      // §17: the durable COMPLETED state is now the replay-prevention authority,
      // so the exclusive claim may be released with the holder token. A failure
      // to release is not an execution failure and must not mask the success.
      await releaseRequestClaim(claim).catch(() => undefined);
      return response(correlationId, "success", {
        summary: "Play edit opened and verified.",
      });
    }

    // Any non-success outcome is terminal-non-reusable: a request whose external
    // effect may have happened must never be silently re-enabled, and no
    // reverse transition to PENDING exists. The claim is retained.
    await normalizeToRecovery(deps.pendingStore, requestId);
    const code = execution.result.code;
    // Local durable-state failure. The consumption write failed, so the approval
    // was denied and no mutating tool could begin: mutation impossibility is
    // proven, so this is definite rather than ambiguous, and it is emphatically
    // not an approval mismatch.
    if (consumptionFailed) {
      return response(correlationId, "local_state_failure", {
        error: {
          code: "APPROVAL_CONSUMPTION_PERSIST_FAILED",
          message:
            "Required local approval-consumption state could not be persisted; no remote mutation began.",
        },
      });
    }
    if (execution.result.externalStateUncertain) {
      return response(correlationId, "external_state_ambiguous", {
        error: {
          code,
          message: "The edit outcome is ambiguous; operator recovery is required.",
        },
      });
    }
    if (code === "APPROVAL_DENIED" || code === "APPROVAL_REQUIRED") {
      return response(correlationId, "approval_mismatch", {
        error: {
          code,
          message: "The runtime approval could not be resolved for this request.",
        },
      });
    }
    return response(correlationId, "remote_failure", {
      error: { code, message: "The open-edit operation did not complete successfully." },
    });
  }

  async function handle(envelope: DaemonRequestEnvelope): Promise<DaemonResponseEnvelope> {
    const { correlationId, request } = envelope;
    if (!DAEMON_SERVED_OPERATIONS.includes(request.kind)) {
      return response(correlationId, "operation_unavailable", {
        operation: request.kind,
        summary: "This daemon build does not serve that operation yet.",
      });
    }
    switch (request.kind) {
      case "status":
        return statusOperation(deps, correlationId);
      case "prepare_open_edit":
        return prepareOpenEdit(correlationId);
      case "execute_open_edit":
        return executeOpenEdit(correlationId, request.requestId, request.signature);
      case "attach_notes":
        if (deps.attachNotes === undefined) {
          return response(correlationId, "operation_unavailable", {
            operation: request.kind,
            summary: "This daemon build does not serve that operation yet.",
          });
        }
        return attachNotesOperation(
          deps.attachNotes,
          deps.packageOperations,
          correlationId,
          request,
        );
      case "prepare_commit":
        if (deps.commit === undefined) {
          return response(correlationId, "operation_unavailable", {
            operation: request.kind,
            summary: "This daemon build does not serve that operation yet.",
          });
        }
        return prepareCommitOperation(deps.commit, correlationId, {
          track: request.track,
          versionCode: request.versionCode,
        });
      case "execute_commit":
        if (deps.commit === undefined) {
          return response(correlationId, "operation_unavailable", {
            operation: request.kind,
            summary: "This daemon build does not serve that operation yet.",
          });
        }
        return executeCommitOperation(
          deps.commit,
          deps.packageOperations,
          correlationId,
          request.requestId,
          request.signature,
        );
      case "prepare_verify_committed":
        if (deps.verifyCommitted === undefined) {
          return response(correlationId, "operation_unavailable", {
            operation: request.kind,
            summary: "This daemon build does not serve that operation yet.",
          });
        }
        return prepareVerifyCommitted(deps.verifyCommitted, deps.packageOperations, correlationId, {
          track: request.track,
          versionCode: request.versionCode,
        });
      case "execute_verify_committed":
        if (deps.verifyCommitted === undefined) {
          return response(correlationId, "operation_unavailable", {
            operation: request.kind,
            summary: "This daemon build does not serve that operation yet.",
          });
        }
        return executeVerifyCommitted(
          deps.verifyCommitted,
          deps.packageOperations,
          correlationId,
          request.requestId,
          request.signature,
        );
      case "prepare_reconcile_commit":
        if (deps.reconcileCommit === undefined) {
          return response(correlationId, "operation_unavailable", {
            operation: request.kind,
            summary: "This daemon build does not serve that operation yet.",
          });
        }
        return prepareReconcileCommit(deps.reconcileCommit, deps.packageOperations, correlationId);
      case "execute_reconcile_commit":
        if (deps.reconcileCommit === undefined) {
          return response(correlationId, "operation_unavailable", {
            operation: request.kind,
            summary: "This daemon build does not serve that operation yet.",
          });
        }
        return executeReconcileCommit(
          deps.reconcileCommit,
          deps.packageOperations,
          correlationId,
          request.requestId,
          request.signature,
        );
      default: {
        // Defensive only: the served-map guard above already answers every
        // operation this build does not serve, so this branch is unreachable for
        // a validated envelope. The kind is read without narrowing so a future
        // request kind cannot make the exhaustiveness check fail the build.
        const kind: DaemonRequestKind = (request as { kind: DaemonRequestKind }).kind;
        return response(correlationId, "operation_unavailable", {
          operation: kind,
          summary: "This daemon build does not serve that operation yet.",
        });
      }
    }
  }

  return Object.freeze({ handle });
}

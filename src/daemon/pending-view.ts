/**
 * Shared server-owned views of a durable pending-operation record.
 *
 * These helpers exist so that EVERY signed path (open-edit, commit, and the
 * later verify/reconcile operations) projects a pending record into exactly one
 * canonical signed payload and one safe operator challenge. The signed
 * projection is security-relevant: a second, divergent implementation could
 * silently sign different bytes than the resolver verifies, so there is
 * deliberately only one.
 *
 * Nothing here is client-influenced. The projection contains only server-owned
 * facts and never credentials, tokens, pending intent, edit identity, digests
 * beyond the request digest, or raw Google payloads.
 */
import {
  encodeOperatorApprovalPayload,
  OPERATOR_APPROVAL_PROTOCOL_VERSION,
  type OperatorApprovalPayload,
} from "../runtime/approvals/operator-signature.js";
import type {
  PendingOperationRecord,
  PendingOperationStateName,
  PendingPrepareInput,
} from "./pending-store.js";
import {
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
  serializeDaemonResponse,
  type DaemonApprovalChallenge,
  type DaemonResponseEnvelope,
  type DaemonResponseOutcome,
} from "./protocol.js";

export function envelope(
  correlationId: string,
  outcome: DaemonResponseOutcome,
  extra: Omit<
    Partial<DaemonResponseEnvelope>,
    "protocolVersion" | "correlationId" | "outcome"
  > = {},
): DaemonResponseEnvelope {
  return Object.freeze({
    protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
    correlationId,
    outcome,
    ...extra,
  });
}

/** The exact signed projection of a server-owned pending record. */
type SignedRecord = Pick<
  PendingOperationRecord,
  | "requestId"
  | "nonce"
  | "toolName"
  | "permission"
  | "packageName"
  | "requestDigest"
  | "expiresAtUtc"
>;

export function approvalPayloadFor(record: SignedRecord): OperatorApprovalPayload {
  return {
    protocolVersion: OPERATOR_APPROVAL_PROTOCOL_VERSION,
    requestId: record.requestId,
    nonce: record.nonce,
    toolName: record.toolName,
    permission: record.permission,
    packageName: record.packageName,
    requestDigest: record.requestDigest,
    expiresAtUtc: record.expiresAtUtc,
  };
}

/**
 * Safe challenge metadata. No pending intent, no internal identities, no
 * credentials — only what a human needs to sign the canonical bytes.
 */
export function approvalChallengeFor(
  record: SignedRecord,
  statementCanonical: string,
): DaemonApprovalChallenge {
  return Object.freeze({
    approvalStatementVersion: 1 as const,
    approvalStatementCanonical: statementCanonical,
    requestId: record.requestId,
    toolName: record.toolName,
    permission: record.permission,
    packageName: record.packageName,
    requestDigest: record.requestDigest,
    expiresAtUtc: record.expiresAtUtc,
    canonicalPayload: encodeOperatorApprovalPayload(approvalPayloadFor(record)).toString("utf8"),
  });
}

/** Refuse impossible-to-deliver semantics BEFORE durable pending creation.
 * UUID36 and base64url nonce43 come from the unchanged store generators. The
 * longest canonical Date ISO expiry is27 bytes. That reserves six envelope
 * bytes beyond an ordinary24-byte expiry (which appears twice). No truncation.
 * Full JSON serialization accounts for statement double escaping and UTF8,
 * the exact summary/correlation and signed payload, not a note-only estimate.
 */
export function preflightApprovalResponse(
  correlationId: string,
  summary: string,
  statementCanonical: string,
  binding: Pick<PendingPrepareInput, "toolName" | "permission" | "packageName" | "requestDigest">,
): DaemonResponseEnvelope | undefined {
  try {
    serializeDaemonResponse(
      envelope(correlationId, "approval_required", {
        summary,
        approval: approvalChallengeFor(
          {
            ...binding,
            requestId: "00000000-0000-4000-8000-000000000000",
            nonce: "n".repeat(43),
            expiresAtUtc: "+100000-01-01T00:00:00.000Z",
          },
          statementCanonical,
        ),
      }),
    );
    return undefined;
  } catch {
    return envelope(correlationId, "local_state_failure", {
      error: {
        code: "APPROVAL_CHALLENGE_UNDELIVERABLE",
        message:
          "The complete approval statement or envelope is invalid or exceeds transport bounds; no pending request was created.",
      },
    });
  }
}

/**
 * Map a durable non-PENDING state onto its own protocol v5 outcome.
 *
 * TTL is enforced through the store's own state projection, which schema v2
 * deliberately orders so that RECOVERY_REQUIRED and COMPLETED always outrank
 * expiry. There is no second, competing expiry rule here.
 */
export function outcomeForNonPendingState(
  state: PendingOperationStateName,
  correlationId: string,
  requestId: string,
): DaemonResponseEnvelope | undefined {
  switch (state) {
    case "pending":
      return undefined;
    case "absent":
      return envelope(correlationId, "request_not_found", { requestId });
    case "expired":
      return envelope(correlationId, "approval_expired");
    case "claimed":
      return envelope(correlationId, "request_claim_held");
    case "consumed":
    case "completed":
      return envelope(correlationId, "request_already_consumed");
    case "recovery_required":
      return envelope(correlationId, "external_state_ambiguous");
  }
}

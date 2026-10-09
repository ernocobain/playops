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
import type { PendingOperationRecord, PendingOperationStateName } from "./pending-store.js";
import {
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
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
export function approvalPayloadFor(record: PendingOperationRecord): OperatorApprovalPayload {
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
export function approvalChallengeFor(record: PendingOperationRecord): DaemonApprovalChallenge {
  return Object.freeze({
    requestId: record.requestId,
    toolName: record.toolName,
    permission: record.permission,
    packageName: record.packageName,
    requestDigest: record.requestDigest,
    expiresAtUtc: record.expiresAtUtc,
    canonicalPayload: encodeOperatorApprovalPayload(approvalPayloadFor(record)).toString("utf8"),
  });
}

/**
 * Map a durable non-PENDING state onto its own protocol v4 outcome.
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

/**
 * Signature-backed production approval resolver (privilege-separated operator path).
 *
 * This is the external approval source for the existing approval gate. It does
 * NOT manufacture approval: it reproduces a detached Ed25519 signature the
 * operator produced off-host, and only after that signature verifies against the
 * exact server-owned challenge does it return an approved grant.
 *
 * Two independent conditions must both hold before a grant is issued:
 *
 *   1. The runtime approval request raised by `runAgent` must match the
 *      server-owned pending record and the signed payload field-for-field.
 *   2. The detached signature must verify against the canonical bytes of that
 *      payload under the pinned trust anchor.
 *
 * Any deviation is a denial. There is deliberately no fallback to `interactive`
 * or `token`, and no code path constructs an approved grant without a verified
 * signature.
 */
import type { NewAuditEntry } from "../audit/index.js";
import type { AgentApprovalResolver } from "../runtime/agent/index.js";
import type { ApprovalGrant, ApprovalLedger, ApprovalRequest } from "../runtime/approvals/index.js";
import type { ApprovalRecord } from "../runtime/permissions/index.js";
import type { PendingOperationRecord } from "./pending-store.js";
import {
  OPERATOR_APPROVAL_PROTOCOL_VERSION,
  type OperatorApprovalPayload,
  type OperatorApprovalVerifier,
} from "../runtime/approvals/operator-signature.js";

/** Audit actor for approval events: the approval authority is the operator. */
const ACTOR = "operator";

export type SignatureApprovalMismatchReason =
  | "REQUEST_TOOL_MISMATCH"
  | "REQUEST_PERMISSION_MISMATCH"
  | "REQUEST_DIGEST_MISMATCH"
  | "PENDING_TOOL_MISMATCH"
  | "PENDING_PERMISSION_MISMATCH"
  | "PENDING_DIGEST_MISMATCH"
  | "PENDING_REQUEST_ID_MISMATCH"
  | "PENDING_NONCE_MISMATCH"
  | "PENDING_PACKAGE_MISMATCH"
  | "PENDING_EXPIRY_MISMATCH";

export type SignatureApprovalMatch =
  { readonly ok: true } | { readonly ok: false; readonly reason: SignatureApprovalMismatchReason };

const GATED_LEVELS: readonly string[] = Object.freeze(["destructive", "publish"]);

/**
 * Prove that the runtime approval request, the signed payload and the
 * server-owned pending record all describe the same operation. Pure and
 * side-effect free so it can be asserted directly.
 */
export function matchSignatureApproval(
  request: ApprovalRequest,
  payload: OperatorApprovalPayload,
  pending: PendingOperationRecord,
): SignatureApprovalMatch {
  if (!GATED_LEVELS.includes(request.permission))
    return { ok: false, reason: "REQUEST_PERMISSION_MISMATCH" };
  if (request.toolName !== payload.toolName) return { ok: false, reason: "REQUEST_TOOL_MISMATCH" };
  if (request.permission !== payload.permission)
    return { ok: false, reason: "REQUEST_PERMISSION_MISMATCH" };
  if (request.requestDigest !== payload.requestDigest)
    return { ok: false, reason: "REQUEST_DIGEST_MISMATCH" };

  if (pending.toolName !== payload.toolName) return { ok: false, reason: "PENDING_TOOL_MISMATCH" };
  if (pending.permission !== payload.permission)
    return { ok: false, reason: "PENDING_PERMISSION_MISMATCH" };
  if (pending.requestDigest !== payload.requestDigest)
    return { ok: false, reason: "PENDING_DIGEST_MISMATCH" };
  if (pending.requestId !== payload.requestId)
    return { ok: false, reason: "PENDING_REQUEST_ID_MISMATCH" };
  if (pending.nonce !== payload.nonce) return { ok: false, reason: "PENDING_NONCE_MISMATCH" };
  if (pending.packageName !== payload.packageName)
    return { ok: false, reason: "PENDING_PACKAGE_MISMATCH" };
  if (pending.expiresAtUtc !== payload.expiresAtUtc)
    return { ok: false, reason: "PENDING_EXPIRY_MISMATCH" };
  if (payload.protocolVersion !== OPERATOR_APPROVAL_PROTOCOL_VERSION) {
    return { ok: false, reason: "REQUEST_PERMISSION_MISMATCH" };
  }
  return { ok: true };
}

export interface SignatureApprovalResolverInput {
  readonly verifier: OperatorApprovalVerifier;
  /** Server-owned pending operation the signature was requested against. */
  readonly pending: PendingOperationRecord;
  /** Canonical payload the operator signed; must project the pending record. */
  readonly payload: OperatorApprovalPayload;
  /** Detached base64url Ed25519 signature over the canonical payload bytes. */
  readonly signature: string;
  readonly ledger: ApprovalLedger;
  readonly now?: () => Date;
  /**
   * Durable consumption seam.
   *
   * Awaited AFTER the signature is verified and BEFORE the approved grant is
   * returned, so the caller can record that the pending request has been
   * consumed while it is still impossible for the mutating tool to have run.
   *
   * If this rejects, the resolver denies: `runAgent` aborts and the tool is
   * never invoked. The hook can only ever withhold approval, never grant it, so
   * it cannot weaken the signature requirement.
   */
  readonly onApprovalConsumed?: () => Promise<void>;
}

function deniedRecord(request: ApprovalRequest): ApprovalRecord {
  return Object.freeze({
    toolName: request.toolName,
    permission: request.permission,
    decision: "denied",
  });
}

function approvedRecord(request: ApprovalRequest): ApprovalRecord {
  return Object.freeze({
    toolName: request.toolName,
    permission: request.permission,
    decision: "approved",
  });
}

/**
 * Build the `operator_signature` approval source.
 *
 * The returned resolver is the only thing that can produce an approved grant on
 * this path. It records its true provenance, and it never records the signature
 * bytes themselves (only that verification succeeded).
 */
export function createOperatorSignatureApprovalResolver(
  input: SignatureApprovalResolverInput,
): AgentApprovalResolver {
  const clock = input.now ?? ((): Date => new Date());

  const append = (
    request: ApprovalRequest,
    type: "approval.approved" | "approval.consumed" | "approval.denied",
    status: NewAuditEntry["status"],
    extra: Record<string, unknown>,
  ): void => {
    input.ledger.append({
      type,
      actor: ACTOR,
      action: request.toolName,
      status,
      timestamp: clock().toISOString(),
      metadata: {
        requestId: request.requestId,
        toolName: request.toolName,
        permission: request.permission,
        requestDigest: request.requestDigest,
        source: "operator_signature",
        ...extra,
      },
    });
  };

  return {
    resolve: async (request: ApprovalRequest): Promise<ApprovalGrant> => {
      const match = matchSignatureApproval(request, input.payload, input.pending);
      if (!match.ok) {
        append(request, "approval.denied", "denied", { reason: match.reason });
        return Object.freeze({
          record: deniedRecord(request),
          requestId: request.requestId,
          requestDigest: request.requestDigest,
          source: "operator_signature" as const,
        });
      }
      if (!input.verifier.verify(input.payload, input.signature)) {
        append(request, "approval.denied", "denied", { reason: "SIGNATURE_INVALID" });
        return Object.freeze({
          record: deniedRecord(request),
          requestId: request.requestId,
          requestDigest: request.requestDigest,
          source: "operator_signature" as const,
        });
      }
      // Durable consumption seam: record consumption while the tool still cannot
      // have run. Failure denies the approval, so execution aborts.
      if (input.onApprovalConsumed !== undefined) {
        try {
          await input.onApprovalConsumed();
        } catch {
          append(request, "approval.denied", "denied", {
            reason: "APPROVAL_CONSUMPTION_FAILED",
          });
          return Object.freeze({
            record: deniedRecord(request),
            requestId: request.requestId,
            requestDigest: request.requestDigest,
            source: "operator_signature" as const,
          });
        }
      }
      append(request, "approval.approved", "success", { signatureVerified: true });
      append(request, "approval.consumed", "success", { signatureVerified: true });
      return Object.freeze({
        record: approvedRecord(request),
        requestId: request.requestId,
        requestDigest: request.requestDigest,
        source: "operator_signature" as const,
      });
    },
  };
}

/**
 * Approval gate (Phase 2.3).
 *
 * Human-approval boundary for tools whose Phase 2.2 decision is
 * APPROVAL_REQUIRED. Produces Phase 2.2 `ApprovalRecord`s bound to one exact
 * request; never executes tools, never stores raw tokens.
 *
 * Ledger = the existing append-only audit log (Phase 0.6). Token state is
 * reconstructed from safe events; only a SHA-256 digest of the token is stored.
 */
import {
  createHash,
  randomBytes as nodeRandomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  appendAuditEntry,
  AuditError,
  readAuditEntries,
  type AuditEntry,
  type NewAuditEntry,
} from "../../audit/index.js";
import type { ApprovalRecord } from "../permissions/index.js";
import type { ToolPermissionLevel } from "../tools/index.js";

/** Conservative default: an approval challenge is valid for 10 minutes. */
export const APPROVAL_TOKEN_TTL_MS = 10 * 60 * 1000;

/** Only these levels are gated (mirrors Phase 2.2 policy). */
const CHALLENGEABLE: ReadonlySet<ToolPermissionLevel> = new Set(["destructive", "publish"]);

const ACTOR = "operator";
const TOKEN_BYTES = 32; // 256 bits

export type ApprovalGateErrorCode =
  | "INVALID_REQUEST"
  | "TOKEN_INVALID"
  | "TOKEN_EXPIRED"
  | "TOKEN_ALREADY_USED"
  | "TOKEN_REQUEST_MISMATCH"
  | "CLI_ARGUMENT_INVALID"
  | "AUDIT_FAILURE";

/** Messages are fixed strings; they never carry tokens or request input. */
export class ApprovalGateError extends Error {
  override readonly name = "ApprovalGateError";
  constructor(
    readonly code: ApprovalGateErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface ApprovalRequestInput {
  readonly toolName: string;
  readonly permission: ToolPermissionLevel;
  /** Caller-provided digest of a *safe* canonical request representation. */
  readonly requestDigest: string;
  /** Caller-provided human-readable text shown to the operator. */
  readonly safeSummary: string;
}

export interface ApprovalRequest extends ApprovalRequestInput {
  readonly requestId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type ApprovalSource = "interactive" | "token" | "operator_signature";

export interface ApprovalGrant {
  readonly record: ApprovalRecord;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly source: ApprovalSource;
}

export interface ApprovalChallenge {
  readonly requestId: string;
  /** Show once; never persist or log. */
  readonly rawToken: string;
  readonly proofDigest: string;
  readonly expiresAt: string;
}

export interface ApprovalPrompt {
  ask(text: string): Promise<string>;
}

/** Storage boundary: an append-only ledger of audit entries. */
export interface ApprovalLedger {
  append(entry: NewAuditEntry): void;
  read(): readonly AuditEntry[];
}

export interface ApprovalGateDeps {
  readonly ledger: ApprovalLedger;
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Buffer;
  readonly requestId?: () => string;
}

export function createFileApprovalLedger(logPath: string): ApprovalLedger {
  return {
    append: (entry) => {
      appendAuditEntry(logPath, entry);
    },
    read: () => readAuditEntries(logPath),
  };
}

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

function nowOf(deps: ApprovalGateDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function digestToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

function digestsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

function withLedger<T>(fn: () => T): T {
  try {
    return fn();
  } catch (cause) {
    if (cause instanceof AuditError) {
      throw new ApprovalGateError("AUDIT_FAILURE", "Approval ledger operation failed", { cause });
    }
    throw cause;
  }
}

function append(
  deps: ApprovalGateDeps,
  request: ApprovalRequest,
  type: string,
  status: NewAuditEntry["status"],
  extra: Record<string, unknown> = {},
): void {
  withLedger(() =>
    deps.ledger.append({
      type,
      actor: ACTOR,
      action: request.toolName,
      status,
      timestamp: nowOf(deps).toISOString(),
      metadata: {
        requestId: request.requestId,
        toolName: request.toolName,
        permission: request.permission,
        requestDigest: request.requestDigest,
        ...extra,
      },
    }),
  );
}

function recordFor(request: ApprovalRequest, decision: ApprovalRecord["decision"]): ApprovalRecord {
  return Object.freeze({ toolName: request.toolName, permission: request.permission, decision });
}

function grant(
  request: ApprovalRequest,
  source: ApprovalSource,
  decision: ApprovalRecord["decision"],
): ApprovalGrant {
  return Object.freeze({
    record: recordFor(request, decision),
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    source,
  });
}

/** Validate and register one exact requested destructive/publish action. */
export function createApprovalRequest(
  input: ApprovalRequestInput,
  deps: ApprovalGateDeps,
): ApprovalRequest {
  if (typeof input !== "object" || input === null) {
    throw new ApprovalGateError("INVALID_REQUEST", "Approval request must be an object");
  }
  if (isBlank(input.toolName))
    throw new ApprovalGateError("INVALID_REQUEST", "toolName is required");
  if (!CHALLENGEABLE.has(input.permission)) {
    throw new ApprovalGateError(
      "INVALID_REQUEST",
      "Only destructive/publish tools require approval",
    );
  }
  if (isBlank(input.requestDigest))
    throw new ApprovalGateError("INVALID_REQUEST", "requestDigest is required");
  if (isBlank(input.safeSummary))
    throw new ApprovalGateError("INVALID_REQUEST", "safeSummary is required");

  const created = nowOf(deps);
  const request: ApprovalRequest = Object.freeze({
    requestId: deps.requestId ? deps.requestId() : randomUUID(),
    toolName: input.toolName,
    permission: input.permission,
    requestDigest: input.requestDigest,
    safeSummary: input.safeSummary,
    createdAt: created.toISOString(),
    expiresAt: new Date(created.getTime() + APPROVAL_TOKEN_TTL_MS).toISOString(),
  });
  append(deps, request, "approval.requested", "pending", { expiresAt: request.expiresAt });
  return request;
}

/** Issue an opaque single-use token for `request`; only its digest is recorded. */
export function createApprovalChallenge(
  request: ApprovalRequest,
  deps: ApprovalGateDeps,
): ApprovalChallenge {
  const bytes = (deps.randomBytes ?? nodeRandomBytes)(TOKEN_BYTES);
  const rawToken = Buffer.from(bytes).toString("base64url");
  const proofDigest = digestToken(rawToken);
  append(deps, request, "approval.challenged", "pending", {
    proofDigest,
    expiresAt: request.expiresAt,
  });
  return Object.freeze({
    requestId: request.requestId,
    rawToken,
    proofDigest,
    expiresAt: request.expiresAt,
  });
}

const AFFIRMATIVE = new Set(["y", "yes"]);

/** Ask the operator; anything other than y/yes (case-insensitive) is a denial. */
export async function approveInteractively(
  request: ApprovalRequest,
  prompt: ApprovalPrompt,
  deps: ApprovalGateDeps,
): Promise<ApprovalGrant> {
  const text =
    `Approval required\n` +
    `  Tool:       ${request.toolName}\n` +
    `  Permission: ${request.permission}\n` +
    `  Action:     ${request.safeSummary}\n` +
    `Proceed? [y/N] `;
  const answer = await prompt.ask(text);
  const approved = AFFIRMATIVE.has(String(answer).trim().toLowerCase());
  if (approved) {
    append(deps, request, "approval.approved", "success", { source: "interactive" });
    return grant(request, "interactive", "approved");
  }
  append(deps, request, "approval.denied", "denied", { source: "interactive" });
  return grant(request, "interactive", "denied");
}

interface ChallengeState {
  request: { requestId: string; toolName: string; permission: string; requestDigest: string };
  expiresAt: string;
  consumed: boolean;
}

function meta(entry: AuditEntry, key: string): string | undefined {
  const value = entry.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Reconstruct the state of the challenge whose stored digest matches `proofDigest`. */
function findChallenge(
  entries: readonly AuditEntry[],
  proofDigest: string,
): ChallengeState | undefined {
  let state: ChallengeState | undefined;
  for (const entry of entries) {
    if (entry.type === "approval.challenged") {
      const stored = meta(entry, "proofDigest");
      if (stored !== undefined && digestsEqual(stored, proofDigest)) {
        state = {
          request: {
            requestId: meta(entry, "requestId") ?? "",
            toolName: meta(entry, "toolName") ?? "",
            permission: meta(entry, "permission") ?? "",
            requestDigest: meta(entry, "requestDigest") ?? "",
          },
          expiresAt: meta(entry, "expiresAt") ?? "",
          consumed: false,
        };
      }
    } else if (state && entry.type === "approval.consumed") {
      const stored = meta(entry, "proofDigest");
      if (stored !== undefined && digestsEqual(stored, proofDigest)) state.consumed = true;
    }
  }
  return state;
}

/**
 * Validate a presented raw token against the ledger for exactly `request`.
 * On success appends approved + consumed events and returns a grant.
 *
 * Limitation: consumption is check-then-append on an append-only file without
 * cross-process locking; two concurrent processes presenting the same token in
 * the same instant could both pass. Single-operator CLI scope accepts this and
 * documents it in PLAYOPS_PLAN.md.
 */
export function resolveApprovalToken(
  request: ApprovalRequest,
  rawToken: string,
  deps: ApprovalGateDeps,
): ApprovalGrant {
  if (isBlank(rawToken))
    throw new ApprovalGateError("TOKEN_INVALID", "Approval token is missing or blank");
  const proofDigest = digestToken(rawToken.trim());
  const entries = withLedger(() => deps.ledger.read());
  const state = findChallenge(entries, proofDigest);
  if (!state) throw new ApprovalGateError("TOKEN_INVALID", "Approval token not recognized");

  const bound = state.request;
  if (
    bound.requestId !== request.requestId ||
    bound.toolName !== request.toolName ||
    bound.permission !== request.permission ||
    bound.requestDigest !== request.requestDigest
  ) {
    throw new ApprovalGateError(
      "TOKEN_REQUEST_MISMATCH",
      "Approval token is bound to a different request",
    );
  }
  if (state.consumed)
    throw new ApprovalGateError("TOKEN_ALREADY_USED", "Approval token already consumed");

  const expiresMs = Date.parse(state.expiresAt);
  if (Number.isNaN(expiresMs) || nowOf(deps).getTime() >= expiresMs) {
    append(deps, request, "approval.expired", "denied", { proofDigest, source: "token" });
    throw new ApprovalGateError("TOKEN_EXPIRED", "Approval token has expired");
  }

  append(deps, request, "approval.approved", "success", { proofDigest, source: "token" });
  append(deps, request, "approval.consumed", "success", { proofDigest, source: "token" });
  return grant(request, "token", "approved");
}

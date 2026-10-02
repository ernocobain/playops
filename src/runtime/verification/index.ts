/**
 * Verification model (Phase 2.4).
 *
 * Post-action read-back confirmation for a tool that has ALREADY executed.
 * Answers one question: did the resulting state match expectations?
 *
 * Policy (intentional, fail closed): `read` → verification optional;
 * `write` / `destructive` / `publish` → verification REQUIRED. A mutating tool
 * without a verifier can never be reported as verified.
 *
 * This module never calls `execute`, never touches permissions or approvals,
 * never retries, and records only safe metadata in the existing audit log.
 * It expects already-validated `input`/`output` (the future executor parses
 * through the Phase 2.1 schemas); it does not re-parse.
 */
import { appendAuditEntry, AuditError, type NewAuditEntry } from "../../audit/index.js";
import {
  TOOL_PERMISSION_LEVELS,
  type ToolContext,
  type ToolDefinition,
  type ToolPermissionLevel,
} from "../tools/index.js";

export type VerificationStatus = "passed" | "failed" | "skipped" | "error";

export type VerificationCode =
  | "VERIFIED"
  | "VERIFICATION_FAILED"
  | "VERIFIER_REQUIRED"
  | "VERIFIER_ERROR"
  | "VERIFICATION_SKIPPED"
  | "INVALID_TOOL";

export interface VerificationResult {
  readonly toolName: string;
  /** `null` when the tool declared an unsupported level (fail closed). */
  readonly permission: ToolPermissionLevel | null;
  readonly required: boolean;
  readonly status: VerificationStatus;
  readonly code: VerificationCode;
  /** True iff `code === "VERIFIED"`. */
  readonly verified: boolean;
}

/** Safe correlation supplied explicitly by the caller (never derived from input). */
export interface VerificationCorrelation {
  readonly requestId?: string;
  readonly requestDigest?: string;
}

/** The already-executed outcome to verify. */
export interface VerificationSubject<Input, Output> {
  readonly tool: ToolDefinition<Input, Output>;
  readonly input: Input;
  readonly output: Output;
  readonly context: ToolContext;
}

/** Minimal append boundary over the Phase 0.6 audit log. */
export interface VerificationLedger {
  append(entry: NewAuditEntry): Promise<void>;
}

export interface VerificationDeps {
  readonly ledger: VerificationLedger;
  readonly correlation?: VerificationCorrelation;
}

export type VerificationErrorCode = "AUDIT_FAILURE";

/** Infrastructure failure only; messages are fixed strings, cause kept programmatically. */
export class VerificationError extends Error {
  override readonly name = "VerificationError";
  constructor(
    readonly code: VerificationErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export const VERIFICATION_EVENT = "verification.completed";
const ACTOR = "system";
const OPTIONAL_LEVELS: ReadonlySet<ToolPermissionLevel> = new Set(["read"]);

export function createFileVerificationLedger(logPath: string): VerificationLedger {
  return {
    append: async (entry) => {
      await appendAuditEntry(logPath, entry);
    },
  };
}

function isLevel(value: unknown): value is ToolPermissionLevel {
  return TOOL_PERMISSION_LEVELS.some((level) => level === value);
}

function result(
  toolName: string,
  permission: ToolPermissionLevel | null,
  required: boolean,
  status: VerificationStatus,
  code: VerificationCode,
): VerificationResult {
  return Object.freeze({
    toolName,
    permission,
    required,
    status,
    code,
    verified: code === "VERIFIED",
  });
}

/** Structural check at the untyped boundary; anything odd fails closed as INVALID_TOOL. */
function inspectTool(tool: unknown):
  | {
      ok: true;
      name: string;
      permission: ToolPermissionLevel;
      verify: ((...args: never[]) => Promise<boolean>) | undefined;
    }
  | { ok: false; name: string; permission: ToolPermissionLevel | null } {
  if (typeof tool !== "object" || tool === null) return { ok: false, name: "", permission: null };
  const name = Reflect.get(tool, "name");
  const permission = Reflect.get(tool, "permission");
  const verify = Reflect.get(tool, "verify");
  const safeName = typeof name === "string" ? name : "";
  const safeLevel = isLevel(permission) ? permission : null;
  if (!safeName.trim() || safeLevel === null)
    return { ok: false, name: safeName, permission: safeLevel };
  if (verify !== undefined && typeof verify !== "function") {
    return { ok: false, name: safeName, permission: safeLevel };
  }
  return { ok: true, name: safeName, permission: safeLevel, verify: verify as never };
}

async function decide<Input, Output>(
  subject: VerificationSubject<Input, Output>,
): Promise<VerificationResult> {
  const inspected = inspectTool(subject.tool);
  if (!inspected.ok)
    return result(inspected.name, inspected.permission, true, "failed", "INVALID_TOOL");
  const { name, permission } = inspected;
  const required = !OPTIONAL_LEVELS.has(permission);
  // Only here do we call the typed verifier; the definition's own generics carry Input/Output.
  const verify = subject.tool.verify;
  if (!verify) {
    return required
      ? result(name, permission, true, "failed", "VERIFIER_REQUIRED")
      : result(name, permission, false, "skipped", "VERIFICATION_SKIPPED");
  }
  let outcome: unknown;
  try {
    outcome = await verify(subject.input, subject.output, subject.context);
  } catch {
    // Raw error intentionally dropped from result/audit; a verifier failure is not a secret channel.
    return result(name, permission, required, "error", "VERIFIER_ERROR");
  }
  if (outcome === true) return result(name, permission, required, "passed", "VERIFIED");
  if (outcome === false) return result(name, permission, required, "failed", "VERIFICATION_FAILED");
  return result(name, permission, required, "error", "VERIFIER_ERROR");
}

function toAuditEntry(
  r: VerificationResult,
  correlation: VerificationCorrelation | undefined,
): NewAuditEntry {
  const metadata: Record<string, unknown> = {
    toolName: r.toolName,
    permission: r.permission,
    required: r.required,
    status: r.status,
    code: r.code,
  };
  if (typeof correlation?.requestId === "string" && correlation.requestId.trim()) {
    metadata.requestId = correlation.requestId;
  }
  if (typeof correlation?.requestDigest === "string" && correlation.requestDigest.trim()) {
    metadata.requestDigest = correlation.requestDigest;
  }
  return {
    type: VERIFICATION_EVENT,
    actor: ACTOR,
    action: r.toolName || "unknown",
    status: r.verified || r.code === "VERIFICATION_SKIPPED" ? "success" : "failure",
    metadata,
  };
}

/**
 * Verify an already-executed tool outcome and record the result.
 * Normal outcomes are results; only audit failure throws (`AUDIT_FAILURE`).
 */
export async function verifyToolOutcome<Input, Output>(
  subject: VerificationSubject<Input, Output>,
  deps: VerificationDeps,
): Promise<VerificationResult> {
  const r = await decide(subject);
  try {
    await deps.ledger.append(toAuditEntry(r, deps.correlation));
  } catch (cause) {
    const detail = cause instanceof AuditError ? ` (${cause.code})` : "";
    throw new VerificationError(
      "AUDIT_FAILURE",
      `Verification audit record could not be written${detail}`,
      {
        cause,
      },
    );
  }
  return r;
}

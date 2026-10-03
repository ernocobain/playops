/**
 * Phase 5.1 — PlayOps-owned App Health error model.
 *
 * Deterministic, provider-neutral codes. Google/Reporting failures are always
 * carried as a preserved `cause` (programmatically available, never serialized),
 * so no raw Google object, token, key or transport detail reaches tool output.
 */
export type HealthErrorCode =
  | "INVALID_ARGUMENT"
  | "REMOTE_DATA_INVALID"
  | "PAGINATION_LOOP"
  | "MAX_PAGES_EXCEEDED"
  | "SOURCE_FAILED"
  | "ALERT_AUDIT_FAILED"
  | "INCOMPATIBLE_WINDOWS"
  | "DUPLICATE_IDENTITY"
  | "INVALID_DECIMAL";

export class HealthError extends Error {
  override readonly name = "HealthError";

  constructor(
    message: string,
    readonly code: HealthErrorCode,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

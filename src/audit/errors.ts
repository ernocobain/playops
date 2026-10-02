/**
 * Audit module error types (Phase 0.6).
 */
export class AuditError extends Error {
  override readonly name = "AuditError";

  constructor(
    message: string,
    readonly code: "AUDIT_MALFORMED_LINE" | "AUDIT_WRITE_FAILED" | "AUDIT_READ_FAILED",
    /** 1-based line number in the log file, when the failure is line-specific. */
    readonly line?: number,
  ) {
    super(message);
  }
}

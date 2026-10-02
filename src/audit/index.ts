/**
 * Public surface of the PlayOps audit module (Phase 0.6).
 * Generic JSONL storage layer only — no runtime/permission/approval logic.
 */
export { appendAuditEntry, readAuditEntries } from "./log.js";
export { sanitizeAuditMetadata, REDACTED } from "./sanitize.js";
export { AuditError } from "./errors.js";
export type { AuditEntry, AuditStatus, NewAuditEntry } from "./types.js";

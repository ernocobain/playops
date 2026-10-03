/**
 * Append-only JSONL audit log writer/reader (Phase 0.6).
 *
 * Storage format: UTF-8 JSON Lines — exactly one complete JSON object per
 * line, newline-terminated. Writes only ever append; the file is never
 * truncated, rewritten, or compacted by this module.
 */
import { appendFileSync, mkdirSync, openSync, closeSync, readFileSync, fsyncSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { AuditError } from "./errors.js";
import { sanitizeAuditMetadata } from "./sanitize.js";
import type { AuditEntry, NewAuditEntry } from "./types.js";

/**
 * Append one entry to the audit log.
 *
 * - Creates the parent directory and the file when missing.
 * - Appends a single newline-terminated JSON line; never truncates.
 * - Metadata is sanitized (secrets redacted) before writing.
 * - Returns the entry exactly as written (id/timestamp filled in).
 * - Optional durable mode (Phase 5.4): fsync the file and its containing directory
 *   before returning. Unsupported/failed sync fails closed with AUDIT_WRITE_FAILED.
 *   Ordinary runtime audit calls retain their established behavior. This is not
 *   a multi-entry transaction or a guarantee about newly-created ancestor directories.
 */
export function appendAuditEntry(
  logPath: string,
  entry: NewAuditEntry,
  options: { readonly durable?: boolean } = {},
): AuditEntry {
  const written: AuditEntry = {
    id: randomUUID(),
    timestamp: entry.timestamp ?? new Date().toISOString(),
    type: entry.type,
    actor: entry.actor,
    action: entry.action,
    status: entry.status,
    ...(entry.metadata !== undefined ? { metadata: sanitizeAuditMetadata(entry.metadata) } : {}),
  };

  const line = `${JSON.stringify(written)}\n`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    // O_APPEND guarantees append semantics; the file is created if absent.
    const fd = openSync(logPath, "a");
    try {
      appendFileSync(fd, line, "utf8");
      if (options.durable) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (options.durable) {
      const directory = openSync(dirname(logPath), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  } catch (cause) {
    throw new AuditError(
      `Failed to append audit entry to ${logPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      "AUDIT_WRITE_FAILED",
    );
  }
  return written;
}

/**
 * Read all entries in file order.
 *
 * - Missing file → empty list (intentional: nothing has been audited yet).
 * - Empty file → empty list.
 * - Any line that is not valid JSON → AuditError(AUDIT_MALFORMED_LINE, line=N).
 */
export function readAuditEntries(logPath: string): AuditEntry[] {
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new AuditError(
      `Failed to read audit log ${logPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      "AUDIT_READ_FAILED",
    );
  }

  if (text.length === 0) return [];

  const entries: AuditEntry[] = [];
  const lines = text.split("\n");
  // A trailing newline produces a final empty segment; skip blank segments but
  // keep true line numbering (1-based) for errors.
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    if (raw === undefined || raw.trim() === "") continue;
    try {
      entries.push(JSON.parse(raw) as AuditEntry);
    } catch {
      throw new AuditError(
        `Malformed JSONL in ${logPath} at line ${index + 1}`,
        "AUDIT_MALFORMED_LINE",
        index + 1,
      );
    }
  }
  return entries;
}

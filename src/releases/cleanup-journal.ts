/**
 * Phase 4.15 — durable cleanup journal for KNOWN ephemeral Play edits.
 *
 * WHY THIS EXISTS: Phase 4.11/4.12/4.13 create one temporary verification edit,
 * hold its id only in a local variable, and delete it at the end of the same run.
 * If that delete fails, the run returns `*_VERIFICATION_CLEANUP_FAILED` and the
 * leftover `editId` is lost — PlayOps can never name the abandoned edit again.
 * Google exposes no "list my active edits" operation, so a lost id is
 * unrecoverable. This journal persists the exact id (and only that) immediately
 * after a trustworthy insert response, and removes it only after a confirmed
 * delete.
 *
 * SCOPE: local bookkeeping only. The journal never calls Google, never performs a
 * delete, and never decides whether an edit is inactive.
 *
 * Storage: caller-supplied path, Node built-ins only, atomic replace
 * (temp file → fsync → rename) so a partially written file can never become the
 * accepted journal. Malformed or unsupported state fails safely and is never
 * silently overwritten, and a journal bound to another package is refused.
 *
 * CONCURRENCY LIMITATION (single-process, single-operator CLI): atomic
 * replacement protects against torn files; it does NOT provide multi-process
 * distributed locking. No lock or database is introduced.
 *
 * IRREDUCIBLE WINDOW (honest): Google may accept `edits.insert` while the process
 * dies before a trustworthy editId is received and persisted here. No
 * `edits.list` exists, so PlayOps cannot reconstruct that remote identity
 * afterwards. Phase 4.15 does not remove this API-level limitation.
 */
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import {
  compareEpochSeconds,
  parseEpochSeconds,
  parseGooglePlayEditSession,
  ReleaseError,
  validateReleasePackageName,
} from "./index.js";

export const RELEASE_EDIT_CLEANUP_JOURNAL_VERSION = 1 as const;

/** Closed purpose enum: every entry has to say why PlayOps created that edit. */
export const RELEASE_EDIT_CLEANUP_JOURNAL_SOURCES = Object.freeze([
  "exact_release_verification",
  "rollout_verification",
  "status_control_verification",
] as const);

export type ReleaseEditCleanupJournalSource = (typeof RELEASE_EDIT_CLEANUP_JOURNAL_SOURCES)[number];

/** One durable record; contains no credential, token, note, Track, or approval data. */
export interface ReleaseEditCleanupJournalRecord {
  readonly version: typeof RELEASE_EDIT_CLEANUP_JOURNAL_VERSION;
  readonly packageName: string;
  readonly editId: string;
  /** Lossless decimal string, compared with `BigInt` (never floating point). */
  readonly expiryTimeSeconds: string;
  /** Closed purpose enum; never free-form text. */
  readonly source: ReleaseEditCleanupJournalSource;
  /** Local timestamp (ISO-8601) for diagnostics only. */
  readonly createdAt: string;
}

export interface ReleaseEditCleanupJournalEntryInput {
  readonly editId: string;
  readonly expiryTimeSeconds: string;
  readonly source: ReleaseEditCleanupJournalSource;
  readonly createdAt: string;
}

export interface ReleaseEditCleanupJournal {
  /** All records for the bound package; `[]` when no journal file exists yet. */
  list(): Promise<readonly ReleaseEditCleanupJournalRecord[]>;
  /** Atomically records exactly one edit id (replacing an identical existing id). */
  record(entry: ReleaseEditCleanupJournalEntryInput): Promise<void>;
  /** Removes exactly one edit id; a missing id is a no-op. */
  remove(editId: string): Promise<void>;
}

export interface ReleaseEditCleanupJournalOptions {
  /** Composition-bound package; records for another application are refused. */
  readonly expectedPackageName?: string;
}

interface JournalFile {
  readonly version: typeof RELEASE_EDIT_CLEANUP_JOURNAL_VERSION;
  readonly packageName: string;
  readonly records: readonly ReleaseEditCleanupJournalRecord[];
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function isJournalSource(value: unknown): value is ReleaseEditCleanupJournalSource {
  return RELEASE_EDIT_CLEANUP_JOURNAL_SOURCES.some((source) => source === value);
}

function invalidJournal(): ReleaseError {
  return new ReleaseError(
    "EDIT_CLEANUP_JOURNAL_INVALID",
    "The tracked Play edit cleanup journal is invalid.",
  );
}

/** Structural validation of untrusted persisted state; nothing is guessed around. */
function parseJournalFile(value: unknown, expectedPackageName: string): JournalFile {
  if (!isRecord(value)) throw invalidJournal();
  const allowedKeys = new Set(["version", "packageName", "records"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw invalidJournal();
  if (value.version !== RELEASE_EDIT_CLEANUP_JOURNAL_VERSION) throw invalidJournal();
  if (typeof value.packageName !== "string") throw invalidJournal();
  if (value.packageName !== expectedPackageName) {
    throw new ReleaseError(
      "EDIT_CLEANUP_JOURNAL_PACKAGE_MISMATCH",
      "The tracked Play edit cleanup journal belongs to a different package.",
    );
  }
  if (!Array.isArray(value.records)) throw invalidJournal();
  const seen = new Set<string>();
  const records = value.records.map((record: unknown) => {
    if (!isRecord(record)) throw invalidJournal();
    const recordKeys = new Set([
      "version",
      "packageName",
      "editId",
      "expiryTimeSeconds",
      "source",
      "createdAt",
    ]);
    if (Object.keys(record).some((key) => !recordKeys.has(key))) throw invalidJournal();
    if (record.version !== RELEASE_EDIT_CLEANUP_JOURNAL_VERSION) throw invalidJournal();
    if (record.packageName !== expectedPackageName) throw invalidJournal();
    if (!isJournalSource(record.source)) throw invalidJournal();
    if (!isCanonicalIsoTimestamp(record.createdAt)) throw invalidJournal();
    let editId: string;
    let expiryTimeSeconds: string;
    try {
      const session = parseGooglePlayEditSession(
        {
          packageName: expectedPackageName,
          editId: record.editId,
          expiryTimeSeconds: record.expiryTimeSeconds,
        },
        expectedPackageName,
      );
      editId = session.editId;
      expiryTimeSeconds = parseEpochSeconds(record.expiryTimeSeconds);
    } catch (cause) {
      throw new ReleaseError(
        "EDIT_CLEANUP_JOURNAL_INVALID",
        "The tracked Play edit cleanup journal is invalid.",
        { cause },
      );
    }
    if (seen.has(editId)) throw invalidJournal();
    seen.add(editId);
    return Object.freeze({
      version: RELEASE_EDIT_CLEANUP_JOURNAL_VERSION,
      packageName: expectedPackageName,
      editId,
      expiryTimeSeconds,
      source: record.source,
      createdAt: record.createdAt,
    });
  });
  return Object.freeze({
    version: RELEASE_EDIT_CLEANUP_JOURNAL_VERSION,
    packageName: expectedPackageName,
    records: Object.freeze(records),
  });
}

/**
 * File-backed journal. The caller/composition supplies the path; nothing here
 * reads configuration, credentials, or environment state.
 */
export function createFileReleaseEditCleanupJournal(
  path: string,
  options: ReleaseEditCleanupJournalOptions = {},
): ReleaseEditCleanupJournal {
  if (typeof path !== "string" || path.trim() === "") {
    throw new ReleaseError(
      "INVALID_ARGUMENT",
      "Edit cleanup journal path must be a non-empty string.",
    );
  }
  const boundPackageName = validateReleasePackageName(options?.expectedPackageName);

  const read = async (): Promise<JournalFile> => {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (cause) {
      if (isErrnoCode(cause, "ENOENT")) {
        return Object.freeze({
          version: RELEASE_EDIT_CLEANUP_JOURNAL_VERSION,
          packageName: boundPackageName,
          records: Object.freeze([]),
        });
      }
      throw new ReleaseError(
        "EDIT_CLEANUP_JOURNAL_READ_FAILED",
        "The tracked Play edit cleanup journal could not be read.",
        { cause },
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (cause) {
      throw new ReleaseError(
        "EDIT_CLEANUP_JOURNAL_INVALID",
        "The tracked Play edit cleanup journal is not valid JSON.",
        { cause },
      );
    }
    return parseJournalFile(json, boundPackageName);
  };

  const write = async (file: JournalFile): Promise<void> => {
    const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      // Phase 6.5: owner-only temp file and owner-only PlayOps-created parent.
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const handle = await open(tempPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, path);
    } catch (cause) {
      await unlink(tempPath).catch(() => undefined);
      throw new ReleaseError(
        "EDIT_CLEANUP_JOURNAL_WRITE_FAILED",
        "The tracked Play edit cleanup journal could not be written.",
        { cause },
      );
    }
  };

  return Object.freeze({
    async list(): Promise<readonly ReleaseEditCleanupJournalRecord[]> {
      return (await read()).records;
    },

    async record(entry: ReleaseEditCleanupJournalEntryInput): Promise<void> {
      if (!isRecord(entry) || !isJournalSource(entry.source)) {
        throw new ReleaseError("INVALID_ARGUMENT", "Edit cleanup journal entry is invalid.");
      }
      if (!isCanonicalIsoTimestamp(entry.createdAt)) {
        throw new ReleaseError(
          "INVALID_ARGUMENT",
          "Edit cleanup journal entry timestamp is invalid.",
        );
      }
      let session;
      try {
        session = parseGooglePlayEditSession(
          {
            packageName: boundPackageName,
            editId: entry.editId,
            expiryTimeSeconds: entry.expiryTimeSeconds,
          },
          boundPackageName,
        );
      } catch (cause) {
        throw new ReleaseError(
          "INVALID_ARGUMENT",
          "Edit cleanup journal entry identity is invalid.",
          { cause },
        );
      }
      const record: ReleaseEditCleanupJournalRecord = Object.freeze({
        version: RELEASE_EDIT_CLEANUP_JOURNAL_VERSION,
        packageName: boundPackageName,
        editId: session.editId,
        expiryTimeSeconds: parseEpochSeconds(entry.expiryTimeSeconds),
        source: entry.source,
        createdAt: entry.createdAt,
      });
      const current = await read();
      const retained = current.records.filter((existing) => existing.editId !== record.editId);
      await write(
        Object.freeze({
          version: RELEASE_EDIT_CLEANUP_JOURNAL_VERSION,
          packageName: boundPackageName,
          records: Object.freeze([...retained, record]),
        }),
      );
    },

    async remove(editId: string): Promise<void> {
      if (typeof editId !== "string" || editId.trim() === "" || editId !== editId.trim()) {
        throw new ReleaseError(
          "INVALID_ARGUMENT",
          "Edit cleanup journal removal identity is invalid.",
        );
      }
      const current = await read();
      const retained = current.records.filter((record) => record.editId !== editId);
      if (retained.length === current.records.length) return;
      await write(
        Object.freeze({
          version: RELEASE_EDIT_CLEANUP_JOURNAL_VERSION,
          packageName: boundPackageName,
          records: Object.freeze(retained),
        }),
      );
    },
  });
}

/**
 * Local classification of one journalled record. This is intentionally limited to
 * evidence PlayOps actually owns: trusted local expiry. It never decides that a
 * remote edit is inactive — see `docs/phase-4.15-plan.md` §3.
 */
export type ReleaseEditCleanupLocalState = "expired" | "not-expired";

export function classifyReleaseEditCleanupRecordLocally(
  record: { readonly expiryTimeSeconds: string },
  nowSeconds: string,
): ReleaseEditCleanupLocalState {
  return compareEpochSeconds(nowSeconds, parseEpochSeconds(record.expiryTimeSeconds)) >= 0
    ? "expired"
    : "not-expired";
}

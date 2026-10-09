/**
 * Durable server-owned pending-operation store (privilege-separated operator path).
 *
 * Holds exactly the facts an operator was asked to sign, plus the server-derived
 * trusted intent needed to execute later. It is private server state: it must
 * never be copied into audit JSONL, and it never contains credentials, tokens or
 * key material.
 *
 * `requestId` and `nonce` are generated here and are never accepted from a
 * caller, so client input cannot collide with or pre-empt a server-side identity.
 *
 * Durability mirrors the repository's existing private-write pattern: 0700 parent,
 * 0600 file, exclusive temp create, file fsync, rename, parent-directory fsync.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { APPROVAL_TOKEN_TTL_MS } from "../runtime/approvals/index.js";
import type { ToolPermissionLevel } from "../runtime/tools/index.js";

export const PENDING_RECORD_SCHEMA_VERSION = 2;

/** Only approval-gated operations get a pending record; `write` tools never do. */
const CHALLENGEABLE: ReadonlySet<ToolPermissionLevel> = new Set(["destructive", "publish"]);

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const EPOCH_SECONDS_PATTERN = /^[0-9]{1,20}$/u;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._][a-z][a-z0-9]*)*$/u;
const TRACK_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

export type PendingStoreErrorCode =
  | "PENDING_STORE_INSECURE"
  | "PENDING_RECORD_INVALID"
  | "PENDING_RECORD_NOT_FOUND"
  | "PENDING_REQUEST_ID_INVALID"
  | "PENDING_TRANSITION_ILLEGAL";

export class PendingStoreError extends Error {
  override readonly name = "PendingStoreError";

  constructor(
    readonly code: PendingStoreErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export type PendingState = "PENDING" | "CLAIMED" | "CONSUMED" | "RECOVERY_REQUIRED" | "COMPLETED";

/**
 * Legal state transitions.
 *
 * There is deliberately no path back to PENDING, no automatic release of a
 * CLAIMED record, and no edge out of either terminal state.
 *
 * `RECOVERY_REQUIRED` is the only honest representation of "this prepared
 * request must never execute normally again" when the outcome is uncertain. It
 * is reached from `PENDING` (the unavoidable crash window between O_EXCL claim
 * creation and the durable `CLAIMED` transition), from `CLAIMED` (exclusivity
 * obtained, boundary not durably represented) and from `CONSUMED` (transport may
 * have occurred, outcome ambiguous). All three can only reduce availability,
 * never grant execution authority, so they are the safe direction.
 *
 * `RECOVERY_REQUIRED` asserts only that normal reuse and automatic retry are
 * forbidden. It does NOT assert that a remote mutation happened, that it did
 * not happen, or that cleanup is complete — those facts stay authoritative in
 * the operation-specific evidence (commit-attempt journal, cleanup journal,
 * verifier/audit records, claim file).
 */
export const LEGAL_PENDING_TRANSITIONS: Readonly<Record<PendingState, readonly PendingState[]>> =
  Object.freeze({
    PENDING: Object.freeze(["CLAIMED", "RECOVERY_REQUIRED"] as const),
    CLAIMED: Object.freeze(["CONSUMED", "RECOVERY_REQUIRED"] as const),
    CONSUMED: Object.freeze(["COMPLETED", "RECOVERY_REQUIRED"] as const),
    RECOVERY_REQUIRED: Object.freeze([] as const),
    COMPLETED: Object.freeze([] as const),
  });

export type PendingOperationKind = "open_edit" | "commit" | "verify_committed" | "reconcile_commit";

export interface PendingOpenEditIntent {
  readonly kind: "open_edit";
}

export interface PendingCommitIntent {
  readonly kind: "commit";
  readonly targetTrack: string;
  readonly versionCode: string;
  readonly editId: string;
  readonly stateDigest: string;
  readonly validationExpiryTimeSeconds: string;
  readonly releaseName: string;
  readonly releaseStatus: string;
}

export interface PendingVerifyCommittedIntent {
  readonly kind: "verify_committed";
  readonly targetTrack: string;
  readonly versionCode: string;
  readonly expectedStateDigest: string;
}

export interface PendingReconcileCommitIntent {
  readonly kind: "reconcile_commit";
}

export type PendingIntent =
  | PendingOpenEditIntent
  | PendingCommitIntent
  | PendingVerifyCommittedIntent
  | PendingReconcileCommitIntent;

export interface PendingOperationRecord {
  readonly schemaVersion: number;
  readonly requestId: string;
  readonly nonce: string;
  readonly operation: PendingOperationKind;
  readonly toolName: string;
  readonly permission: ToolPermissionLevel;
  readonly packageName: string;
  readonly requestDigest: string;
  readonly createdAtUtc: string;
  readonly expiresAtUtc: string;
  readonly intent: PendingIntent;
  readonly state: PendingState;
}

/** Server-derived input. Deliberately a distinct type from any client request. */
export interface PendingPrepareInput {
  readonly operation: PendingOperationKind;
  readonly toolName: string;
  readonly permission: ToolPermissionLevel;
  readonly packageName: string;
  readonly requestDigest: string;
  readonly intent: PendingIntent;
}

export type PendingOperationStateName =
  "absent" | "pending" | "claimed" | "consumed" | "recovery_required" | "completed" | "expired";

export interface PendingOperationStore {
  prepare(input: PendingPrepareInput): Promise<PendingOperationRecord>;
  load(requestId: string): Promise<PendingOperationRecord | undefined>;
  list(): Promise<readonly PendingOperationRecord[]>;
  transition(
    requestId: string,
    from: PendingState,
    to: PendingState,
  ): Promise<PendingOperationRecord>;
  state(requestId: string): Promise<PendingOperationStateName>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordInvalid(detail: string): PendingStoreError {
  return new PendingStoreError("PENDING_RECORD_INVALID", `Pending record is invalid: ${detail}`);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw recordInvalid(`unknown field "${key}"`);
  }
}

function requireString(value: unknown, field: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0) throw recordInvalid(`${field} is required`);
  if (pattern && !pattern.test(value)) throw recordInvalid(`${field} has an invalid format`);
  return value;
}

function requireInstant(value: unknown, field: string): string {
  const text = requireString(value, field);
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== text) {
    throw recordInvalid(`${field} is not a canonical instant`);
  }
  return text;
}

function requirePermission(value: unknown): ToolPermissionLevel {
  if (value !== "destructive" && value !== "publish") {
    throw recordInvalid("permission must be destructive or publish");
  }
  return value;
}

function parseIntent(value: unknown): PendingIntent {
  if (!isRecord(value)) throw recordInvalid("intent must be an object");
  const kind = value.kind;
  switch (kind) {
    case "open_edit":
      exactKeys(value, ["kind"]);
      return Object.freeze({ kind: "open_edit" });
    case "reconcile_commit":
      exactKeys(value, ["kind"]);
      return Object.freeze({ kind: "reconcile_commit" });
    case "commit":
      exactKeys(value, [
        "kind",
        "targetTrack",
        "versionCode",
        "editId",
        "stateDigest",
        "validationExpiryTimeSeconds",
        "releaseName",
        "releaseStatus",
      ]);
      return Object.freeze({
        kind: "commit",
        targetTrack: requireString(value.targetTrack, "intent.targetTrack", TRACK_PATTERN),
        versionCode: requireString(value.versionCode, "intent.versionCode", EPOCH_SECONDS_PATTERN),
        editId: requireString(value.editId, "intent.editId"),
        stateDigest: requireString(value.stateDigest, "intent.stateDigest", DIGEST_PATTERN),
        validationExpiryTimeSeconds: requireString(
          value.validationExpiryTimeSeconds,
          "intent.validationExpiryTimeSeconds",
          EPOCH_SECONDS_PATTERN,
        ),
        releaseName: requireString(value.releaseName, "intent.releaseName"),
        releaseStatus: requireString(value.releaseStatus, "intent.releaseStatus"),
      });
    case "verify_committed":
      exactKeys(value, ["kind", "targetTrack", "versionCode", "expectedStateDigest"]);
      return Object.freeze({
        kind: "verify_committed",
        targetTrack: requireString(value.targetTrack, "intent.targetTrack", TRACK_PATTERN),
        versionCode: requireString(value.versionCode, "intent.versionCode", EPOCH_SECONDS_PATTERN),
        expectedStateDigest: requireString(
          value.expectedStateDigest,
          "intent.expectedStateDigest",
          DIGEST_PATTERN,
        ),
      });
    default:
      throw recordInvalid("intent.kind is unknown");
  }
}

/** Strict, fail-closed parse of a persisted record. Malformed records are never repaired. */
export function parsePendingOperationRecord(value: unknown): PendingOperationRecord {
  if (!isRecord(value)) throw recordInvalid("expected an object");
  exactKeys(value, [
    "schemaVersion",
    "requestId",
    "nonce",
    "operation",
    "toolName",
    "permission",
    "packageName",
    "requestDigest",
    "createdAtUtc",
    "expiresAtUtc",
    "intent",
    "state",
  ]);
  if (value.schemaVersion !== PENDING_RECORD_SCHEMA_VERSION) {
    throw recordInvalid("unsupported schema version");
  }
  const state = value.state;
  if (
    state !== "PENDING" &&
    state !== "CLAIMED" &&
    state !== "CONSUMED" &&
    state !== "RECOVERY_REQUIRED" &&
    state !== "COMPLETED"
  ) {
    throw recordInvalid("state is unknown");
  }
  const operation = value.operation;
  if (
    operation !== "open_edit" &&
    operation !== "commit" &&
    operation !== "verify_committed" &&
    operation !== "reconcile_commit"
  ) {
    throw recordInvalid("operation is unknown");
  }
  const intent = parseIntent(value.intent);
  if (intent.kind !== operation) throw recordInvalid("intent does not match the operation");
  const nonce = requireString(value.nonce, "nonce");
  if (nonce.length < 16) throw recordInvalid("nonce is too short to be a secure challenge");
  return Object.freeze({
    schemaVersion: PENDING_RECORD_SCHEMA_VERSION,
    requestId: requireString(value.requestId, "requestId", REQUEST_ID_PATTERN),
    nonce,
    operation,
    toolName: requireString(value.toolName, "toolName", TOOL_NAME_PATTERN),
    permission: requirePermission(value.permission),
    packageName: requireString(value.packageName, "packageName"),
    requestDigest: requireString(value.requestDigest, "requestDigest", DIGEST_PATTERN),
    createdAtUtc: requireInstant(value.createdAtUtc, "createdAtUtc"),
    expiresAtUtc: requireInstant(value.expiresAtUtc, "expiresAtUtc"),
    intent,
    state,
  });
}

interface PrivateWriteOptions {
  readonly now?: () => Date;
}

function assertRequestId(value: string): string {
  if (!REQUEST_ID_PATTERN.test(value)) {
    throw new PendingStoreError(
      "PENDING_REQUEST_ID_INVALID",
      "Pending request identifier is not a canonical identifier.",
    );
  }
  return value;
}

function isErrno(cause: unknown, code: string): boolean {
  return isRecord(cause) && cause.code === code;
}

export function createFilePendingOperationStore(
  rootDir: string,
  options: PrivateWriteOptions = {},
): PendingOperationStore {
  if (typeof rootDir !== "string" || rootDir.trim().length === 0) {
    throw new PendingStoreError("PENDING_STORE_INSECURE", "Pending store root is required.");
  }
  const clock = options.now ?? ((): Date => new Date());
  const fileFor = (requestId: string): string =>
    join(rootDir, `${assertRequestId(requestId)}.json`);

  async function assertPrivateParent(): Promise<void> {
    const parent = await lstat(rootDir);
    if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700) {
      throw new PendingStoreError(
        "PENDING_STORE_INSECURE",
        "Pending store directory must be a private 0700 directory.",
      );
    }
  }

  async function readRecord(requestId: string): Promise<PendingOperationRecord | undefined> {
    const path = fileFor(requestId);
    await assertPrivateParent();
    let stats;
    try {
      stats = await lstat(path);
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) return undefined;
      throw cause;
    }
    if (!stats.isFile() || (stats.mode & 0o777) !== 0o600) {
      throw new PendingStoreError(
        "PENDING_STORE_INSECURE",
        "Pending record file must be a private 0600 regular file.",
      );
    }
    const contents = await readFile(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (cause) {
      throw new PendingStoreError("PENDING_RECORD_INVALID", "Pending record is not valid JSON.", {
        cause,
      });
    }
    return parsePendingOperationRecord(parsed);
  }

  async function writeRecord(record: PendingOperationRecord): Promise<void> {
    const path = fileFor(record.requestId);
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    await assertPrivateParent();
    const temp = `${path}.tmp-${randomBytes(8).toString("hex")}`;
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  return Object.freeze({
    async prepare(input: PendingPrepareInput): Promise<PendingOperationRecord> {
      if (!isRecord(input)) throw recordInvalid("prepare input must be an object");
      const permission = requirePermission(input.permission);
      if (!CHALLENGEABLE.has(permission)) throw recordInvalid("operation is not approval-gated");
      const intent = parseIntent(input.intent);
      if (intent.kind !== input.operation)
        throw recordInvalid("intent does not match the operation");
      const createdAt = clock();
      const record: PendingOperationRecord = Object.freeze({
        schemaVersion: PENDING_RECORD_SCHEMA_VERSION,
        requestId: randomUUID(),
        // Cryptographically random, never derived from time, package, digest or id.
        nonce: randomBytes(32).toString("base64url"),
        operation: input.operation,
        toolName: requireString(input.toolName, "toolName", TOOL_NAME_PATTERN),
        permission,
        packageName: requireString(input.packageName, "packageName"),
        requestDigest: requireString(input.requestDigest, "requestDigest", DIGEST_PATTERN),
        createdAtUtc: createdAt.toISOString(),
        expiresAtUtc: new Date(createdAt.getTime() + APPROVAL_TOKEN_TTL_MS).toISOString(),
        intent,
        state: "PENDING",
      });
      await writeRecord(record);
      return record;
    },

    async load(requestId: string): Promise<PendingOperationRecord | undefined> {
      return readRecord(requestId);
    },

    async list(): Promise<readonly PendingOperationRecord[]> {
      await assertPrivateParent();
      const entries = await readdir(rootDir);
      const records: PendingOperationRecord[] = [];
      for (const entry of entries.sort()) {
        if (!entry.endsWith(".json")) continue;
        const record = await readRecord(entry.slice(0, -".json".length));
        if (record) records.push(record);
      }
      return Object.freeze(records);
    },

    async transition(
      requestId: string,
      from: PendingState,
      to: PendingState,
    ): Promise<PendingOperationRecord> {
      const existing = await readRecord(requestId);
      if (!existing) {
        throw new PendingStoreError("PENDING_RECORD_NOT_FOUND", "Pending record was not found.");
      }
      if (existing.state !== from) {
        throw new PendingStoreError(
          "PENDING_TRANSITION_ILLEGAL",
          "Pending record is not in the expected state.",
        );
      }
      if (!LEGAL_PENDING_TRANSITIONS[from].includes(to)) {
        throw new PendingStoreError(
          "PENDING_TRANSITION_ILLEGAL",
          "Pending state transition is not permitted.",
        );
      }
      const next: PendingOperationRecord = Object.freeze({ ...existing, state: to });
      await writeRecord(next);
      return next;
    },

    async state(requestId: string): Promise<PendingOperationStateName> {
      const record = await readRecord(requestId);
      if (!record) return "absent";
      // Only PENDING is subject to expiry, and terminal execution evidence
      // outranks TTL: an expired approval window must never mask a
      // recovery-required or completed request.
      if (record.state === "PENDING" && Date.parse(record.expiresAtUtc) <= clock().getTime()) {
        return "expired";
      }
      switch (record.state) {
        case "PENDING":
          return "pending";
        case "CLAIMED":
          return "claimed";
        case "CONSUMED":
          return "consumed";
        case "RECOVERY_REQUIRED":
          return "recovery_required";
        default:
          return "completed";
      }
    },
  });
}

/** True when the record's approval window has closed. Expired records are never executed. */
export function isPendingRecordExpired(record: PendingOperationRecord, now: Date): boolean {
  return Date.parse(record.expiresAtUtc) <= now.getTime();
}

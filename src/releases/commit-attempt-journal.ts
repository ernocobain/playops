/**
 * Durable operational authority for approved commit attempts; audit is not a substitute.
 * File/temp are private, writes use fsync + atomic rename + directory fsync.
 * Atomic replacement prevents torn records, not multi-process distributed races:
 * this follows the project's single-operator/single-process release-store contract.
 * Callers serialize operations and await every durable marker before the associated
 * network mutation. Insert/delete acknowledgment requires an already-persisted
 * attempt marker; an unknown insert identity is retained, never reset/reinserted.
 * A verification identity is immutable, distinct from the original edit, and
 * retained after cleanup together with the observed proof. The journal does not
 * call Google: exact-state observations and post-delete context checks are caller
 * assertions, not claims inferred from timestamps, expiry, or audit success.
 * Terminal records remain historical evidence; pending verification cleanup still
 * blocks preparation, even when the original attempt is not committed.
 * attemptedAtUtc identifies local attempt preparation, not proof of bytes sent.
 */
import { randomUUID, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  compareEpochSeconds,
  normalizeReleaseVersionCode,
  parseEpochSeconds,
  parseGooglePlayEditSession,
  RELEASE_STATUSES,
  ReleaseError,
  validateReleasePackageName,
  validateReleaseTargetTrack,
  type ReleaseStatus,
} from "./index.js";

export const RELEASE_COMMIT_ATTEMPT_JOURNAL_VERSION = 1 as const;
export const RELEASE_COMMIT_ATTEMPT_STATES = Object.freeze([
  "PREPARED",
  "TRANSPORT_ATTEMPTED",
  "ACKNOWLEDGED",
  "AMBIGUOUS",
  "REMOTE_VERIFIED",
  "RECONCILED_COMMITTED",
  "RECONCILED_NOT_COMMITTED",
] as const);
export type ReleaseCommitAttemptState = (typeof RELEASE_COMMIT_ATTEMPT_STATES)[number];

/**
 * Only recovery metadata may change; original approval and commit identity are
 * immutable. `acknowledgedAtUtc` is historical durable evidence that Google
 * acknowledged this exact commit; it is set only while entering ACKNOWLEDGED and
 * is never cleared, so later states keep the fact discoverable.
 */
export interface ReleaseCommitAttemptVerificationPatch {
  /** Durable acknowledgement evidence; set only on the ACKNOWLEDGED transition. */
  readonly acknowledgedAtUtc?: string;
  /** Persist and await before the single verification insert; true never permits replay. */
  readonly verificationInsertAttempted?: true;
  readonly verificationEditId?: string;
  readonly verificationEditExpiryTimeSeconds?: string;
  readonly verificationPreDeleteReadVerified?: true;
  /** Persist and await before delete, after the exact-identity pre-delete read. */
  readonly verificationDeleteAttempted?: true;
  readonly verificationDeleteAcknowledged?: true;
  readonly verificationObservedStateDigest?: string;
  readonly verificationObservedAtUtc?: string;
  /** Caller assertion of acknowledged delete and verified post-delete context, not local expiry. */
  readonly verificationCleanupVerified?: true;
}

export interface ReleaseCommitAttemptJournalRecord extends ReleaseCommitAttemptVerificationPatch {
  readonly version: typeof RELEASE_COMMIT_ATTEMPT_JOURNAL_VERSION;
  /** Local non-secret correlation handle; distinguishes fresh approved attempts. */
  readonly attemptId: string;
  readonly packageName: string;
  readonly editId: string;
  readonly expiryTimeSeconds: string;
  readonly targetTrack: string;
  readonly versionCode: string;
  readonly releaseName: string;
  readonly releaseStatus: ReleaseStatus;
  readonly expectedStateDigest: string;
  /**
   * Exact trusted pre-mutation target digest, supplied as recovery/diagnostic
   * evidence. It is intentionally NOT approval-bound, so equality with it is
   * never sufficient on its own to prove NOT_COMMITTED; recovery reports that
   * observation as unresolved (CASE_3) instead.
   */
  readonly priorStateDigest?: string;
  readonly validationExpiryTimeSeconds: string;
  readonly requestDigest: string;
  readonly state: ReleaseCommitAttemptState;
  readonly attemptedAtUtc: string;
  readonly updatedAtUtc: string;
}
export type ReleaseCommitAttemptPreparedInput = Omit<
  ReleaseCommitAttemptJournalRecord,
  "attemptId" | "state" | keyof ReleaseCommitAttemptVerificationPatch
>;
export interface ReleaseCommitAttemptJournal {
  list(): Promise<readonly ReleaseCommitAttemptJournalRecord[]>;
  prepare(input: ReleaseCommitAttemptPreparedInput): Promise<ReleaseCommitAttemptJournalRecord>;
  transition(
    attemptId: string,
    from: ReleaseCommitAttemptState,
    to: ReleaseCommitAttemptState,
    updatedAtUtc: string,
    patch?: ReleaseCommitAttemptVerificationPatch,
  ): Promise<ReleaseCommitAttemptJournalRecord>;
  updateVerification(
    attemptId: string,
    from: ReleaseCommitAttemptState,
    updatedAtUtc: string,
    patch: ReleaseCommitAttemptVerificationPatch,
  ): Promise<ReleaseCommitAttemptJournalRecord>;
}
interface JournalFile {
  readonly version: typeof RELEASE_COMMIT_ATTEMPT_JOURNAL_VERSION;
  readonly packageName: string;
  readonly records: readonly ReleaseCommitAttemptJournalRecord[];
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalid(cause?: unknown): ReleaseError {
  return new ReleaseError(
    "COMMIT_ATTEMPT_JOURNAL_INVALID",
    "The durable commit-attempt journal is unavailable or invalid.",
    {
      ...(cause === undefined ? {} : { cause }),
      externalStateUncertain: false,
    },
  );
}
function iso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
function state(value: unknown): value is ReleaseCommitAttemptState {
  return RELEASE_COMMIT_ATTEMPT_STATES.some((candidate) => candidate === value);
}
function status(value: unknown): value is ReleaseStatus {
  return RELEASE_STATUSES.some((candidate) => candidate === value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) throw invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw invalid();
  }
}
function errno(value: unknown, code: string): boolean {
  return object(value) && value.code === code;
}
const VERIFICATION_FLAGS = Object.freeze([
  "verificationInsertAttempted",
  "verificationPreDeleteReadVerified",
  "verificationDeleteAttempted",
  "verificationDeleteAcknowledged",
  "verificationCleanupVerified",
] as const);
const VERIFICATION_KEYS: readonly (keyof ReleaseCommitAttemptVerificationPatch)[] = Object.freeze([
  ...VERIFICATION_FLAGS,
  "verificationEditId",
  "verificationEditExpiryTimeSeconds",
  "verificationObservedStateDigest",
  "verificationObservedAtUtc",
  "acknowledgedAtUtc",
]);
const TRANSITIONS: Readonly<
  Record<ReleaseCommitAttemptState, readonly ReleaseCommitAttemptState[]>
> = Object.freeze({
  PREPARED: ["TRANSPORT_ATTEMPTED", "RECONCILED_NOT_COMMITTED"],
  TRANSPORT_ATTEMPTED: ["ACKNOWLEDGED", "AMBIGUOUS", "RECONCILED_NOT_COMMITTED", "REMOTE_VERIFIED"],
  ACKNOWLEDGED: ["REMOTE_VERIFIED"],
  AMBIGUOUS: ["REMOTE_VERIFIED", "RECONCILED_NOT_COMMITTED"],
  REMOTE_VERIFIED: ["RECONCILED_COMMITTED"],
  RECONCILED_COMMITTED: [],
  RECONCILED_NOT_COMMITTED: [],
});
const RECORD_KEYS = Object.freeze([
  "version",
  "attemptId",
  "packageName",
  "editId",
  "expiryTimeSeconds",
  "targetTrack",
  "versionCode",
  "releaseName",
  "releaseStatus",
  "expectedStateDigest",
  "priorStateDigest",
  "validationExpiryTimeSeconds",
  "requestDigest",
  "state",
  "attemptedAtUtc",
  "updatedAtUtc",
  ...VERIFICATION_KEYS,
]);
function parseVerification(
  value: Record<string, unknown>,
  packageName: string,
): ReleaseCommitAttemptVerificationPatch {
  for (const flag of VERIFICATION_FLAGS) {
    if (Object.hasOwn(value, flag) && value[flag] !== true) throw invalid();
  }
  let acknowledgedAtUtc: string | undefined;
  if (Object.hasOwn(value, "acknowledgedAtUtc")) {
    if (!iso(value.acknowledgedAtUtc)) throw invalid();
    acknowledgedAtUtc = value.acknowledgedAtUtc;
  }
  const hasId = Object.hasOwn(value, "verificationEditId");
  const hasExpiry = Object.hasOwn(value, "verificationEditExpiryTimeSeconds");
  if (hasId !== hasExpiry || (hasId && value.verificationInsertAttempted !== true)) throw invalid();
  let verificationEditId: string | undefined;
  let verificationEditExpiryTimeSeconds: string | undefined;
  if (hasId) {
    const identity = parseGooglePlayEditSession(
      {
        packageName,
        editId: value.verificationEditId,
        expiryTimeSeconds: value.verificationEditExpiryTimeSeconds,
      },
      packageName,
    );
    if (identity.editId === value.editId) throw invalid();
    verificationEditId = identity.editId;
    verificationEditExpiryTimeSeconds = parseEpochSeconds(value.verificationEditExpiryTimeSeconds);
  }
  const hasProof = Object.hasOwn(value, "verificationObservedStateDigest");
  if (hasProof !== Object.hasOwn(value, "verificationObservedAtUtc")) throw invalid();
  let verificationObservedStateDigest: string | undefined;
  let verificationObservedAtUtc: string | undefined;
  if (hasProof) {
    if (
      !hasId ||
      !digest(value.verificationObservedStateDigest) ||
      !iso(value.verificationObservedAtUtc)
    )
      throw invalid();
    verificationObservedStateDigest = value.verificationObservedStateDigest;
    verificationObservedAtUtc = value.verificationObservedAtUtc;
  }
  if (
    (value.verificationPreDeleteReadVerified === true && !hasId) ||
    (value.verificationDeleteAttempted === true &&
      value.verificationPreDeleteReadVerified !== true) ||
    (value.verificationDeleteAcknowledged === true && value.verificationDeleteAttempted !== true) ||
    (value.verificationCleanupVerified === true && value.verificationDeleteAcknowledged !== true)
  )
    throw invalid();
  return {
    ...(value.verificationInsertAttempted === true
      ? { verificationInsertAttempted: true as const }
      : {}),
    ...(verificationEditId === undefined
      ? {}
      : { verificationEditId, verificationEditExpiryTimeSeconds }),
    ...(verificationObservedStateDigest === undefined
      ? {}
      : { verificationObservedStateDigest, verificationObservedAtUtc }),
    ...(acknowledgedAtUtc === undefined ? {} : { acknowledgedAtUtc }),
    ...(value.verificationPreDeleteReadVerified === true
      ? { verificationPreDeleteReadVerified: true as const }
      : {}),
    ...(value.verificationDeleteAttempted === true
      ? { verificationDeleteAttempted: true as const }
      : {}),
    ...(value.verificationDeleteAcknowledged === true
      ? { verificationDeleteAcknowledged: true as const }
      : {}),
    ...(value.verificationCleanupVerified === true
      ? { verificationCleanupVerified: true as const }
      : {}),
  };
}
export function parseReleaseCommitAttemptJournalRecord(
  value: unknown,
  expectedPackageName: string,
): ReleaseCommitAttemptJournalRecord {
  try {
    if (!object(value)) throw invalid();
    keys(value, RECORD_KEYS);
    if (
      value.version !== RELEASE_COMMIT_ATTEMPT_JOURNAL_VERSION ||
      value.packageName !== expectedPackageName ||
      typeof value.attemptId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        value.attemptId,
      ) ||
      !state(value.state) ||
      !status(value.releaseStatus) ||
      !iso(value.attemptedAtUtc) ||
      !iso(value.updatedAtUtc) ||
      typeof value.releaseName !== "string" ||
      value.releaseName.trim() === "" ||
      !digest(value.expectedStateDigest) ||
      !digest(value.requestDigest) ||
      (value.priorStateDigest !== undefined && !digest(value.priorStateDigest))
    )
      throw invalid();
    const identity = parseGooglePlayEditSession(
      {
        packageName: value.packageName,
        editId: value.editId,
        expiryTimeSeconds: value.expiryTimeSeconds,
      },
      expectedPackageName,
    );
    const expiryTimeSeconds = parseEpochSeconds(value.expiryTimeSeconds);
    const validationExpiryTimeSeconds = parseEpochSeconds(value.validationExpiryTimeSeconds);
    if (compareEpochSeconds(expiryTimeSeconds, validationExpiryTimeSeconds) !== 0) throw invalid();
    const verification = parseVerification(value, expectedPackageName);
    if (value.state === "PREPARED" && Object.keys(verification).length !== 0) throw invalid();
    if (
      (value.state === "REMOTE_VERIFIED" || value.state === "RECONCILED_COMMITTED") &&
      verification.verificationObservedStateDigest !== value.expectedStateDigest
    )
      throw invalid();
    if (value.state === "RECONCILED_COMMITTED" && verification.verificationCleanupVerified !== true)
      throw invalid();
    // Durable acknowledgement lineage: an ACKNOWLEDGED record must carry the
    // evidence, and the evidence may only exist where an acknowledgement is
    // state-consistent. Remote verification may legitimately have no ACK (an
    // ambiguous commit can later be proven committed without one).
    if (value.state === "ACKNOWLEDGED" && verification.acknowledgedAtUtc === undefined)
      throw invalid();
    if (
      verification.acknowledgedAtUtc !== undefined &&
      !["ACKNOWLEDGED", "REMOTE_VERIFIED", "RECONCILED_COMMITTED"].includes(value.state)
    )
      throw invalid();
    return Object.freeze({
      version: RELEASE_COMMIT_ATTEMPT_JOURNAL_VERSION,
      attemptId: value.attemptId,
      packageName: expectedPackageName,
      editId: identity.editId,
      expiryTimeSeconds,
      targetTrack: validateReleaseTargetTrack(value.targetTrack),
      versionCode: normalizeReleaseVersionCode(value.versionCode),
      releaseName: value.releaseName,
      releaseStatus: value.releaseStatus,
      expectedStateDigest: value.expectedStateDigest,
      ...(value.priorStateDigest === undefined ? {} : { priorStateDigest: value.priorStateDigest }),
      validationExpiryTimeSeconds,
      requestDigest: value.requestDigest,
      state: value.state,
      attemptedAtUtc: value.attemptedAtUtc,
      updatedAtUtc: value.updatedAtUtc,
      ...verification,
    });
  } catch (cause) {
    if (cause instanceof ReleaseError && cause.code === "COMMIT_ATTEMPT_JOURNAL_INVALID")
      throw cause;
    throw invalid(cause);
  }
}
function unresolved(record: ReleaseCommitAttemptJournalRecord): boolean {
  return (
    (record.state !== "RECONCILED_COMMITTED" && record.state !== "RECONCILED_NOT_COMMITTED") ||
    (record.verificationInsertAttempted === true && record.verificationCleanupVerified !== true)
  );
}
function parseFile(value: unknown, packageName: string): JournalFile {
  if (!object(value)) throw invalid();
  keys(value, ["version", "packageName", "records"]);
  if (
    value.version !== RELEASE_COMMIT_ATTEMPT_JOURNAL_VERSION ||
    value.packageName !== packageName ||
    !Array.isArray(value.records)
  )
    throw invalid();
  const records = value.records.map((record) =>
    parseReleaseCommitAttemptJournalRecord(record, packageName),
  );
  if (
    new Set(records.map((record) => record.attemptId)).size !== records.length ||
    records.slice(0, -1).some(unresolved)
  )
    throw invalid();
  return Object.freeze({
    version: RELEASE_COMMIT_ATTEMPT_JOURNAL_VERSION,
    packageName,
    records: Object.freeze(records),
  });
}
export function createFileReleaseCommitAttemptJournal(
  path: string,
  options: { readonly expectedPackageName: string },
): ReleaseCommitAttemptJournal {
  if (typeof path !== "string" || path.trim() === "") throw invalid();
  const packageName = validateReleasePackageName(options?.expectedPackageName);
  const empty = (): JournalFile =>
    Object.freeze({
      version: RELEASE_COMMIT_ATTEMPT_JOURNAL_VERSION,
      packageName,
      records: Object.freeze([]),
    });
  const read = async (): Promise<JournalFile> => {
    try {
      const parent = await lstat(dirname(path));
      if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700) throw invalid();
      const file = await lstat(path);
      if (!file.isFile() || (file.mode & 0o777) !== 0o600) throw invalid();
    } catch (cause) {
      if (errno(cause, "ENOENT")) return empty();
      throw invalid(cause);
    }
    try {
      return parseFile(JSON.parse(await readFile(path, "utf8")), packageName);
    } catch (cause) {
      // An existing authority that becomes unreadable is never treated as absent.
      throw invalid(cause);
    }
  };
  const write = async (file: JournalFile): Promise<void> => {
    const temp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let ownsTemp = false;
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const parent = await lstat(dirname(path));
      if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700) throw invalid();
      const handle = await open(temp, "wx", 0o600);
      ownsTemp = true;
      try {
        await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, path);
      ownsTemp = false;
      // A directory-sync failure may leave the replacement visible, but never
      // returns success or rolls back conservative transport/recovery evidence.
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (cause) {
      if (ownsTemp) await unlink(temp).catch(() => undefined);
      throw invalid(cause);
    }
  };
  const update = async (
    attemptId: string,
    from: ReleaseCommitAttemptState,
    to: ReleaseCommitAttemptState,
    updatedAtUtc: string,
    patch: ReleaseCommitAttemptVerificationPatch,
  ): Promise<ReleaseCommitAttemptJournalRecord> => {
    if (!object(patch)) throw invalid();
    keys(patch, VERIFICATION_KEYS);
    const file = await read();
    const previous = file.records.find((record) => record.attemptId === attemptId);
    if (!previous || previous.state !== from) throw invalid();
    if (
      previous.state === "RECONCILED_NOT_COMMITTED" &&
      previous.verificationInsertAttempted !== true &&
      patch.verificationInsertAttempted === true
    )
      throw invalid();
    if (Object.hasOwn(patch, "acknowledgedAtUtc")) {
      if (to !== "ACKNOWLEDGED" || patch.acknowledgedAtUtc === previous.acknowledgedAtUtc)
        throw invalid();
      if (previous.acknowledgedAtUtc !== undefined) throw invalid();
    }
    for (const key of ["verificationEditId", "verificationEditExpiryTimeSeconds"] as const) {
      if (previous[key] !== undefined && Object.hasOwn(patch, key) && patch[key] !== previous[key])
        throw invalid();
    }
    if (
      previous.verificationCleanupVerified === true &&
      VERIFICATION_KEYS.some((key) => Object.hasOwn(patch, key) && patch[key] !== previous[key])
    )
      throw invalid();
    if (
      (Object.hasOwn(patch, "verificationEditId") ||
        Object.hasOwn(patch, "verificationEditExpiryTimeSeconds")) &&
      previous.verificationInsertAttempted !== true
    )
      throw invalid();
    if (
      patch.verificationDeleteAcknowledged === true &&
      previous.verificationDeleteAttempted !== true
    )
      throw invalid();
    const record = parseReleaseCommitAttemptJournalRecord(
      { ...previous, ...patch, state: to, updatedAtUtc },
      packageName,
    );
    await write({
      ...file,
      records: file.records.map((entry) => (entry.attemptId === attemptId ? record : entry)),
    });
    return record;
  };
  return Object.freeze({
    async list() {
      return (await read()).records;
    },
    async prepare(input: ReleaseCommitAttemptPreparedInput) {
      if (!object(input)) throw invalid();
      keys(
        input,
        RECORD_KEYS.filter(
          (key) =>
            key !== "attemptId" &&
            key !== "state" &&
            !VERIFICATION_KEYS.some((verificationKey) => verificationKey === key),
        ),
      );
      const record = parseReleaseCommitAttemptJournalRecord(
        { ...input, attemptId: randomUUID(), state: "PREPARED" },
        packageName,
      );
      const file = await read();
      if (file.records.some(unresolved)) {
        throw invalid();
      }
      await write({ ...file, records: [...file.records, record] });
      return record;
    },
    async transition(
      attemptId: string,
      from: ReleaseCommitAttemptState,
      to: ReleaseCommitAttemptState,
      updatedAtUtc: string,
      patch: ReleaseCommitAttemptVerificationPatch = {},
    ) {
      if (!state(from) || !state(to) || !TRANSITIONS[from].includes(to)) throw invalid();
      return update(attemptId, from, to, updatedAtUtc, patch);
    },
    async updateVerification(
      attemptId: string,
      from: ReleaseCommitAttemptState,
      updatedAtUtc: string,
      patch: ReleaseCommitAttemptVerificationPatch,
    ) {
      return update(attemptId, from, from, updatedAtUtc, patch);
    },
  });
}

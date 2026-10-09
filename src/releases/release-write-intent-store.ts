/**
 * Durable release write-intent gate.
 *
 * This is a SAFETY GATE, not an approval mechanism. It exists for one reason:
 * a release-lane write (starting with `attach_notes`) reads current remote state,
 * then mutates it. If the mutation's outcome becomes uncertain, nothing prevents
 * an immediate or concurrent second write from reading the *stale* state again
 * and issuing a second blind remote update.
 *
 * The gate closes that window durably:
 *
 *   acquire (exclusive, O_EXCL)  -> PREPARED durable
 *   mark TRANSPORT_ATTEMPTED     -> durable BEFORE the remote call
 *   remote call
 *   read-back settles it         -> VERIFIED_EXPECTED | VERIFIED_PRIOR | AMBIGUOUS
 *
 * An active record IS the exclusive gate for its managed edit. Exactly one
 * writer per edit can hold it. The scope key is a fixed SHA-256 of the trusted
 * package name plus the edit id, so no untrusted string ever becomes a path
 * component.
 *
 * Scope is deliberately coarse (one active write intent per MANAGED EDIT, not
 * per track/locale): v0.3.0 prioritises correctness over write concurrency.
 *
 * This module deliberately does NOT use, and does not extend, the daemon's
 * signed pending-operation records (those are approval-gated and must not be
 * reused for an unsigned write), the commit-attempt journal, the cleanup
 * journal, or the managed-session schema. It is a separate lifecycle.
 *
 * Nothing here infers safety. There is no stale takeover: PID liveness, mtime
 * age and elapsed time are all ignored on purpose. Only an explicit, separately
 * authorised recovery path may settle a record that a crash left behind.
 *
 * GATE VERDICTS (see `ReleaseWriteIntentGate`) — durable states are never
 * collapsed onto a single "busy" answer:
 *
 *   PREPARED            -> operation_in_progress
 *   TRANSPORT_ATTEMPTED -> external_state_ambiguous
 *   AMBIGUOUS           -> external_state_ambiguous
 *   VERIFIED_EXPECTED   -> cleanup_pending
 *   VERIFIED_PRIOR      -> cleanup_pending
 *
 * The ONLY normal release rule is `release()` from a terminal verified state.
 * A proven no-op gets no bypass: it walks the ordinary path
 * (PREPARED -> VERIFIED_PRIOR -> release) and never marks TRANSPORT_ATTEMPTED.
 *
 * The `attach_notes` target derivation this gate protects is pinned, as data,
 * in `./release-note-target-contract.ts`.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export const RELEASE_WRITE_INTENT_SCHEMA_VERSION = 1;

/** Parent directory mode for the private intent store. */
const STORE_MODE = 0o700;
/** File mode for every intent record. */
const RECORD_MODE = 0o600;

const TRACK_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const VERSION_CODE_PATTERN = /^[0-9]{1,20}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const ATTEMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
// eslint-disable-next-line no-control-regex -- intentional: reject control characters in identifiers
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export type ReleaseWriteIntentState =
  "PREPARED" | "TRANSPORT_ATTEMPTED" | "VERIFIED_EXPECTED" | "VERIFIED_PRIOR" | "AMBIGUOUS";

export const RELEASE_WRITE_INTENT_STATES: readonly ReleaseWriteIntentState[] = Object.freeze([
  "PREPARED",
  "TRANSPORT_ATTEMPTED",
  "VERIFIED_EXPECTED",
  "VERIFIED_PRIOR",
  "AMBIGUOUS",
]);

/**
 * Conservative transition graph.
 *
 * There is no edge back to PREPARED, no automatic AMBIGUOUS ->
 * TRANSPORT_ATTEMPTED, and no edge out of either terminal state: recovery may
 * settle an ambiguous record but must never retry the write automatically.
 */
export const LEGAL_WRITE_INTENT_TRANSITIONS: Readonly<
  Record<ReleaseWriteIntentState, readonly ReleaseWriteIntentState[]>
> = Object.freeze({
  PREPARED: Object.freeze(["TRANSPORT_ATTEMPTED", "VERIFIED_PRIOR"] as const),
  TRANSPORT_ATTEMPTED: Object.freeze(["VERIFIED_EXPECTED", "VERIFIED_PRIOR", "AMBIGUOUS"] as const),
  AMBIGUOUS: Object.freeze(["VERIFIED_EXPECTED", "VERIFIED_PRIOR"] as const),
  VERIFIED_EXPECTED: Object.freeze([] as const),
  VERIFIED_PRIOR: Object.freeze([] as const),
});

/** States from which the active gate may be explicitly released. */
export const TERMINAL_WRITE_INTENT_STATES: readonly ReleaseWriteIntentState[] = Object.freeze([
  "VERIFIED_EXPECTED",
  "VERIFIED_PRIOR",
]);

export interface ReleaseWriteIntentRecord {
  readonly schemaVersion: number;
  readonly attemptId: string;
  readonly packageName: string;
  readonly editId: string;
  readonly track: string;
  readonly versionCode: string;
  readonly locale: string;
  /** SHA-256 of the requested note text. The text itself is never persisted. */
  readonly noteDigest: string;
  readonly priorTrackDigest: string;
  readonly expectedTrackDigest: string;
  readonly state: ReleaseWriteIntentState;
  readonly createdAtUtc: string;
  readonly updatedAtUtc: string;
}

export type ReleaseWriteIntentErrorCode =
  | "WRITE_INTENT_STORE_INSECURE"
  | "WRITE_INTENT_SCOPE_INVALID"
  | "WRITE_INTENT_RECORD_INVALID"
  | "WRITE_INTENT_NOT_FOUND"
  | "WRITE_INTENT_ACTIVE"
  | "WRITE_INTENT_TRANSITION_ILLEGAL"
  | "WRITE_INTENT_RELEASE_DENIED";

export class ReleaseWriteIntentError extends Error {
  override readonly name = "ReleaseWriteIntentError";

  constructor(
    readonly code: ReleaseWriteIntentErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

function invalidRecord(detail: string): ReleaseWriteIntentError {
  return new ReleaseWriteIntentError(
    "WRITE_INTENT_RECORD_INVALID",
    `Release write-intent record is invalid: ${detail}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw invalidRecord(`unknown key "${key}"`);
    }
  }
}

function readIdentifier(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReleaseWriteIntentError(
      "WRITE_INTENT_SCOPE_INVALID",
      `${field} must be a non-empty string.`,
    );
  }
  if (value.length > maxChars || CONTROL_CHARACTERS.test(value)) {
    throw new ReleaseWriteIntentError(
      "WRITE_INTENT_SCOPE_INVALID",
      `${field} is not a usable release write scope.`,
    );
  }
  return value;
}

function readPattern(value: unknown, field: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw invalidRecord(`${field} is not canonical`);
  }
  return value;
}

function readDigest(value: unknown, field: string): string {
  return readPattern(value, field, DIGEST_PATTERN);
}

function readTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw invalidRecord(`${field} is not a timestamp`);
  }
  return value;
}

function readState(value: unknown): ReleaseWriteIntentState {
  if (
    typeof value !== "string" ||
    !RELEASE_WRITE_INTENT_STATES.includes(value as ReleaseWriteIntentState)
  ) {
    throw invalidRecord("state is not a known write-intent state");
  }
  return value as ReleaseWriteIntentState;
}

/** Strict parser. Unknown schema, unknown key or malformed value fails closed. */
export function parseReleaseWriteIntentRecord(value: unknown): ReleaseWriteIntentRecord {
  if (!isRecord(value)) throw invalidRecord("record must be an object");
  exactKeys(value, [
    "schemaVersion",
    "attemptId",
    "packageName",
    "editId",
    "track",
    "versionCode",
    "locale",
    "noteDigest",
    "priorTrackDigest",
    "expectedTrackDigest",
    "state",
    "createdAtUtc",
    "updatedAtUtc",
  ]);
  if (value.schemaVersion !== RELEASE_WRITE_INTENT_SCHEMA_VERSION) {
    throw invalidRecord("unsupported schema version");
  }
  return Object.freeze({
    schemaVersion: RELEASE_WRITE_INTENT_SCHEMA_VERSION,
    attemptId: readPattern(value.attemptId, "attemptId", ATTEMPT_ID_PATTERN),
    packageName: readIdentifier(value.packageName, "packageName", 255),
    editId: readIdentifier(value.editId, "editId", 256),
    track: readPattern(value.track, "track", TRACK_PATTERN),
    versionCode: readPattern(value.versionCode, "versionCode", VERSION_CODE_PATTERN),
    locale: readPattern(value.locale, "locale", LOCALE_PATTERN),
    noteDigest: readDigest(value.noteDigest, "noteDigest"),
    priorTrackDigest: readDigest(value.priorTrackDigest, "priorTrackDigest"),
    expectedTrackDigest: readDigest(value.expectedTrackDigest, "expectedTrackDigest"),
    state: readState(value.state),
    createdAtUtc: readTimestamp(value.createdAtUtc, "createdAtUtc"),
    updatedAtUtc: readTimestamp(value.updatedAtUtc, "updatedAtUtc"),
  });
}

/**
 * Fixed safe scope key: SHA-256 over the trusted package name and the edit id,
 * separated by NUL. The raw edit id is never used as a path component.
 */
export function releaseWriteIntentScopeKey(packageName: string, editId: string): string {
  const safePackage = readIdentifier(packageName, "packageName", 255);
  const safeEdit = readIdentifier(editId, "editId", 256);
  return createHash("sha256").update(`${safePackage}\u0000${safeEdit}`, "utf8").digest("hex");
}

export function releaseWriteIntentPath(
  rootDir: string,
  packageName: string,
  editId: string,
): string {
  return join(rootDir, `${releaseWriteIntentScopeKey(packageName, editId)}.write-intent.json`);
}

/** SHA-256 of the requested note text. Only this digest is ever persisted. */
export function releaseWriteIntentNoteDigest(noteText: string): string {
  if (typeof noteText !== "string") {
    throw new ReleaseWriteIntentError("WRITE_INTENT_RECORD_INVALID", "Note text must be a string.");
  }
  return createHash("sha256").update(noteText, "utf8").digest("hex");
}

/**
 * The verdict a future normal write path must act on.
 *
 * Mapping by durable state, with no state collapsed into another:
 *
 *   PREPARED            -> operation_in_progress    (another attempt owns the gate)
 *   TRANSPORT_ATTEMPTED -> external_state_ambiguous (a remote effect may exist)
 *   AMBIGUOUS           -> external_state_ambiguous (neither exact state is proven)
 *   VERIFIED_EXPECTED   -> cleanup_pending          (externally settled; local cleanup only)
 *   VERIFIED_PRIOR      -> cleanup_pending
 *
 * A terminal leftover — a crash between verification and release — is NOT "in
 * progress" and NOT ambiguous: the external edit state is already
 * authoritatively settled and only local gate cleanup remains. It is never
 * silently deleted; an ordinary writer reports `cleanup_pending` until the
 * record is explicitly released.
 */
export type ReleaseWriteIntentGate =
  | { readonly status: "clear" }
  | {
      readonly status: "held";
      readonly state: ReleaseWriteIntentState;
      readonly attemptId: string;
      readonly outcome: "operation_in_progress" | "external_state_ambiguous" | "cleanup_pending";
    };

type HeldOutcome = Extract<ReleaseWriteIntentGate, { status: "held" }>["outcome"];

function outcomeForHeldState(state: ReleaseWriteIntentState): HeldOutcome {
  switch (state) {
    case "PREPARED":
      return "operation_in_progress";
    case "TRANSPORT_ATTEMPTED":
    case "AMBIGUOUS":
      return "external_state_ambiguous";
    case "VERIFIED_EXPECTED":
    case "VERIFIED_PRIOR":
      return "cleanup_pending";
  }
}

export interface ReleaseWriteIntentAcquireInput {
  readonly packageName: string;
  readonly editId: string;
  readonly track: string;
  readonly versionCode: string;
  readonly locale: string;
  readonly noteDigest: string;
  readonly priorTrackDigest: string;
  readonly expectedTrackDigest: string;
}

export interface ReleaseWriteIntentStore {
  /** Exclusive acquisition. Fails closed with WRITE_INTENT_ACTIVE if held. */
  acquire(input: ReleaseWriteIntentAcquireInput): Promise<ReleaseWriteIntentRecord>;
  load(scope: {
    packageName: string;
    editId: string;
  }): Promise<ReleaseWriteIntentRecord | undefined>;
  /** Durable state transition, validated against the legal graph. */
  transition(scope: {
    packageName: string;
    editId: string;
    from: ReleaseWriteIntentState;
    to: ReleaseWriteIntentState;
  }): Promise<ReleaseWriteIntentRecord>;
  /**
   * Explicit release of the gate. This is the ONLY normal release rule, and it is
   * permitted only from a durably verified terminal state
   * (`VERIFIED_EXPECTED` | `VERIFIED_PRIOR`).
   *
   * There is deliberately no bypass from `PREPARED`, `TRANSPORT_ATTEMPTED` or
   * `AMBIGUOUS`. A proven no-op reaches a terminal state the ordinary way:
   * acquire -> PREPARED -> fresh read proves the requested note already present
   * -> PREPARED -> VERIFIED_PRIOR -> release. It never enters TRANSPORT_ATTEMPTED.
   */
  release(scope: {
    packageName: string;
    editId: string;
    expectedState: ReleaseWriteIntentState;
  }): Promise<void>;
  /** The gate verdict for a new write attempt. Read-only. */
  inspect(scope: { packageName: string; editId: string }): Promise<ReleaseWriteIntentGate>;
}

export interface ReleaseWriteIntentStoreOptions {
  readonly now?: () => Date;
  readonly attemptId?: () => string;
}

function isErrno(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === code;
}

async function assertPrivateStore(rootDir: string): Promise<void> {
  const stats = await lstat(rootDir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new ReleaseWriteIntentError(
      "WRITE_INTENT_STORE_INSECURE",
      "Release write-intent store root must be a real directory.",
    );
  }
  if ((stats.mode & 0o777) !== STORE_MODE) {
    throw new ReleaseWriteIntentError(
      "WRITE_INTENT_STORE_INSECURE",
      "Release write-intent store root must be mode 0700.",
    );
  }
}

/** Write bytes to a path durably: exclusive create, fsync file, fsync directory. */
async function writeDurable(path: string, contents: string): Promise<void> {
  const handle = await open(path, "wx", RECORD_MODE);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (cause) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw cause;
  }
  await handle.close();
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } catch {
    // Some filesystems refuse directory fsync; the record itself is already synced.
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function createFileReleaseWriteIntentStore(
  rootDir: string,
  options: ReleaseWriteIntentStoreOptions = {},
): ReleaseWriteIntentStore {
  const clock = options.now ?? ((): Date => new Date());
  const newAttemptId = options.attemptId ?? ((): string => randomUUID());

  async function ensureRoot(): Promise<void> {
    await mkdir(rootDir, { recursive: true, mode: STORE_MODE });
    await assertPrivateStore(rootDir);
  }

  async function readRecord(path: string): Promise<ReleaseWriteIntentRecord | undefined> {
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (cause) {
      if (isErrno(cause, "ENOENT")) return undefined;
      throw cause;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch (cause) {
      throw new ReleaseWriteIntentError(
        "WRITE_INTENT_RECORD_INVALID",
        "Release write-intent record is not valid JSON.",
        { cause },
      );
    }
    return parseReleaseWriteIntentRecord(parsed);
  }

  return Object.freeze({
    async acquire(input: ReleaseWriteIntentAcquireInput): Promise<ReleaseWriteIntentRecord> {
      await ensureRoot();
      const path = releaseWriteIntentPath(rootDir, input.packageName, input.editId);
      const now = clock().toISOString();
      const record: ReleaseWriteIntentRecord = Object.freeze({
        schemaVersion: RELEASE_WRITE_INTENT_SCHEMA_VERSION,
        attemptId: readPattern(newAttemptId(), "attemptId", ATTEMPT_ID_PATTERN),
        packageName: readIdentifier(input.packageName, "packageName", 255),
        editId: readIdentifier(input.editId, "editId", 256),
        track: readPattern(input.track, "track", TRACK_PATTERN),
        versionCode: readPattern(input.versionCode, "versionCode", VERSION_CODE_PATTERN),
        locale: readPattern(input.locale, "locale", LOCALE_PATTERN),
        noteDigest: readDigest(input.noteDigest, "noteDigest"),
        priorTrackDigest: readDigest(input.priorTrackDigest, "priorTrackDigest"),
        expectedTrackDigest: readDigest(input.expectedTrackDigest, "expectedTrackDigest"),
        state: "PREPARED",
        createdAtUtc: now,
        updatedAtUtc: now,
      });
      try {
        await writeDurable(path, `${JSON.stringify(record, null, 2)}\n`);
      } catch (cause) {
        if (isErrno(cause, "EEXIST")) {
          throw new ReleaseWriteIntentError(
            "WRITE_INTENT_ACTIVE",
            "An active release write intent already holds the gate for this edit.",
            { cause },
          );
        }
        throw cause;
      }
      await syncDirectory(rootDir);
      return record;
    },

    load(scope: {
      packageName: string;
      editId: string;
    }): Promise<ReleaseWriteIntentRecord | undefined> {
      return readRecord(releaseWriteIntentPath(rootDir, scope.packageName, scope.editId));
    },

    async transition(scope: {
      packageName: string;
      editId: string;
      from: ReleaseWriteIntentState;
      to: ReleaseWriteIntentState;
    }): Promise<ReleaseWriteIntentRecord> {
      await assertPrivateStore(rootDir);
      const path = releaseWriteIntentPath(rootDir, scope.packageName, scope.editId);
      const current = await readRecord(path);
      if (current === undefined) {
        throw new ReleaseWriteIntentError(
          "WRITE_INTENT_NOT_FOUND",
          "No release write intent is recorded for this edit.",
        );
      }
      if (current.state !== scope.from) {
        throw new ReleaseWriteIntentError(
          "WRITE_INTENT_TRANSITION_ILLEGAL",
          `Release write intent is in state ${current.state}, not ${scope.from}.`,
        );
      }
      if (!LEGAL_WRITE_INTENT_TRANSITIONS[current.state].includes(scope.to)) {
        throw new ReleaseWriteIntentError(
          "WRITE_INTENT_TRANSITION_ILLEGAL",
          `Release write intent cannot move from ${current.state} to ${scope.to}.`,
        );
      }
      const next: ReleaseWriteIntentRecord = Object.freeze({
        ...current,
        state: scope.to,
        updatedAtUtc: clock().toISOString(),
      });
      // Atomic replace: the exclusive gate stays held across the transition.
      const staging = `${path}.${next.updatedAtUtc.replace(/[^0-9]/gu, "")}.tmp`;
      await writeDurable(staging, `${JSON.stringify(next, null, 2)}\n`);
      await rename(staging, path);
      await syncDirectory(rootDir);
      return next;
    },

    async release(scope: {
      packageName: string;
      editId: string;
      expectedState: ReleaseWriteIntentState;
    }): Promise<void> {
      await assertPrivateStore(rootDir);
      const path = releaseWriteIntentPath(rootDir, scope.packageName, scope.editId);
      const current = await readRecord(path);
      if (current === undefined) {
        throw new ReleaseWriteIntentError(
          "WRITE_INTENT_NOT_FOUND",
          "No release write intent is recorded for this edit.",
        );
      }
      if (
        !TERMINAL_WRITE_INTENT_STATES.includes(scope.expectedState) ||
        current.state !== scope.expectedState
      ) {
        throw new ReleaseWriteIntentError(
          "WRITE_INTENT_RELEASE_DENIED",
          "The gate may only be released from a durably verified terminal state.",
        );
      }
      await unlink(path);
      await syncDirectory(rootDir);
    },

    async inspect(scope: { packageName: string; editId: string }): Promise<ReleaseWriteIntentGate> {
      const current = await readRecord(
        releaseWriteIntentPath(rootDir, scope.packageName, scope.editId),
      );
      if (current === undefined) return Object.freeze({ status: "clear" });
      return Object.freeze({
        status: "held",
        state: current.state,
        attemptId: current.attemptId,
        outcome: outcomeForHeldState(current.state),
      });
    },
  });
}

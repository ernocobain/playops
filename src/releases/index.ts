export const RELEASE_STATUSES = Object.freeze([
  "statusUnspecified",
  "draft",
  "inProgress",
  "halted",
  "completed",
] as const);

export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

/** Phase 4.6 intentionally supports only new-release configuration statuses. */
export const RELEASE_CONFIGURATION_STATUSES = Object.freeze([
  "draft",
  "inProgress",
  "completed",
] as const);

export type ReleaseConfigurationStatus = (typeof RELEASE_CONFIGURATION_STATUSES)[number];

export interface ReleaseConfigurationRelease {
  readonly name: string;
  readonly versionCodes: readonly string[];
  readonly status: ReleaseConfigurationStatus;
  readonly userFraction?: number;
}

/** Full normalized release body used when round-tripping an active Track. */
export interface ReleaseTrackReleaseUpdate {
  readonly name?: string;
  readonly versionCodes: readonly string[];
  readonly status: ReleaseStatus;
  readonly userFraction?: number;
  readonly releaseNotes?: readonly LocalizedReleaseNote[];
  readonly countryTargeting?: ReleaseCountryTargeting;
  readonly inAppUpdatePriority?: number;
}

/** Track body owned by PlayOps for the narrow Phase 4.6/4.7 update operations. */
export interface ReleaseTrackUpdateRequest {
  readonly track: string;
  readonly releases: readonly ReleaseTrackReleaseUpdate[];
}

export interface LocalizedReleaseNote {
  readonly language: string;
  readonly text: string;
}

export interface ReleaseCountryTargeting {
  readonly countries: readonly string[];
  readonly includeRestOfWorld: boolean;
}

export interface ReleaseState {
  readonly name?: string;
  readonly status: ReleaseStatus;
  /** Google represents these int64 values as decimal strings; preserve them exactly. */
  readonly versionCodes: readonly string[];
  readonly userFraction?: number;
  readonly releaseNotes?: readonly LocalizedReleaseNote[];
  readonly countryTargeting?: ReleaseCountryTargeting;
  readonly inAppUpdatePriority?: number;
}

export interface ReleaseTrackState {
  readonly track: string;
  readonly releases: readonly ReleaseState[];
}

/** Coarse live-release projection returned by applications.tracks.releases.list. */
export interface ReleaseSummaryState {
  readonly releaseName: string;
  readonly track: string;
  readonly versionCodes: readonly string[];
  /** Google ReleaseLifecycleState; intentionally not mapped to TrackRelease.status. */
  readonly releaseLifecycleState: string;
}

/** Normalized Google-assigned App Bundle identity; no raw Schema$Bundle escapes. */
export interface ReleaseBundle {
  /** Canonical positive decimal versionCode string. */
  readonly versionCode: string;
  readonly sha256: string;
  readonly sha1?: string;
}

/** Runtime-only edit identity; never persisted to config or long-lived storage. */
export interface GooglePlayEditSession {
  readonly packageName: string;
  readonly editId: string;
  readonly expiryTimeSeconds?: string;
}

export type ReleaseErrorCode =
  | "INVALID_ARGUMENT"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_INVALID"
  | "ARTIFACT_READ_FAILED"
  | "ARTIFACT_CHANGED"
  | "UPLOAD_FAILED"
  | "UPLOAD_RESPONSE_INVALID"
  | "BUNDLE_LIST_FAILED"
  | "EDIT_CREATE_FAILED"
  | "EDIT_INVALID"
  | "EDIT_SESSION_REQUIRED"
  | "EDIT_SESSION_EXPIRED"
  | "EDIT_SESSION_ALREADY_OPEN"
  | "EDIT_SESSION_INVALID"
  | "EDIT_SESSION_PACKAGE_MISMATCH"
  | "EDIT_SESSION_STORE_INVALID"
  | "EDIT_SESSION_WRITE_FAILED"
  | "TRACK_LIST_FAILED"
  | "TRACK_READ_FAILED"
  | "TRACK_MISMATCH"
  | "UPLOADED_BUNDLE_NOT_FOUND"
  | "VERSION_CODE_NOT_GREATER"
  | "INVALID_RELEASE_CONFIGURATION"
  | "STAGED_ROLLOUT_REQUIRES_EXISTING_RELEASE"
  | "OUTSTANDING_RELEASE_EXISTS"
  | "TRACK_UPDATE_FAILED"
  | "TRACK_UPDATE_RESPONSE_INVALID"
  | "INVALID_RELEASE_NOTES"
  | "CONFIGURED_RELEASE_NOT_FOUND"
  | "CONFIGURED_RELEASE_AMBIGUOUS"
  | "CONFIGURED_RELEASE_CHANGED"
  | "TRACK_STATE_NOT_ROUNDTRIPPABLE"
  | "EDIT_VALIDATION_FAILED"
  | "VALIDATION_RESPONSE_MISMATCH"
  | "VALIDATION_RESPONSE_INVALID"
  | "EDIT_VALIDATION_EXPIRED"
  | "INVALID_COMMIT_INTENT"
  | "COMMIT_POLICY_UNSUPPORTED"
  | "COMMIT_STATE_CHANGED"
  | "COMMIT_REJECTED"
  | "CHANGES_ALREADY_IN_REVIEW"
  | "COMMIT_FAILED"
  | "COMMIT_RESPONSE_INVALID"
  | "COMMIT_SESSION_CLEANUP_FAILED"
  | "COMMIT_AUDIT_FAILED"
  | "RELEASE_SUMMARY_READ_FAILED"
  | "RELEASE_SUMMARY_RESPONSE_INVALID"
  | "COMMITTED_RELEASE_NOT_OBSERVED"
  | "COMMITTED_RELEASE_AMBIGUOUS"
  | "MANAGED_EDIT_ALREADY_OPEN"
  | "VERIFICATION_EDIT_CREATE_FAILED"
  | "VERIFICATION_EDIT_RESPONSE_INVALID"
  | "VERIFICATION_TRACK_READ_FAILED"
  | "VERIFICATION_STATE_MISMATCH"
  | "VERIFICATION_EDIT_CLEANUP_FAILED"
  | "VERIFICATION_AUDIT_FAILED"
  | "INVALID_ROLLOUT_FRACTION"
  | "ROLLOUT_FRACTION_NOT_INCREASED"
  | "TARGET_ROLLOUT_RELEASE_NOT_FOUND"
  | "TARGET_ROLLOUT_RELEASE_AMBIGUOUS"
  | "ROLLOUT_NOT_IN_PROGRESS"
  | "ROLLOUT_STATE_CHANGED"
  | "ROLLOUT_UPDATE_FAILED"
  | "ROLLOUT_UPDATE_RESPONSE_INVALID"
  | "ROLLOUT_EDIT_VERIFICATION_FAILED"
  | "ROLLOUT_EDIT_CREATE_FAILED"
  | "ROLLOUT_EDIT_RESPONSE_INVALID"
  | "ROLLOUT_OPERATIONAL_CLEANUP_FAILED"
  | "ROLLOUT_COMMIT_FAILED"
  | "ROLLOUT_POST_COMMIT_NOT_OBSERVED"
  | "ROLLOUT_POST_COMMIT_MISMATCH"
  | "ROLLOUT_VERIFICATION_BLOCKED_BY_ACTIVE_EDIT"
  | "ROLLOUT_VERIFICATION_CLEANUP_FAILED"
  | "ROLLOUT_AUDIT_FAILED"
  | "ROLLOUT_STATE_NOT_ROUNDTRIPPABLE"
  | "HALTED_ROLLOUT_FRACTION_MISSING"
  | "ROLLOUT_STATUS_NOT_ELIGIBLE"
  | "STATUS_CONTROL_EDIT_CREATE_FAILED"
  | "STATUS_CONTROL_EDIT_RESPONSE_INVALID"
  | "STATUS_CONTROL_UPDATE_FAILED"
  | "STATUS_CONTROL_UPDATE_RESPONSE_INVALID"
  | "STATUS_CONTROL_EDIT_VERIFICATION_FAILED"
  | "STATUS_CONTROL_COMMIT_FAILED"
  | "STATUS_CONTROL_POST_COMMIT_NOT_OBSERVED"
  | "STATUS_CONTROL_POST_COMMIT_MISMATCH"
  | "STATUS_CONTROL_VERIFICATION_BLOCKED_BY_ACTIVE_EDIT"
  | "STATUS_CONTROL_VERIFICATION_CLEANUP_FAILED"
  | "STATUS_CONTROL_AUDIT_FAILED"
  | "EDIT_CLEANUP_JOURNAL_INVALID"
  | "EDIT_CLEANUP_JOURNAL_READ_FAILED"
  | "EDIT_CLEANUP_JOURNAL_WRITE_FAILED"
  | "EDIT_CLEANUP_JOURNAL_PACKAGE_MISMATCH"
  | "EDIT_CLEANUP_JOURNAL_REMOVE_FAILED"
  | "EDIT_CLEANUP_RECORD_NOT_FOUND"
  | "EDIT_CLEANUP_RECORD_CHANGED"
  | "EDIT_CLEANUP_RECONCILE_FAILED"
  | "EDIT_CLEANUP_REMOTE_DELETE_UNVERIFIABLE"
  | "EDIT_CLEANUP_REMOTE_DELETE_FAILED"
  | "EDIT_CLEANUP_REMOTE_INACTIVE_UNVERIFIED"
  | "EDIT_CLEANUP_STATE_UNKNOWN"
  | "EDIT_HYGIENE_STATE_INVALID"
  | "VERIFICATION_JOURNAL_WRITE_FAILED"
  | "VERIFICATION_JOURNAL_REMOVE_FAILED"
  | "ROLLOUT_JOURNAL_WRITE_FAILED"
  | "ROLLOUT_JOURNAL_REMOVE_FAILED"
  | "STATUS_CONTROL_JOURNAL_WRITE_FAILED"
  | "STATUS_CONTROL_JOURNAL_REMOVE_FAILED"
  | "TRACK_INVALID"
  | "REMOTE_DATA_INVALID";

/**
 * Safe structured classification projected exactly once at the Google boundary
 * (see `src/googleplay/publisher`). Only allowlisted machine-readable fields: no
 * Google SDK/Gaxios type, raw message, header, URL, request config, response
 * body, or credential ever crosses that boundary.
 */
export interface ReleaseErrorClassification {
  /** PublisherError code, e.g. `API_REQUEST_FAILED`. */
  readonly publisherCode?: string;
  /** Numeric HTTP status (400–599) when structurally available. */
  readonly status?: number;
  /** Google `error.status` token, e.g. `FAILED_PRECONDITION`. */
  readonly googleStatus?: string;
  /** Google `error.errors[].reason` tokens, e.g. `["failedPrecondition"]`. */
  readonly googleReasons?: readonly string[];
  /** System transport code, e.g. `ECONNRESET`. */
  readonly transportCode?: string;
}

/** Fixed safe message with the upstream failure retained only as `cause`. */
export class ReleaseError extends Error {
  override readonly name = "ReleaseError";

  constructor(
    readonly code: ReleaseErrorCode,
    message: string,
    options?: {
      cause?: unknown;
      externalStateUncertain?: boolean;
      classification?: ReleaseErrorClassification;
    },
  ) {
    super(message, options);
    this.externalStateUncertain = options?.externalStateUncertain;
    const classification = options?.classification;
    this.publisherCode = classification?.publisherCode;
    this.status = classification?.status;
    this.googleStatus = classification?.googleStatus;
    this.googleReasons = classification?.googleReasons;
    this.transportCode = classification?.transportCode;
  }

  /** Optional execution hint for known pre-mutation domain failures. */
  readonly externalStateUncertain?: boolean;
  /** PublisherError code for a mapped Google API failure. */
  readonly publisherCode?: string;
  /** Numeric HTTP status for a mapped Google API failure. */
  readonly status?: number;
  /** Google `error.status` token for a mapped Google API failure. */
  readonly googleStatus?: string;
  /** Google structured reasons for a mapped Google API failure. */
  readonly googleReasons?: readonly string[];
  /** System transport code for a mapped transport failure. */
  readonly transportCode?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate and project untrusted Publisher bundle metadata onto owned fields. */
export function normalizeReleaseBundle(value: unknown): ReleaseBundle {
  if (!isRecord(value)) {
    throw new ReleaseError("UPLOAD_RESPONSE_INVALID", "Google Play bundle metadata is invalid.");
  }
  const versionCode = value.versionCode;
  const sha256 = value.sha256;
  const sha1 = value.sha1;
  if (
    typeof versionCode !== "string" ||
    !/^[1-9]\d*$/u.test(versionCode) ||
    BigInt(versionCode) > 2_100_000_000n ||
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/iu.test(sha256)
  ) {
    throw new ReleaseError("UPLOAD_RESPONSE_INVALID", "Google Play bundle metadata is invalid.");
  }
  if (
    sha1 !== undefined &&
    sha1 !== null &&
    (typeof sha1 !== "string" || !/^[0-9a-f]{40}$/iu.test(sha1))
  ) {
    throw new ReleaseError("UPLOAD_RESPONSE_INVALID", "Google Play bundle metadata is invalid.");
  }
  return Object.freeze({
    versionCode,
    sha256: sha256.toLowerCase(),
    ...(typeof sha1 === "string" ? { sha1: sha1.toLowerCase() } : {}),
  });
}

export function validateReleasePackageName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(value)
  ) {
    throw new ReleaseError("INVALID_ARGUMENT", "Google Play package name is invalid.");
  }
  return value;
}

function editIdIsValid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    // eslint-disable-next-line no-control-regex -- reject control characters in generated edit ids
    !/[\s\x00-\x1f\x7f/]/u.test(value)
  );
}

/** Validate an ephemeral session and bind it to the composition's package. */
export function parseGooglePlayEditSession(
  value: unknown,
  expectedPackageName: string,
): GooglePlayEditSession {
  if (!isRecord(value)) {
    throw new ReleaseError("EDIT_INVALID", "Temporary edit session is invalid.");
  }
  try {
    validateReleasePackageName(expectedPackageName);
  } catch (cause) {
    throw new ReleaseError("EDIT_INVALID", "Temporary edit session is invalid.", { cause });
  }
  const allowedKeys = new Set(["packageName", "editId", "expiryTimeSeconds"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new ReleaseError("EDIT_INVALID", "Temporary edit session is invalid.");
  }
  if (value.packageName !== expectedPackageName || !editIdIsValid(value.editId)) {
    throw new ReleaseError("EDIT_INVALID", "Temporary edit session is invalid.");
  }
  let expiryTimeSeconds: string | undefined;
  if (value.expiryTimeSeconds !== undefined) {
    if (typeof value.expiryTimeSeconds !== "string" || !/^\d+$/.test(value.expiryTimeSeconds)) {
      throw new ReleaseError("EDIT_INVALID", "Temporary edit session is invalid.");
    }
    expiryTimeSeconds = value.expiryTimeSeconds;
  }
  return Object.freeze({
    packageName: expectedPackageName,
    editId: value.editId,
    ...(expiryTimeSeconds !== undefined ? { expiryTimeSeconds } : {}),
  });
}

function invalidTrack(): never {
  throw new ReleaseError("TRACK_INVALID", "Remote release track is invalid.");
}

/** Validate one exact operator-bound Google Play track identifier. */
export function validateReleaseTargetTrack(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    // eslint-disable-next-line no-control-regex -- reject unsafe controls while preserving exact spelling
    /[\x00-\x1f\x7f]/u.test(value)
  ) {
    throw new ReleaseError("INVALID_ARGUMENT", "Google Play target track is invalid.");
  }
  return value;
}

function invalidRemoteData(): never {
  throw new ReleaseError("REMOTE_DATA_INVALID", "Remote release data is invalid.");
}

function isReleaseStatus(value: unknown): value is ReleaseStatus {
  return RELEASE_STATUSES.some((candidate) => candidate === value);
}

function normalizeVersionCodes(value: unknown): readonly string[] {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) invalidRemoteData();
  const maxInt64 = "9223372036854775807";
  const codes = value.map((code: unknown) => {
    if (
      typeof code !== "string" ||
      !/^[1-9]\d*$/.test(code) ||
      code.length > maxInt64.length ||
      (code.length === maxInt64.length && code > maxInt64)
    ) {
      invalidRemoteData();
    }
    return code;
  });
  return Object.freeze(codes);
}

function normalizeCountryTargeting(value: unknown): ReleaseCountryTargeting {
  if (!isRecord(value) || !Array.isArray(value.countries)) invalidRemoteData();
  if (typeof value.includeRestOfWorld !== "boolean") invalidRemoteData();
  const countries = value.countries.map((country: unknown) => {
    if (typeof country !== "string" || !/^[A-Za-z]{2}$/u.test(country)) {
      invalidRemoteData();
    }
    return country;
  });
  return Object.freeze({
    countries: Object.freeze(countries),
    includeRestOfWorld: value.includeRestOfWorld,
  });
}

function normalizeReleaseNote(value: unknown): LocalizedReleaseNote {
  if (!isRecord(value) || typeof value.language !== "string" || typeof value.text !== "string") {
    invalidRemoteData();
  }
  let language: string | undefined;
  try {
    language = Intl.getCanonicalLocales(value.language)[0];
  } catch {
    invalidRemoteData();
  }
  if (!language) invalidRemoteData();
  return Object.freeze({ language, text: value.text });
}

function normalizeRelease(value: unknown): ReleaseState {
  if (!isRecord(value)) invalidRemoteData();
  const status = value.status;
  if (!isReleaseStatus(status)) invalidRemoteData();

  let name: string | undefined;
  if (value.name !== undefined && value.name !== null) {
    if (typeof value.name !== "string" || value.name.trim() === "") invalidRemoteData();
    name = value.name;
  }

  let userFraction: number | undefined;
  if (value.userFraction !== undefined && value.userFraction !== null) {
    if (
      typeof value.userFraction !== "number" ||
      !Number.isFinite(value.userFraction) ||
      value.userFraction <= 0 ||
      value.userFraction >= 1 ||
      (status !== "inProgress" && status !== "halted")
    ) {
      invalidRemoteData();
    }
    userFraction = value.userFraction;
  }

  let releaseNotes: readonly LocalizedReleaseNote[] | undefined;
  if (value.releaseNotes !== undefined && value.releaseNotes !== null) {
    if (!Array.isArray(value.releaseNotes)) invalidRemoteData();
    releaseNotes = Object.freeze(value.releaseNotes.map(normalizeReleaseNote));
  }

  let countryTargeting: ReleaseCountryTargeting | undefined;
  if (value.countryTargeting !== undefined) {
    countryTargeting = normalizeCountryTargeting(value.countryTargeting);
  }

  let inAppUpdatePriority: number | undefined;
  if (value.inAppUpdatePriority !== undefined && value.inAppUpdatePriority !== null) {
    if (
      typeof value.inAppUpdatePriority !== "number" ||
      !Number.isInteger(value.inAppUpdatePriority) ||
      value.inAppUpdatePriority < 0 ||
      value.inAppUpdatePriority > 5
    ) {
      invalidRemoteData();
    }
    inAppUpdatePriority = value.inAppUpdatePriority;
  }

  return Object.freeze({
    ...(name !== undefined ? { name } : {}),
    status,
    versionCodes: normalizeVersionCodes(value.versionCodes),
    ...(userFraction !== undefined ? { userFraction } : {}),
    ...(releaseNotes !== undefined ? { releaseNotes } : {}),
    ...(countryTargeting !== undefined ? { countryTargeting } : {}),
    ...(inAppUpdatePriority !== undefined ? { inAppUpdatePriority } : {}),
  });
}

function normalizeTrack(value: unknown): ReleaseTrackState {
  if (
    !isRecord(value) ||
    typeof value.track !== "string" ||
    value.track !== value.track.trim() ||
    /\s/u.test(value.track) ||
    value.track.trim() === "" ||
    // eslint-disable-next-line no-control-regex -- reject control characters in Google track ids
    /[\x00-\x1f\x7f]/u.test(value.track)
  ) {
    invalidTrack();
  }
  const rawReleases = value.releases ?? [];
  if (!Array.isArray(rawReleases)) invalidTrack();
  return Object.freeze({
    track: value.track,
    releases: Object.freeze(rawReleases.map(normalizeRelease)),
  });
}

/** Validate untrusted generated-client data and project it to owned fields only. */
export function normalizeReleaseTracks(value: unknown): readonly ReleaseTrackState[] {
  if (!Array.isArray(value)) invalidTrack();
  return Object.freeze(value.map(normalizeTrack));
}

export type ReleaseVersionCodeRelation = "greater" | "equal" | "lower" | "no-current-version";

export interface ReleaseVersionCodeComparison {
  readonly uploadedVersionCode: string;
  readonly currentMaxVersionCode: string | null;
  readonly relation: ReleaseVersionCodeRelation;
}

/** Reuse the existing canonical decimal/int64 validation for one versionCode. */
export function normalizeReleaseVersionCode(value: unknown): string {
  const normalized = normalizeVersionCodes([value])[0];
  if (normalized === undefined) invalidRemoteData();
  return normalized;
}

/**
 * Compare one validated uploaded versionCode to every versionCode on one
 * normalized target track. Array order and release status have no ordering role.
 */
export function compareVersionCodeAgainstTrack(
  uploadedVersionCode: unknown,
  track: ReleaseTrackState,
): ReleaseVersionCodeComparison {
  const uploaded = normalizeReleaseVersionCode(uploadedVersionCode);
  const [normalizedTrack] = normalizeReleaseTracks([track]);
  if (!normalizedTrack) invalidTrack();

  let currentMaxVersionCode: string | null = null;
  let currentMax: bigint | null = null;
  for (const release of normalizedTrack.releases) {
    for (const versionCode of release.versionCodes) {
      const candidate = BigInt(versionCode);
      if (currentMax === null || candidate > currentMax) {
        currentMax = candidate;
        currentMaxVersionCode = versionCode;
      }
    }
  }

  let relation: ReleaseVersionCodeRelation;
  if (currentMax === null) {
    relation = "no-current-version";
  } else {
    const uploadedValue = BigInt(uploaded);
    relation =
      uploadedValue > currentMax ? "greater" : uploadedValue === currentMax ? "equal" : "lower";
  }
  return Object.freeze({ uploadedVersionCode: uploaded, currentMaxVersionCode, relation });
}

// ---------------------------------------------------------------------------
// Phase 4.2 — managed Play edit session (durable, locally tracked)
//
// Google's Edits workflow gives each AppEdit an `id` and an `expiryTimeSeconds`
// (seconds since epoch, returned as a decimal STRING). See PLAYOPS_PLAN.md §9/§24
// for why this session must be tracked explicitly instead of created implicitly.
// ---------------------------------------------------------------------------

export const RELEASE_EDIT_SESSION_VERSION = 1 as const;

/**
 * PlayOps-owned persisted edit session. Contains no credentials, tokens, auth
 * headers, raw Google responses, or approval material. `expiryTimeSeconds` is a
 * lossless decimal string — never converted through floating point.
 */
export interface ReleaseEditSession {
  readonly version: typeof RELEASE_EDIT_SESSION_VERSION;
  readonly packageName: string;
  readonly editId: string;
  /** Epoch seconds as a validated decimal string (Google `AppEdit.expiryTimeSeconds`). */
  readonly expiryTimeSeconds: string;
  /** Local creation timestamp (ISO-8601, diagnostic metadata only). */
  readonly createdAt: string;
}

/** Unsigned decimal seconds; preserved verbatim so int64-scale values stay lossless. */
export function parseEpochSeconds(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new ReleaseError("INVALID_ARGUMENT", "Epoch seconds value is invalid.");
  }
  return value;
}

/** Lossless decimal-string comparison (`-1` | `0` | `1`), never via floating point. */
export function compareEpochSeconds(left: unknown, right: unknown): number {
  const a = BigInt(parseEpochSeconds(left));
  const b = BigInt(parseEpochSeconds(right));
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Current epoch seconds as a decimal string; injectable clock for deterministic tests. */
export function epochSecondsFromDate(clock: () => Date = () => new Date()): string {
  const date = clock();
  const milliseconds = date instanceof Date ? date.getTime() : Number.NaN;
  if (!Number.isFinite(milliseconds)) {
    throw new ReleaseError("INVALID_ARGUMENT", "Clock returned an invalid date.");
  }
  return (BigInt(Math.trunc(milliseconds)) / 1000n).toString();
}

/** A session is expired once `now >= expiryTimeSeconds` (boundary is inclusive). */
export function isReleaseEditSessionExpired(
  session: ReleaseEditSession,
  nowSeconds: string,
): boolean {
  return compareEpochSeconds(nowSeconds, session.expiryTimeSeconds) >= 0;
}

/** Project persisted local state onto the runtime-only Google boundary shape. */
export function toGooglePlayEditSession(session: ReleaseEditSession): GooglePlayEditSession {
  return Object.freeze({
    packageName: session.packageName,
    editId: session.editId,
    expiryTimeSeconds: session.expiryTimeSeconds,
  });
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

/** Build a session from one validated Google-boundary edit plus the observation time. */
export function createReleaseEditSession(
  edit: GooglePlayEditSession,
  createdAt: string,
): ReleaseEditSession {
  if (edit.expiryTimeSeconds === undefined) {
    throw new ReleaseError(
      "EDIT_INVALID",
      "Temporary edit session has no expiry; the edit cannot be tracked safely.",
    );
  }
  if (!isCanonicalIsoTimestamp(createdAt)) {
    throw new ReleaseError("INVALID_ARGUMENT", "Session creation timestamp is invalid.");
  }
  return Object.freeze({
    version: RELEASE_EDIT_SESSION_VERSION,
    packageName: validateReleasePackageName(edit.packageName),
    editId: edit.editId,
    expiryTimeSeconds: parseEpochSeconds(edit.expiryTimeSeconds),
    createdAt,
  });
}

/**
 * Structural validation of untrusted persisted state. Package identity is checked
 * against the composition binding; a mismatch is reported instead of guessed around.
 * No credential, token, or raw Google field is ever accepted here.
 */
export function parseReleaseEditSession(
  value: unknown,
  expectedPackageName: string,
): ReleaseEditSession {
  if (!isRecord(value)) {
    throw new ReleaseError("EDIT_SESSION_STORE_INVALID", "Tracked edit session is invalid.");
  }
  const allowedKeys = new Set([
    "version",
    "packageName",
    "editId",
    "expiryTimeSeconds",
    "createdAt",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new ReleaseError("EDIT_SESSION_STORE_INVALID", "Tracked edit session is invalid.");
  }
  if (value.version !== RELEASE_EDIT_SESSION_VERSION) {
    throw new ReleaseError(
      "EDIT_SESSION_STORE_INVALID",
      "Tracked edit session version is unsupported.",
    );
  }
  let boundPackageName: string;
  try {
    boundPackageName = validateReleasePackageName(expectedPackageName);
  } catch (cause) {
    throw new ReleaseError("INVALID_ARGUMENT", "Tracked edit session binding is invalid.", {
      cause,
    });
  }
  if (typeof value.packageName !== "string") {
    throw new ReleaseError("EDIT_SESSION_STORE_INVALID", "Tracked edit session is invalid.");
  }
  if (value.packageName !== boundPackageName) {
    throw new ReleaseError(
      "EDIT_SESSION_PACKAGE_MISMATCH",
      "Tracked edit session belongs to a different package.",
    );
  }
  if (!editIdIsValid(value.editId)) {
    throw new ReleaseError("EDIT_SESSION_STORE_INVALID", "Tracked edit session is invalid.");
  }
  if (!isCanonicalIsoTimestamp(value.createdAt)) {
    throw new ReleaseError("EDIT_SESSION_STORE_INVALID", "Tracked edit session is invalid.");
  }
  let expiryTimeSeconds: string;
  try {
    expiryTimeSeconds = parseEpochSeconds(value.expiryTimeSeconds);
  } catch (cause) {
    throw new ReleaseError("EDIT_SESSION_STORE_INVALID", "Tracked edit session is invalid.", {
      cause,
    });
  }
  return Object.freeze({
    version: RELEASE_EDIT_SESSION_VERSION,
    packageName: boundPackageName,
    editId: value.editId,
    expiryTimeSeconds,
    createdAt: value.createdAt,
  });
}

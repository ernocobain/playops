/**
 * Phase 4.7 — attach operator-bound localized release notes.
 *
 * The tool validates notes locally, fresh-reads the managed edit and exact target
 * track, verifies the Phase 4.6 release identity, round-trips every normalized
 * active release, updates only the target release's releaseNotes once, and
 * verifies the full expected track snapshot with a fresh read-back.
 */
import type { AgentToolBinding } from "../runtime/agent/index.js";
import type { ToolDefinition, ToolSchema } from "../runtime/tools/index.js";
import type { VerificationResult } from "../runtime/verification/index.js";
import {
  compareEpochSeconds,
  epochSecondsFromDate,
  isReleaseEditSessionExpired,
  normalizeReleaseBundle,
  normalizeReleaseTracks,
  normalizeReleaseVersionCode,
  parseReleaseEditSession,
  RELEASE_CONFIGURATION_STATUSES,
  ReleaseError,
  toGooglePlayEditSession,
  validateReleasePackageName,
  validateReleaseTargetTrack,
  type LocalizedReleaseNote,
  type ReleaseBundle,
  type ReleaseCountryTargeting,
  type ReleaseEditSession,
  type ReleaseState,
  type ReleaseTrackReleaseUpdate,
  type ReleaseTrackState,
  type ReleaseTrackUpdateRequest,
} from "./index.js";
import type { ReleaseConfigurationGateway } from "./gateway.js";
import type { ReleaseConfigurationResult } from "./configure-release-tool.js";
import { loadReleaseEditSessionState, type ReleaseEditSessionStore } from "./session-store.js";

export const RELEASES_ATTACH_RELEASE_NOTES_TOOL_NAME = "releases.attach_release_notes";
export const RELEASE_NOTE_MAX_UNICODE_CODE_POINTS = 500;

export interface ReleaseNotesAttachmentResult {
  readonly targetTrack: string;
  readonly versionCode: string;
  readonly languages: readonly string[];
  readonly noteCount: number;
  readonly updated: boolean;
}

export interface ReleaseNotesAttachmentToolOptions {
  readonly packageName: string;
  /** Exact operator/workflow-bound target; never accepted from the model. */
  readonly targetTrack: string;
  /** The exact Phase 4.6 configuration result/intent to protect against stale state. */
  readonly configuredRelease: ReleaseConfigurationResult;
  /** Verified Phase 4.3 identity used to identify the configured release. */
  readonly uploadedBundle: ReleaseBundle;
  /** Operator/workflow-bound notes; never accepted from the model. */
  readonly localizedReleaseNotes: readonly LocalizedReleaseNote[];
  readonly sessionStore: ReleaseEditSessionStore;
  readonly gateway: ReleaseConfigurationGateway;
  readonly now?: () => Date;
}

export interface ReleaseNotesAttachmentTool {
  readonly tool: ToolDefinition<Record<string, never>, ReleaseNotesAttachmentResult>;
  readonly binding: AgentToolBinding;
}

const EXPECTED_TRACK = Symbol("phase47.expectedTrack");
type InternalAttachmentResult = ReleaseNotesAttachmentResult & {
  readonly [EXPECTED_TRACK]?: ReleaseTrackState;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidNotes(message = "Localized release notes are invalid."): ReleaseError {
  return new ReleaseError("INVALID_RELEASE_NOTES", message);
}

function invalidConfiguration(message = "Configured release identity is invalid."): ReleaseError {
  return new ReleaseError("INVALID_RELEASE_CONFIGURATION", message);
}

function safePreMutationError(
  code: ReleaseError["code"],
  message: string,
  cause?: unknown,
): ReleaseError {
  return new ReleaseError(code, message, {
    ...(cause !== undefined ? { cause } : {}),
  });
}

function hasUnsafeControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) ||
      codePoint === 0x7f ||
      (codePoint >= 0x80 && codePoint <= 0x9f)
    ) {
      return true;
    }
  }
  return false;
}

function canonicalizeLanguage(value: unknown): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value !== value.trim() ||
    hasUnsafeControlCharacters(value)
  ) {
    throw invalidNotes("Release-note language is invalid.");
  }
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    if (!canonical) throw invalidNotes("Release-note language is invalid.");
    return canonical;
  } catch (cause) {
    if (cause instanceof ReleaseError) throw cause;
    throw invalidNotes("Release-note language is invalid.");
  }
}

function validateNoteText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    hasUnsafeControlCharacters(value) ||
    Array.from(value).length > RELEASE_NOTE_MAX_UNICODE_CODE_POINTS
  ) {
    throw invalidNotes("Release-note text is invalid or exceeds the 500-character limit.");
  }
  return value;
}

function normalizeOneNote(value: unknown): LocalizedReleaseNote {
  if (!isRecord(value)) throw invalidNotes();
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "language" || keys[1] !== "text") {
    throw invalidNotes();
  }
  return Object.freeze({
    language: canonicalizeLanguage(value.language),
    text: validateNoteText(value.text),
  });
}

function sortNotes(notes: readonly LocalizedReleaseNote[]): readonly LocalizedReleaseNote[] {
  return Object.freeze(
    [...notes].sort((left, right) =>
      left.language < right.language ? -1 : left.language > right.language ? 1 : 0,
    ),
  );
}

function rejectDuplicateLanguages(notes: readonly LocalizedReleaseNote[]): void {
  const seen = new Set<string>();
  for (const note of notes) {
    if (seen.has(note.language)) throw invalidNotes("Duplicate release-note language.");
    seen.add(note.language);
  }
}

/** Validate and canonicalize caller-bound notes; note text is never rewritten. */
export function normalizeReleaseNotesIntent(value: unknown): readonly LocalizedReleaseNote[] {
  if (!Array.isArray(value) || value.length < 1) {
    throw invalidNotes("At least one localized release note is required.");
  }
  const notes = value.map(normalizeOneNote);
  rejectDuplicateLanguages(notes);
  return sortNotes(notes);
}

function normalizeExistingNotes(
  value: readonly LocalizedReleaseNote[] | undefined,
): readonly LocalizedReleaseNote[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ReleaseError(
      "TRACK_STATE_NOT_ROUNDTRIPPABLE",
      "Existing target-track release notes cannot be safely round-tripped.",
    );
  }
  try {
    const notes = value.map(normalizeOneNote);
    rejectDuplicateLanguages(notes);
    return Object.freeze(notes);
  } catch (cause) {
    if (cause instanceof ReleaseError && cause.code === "TRACK_STATE_NOT_ROUNDTRIPPABLE") {
      throw cause;
    }
    throw new ReleaseError(
      "TRACK_STATE_NOT_ROUNDTRIPPABLE",
      "Existing target-track release notes cannot be safely round-tripped.",
      { cause },
    );
  }
}

function canonicalVersionCodeSet(values: readonly unknown[]): readonly string[] {
  const normalized = values.map((value) => normalizeReleaseVersionCode(value));
  const unique = [...new Set(normalized)];
  unique.sort((left, right) => {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return Object.freeze(unique);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function notesMap(notes: readonly LocalizedReleaseNote[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const note of notes ?? []) {
    if (map.has(note.language)) throw new Error("duplicate release note language");
    map.set(note.language, note.text);
  }
  return map;
}

function sameNotes(
  left: readonly LocalizedReleaseNote[] | undefined,
  right: readonly LocalizedReleaseNote[] | undefined,
): boolean {
  let leftMap: Map<string, string>;
  let rightMap: Map<string, string>;
  try {
    leftMap = notesMap(left);
    rightMap = notesMap(right);
  } catch {
    return false;
  }
  if (leftMap.size !== rightMap.size) return false;
  for (const [language, text] of leftMap) {
    if (rightMap.get(language) !== text) return false;
  }
  return true;
}

function sameCountryTargeting(
  left: ReleaseCountryTargeting | undefined,
  right: ReleaseCountryTargeting | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftCountries = [...left.countries].sort();
  const rightCountries = [...right.countries].sort();
  return (
    left.includeRestOfWorld === right.includeRestOfWorld &&
    sameStringSet(leftCountries, rightCountries)
  );
}

function sameRelease(left: ReleaseState, right: ReleaseState): boolean {
  let leftCodes: readonly string[];
  let rightCodes: readonly string[];
  try {
    leftCodes = canonicalVersionCodeSet(left.versionCodes);
    rightCodes = canonicalVersionCodeSet(right.versionCodes);
  } catch {
    return false;
  }
  return (
    left.name === right.name &&
    left.status === right.status &&
    sameStringSet(leftCodes, rightCodes) &&
    left.userFraction === right.userFraction &&
    sameNotes(left.releaseNotes, right.releaseNotes) &&
    sameCountryTargeting(left.countryTargeting, right.countryTargeting) &&
    left.inAppUpdatePriority === right.inAppUpdatePriority
  );
}

function sameTrack(left: ReleaseTrackState, right: ReleaseTrackState): boolean {
  return (
    left.track === right.track &&
    left.releases.length === right.releases.length &&
    left.releases.every((release, index) => {
      const expected = right.releases[index];
      return expected !== undefined && sameRelease(release, expected);
    })
  );
}

function cloneRelease(release: ReleaseState): ReleaseState {
  const notes = normalizeExistingNotes(release.releaseNotes);
  return Object.freeze({
    ...(release.name !== undefined ? { name: release.name } : {}),
    status: release.status,
    versionCodes: Object.freeze([...release.versionCodes]),
    ...(release.userFraction !== undefined ? { userFraction: release.userFraction } : {}),
    ...(notes !== undefined ? { releaseNotes: notes } : {}),
    ...(release.countryTargeting !== undefined
      ? {
          countryTargeting: Object.freeze({
            countries: Object.freeze([...release.countryTargeting.countries]),
            includeRestOfWorld: release.countryTargeting.includeRestOfWorld,
          }),
        }
      : {}),
    ...(release.inAppUpdatePriority !== undefined
      ? { inAppUpdatePriority: release.inAppUpdatePriority }
      : {}),
  });
}

function cloneTrack(track: ReleaseTrackState): ReleaseTrackState {
  return Object.freeze({
    track: track.track,
    releases: Object.freeze(track.releases.map(cloneRelease)),
  });
}

function releaseToUpdate(release: ReleaseState): ReleaseTrackReleaseUpdate {
  const cloned = cloneRelease(release);
  return {
    ...(cloned.name !== undefined ? { name: cloned.name } : {}),
    versionCodes: cloned.versionCodes,
    status: cloned.status,
    ...(cloned.userFraction !== undefined ? { userFraction: cloned.userFraction } : {}),
    ...(cloned.releaseNotes !== undefined ? { releaseNotes: cloned.releaseNotes } : {}),
    ...(cloned.countryTargeting !== undefined ? { countryTargeting: cloned.countryTargeting } : {}),
    ...(cloned.inAppUpdatePriority !== undefined
      ? { inAppUpdatePriority: cloned.inAppUpdatePriority }
      : {}),
  };
}

function trackToUpdate(track: ReleaseTrackState): ReleaseTrackUpdateRequest {
  return Object.freeze({
    track: track.track,
    releases: Object.freeze(track.releases.map(releaseToUpdate)),
  });
}

function replaceReleaseNotes(
  track: ReleaseTrackState,
  targetIndex: number,
  notes: readonly LocalizedReleaseNote[],
): ReleaseTrackState {
  return Object.freeze({
    track: track.track,
    releases: Object.freeze(
      track.releases.map((release, index) =>
        index === targetIndex
          ? Object.freeze({ ...cloneRelease(release), releaseNotes: notes })
          : cloneRelease(release),
      ),
    ),
  });
}

function configuredReleaseMatches(
  release: ReleaseState,
  configured: ReleaseConfigurationResult,
): boolean {
  let actualCodes: readonly string[];
  let configuredCodes: readonly string[];
  try {
    actualCodes = canonicalVersionCodeSet(release.versionCodes);
    configuredCodes = canonicalVersionCodeSet(configured.versionCodes);
  } catch {
    return false;
  }
  return (
    release.name === configured.releaseName &&
    release.status === configured.status &&
    sameStringSet(actualCodes, configuredCodes) &&
    release.userFraction === configured.userFraction
  );
}

function invalidOutput(cause?: unknown): ReleaseError {
  return new ReleaseError(
    "TRACK_UPDATE_RESPONSE_INVALID",
    "Release-note attachment result is invalid.",
    {
      ...(cause !== undefined ? { cause } : {}),
    },
  );
}

function sessionInvalid(cause?: unknown): ReleaseError {
  return new ReleaseError(
    "EDIT_SESSION_INVALID",
    "The tracked Google Play edit session could not be confirmed; no release notes were changed.",
    { ...(cause !== undefined ? { cause } : {}) },
  );
}

function ensureSessionUnexpired(session: ReleaseEditSession, clock: () => Date): void {
  if (isReleaseEditSessionExpired(session, epochSecondsFromDate(clock))) {
    throw new ReleaseError(
      "EDIT_SESSION_EXPIRED",
      "The tracked Play edit session expired before release-note attachment; no changes were made.",
    );
  }
}

function normalizeTargetTrack(value: unknown, targetTrack: string): ReleaseTrackState {
  try {
    const [track] = normalizeReleaseTracks([value]);
    if (!track || track.track !== targetTrack) {
      throw new ReleaseError(
        "TRACK_MISMATCH",
        "Google Play returned a different track than the operator-selected target.",
      );
    }
    return track;
  } catch (cause) {
    if (cause instanceof ReleaseError) throw cause;
    throw new ReleaseError("TRACK_READ_FAILED", "The configured Play track could not be read.", {
      cause,
    });
  }
}

function normalizeResponseTrack(value: unknown, targetTrack: string): ReleaseTrackState {
  try {
    return normalizeTargetTrack(value, targetTrack);
  } catch (cause) {
    throw new ReleaseError(
      "TRACK_UPDATE_RESPONSE_INVALID",
      "Google Play returned an invalid track-update response; remote state may be uncertain.",
      { cause },
    );
  }
}

function validateConfiguredRelease(
  targetTrack: string,
  configured: ReleaseConfigurationResult,
  uploadedVersionCode: string,
): ReleaseConfigurationResult {
  if (!isRecord(configured) || configured.targetTrack !== targetTrack) {
    throw invalidConfiguration("Phase 4.6 target-track identity is invalid.");
  }
  if (
    typeof configured.releaseName !== "string" ||
    configured.releaseName.trim() === "" ||
    !RELEASE_CONFIGURATION_STATUSES.some((status) => status === configured.status) ||
    !Array.isArray(configured.versionCodes)
  ) {
    throw invalidConfiguration("Phase 4.6 configured release identity is invalid.");
  }
  let versionCodes: readonly string[];
  try {
    versionCodes = canonicalVersionCodeSet(configured.versionCodes);
  } catch {
    throw invalidConfiguration("Phase 4.6 configured release versionCodes are invalid.");
  }
  if (!versionCodes.includes(uploadedVersionCode)) {
    throw invalidConfiguration(
      "Phase 4.6 configured release does not contain the uploaded versionCode.",
    );
  }
  if (configured.status === "inProgress") {
    if (
      typeof configured.userFraction !== "number" ||
      !Number.isFinite(configured.userFraction) ||
      configured.userFraction <= 0 ||
      configured.userFraction >= 1
    ) {
      throw invalidConfiguration("Phase 4.6 configured staged fraction is invalid.");
    }
  } else if (configured.userFraction !== undefined) {
    throw invalidConfiguration("Phase 4.6 configured release has an invalid fraction.");
  }
  return Object.freeze({
    targetTrack,
    releaseName: configured.releaseName,
    status: configured.status,
    versionCodes,
    ...(configured.userFraction !== undefined ? { userFraction: configured.userFraction } : {}),
  });
}

function createOutputSchema(
  targetTrack: string,
  versionCode: string,
  languages: readonly string[],
  noteCount: number,
): ToolSchema<ReleaseNotesAttachmentResult> {
  return {
    parse(value: unknown): ReleaseNotesAttachmentResult {
      if (!isRecord(value)) throw invalidOutput();
      const keys = Object.keys(value).sort();
      const expected = ["languages", "noteCount", "targetTrack", "updated", "versionCode"];
      if (
        keys.length !== expected.length ||
        keys.some((key, index) => key !== expected[index]) ||
        value.targetTrack !== targetTrack ||
        value.versionCode !== versionCode ||
        value.noteCount !== noteCount ||
        typeof value.updated !== "boolean" ||
        !Array.isArray(value.languages) ||
        value.languages.length !== languages.length ||
        value.languages.some((language, index) => language !== languages[index])
      ) {
        throw invalidOutput();
      }
      const result: ReleaseNotesAttachmentResult = {
        targetTrack,
        versionCode,
        languages,
        noteCount,
        updated: value.updated,
      };
      const expectedTrack = Reflect.get(value, EXPECTED_TRACK);
      if (expectedTrack !== undefined) {
        Object.defineProperty(result, EXPECTED_TRACK, { value: expectedTrack });
      }
      return Object.freeze(result);
    },
  };
}

function resultWithSnapshot(
  targetTrack: string,
  versionCode: string,
  notes: readonly LocalizedReleaseNote[],
  updated: boolean,
  expectedTrack: ReleaseTrackState,
): ReleaseNotesAttachmentResult {
  const result = {
    targetTrack,
    versionCode,
    languages: Object.freeze(notes.map((note) => note.language)),
    noteCount: notes.length,
    updated,
  } as InternalAttachmentResult;
  Object.defineProperty(result, EXPECTED_TRACK, { value: expectedTrack });
  return Object.freeze(result);
}

/** Create the write-only-through-the-active-edit Phase 4.7 tool. */
export function createReleaseNotesAttachmentTool(
  options: ReleaseNotesAttachmentToolOptions,
): ReleaseNotesAttachmentTool {
  const packageName = validateReleasePackageName(options?.packageName);
  const targetTrack = validateReleaseTargetTrack(options?.targetTrack);
  const uploadedBundle = normalizeReleaseBundle(options?.uploadedBundle);
  const configuredRelease = validateConfiguredRelease(
    targetTrack,
    options?.configuredRelease,
    uploadedBundle.versionCode,
  );
  const localizedReleaseNotes = normalizeReleaseNotesIntent(options?.localizedReleaseNotes);
  const store = options?.sessionStore;
  const gateway = options?.gateway;
  const clock = options?.now ?? (() => new Date());
  if (!store || typeof store.load !== "function") {
    throw new ReleaseError("INVALID_ARGUMENT", "Release edit session store is invalid.");
  }
  if (
    !gateway ||
    typeof gateway.getEdit !== "function" ||
    typeof gateway.listBundles !== "function" ||
    typeof gateway.getTrack !== "function" ||
    typeof gateway.updateTrack !== "function"
  ) {
    throw new ReleaseError("INVALID_ARGUMENT", "Release-note attachment gateway is invalid.");
  }

  const description =
    "Attach the operator-bound, locally validated localized release notes to the exact Phase 4.6-configured release inside the already-tracked Google Play edit. It fresh-reads the edit, bundle, and target track, preserves every normalized active release field, changes only releaseNotes on the matching versionCode release, updates at most once with retry disabled, and verifies the full expected track snapshot. It never generates notes, validates, commits, publishes, changes release configuration, or controls rollout.";
  const outputSchema = createOutputSchema(
    targetTrack,
    uploadedBundle.versionCode,
    localizedReleaseNotes.map((note) => note.language),
    localizedReleaseNotes.length,
  );
  const inputSchema: ToolSchema<Record<string, never>> = {
    parse(value: unknown): Record<string, never> {
      if (!isRecord(value) || Object.keys(value).length !== 0) {
        throw invalidNotes("Release-note attachment input is invalid.");
      }
      return Object.freeze({});
    },
  };

  const tool: ToolDefinition<Record<string, never>, ReleaseNotesAttachmentResult> = {
    name: RELEASES_ATTACH_RELEASE_NOTES_TOOL_NAME,
    description,
    permission: "write",
    inputSchema,
    outputSchema,
    async execute(input) {
      inputSchema.parse(input);
      let mutationAttempted = false;
      try {
        const state = await loadReleaseEditSessionState(store, epochSecondsFromDate(clock));
        if (state.status === "none") {
          throw new ReleaseError(
            "EDIT_SESSION_REQUIRED",
            "No tracked Play edit session exists for this package; run releases.open_edit first.",
          );
        }
        if (state.status === "expired") {
          throw new ReleaseError(
            "EDIT_SESSION_EXPIRED",
            "The tracked Play edit session has expired; open a new edit explicitly before release-note attachment.",
          );
        }
        const session = parseReleaseEditSession(state.session, packageName);
        const googleSession = toGooglePlayEditSession(session);

        let remoteEdit: unknown;
        try {
          remoteEdit = await gateway.getEdit(googleSession);
        } catch (cause) {
          throw sessionInvalid(cause);
        }
        try {
          if (
            !isRecord(remoteEdit) ||
            remoteEdit.id !== session.editId ||
            typeof remoteEdit.expiryTimeSeconds !== "string" ||
            compareEpochSeconds(remoteEdit.expiryTimeSeconds, session.expiryTimeSeconds) !== 0
          ) {
            throw sessionInvalid();
          }
        } catch (cause) {
          if (cause instanceof ReleaseError && cause.code === "EDIT_SESSION_INVALID") throw cause;
          throw sessionInvalid(cause);
        }
        ensureSessionUnexpired(session, clock);

        let remoteBundles: readonly ReleaseBundle[];
        try {
          remoteBundles = await gateway.listBundles(googleSession);
        } catch (cause) {
          if (cause instanceof ReleaseError) throw cause;
          throw safePreMutationError(
            "BUNDLE_LIST_FAILED",
            "Google Play bundle metadata could not be read for identity verification.",
            cause,
          );
        }
        let normalizedBundles: readonly ReleaseBundle[];
        try {
          normalizedBundles = Object.freeze(
            remoteBundles.map((bundle) => normalizeReleaseBundle(bundle)),
          );
        } catch (cause) {
          throw safePreMutationError(
            "BUNDLE_LIST_FAILED",
            "Google Play bundle metadata could not be read for identity verification.",
            cause,
          );
        }
        if (
          !normalizedBundles.some(
            (bundle) =>
              bundle.versionCode === uploadedBundle.versionCode &&
              bundle.sha256 === uploadedBundle.sha256,
          )
        ) {
          throw new ReleaseError(
            "UPLOADED_BUNDLE_NOT_FOUND",
            "The exact verified uploaded bundle identity is not present in the tracked edit.",
          );
        }
        ensureSessionUnexpired(session, clock);

        let remoteTrack: unknown;
        try {
          remoteTrack = await gateway.getTrack(googleSession, targetTrack);
        } catch (cause) {
          if (cause instanceof ReleaseError) throw cause;
          throw new ReleaseError(
            "TRACK_READ_FAILED",
            "The configured Play track could not be read.",
            {
              cause,
            },
          );
        }
        const normalizedTrack = normalizeTargetTrack(remoteTrack, targetTrack);
        let safeTrack: ReleaseTrackState;
        try {
          safeTrack = cloneTrack(normalizedTrack);
        } catch (cause) {
          if (cause instanceof ReleaseError && cause.code === "TRACK_STATE_NOT_ROUNDTRIPPABLE") {
            throw cause;
          }
          throw new ReleaseError(
            "TRACK_STATE_NOT_ROUNDTRIPPABLE",
            "The fresh target-track state cannot be safely round-tripped.",
            { cause },
          );
        }

        const matching = safeTrack.releases
          .map((release, index) => ({ release, index }))
          .filter(({ release }) => release.versionCodes.includes(uploadedBundle.versionCode));
        if (matching.length === 0) {
          throw new ReleaseError(
            "CONFIGURED_RELEASE_NOT_FOUND",
            "The Phase 4.6-configured release was not found on the fresh target track.",
          );
        }
        if (matching.length > 1) {
          throw new ReleaseError(
            "CONFIGURED_RELEASE_AMBIGUOUS",
            "The uploaded versionCode matches multiple releases on the fresh target track.",
          );
        }
        const match = matching[0];
        if (!match || !configuredReleaseMatches(match.release, configuredRelease)) {
          throw new ReleaseError(
            "CONFIGURED_RELEASE_CHANGED",
            "The Phase 4.6-configured release changed before release-note attachment.",
          );
        }

        const alreadyAttached = sameNotes(match.release.releaseNotes, localizedReleaseNotes);
        const expectedTrack = alreadyAttached
          ? safeTrack
          : replaceReleaseNotes(safeTrack, match.index, localizedReleaseNotes);
        if (alreadyAttached) {
          return resultWithSnapshot(
            targetTrack,
            uploadedBundle.versionCode,
            localizedReleaseNotes,
            false,
            expectedTrack,
          );
        }
        ensureSessionUnexpired(session, clock);
        const request = trackToUpdate(expectedTrack);
        mutationAttempted = true;
        let updateResponse: unknown;
        try {
          updateResponse = await gateway.updateTrack(googleSession, targetTrack, request);
        } catch (cause) {
          if (
            cause instanceof ReleaseError &&
            (cause.code === "TRACK_UPDATE_FAILED" || cause.code === "TRACK_UPDATE_RESPONSE_INVALID")
          ) {
            throw cause;
          }
          throw new ReleaseError(
            "TRACK_UPDATE_FAILED",
            "Google Play release-note attachment failed; remote edit state may be uncertain.",
            { cause },
          );
        }
        const responseTrack = normalizeResponseTrack(updateResponse, targetTrack);
        const responseMatches = responseTrack.releases.filter((release) =>
          release.versionCodes.includes(uploadedBundle.versionCode),
        );
        if (responseMatches.length !== 1) {
          throw new ReleaseError(
            "TRACK_UPDATE_RESPONSE_INVALID",
            "Google Play returned a track-update response without one target release; remote state may be uncertain.",
          );
        }
        return resultWithSnapshot(
          targetTrack,
          uploadedBundle.versionCode,
          localizedReleaseNotes,
          true,
          expectedTrack,
        );
      } catch (cause) {
        if (!mutationAttempted && cause instanceof ReleaseError) {
          throw new ReleaseError(cause.code, cause.message, {
            cause,
            externalStateUncertain: false,
          });
        }
        throw cause;
      }
    },
    async verify(_input, output) {
      let result: ReleaseNotesAttachmentResult;
      try {
        result = outputSchema.parse(output);
      } catch {
        return false;
      }
      const expectedTrack = Reflect.get(result, EXPECTED_TRACK) as ReleaseTrackState | undefined;
      if (!expectedTrack) return false;
      let state: Awaited<ReturnType<typeof loadReleaseEditSessionState>>;
      try {
        state = await loadReleaseEditSessionState(store, epochSecondsFromDate(clock));
      } catch {
        return false;
      }
      if (state.status !== "active") return false;
      let session: ReleaseEditSession;
      try {
        session = parseReleaseEditSession(state.session, packageName);
      } catch {
        return false;
      }
      let remoteTrack: unknown;
      try {
        remoteTrack = await gateway.getTrack(toGooglePlayEditSession(session), targetTrack);
      } catch {
        return false;
      }
      try {
        const actualTrack = cloneTrack(normalizeTargetTrack(remoteTrack, targetTrack));
        return sameTrack(actualTrack, expectedTrack);
      } catch {
        return false;
      }
    },
  };

  const binding: AgentToolBinding = {
    toolName: RELEASES_ATTACH_RELEASE_NOTES_TOOL_NAME,
    llm: {
      name: RELEASES_ATTACH_RELEASE_NOTES_TOOL_NAME,
      description,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    serializeResult(output: unknown, verification: VerificationResult): string {
      const result = outputSchema.parse(output);
      if (
        !verification ||
        verification.toolName !== RELEASES_ATTACH_RELEASE_NOTES_TOOL_NAME ||
        verification.permission !== "write" ||
        verification.required !== true ||
        verification.status !== "passed" ||
        verification.code !== "VERIFIED" ||
        verification.verified !== true
      ) {
        throw invalidOutput();
      }
      return JSON.stringify({
        targetTrack: result.targetTrack,
        versionCode: result.versionCode,
        languages: result.languages,
        noteCount: result.noteCount,
        updated: result.updated,
      });
    },
  };
  return Object.freeze({ tool, binding });
}

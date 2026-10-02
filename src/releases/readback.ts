import {
  ReleaseError,
  type ReleaseCountryTargeting,
  type LocalizedReleaseNote,
  type ReleaseState,
  type ReleaseSummaryState,
  type ReleaseTrackState,
} from "./index.js";
import type { ReleaseSummaryGateway } from "./gateway.js";
import type { ReleaseVerificationIntent } from "./readback-approval.js";

export interface DirectReleaseSummaryEvidence {
  readonly targetTrack: string;
  readonly versionCode: string;
  readonly releaseName: string;
  readonly releaseLifecycleState: string;
  readonly releaseObserved: true;
  readonly exactTrackStateVerified: false;
}

export interface ReleaseSummaryIdentityExpectation {
  readonly targetTrack: string;
  readonly versionCode: string;
  readonly expectedReleaseName: string;
}

export interface ReleaseExactTrackExpectation extends ReleaseSummaryIdentityExpectation {
  readonly expectedStatus: ReleaseState["status"];
  readonly expectedUserFraction?: number;
  readonly expectedReleaseNotes: readonly LocalizedReleaseNote[];
  readonly expectedVersionCodes?: readonly string[];
  readonly expectedCountryTargeting?: ReleaseCountryTargeting;
  readonly expectedInAppUpdatePriority?: number;
}

export interface ExactTrackReleaseEvidence {
  readonly release: ReleaseState;
  readonly exactTrackStateVerified: true;
}

function notesAsMap(
  notes: readonly LocalizedReleaseNote[] | undefined,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const note of notes ?? []) map.set(note.language, note.text);
  return map;
}

function sameNotes(
  expected: readonly LocalizedReleaseNote[],
  actual: readonly LocalizedReleaseNote[] | undefined,
): boolean {
  const expectedMap = notesAsMap(expected);
  const actualMap = notesAsMap(actual);
  if (expectedMap.size !== actualMap.size) return false;
  for (const [language, text] of expectedMap) {
    if (actualMap.get(language) !== text) return false;
  }
  return true;
}

function sameVersionCodeSet(expected: readonly string[], actual: readonly string[]): boolean {
  if (expected.length !== actual.length) return false;
  const sortCodes = (values: readonly string[]) =>
    [...values].sort((left, right) => {
      const a = BigInt(left);
      const b = BigInt(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  const left = sortCodes(expected);
  const right = sortCodes(actual);
  return left.every((value, index) => value === right[index]);
}

function sameCountryTargeting(
  expected: ReleaseCountryTargeting | undefined,
  actual: ReleaseCountryTargeting | undefined,
): boolean {
  if (expected === undefined || actual === undefined) return expected === actual;
  if (expected.includeRestOfWorld !== actual.includeRestOfWorld) return false;
  const left = [...expected.countries].sort();
  const right = [...actual.countries].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function findSummary(
  summaries: readonly ReleaseSummaryState[],
  intent: ReleaseSummaryIdentityExpectation,
): ReleaseSummaryState {
  const matches = summaries.filter((summary) => summary.versionCodes.includes(intent.versionCode));
  if (matches.length === 0) {
    throw new ReleaseError(
      "COMMITTED_RELEASE_NOT_OBSERVED",
      "The direct deployed-release summary does not yet contain the expected version.",
      { externalStateUncertain: false },
    );
  }
  if (matches.length > 1) {
    throw new ReleaseError(
      "COMMITTED_RELEASE_AMBIGUOUS",
      "The direct deployed-release summary contains the expected version more than once.",
      { externalStateUncertain: false },
    );
  }
  const summary = matches[0];
  if (
    !summary ||
    summary.track !== intent.targetTrack ||
    summary.releaseName !== intent.expectedReleaseName
  ) {
    throw new ReleaseError(
      "COMMITTED_RELEASE_NOT_OBSERVED",
      "The direct deployed-release summary does not match the expected track and release identity.",
      { externalStateUncertain: false },
    );
  }
  return summary;
}

/** Layer A: direct deployed-release summary observation. */
export async function inspectDirectReleaseSummaryForIdentity(
  gateway: ReleaseSummaryGateway,
  intent: ReleaseSummaryIdentityExpectation,
): Promise<DirectReleaseSummaryEvidence> {
  let summaries: readonly ReleaseSummaryState[];
  try {
    summaries = await gateway.listReleaseSummaries(intent.targetTrack);
  } catch (cause) {
    if (cause instanceof ReleaseError) throw cause;
    throw new ReleaseError(
      "RELEASE_SUMMARY_READ_FAILED",
      "The direct deployed-release summary could not be read.",
      { cause, externalStateUncertain: false },
    );
  }
  const summary = findSummary(summaries, intent);
  return Object.freeze({
    targetTrack: intent.targetTrack,
    versionCode: intent.versionCode,
    releaseName: summary.releaseName,
    releaseLifecycleState: summary.releaseLifecycleState,
    releaseObserved: true,
    exactTrackStateVerified: false,
  });
}

/** Layer A adapter retained for the Phase 4.11 verification intent. */
export async function inspectDirectReleaseSummary(
  gateway: ReleaseSummaryGateway,
  intent: ReleaseVerificationIntent,
): Promise<DirectReleaseSummaryEvidence> {
  return inspectDirectReleaseSummaryForIdentity(gateway, intent);
}

function exactRelease(
  track: ReleaseTrackState,
  intent: ReleaseExactTrackExpectation,
): ReleaseState {
  if (track.track !== intent.targetTrack) {
    throw new ReleaseError(
      "VERIFICATION_STATE_MISMATCH",
      "The temporary edit returned a different target track.",
      { externalStateUncertain: false },
    );
  }
  const matches = track.releases.filter((release) =>
    release.versionCodes.includes(intent.versionCode),
  );
  if (matches.length === 0) {
    throw new ReleaseError(
      "COMMITTED_RELEASE_NOT_OBSERVED",
      "The exact temporary-edit track does not contain the expected version.",
      { externalStateUncertain: false },
    );
  }
  if (matches.length > 1) {
    throw new ReleaseError(
      "COMMITTED_RELEASE_AMBIGUOUS",
      "The exact temporary-edit track contains the expected version more than once.",
      { externalStateUncertain: false },
    );
  }
  const release = matches[0];
  if (!release) {
    throw new ReleaseError(
      "VERIFICATION_STATE_MISMATCH",
      "The exact release could not be selected.",
    );
  }
  if (release.name !== intent.expectedReleaseName) {
    throw new ReleaseError(
      "VERIFICATION_STATE_MISMATCH",
      "The exact temporary-edit release name does not match the approved release.",
      { externalStateUncertain: false },
    );
  }
  if (release.status !== intent.expectedStatus) {
    throw new ReleaseError(
      "VERIFICATION_STATE_MISMATCH",
      "The exact temporary-edit release status does not match the approved status.",
      { externalStateUncertain: false },
    );
  }
  const actualFraction = release.userFraction;
  if (
    intent.expectedUserFraction === undefined
      ? actualFraction !== undefined
      : actualFraction !== intent.expectedUserFraction
  ) {
    throw new ReleaseError(
      "VERIFICATION_STATE_MISMATCH",
      "The exact temporary-edit rollout fraction does not match the approved fraction semantics.",
      { externalStateUncertain: false },
    );
  }
  if (!sameNotes(intent.expectedReleaseNotes, release.releaseNotes)) {
    throw new ReleaseError(
      "VERIFICATION_STATE_MISMATCH",
      "The exact temporary-edit release notes do not match the trusted configured notes.",
      { externalStateUncertain: false },
    );
  }
  if (
    "expectedVersionCodes" in intent &&
    intent.expectedVersionCodes !== undefined &&
    !sameVersionCodeSet(intent.expectedVersionCodes, release.versionCodes)
  ) {
    throw new ReleaseError(
      "VERIFICATION_STATE_MISMATCH",
      "The exact temporary-edit version-code set does not match the expected rollout state.",
      { externalStateUncertain: false },
    );
  }
  if (
    "expectedCountryTargeting" in intent &&
    !sameCountryTargeting(intent.expectedCountryTargeting, release.countryTargeting)
  ) {
    throw new ReleaseError(
      "VERIFICATION_STATE_MISMATCH",
      "The exact temporary-edit country targeting does not match the expected rollout state.",
      { externalStateUncertain: false },
    );
  }
  if (
    "expectedInAppUpdatePriority" in intent &&
    intent.expectedInAppUpdatePriority !== release.inAppUpdatePriority
  ) {
    throw new ReleaseError(
      "VERIFICATION_STATE_MISMATCH",
      "The exact temporary-edit update priority does not match the expected rollout state.",
      { externalStateUncertain: false },
    );
  }
  return release;
}

/** Layer B exact TrackRelease comparison; lifecycle state is intentionally unused. */
export function verifyExactTrackState(
  track: ReleaseTrackState,
  intent: ReleaseExactTrackExpectation,
): ExactTrackReleaseEvidence {
  const release = exactRelease(track, intent);
  return Object.freeze({ release, exactTrackStateVerified: true });
}

/**
 * Phase 4.13 — exact approval intents for status-only halt/resume control.
 *
 * HALT and RESUME are intentionally separate capabilities and digests. The
 * model-facing input remains `{}`; all release identity and status/fraction
 * values are composition/workflow-bound.
 */
import { createHash } from "node:crypto";
import {
  normalizeReleaseTracks,
  normalizeReleaseVersionCode,
  ReleaseError,
  validateReleasePackageName,
  validateReleaseTargetTrack,
  type ReleaseState,
  type ReleaseTrackState,
} from "./index.js";
import {
  createReleaseCommitStateDigest,
  RELEASE_COMMIT_REVIEW_BEHAVIOR,
  type ReleaseCommitReviewBehavior,
} from "./commit-approval.js";

export const HALT_ROLLOUT_TOOL_NAME = "releases.halt_rollout";
export const RESUME_ROLLOUT_TOOL_NAME = "releases.resume_rollout";

export const HALT_ROLLOUT_OPERATION_KIND = "halt_rollout" as const;
export const RESUME_ROLLOUT_OPERATION_KIND = "resume_rollout" as const;

export type ReleaseStatusControlOperation =
  typeof HALT_ROLLOUT_OPERATION_KIND | typeof RESUME_ROLLOUT_OPERATION_KIND;

export interface ReleaseStatusControlIntentInput {
  readonly packageName: string;
  readonly targetTrack: string;
  readonly versionCode: string;
  readonly releaseName: string;
  readonly currentTrackState: ReleaseTrackState;
  readonly changesInReviewBehavior?: ReleaseCommitReviewBehavior;
  readonly changesNotSentForReview?: boolean;
}

export interface ReleaseStatusControlIntent {
  readonly version: 1;
  readonly operationKind: ReleaseStatusControlOperation;
  readonly packageName: string;
  readonly targetTrack: string;
  readonly versionCode: string;
  readonly releaseName: string;
  readonly expectedCurrentStatus: "inProgress" | "halted";
  readonly desiredStatus: "inProgress" | "halted";
  readonly expectedUserFraction: number;
  readonly currentStateDigest: string;
  readonly expectedTrackState: ReleaseTrackState;
  readonly changesInReviewBehavior: "ERROR_IF_IN_REVIEW";
  readonly changesNotSentForReview: false;
  readonly requestDigest: string;
}

export interface ReleaseStatusControlApprovalBinding {
  readonly permission: "destructive";
  readonly createRequestDigest: (validatedInput: unknown) => string;
  readonly createSafeSummary: (validatedInput: unknown) => string;
}

function statusError(code: ReleaseError["code"], message: string): ReleaseError {
  return new ReleaseError(code, message, { externalStateUncertain: false });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw statusError("INVALID_ARGUMENT", "Status intent contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  throw statusError("INVALID_ARGUMENT", "Status intent contains an unsupported value.");
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function validFraction(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1;
}

function findTargetRelease(
  track: ReleaseTrackState,
  versionCode: string,
  releaseName: string,
): ReleaseState {
  const matches = track.releases.filter((release) => release.versionCodes.includes(versionCode));
  if (matches.length === 0) {
    throw statusError(
      "TARGET_ROLLOUT_RELEASE_NOT_FOUND",
      "The status-control release was not found.",
    );
  }
  if (matches.length > 1) {
    throw statusError(
      "TARGET_ROLLOUT_RELEASE_AMBIGUOUS",
      "The status-control release is ambiguous.",
    );
  }
  const release = matches[0];
  if (!release || release.name !== releaseName) {
    throw statusError(
      "TARGET_ROLLOUT_RELEASE_NOT_FOUND",
      "The status-control release identity does not match.",
    );
  }
  return release;
}

/**
 * Google documents countryTargeting as settable only for inProgress releases
 * in production. When a status-only desired Track would send it with another
 * status, PlayOps cannot prove a lossless round-trip, so it fails closed.
 */
export function assertStatusControlRoundTripSafe(
  track: ReleaseTrackState,
  versionCode: string,
  desiredTargetStatus: "inProgress" | "halted",
): void {
  for (const release of track.releases) {
    const isTarget = release.versionCodes.includes(versionCode);
    const desiredStatus = isTarget ? desiredTargetStatus : release.status;
    if (release.countryTargeting !== undefined && desiredStatus !== "inProgress") {
      throw statusError(
        "ROLLOUT_STATE_NOT_ROUNDTRIPPABLE",
        "Country targeting cannot be safely round-tripped with the desired release status.",
      );
    }
  }
}

function validatePolicy(
  changesInReviewBehavior: ReleaseCommitReviewBehavior,
  changesNotSentForReview: boolean,
): asserts changesInReviewBehavior is "ERROR_IF_IN_REVIEW" {
  if (
    changesInReviewBehavior !== RELEASE_COMMIT_REVIEW_BEHAVIOR ||
    changesNotSentForReview !== false
  ) {
    throw statusError(
      "COMMIT_POLICY_UNSUPPORTED",
      "Status control requires ERROR_IF_IN_REVIEW and changesNotSentForReview=false.",
    );
  }
}

function createIntent(
  input: ReleaseStatusControlIntentInput,
  operationKind: ReleaseStatusControlOperation,
): ReleaseStatusControlIntent {
  const packageName = validateReleasePackageName(input.packageName);
  const targetTrack = validateReleaseTargetTrack(input.targetTrack);
  const versionCode = normalizeReleaseVersionCode(input.versionCode);
  if (typeof input.releaseName !== "string" || input.releaseName.trim() === "") {
    throw statusError("INVALID_ARGUMENT", "Status-control release name is invalid.");
  }
  const [track] = normalizeReleaseTracks([input.currentTrackState]);
  if (!track || track.track !== targetTrack) {
    throw statusError("INVALID_ARGUMENT", "Status-control track identity is invalid.");
  }
  const release = findTargetRelease(track, versionCode, input.releaseName);
  const expectedCurrentStatus =
    operationKind === HALT_ROLLOUT_OPERATION_KIND ? "inProgress" : "halted";
  const desiredStatus = operationKind === HALT_ROLLOUT_OPERATION_KIND ? "halted" : "inProgress";
  if (release.status !== expectedCurrentStatus) {
    throw statusError(
      "ROLLOUT_STATUS_NOT_ELIGIBLE",
      `Status control requires current status ${expectedCurrentStatus}.`,
    );
  }
  if (!validFraction(release.userFraction)) {
    throw statusError(
      operationKind === RESUME_ROLLOUT_OPERATION_KIND
        ? "HALTED_ROLLOUT_FRACTION_MISSING"
        : "INVALID_ROLLOUT_FRACTION",
      "Status control requires a trustworthy fraction strictly between 0 and 1.",
    );
  }
  assertStatusControlRoundTripSafe(track, versionCode, desiredStatus);
  const changesInReviewBehavior = input.changesInReviewBehavior ?? RELEASE_COMMIT_REVIEW_BEHAVIOR;
  const requestedChangesNotSentForReview = input.changesNotSentForReview ?? false;
  validatePolicy(changesInReviewBehavior, requestedChangesNotSentForReview);
  const changesNotSentForReview = false as const;
  const currentStateDigest = createReleaseCommitStateDigest(track);
  const base = {
    version: 1 as const,
    operationKind,
    packageName,
    targetTrack,
    versionCode,
    releaseName: input.releaseName,
    expectedCurrentStatus,
    desiredStatus,
    expectedUserFraction: release.userFraction,
    currentStateDigest,
    expectedTrackState: track,
    changesInReviewBehavior,
    changesNotSentForReview,
    requestDigest: "",
  } satisfies Omit<ReleaseStatusControlIntent, "requestDigest"> & { requestDigest: string };
  return Object.freeze({ ...base, requestDigest: createStatusControlRequestDigest(base) });
}

export function createHaltRolloutIntent(
  input: ReleaseStatusControlIntentInput,
): ReleaseStatusControlIntent {
  return createIntent(input, HALT_ROLLOUT_OPERATION_KIND);
}

export function createResumeRolloutIntent(
  input: ReleaseStatusControlIntentInput,
): ReleaseStatusControlIntent {
  return createIntent(input, RESUME_ROLLOUT_OPERATION_KIND);
}

export function createStatusControlRequestDigest(intent: ReleaseStatusControlIntent): string {
  return digest({
    changesInReviewBehavior: intent.changesInReviewBehavior,
    changesNotSentForReview: intent.changesNotSentForReview,
    currentStateDigest: intent.currentStateDigest,
    desiredStatus: intent.desiredStatus,
    expectedCurrentStatus: intent.expectedCurrentStatus,
    expectedUserFraction: intent.expectedUserFraction,
    operationKind: intent.operationKind,
    packageName: intent.packageName,
    releaseName: intent.releaseName,
    targetTrack: intent.targetTrack,
    version: intent.version,
    versionCode: intent.versionCode,
  });
}

export function createReleaseStatusControlApprovalBinding(
  intent: ReleaseStatusControlIntent,
): ReleaseStatusControlApprovalBinding {
  const requestDigest = createStatusControlRequestDigest(intent);
  const isHalt = intent.operationKind === HALT_ROLLOUT_OPERATION_KIND;
  const summary = [
    isHalt
      ? "HALT staged rollout for the exact approved Google Play release."
      : "RESUME staged rollout for the exact approved Google Play release.",
    `App: ${intent.packageName}`,
    `Track: ${intent.targetTrack}`,
    `Version: ${intent.versionCode}`,
    `Release: ${intent.releaseName}`,
    `Current status: ${intent.expectedCurrentStatus}`,
    `New status: ${intent.desiredStatus}`,
    `Rollout fraction remains exactly: ${String(intent.expectedUserFraction)}`,
    isHalt
      ? "new users will stop receiving this release; users who already have it are not rolled back."
      : "The rollout resumes at the same fraction; eligible new users may begin receiving the release again.",
    "The workflow creates a mutation edit, changes only release status, validates, and commits the Google Play state.",
    "Creating an edit may invalidate another active edit owned by this API user for the same application.",
    "Review behavior: ERROR_IF_IN_REVIEW; PlayOps will fail rather than cancel changes already in review.",
    "Commit is attempted at most once; no automatic commit retry is performed.",
    "The same approval covers bounded post-commit direct and exact status/fraction read-back verification.",
  ].join("\n");
  return Object.freeze({
    permission: "destructive" as const,
    createRequestDigest: () => requestDigest,
    createSafeSummary: () => summary,
  });
}

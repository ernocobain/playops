/**
 * Phase 4.12 — exact approval contract for staged-rollout advancement.
 *
 * This contract is separate from publish approval and Phase 4.11 read-back
 * verification. The requested fraction and the complete approved current track
 * state are workflow-bound; the model-facing tool input remains `{}`.
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

export const RELEASES_UPDATE_ROLLOUT_FRACTION_TOOL_NAME = "releases.update_rollout_fraction";
export const RELEASE_ROLLOUT_OPERATION_KIND = "increase_staged_rollout" as const;

export interface ReleaseRolloutIntentInput {
  readonly packageName: string;
  readonly targetTrack: string;
  readonly versionCode: string;
  readonly releaseName: string;
  readonly currentTrackState: ReleaseTrackState;
  readonly newFraction: number;
  readonly changesInReviewBehavior?: ReleaseCommitReviewBehavior;
  readonly changesNotSentForReview?: boolean;
}

export interface ReleaseRolloutIntent {
  readonly version: 1;
  readonly operationKind: typeof RELEASE_ROLLOUT_OPERATION_KIND;
  readonly packageName: string;
  readonly targetTrack: string;
  readonly versionCode: string;
  readonly releaseName: string;
  readonly expectedStatus: "inProgress";
  readonly previousFraction: number;
  readonly newFraction: number;
  readonly currentStateDigest: string;
  readonly expectedTrackState: ReleaseTrackState;
  readonly changesInReviewBehavior: "ERROR_IF_IN_REVIEW";
  readonly changesNotSentForReview: false;
  readonly requestDigest: string;
}

export interface ReleaseRolloutApprovalBinding {
  readonly permission: "destructive";
  readonly createRequestDigest: (validatedInput: unknown) => string;
  readonly createSafeSummary: (validatedInput: unknown) => string;
}

function invalid(message: string): ReleaseError {
  return new ReleaseError("INVALID_ROLLOUT_FRACTION", message, {
    externalStateUncertain: false,
  });
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid("Rollout intent contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareString)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  throw invalid("Rollout intent contains an unsupported value.");
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
    throw new ReleaseError(
      "TARGET_ROLLOUT_RELEASE_NOT_FOUND",
      "The target rollout release does not contain the expected versionCode.",
      { externalStateUncertain: false },
    );
  }
  if (matches.length > 1) {
    throw new ReleaseError(
      "TARGET_ROLLOUT_RELEASE_AMBIGUOUS",
      "The expected versionCode belongs to more than one rollout release.",
      { externalStateUncertain: false },
    );
  }
  const release = matches[0];
  if (!release || release.name !== releaseName) {
    throw new ReleaseError(
      "TARGET_ROLLOUT_RELEASE_NOT_FOUND",
      "The target rollout release name does not match the trusted workflow identity.",
      { externalStateUncertain: false },
    );
  }
  return release;
}

function validatePolicy(
  changesInReviewBehavior: ReleaseCommitReviewBehavior,
  changesNotSentForReview: boolean,
): asserts changesInReviewBehavior is "ERROR_IF_IN_REVIEW" {
  if (changesInReviewBehavior !== RELEASE_COMMIT_REVIEW_BEHAVIOR) {
    throw new ReleaseError(
      "COMMIT_POLICY_UNSUPPORTED",
      "Phase 4.12 rollout control requires ERROR_IF_IN_REVIEW.",
      { externalStateUncertain: false },
    );
  }
  if (changesNotSentForReview !== false) {
    throw new ReleaseError(
      "COMMIT_POLICY_UNSUPPORTED",
      "Phase 4.12 rollout control requires changesNotSentForReview=false.",
      { externalStateUncertain: false },
    );
  }
}

/** Build an immutable trusted rollout operation from a normalized current track. */
export function createReleaseRolloutIntent(input: ReleaseRolloutIntentInput): ReleaseRolloutIntent {
  const packageName = validateReleasePackageName(input?.packageName);
  const targetTrack = validateReleaseTargetTrack(input?.targetTrack);
  const versionCode = normalizeReleaseVersionCode(input?.versionCode);
  if (typeof input?.releaseName !== "string" || input.releaseName.trim() === "") {
    throw invalid("Rollout release name is invalid.");
  }
  const [track] = normalizeReleaseTracks([input?.currentTrackState]);
  if (!track || track.track !== targetTrack) {
    throw invalid("Rollout target track state does not match the trusted target track.");
  }
  const release = findTargetRelease(track, versionCode, input.releaseName);
  if (release.status !== "inProgress") {
    throw new ReleaseError(
      "ROLLOUT_NOT_IN_PROGRESS",
      "Staged rollout advancement requires an inProgress release.",
      { externalStateUncertain: false },
    );
  }
  if (!validFraction(release.userFraction)) {
    throw invalid("The current rollout fraction must be strictly between 0 and 1.");
  }
  if (!validFraction(input.newFraction)) {
    throw invalid("The new rollout fraction must be strictly between 0 and 1.");
  }
  if (input.newFraction <= release.userFraction) {
    throw new ReleaseError(
      "ROLLOUT_FRACTION_NOT_INCREASED",
      "The new rollout fraction must be greater than the current fraction.",
      { externalStateUncertain: false },
    );
  }
  const changesInReviewBehavior = input.changesInReviewBehavior ?? RELEASE_COMMIT_REVIEW_BEHAVIOR;
  const requestedChangesNotSentForReview = input.changesNotSentForReview ?? false;
  validatePolicy(changesInReviewBehavior, requestedChangesNotSentForReview);
  const changesNotSentForReview = false as const;
  const currentStateDigest = createReleaseCommitStateDigest(track);
  const base = {
    version: 1 as const,
    operationKind: RELEASE_ROLLOUT_OPERATION_KIND,
    packageName,
    targetTrack,
    versionCode,
    releaseName: input.releaseName,
    expectedStatus: "inProgress" as const,
    previousFraction: release.userFraction,
    newFraction: input.newFraction,
    currentStateDigest,
    expectedTrackState: track,
    changesInReviewBehavior,
    changesNotSentForReview,
    requestDigest: "",
  } satisfies Omit<ReleaseRolloutIntent, "requestDigest"> & { requestDigest: string };
  const requestDigest = createReleaseRolloutRequestDigest(base);
  return Object.freeze({ ...base, requestDigest });
}

export function createReleaseRolloutRequestDigest(intent: ReleaseRolloutIntent): string {
  return digest({
    changesInReviewBehavior: intent.changesInReviewBehavior,
    changesNotSentForReview: intent.changesNotSentForReview,
    currentStateDigest: intent.currentStateDigest,
    newFraction: intent.newFraction,
    operationKind: intent.operationKind,
    packageName: intent.packageName,
    previousFraction: intent.previousFraction,
    releaseName: intent.releaseName,
    targetTrack: intent.targetTrack,
    version: intent.version,
    versionCode: intent.versionCode,
  });
}

/** Exact human approval for the whole bounded rollout-control workflow. */
export function createReleaseRolloutApprovalBinding(
  intent: ReleaseRolloutIntent,
): ReleaseRolloutApprovalBinding {
  const requestDigest = createReleaseRolloutRequestDigest(intent);
  const summary = [
    "Increase staged rollout for the exact approved Google Play release.",
    `App: ${intent.packageName}`,
    `Track: ${intent.targetTrack}`,
    `Version: ${intent.versionCode}`,
    `Release: ${intent.releaseName}`,
    `Current rollout: ${String(intent.previousFraction)}`,
    `New rollout: ${String(intent.newFraction)}`,
    "Status remains: inProgress",
    "This changes live user eligibility: the percentage of users eligible for the release after Google accepts the commit.",
    "The workflow creates a mutation edit, changes only this release's userFraction, validates, and commits the change.",
    "Creating an edit may invalidate another active edit owned by this API user for the same application.",
    "Review behavior: ERROR_IF_IN_REVIEW; PlayOps will fail rather than cancel changes already in review.",
    "Commit is attempted at most once; no automatic commit retry is performed.",
    "The same approval covers bounded post-commit direct and exact read-back verification.",
  ].join("\n");
  return Object.freeze({
    permission: "destructive" as const,
    createRequestDigest: () => requestDigest,
    createSafeSummary: () => summary,
  });
}

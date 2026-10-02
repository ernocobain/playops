/**
 * Phase 4.9 — exact approval contract for the future commit operation.
 *
 * This module deliberately contains no ToolDefinition, Publisher commit wrapper,
 * Google call, or production registry registration. It only builds immutable,
 * operator/workflow-bound commit intent and the reusable Phase 2 publish approval
 * binding that Phase 4.10 will attach to the real commit executor.
 */
import { createHash } from "node:crypto";
import type { EditValidationResult } from "./validate-edit-tool.js";
import {
  normalizeReleaseTracks,
  normalizeReleaseVersionCode,
  parseGooglePlayEditSession,
  ReleaseError,
  validateReleasePackageName,
  validateReleaseTargetTrack,
  type LocalizedReleaseNote,
  type ReleaseCountryTargeting,
  type ReleaseState,
  type ReleaseStatus,
  type ReleaseTrackState,
} from "./index.js";

export const RELEASES_COMMIT_EDIT_TOOL_NAME = "releases.commit_edit";

export const RELEASE_COMMIT_REVIEW_BEHAVIORS = Object.freeze([
  "CHANGES_IN_REVIEW_BEHAVIOR_TYPE_UNSPECIFIED",
  "CANCEL_IN_REVIEW_AND_SUBMIT",
  "ERROR_IF_IN_REVIEW",
] as const);

export type ReleaseCommitReviewBehavior = (typeof RELEASE_COMMIT_REVIEW_BEHAVIORS)[number];

/** Safer Phase 4.9 policy; the Google risky default is never silently used. */
export const RELEASE_COMMIT_REVIEW_BEHAVIOR = "ERROR_IF_IN_REVIEW" as const;

export interface ReleaseCommitIntentInput {
  readonly packageName: string;
  readonly editId: string;
  readonly targetTrack: string;
  readonly versionCode: string;
  readonly targetTrackState: ReleaseTrackState;
  readonly validatedEdit: EditValidationResult;
  readonly changesInReviewBehavior?: ReleaseCommitReviewBehavior;
  /** Trusted workflow-only option; defaults to false and is never model-controlled. */
  readonly changesNotSentForReview?: boolean;
}

export interface ReleaseCommitIntent {
  readonly version: 1;
  readonly packageName: string;
  readonly editId: string;
  readonly targetTrack: string;
  readonly versionCode: string;
  readonly releaseName: string;
  readonly releaseStatus: ReleaseStatus;
  readonly rolloutFraction?: number;
  /** Trusted exact notes retained for Phase 4.11 deep read-back; never shown in summaries. */
  readonly releaseNotes: readonly LocalizedReleaseNote[];
  readonly noteLanguages: readonly string[];
  readonly stateDigest: string;
  readonly validationExpiryTimeSeconds: string;
  readonly changesInReviewBehavior: ReleaseCommitReviewBehavior;
  readonly changesNotSentForReview: boolean;
  readonly requestDigest: string;
}

export interface ReleaseCommitApprovalBinding {
  readonly permission: "publish";
  readonly createRequestDigest: (validatedInput: unknown) => string;
  readonly createSafeSummary: (validatedInput: unknown) => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidIntent(message: string): ReleaseError {
  return new ReleaseError("INVALID_COMMIT_INTENT", message);
}

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortVersionCodes(values: readonly string[]): readonly string[] {
  const unique = [...new Set(values)];
  unique.sort((left, right) => {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return Object.freeze(unique);
}

function normalizeNotes(
  notes: readonly LocalizedReleaseNote[] | undefined,
): readonly LocalizedReleaseNote[] {
  const normalized = (notes ?? []).map((note) => {
    if (!isRecord(note) || typeof note.language !== "string" || typeof note.text !== "string") {
      throw invalidIntent("Target release notes are invalid.");
    }
    let language: string | undefined;
    try {
      language = Intl.getCanonicalLocales(note.language)[0];
    } catch (cause) {
      throw new ReleaseError("INVALID_COMMIT_INTENT", "Target release-note locale is invalid.", {
        cause,
      });
    }
    if (!language) throw invalidIntent("Target release-note locale is invalid.");
    return { language, text: note.text };
  });
  const seen = new Set<string>();
  for (const note of normalized) {
    if (seen.has(note.language))
      throw invalidIntent("Target release notes contain duplicate locales.");
    seen.add(note.language);
  }
  normalized.sort((left, right) => compareCodePoint(left.language, right.language));
  return Object.freeze(normalized.map((note) => Object.freeze(note)));
}

function canonicalCountryTargeting(
  countryTargeting: ReleaseCountryTargeting | undefined,
): Record<string, unknown> | null {
  if (countryTargeting === undefined) return null;
  return {
    countries: [...new Set(countryTargeting.countries)].sort(compareCodePoint),
    includeRestOfWorld: countryTargeting.includeRestOfWorld,
  };
}

function canonicalRelease(release: ReleaseState): Record<string, unknown> {
  const notes = normalizeNotes(release.releaseNotes);
  return {
    countryTargeting: canonicalCountryTargeting(release.countryTargeting),
    inAppUpdatePriority: release.inAppUpdatePriority ?? null,
    name: release.name ?? null,
    releaseNotes: notes.map((note) => ({ language: note.language, text: note.text })),
    status: release.status,
    userFraction: release.userFraction ?? null,
    versionCodes: sortVersionCodes(release.versionCodes),
  };
}

function canonicalTrack(track: ReleaseTrackState): Record<string, unknown> {
  const releases = track.releases.map(canonicalRelease);
  releases.sort((left, right) => compareCodePoint(stableStringify(left), stableStringify(right)));
  return { releases, track: track.track };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidIntent("Commit intent contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort(compareCodePoint)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  throw invalidIntent("Commit intent contains an unsupported value.");
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

/** Deterministic digest of normalized active-track state; exact note text is internal only. */
export function createReleaseCommitStateDigest(track: ReleaseTrackState): string {
  const [normalized] = normalizeReleaseTracks([track]);
  if (!normalized) throw invalidIntent("Target track state is invalid.");
  return sha256Canonical(canonicalTrack(normalized));
}

/** Deterministic digest of the exact future commit request identity. */
export function createReleaseCommitRequestDigest(intent: ReleaseCommitIntent): string {
  return sha256Canonical({
    changesInReviewBehavior: intent.changesInReviewBehavior,
    changesNotSentForReview: intent.changesNotSentForReview,
    editId: intent.editId,
    noteLanguages: intent.noteLanguages,
    packageName: intent.packageName,
    releaseName: intent.releaseName,
    releaseStatus: intent.releaseStatus,
    rolloutFraction: intent.rolloutFraction ?? null,
    stateDigest: intent.stateDigest,
    targetTrack: intent.targetTrack,
    toolName: RELEASES_COMMIT_EDIT_TOOL_NAME,
    validationExpiryTimeSeconds: intent.validationExpiryTimeSeconds,
    version: intent.version,
    versionCode: intent.versionCode,
  });
}

function validateIntentForApproval(intent: ReleaseCommitIntent): ReleaseCommitIntent {
  if (!isRecord(intent) || intent.version !== 1) throw invalidIntent("Commit intent is invalid.");
  validateReleasePackageName(intent.packageName);
  validateReleaseTargetTrack(intent.targetTrack);
  parseGooglePlayEditSession(
    { packageName: intent.packageName, editId: intent.editId },
    intent.packageName,
  );
  normalizeReleaseVersionCode(intent.versionCode);
  if (intent.changesInReviewBehavior !== RELEASE_COMMIT_REVIEW_BEHAVIOR) {
    throw new ReleaseError(
      "COMMIT_POLICY_UNSUPPORTED",
      "Phase 4.9 only permits ERROR_IF_IN_REVIEW commit approval policy.",
    );
  }
  if (typeof intent.changesNotSentForReview !== "boolean") {
    throw invalidIntent("changesNotSentForReview must be boolean.");
  }
  if (
    typeof intent.validationExpiryTimeSeconds !== "string" ||
    !/^\d+$/u.test(intent.validationExpiryTimeSeconds)
  ) {
    throw invalidIntent("Phase 4.8 validation evidence is invalid.");
  }
  if (
    typeof intent.releaseName !== "string" ||
    intent.releaseName.trim() === "" ||
    !RELEASE_COMMIT_REVIEW_BEHAVIORS.includes(intent.changesInReviewBehavior)
  ) {
    throw invalidIntent("Commit release identity is invalid.");
  }
  if (
    intent.rolloutFraction !== undefined &&
    (!Number.isFinite(intent.rolloutFraction) ||
      intent.rolloutFraction <= 0 ||
      intent.rolloutFraction >= 1)
  ) {
    throw invalidIntent("Commit rollout fraction is invalid.");
  }
  if (
    !Array.isArray(intent.noteLanguages) ||
    intent.noteLanguages.some((language) => typeof language !== "string") ||
    !Array.isArray(intent.releaseNotes) ||
    typeof intent.stateDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(intent.stateDigest)
  ) {
    throw invalidIntent("Commit state binding is invalid.");
  }
  normalizeNotes(intent.releaseNotes);
  return intent;
}

/** Build an immutable exact commit intent from trusted workflow state. */
export function createReleaseCommitIntent(input: ReleaseCommitIntentInput): ReleaseCommitIntent {
  const packageName = validateReleasePackageName(input?.packageName);
  const targetTrack = validateReleaseTargetTrack(input?.targetTrack);
  let editId: string;
  try {
    editId = parseGooglePlayEditSession({ packageName, editId: input?.editId }, packageName).editId;
  } catch (cause) {
    throw new ReleaseError("INVALID_COMMIT_INTENT", "Managed edit identity is invalid.", { cause });
  }
  const versionCode = normalizeReleaseVersionCode(input?.versionCode);
  if (
    !isRecord(input?.validatedEdit) ||
    input.validatedEdit.valid !== true ||
    typeof input.validatedEdit.expiryTimeSeconds !== "string" ||
    !/^\d+$/u.test(input.validatedEdit.expiryTimeSeconds)
  ) {
    throw invalidIntent("A successful Phase 4.8 validation result is required.");
  }
  const validationExpiryTimeSeconds = input.validatedEdit.expiryTimeSeconds;
  const [track] = normalizeReleaseTracks([input?.targetTrackState]);
  if (!track || track.track !== targetTrack) {
    throw invalidIntent("Target track state does not match the bound target track.");
  }
  const matches = track.releases.filter((release) => release.versionCodes.includes(versionCode));
  if (matches.length !== 1) {
    throw invalidIntent("Exactly one configured release must contain the bound versionCode.");
  }
  const release = matches[0];
  if (!release || typeof release.name !== "string" || release.name.trim() === "") {
    throw invalidIntent("Configured release name is required for commit approval.");
  }
  const changesInReviewBehavior = input.changesInReviewBehavior ?? RELEASE_COMMIT_REVIEW_BEHAVIOR;
  if (changesInReviewBehavior !== RELEASE_COMMIT_REVIEW_BEHAVIOR) {
    throw new ReleaseError(
      "COMMIT_POLICY_UNSUPPORTED",
      "Phase 4.9 only permits ERROR_IF_IN_REVIEW commit approval policy.",
    );
  }
  const changesNotSentForReview = input.changesNotSentForReview ?? false;
  if (typeof changesNotSentForReview !== "boolean") {
    throw invalidIntent("changesNotSentForReview must be boolean.");
  }
  const normalizedNotes = normalizeNotes(release.releaseNotes);
  const stateDigest = createReleaseCommitStateDigest(track);
  const base = {
    version: 1 as const,
    packageName,
    editId,
    targetTrack,
    versionCode,
    releaseName: release.name,
    releaseStatus: release.status,
    ...(release.userFraction !== undefined ? { rolloutFraction: release.userFraction } : {}),
    releaseNotes: Object.freeze(normalizedNotes),
    noteLanguages: Object.freeze(normalizedNotes.map((note) => note.language)),
    stateDigest,
    validationExpiryTimeSeconds,
    changesInReviewBehavior,
    changesNotSentForReview,
    requestDigest: "",
  } satisfies Omit<ReleaseCommitIntent, "requestDigest"> & { requestDigest: string };
  const requestDigest = createReleaseCommitRequestDigest(base);
  return Object.freeze({ ...base, requestDigest });
}

/** Reusable Phase 2 publish binding; no production commit executor is registered here. */
export function createReleaseCommitApprovalBinding(
  intent: ReleaseCommitIntent,
): ReleaseCommitApprovalBinding {
  const validated = validateIntentForApproval(intent);
  const requestDigest = createReleaseCommitRequestDigest(validated);
  const languages =
    validated.noteLanguages.length > 0 ? validated.noteLanguages.join(", ") : "(none)";
  const rollout =
    validated.rolloutFraction === undefined ? "none" : String(validated.rolloutFraction);
  const summary = [
    "PUBLISH Google Play edit.",
    `App: ${validated.packageName}`,
    `Track: ${validated.targetTrack}`,
    `Version: ${validated.versionCode}`,
    `Release: ${validated.releaseName}`,
    `Status: ${validated.releaseStatus}`,
    `Rollout fraction: ${rollout}`,
    `Release-note languages: ${languages}`,
    `Review behavior: ${validated.changesInReviewBehavior}`,
    `Changes not sent for review: ${String(validated.changesNotSentForReview)}`,
    "This action applies the currently validated edit changes to the app.",
    "Committing may invalidate other active edits for this application, including uncommitted work owned by other users.",
    "If changes are already in review, PlayOps will fail rather than cancel that review.",
    "Only this exact commit intent is approved; no other hidden operation is included.",
  ].join("\n");
  return Object.freeze({
    permission: "publish" as const,
    createRequestDigest: () => requestDigest,
    createSafeSummary: () => summary,
  });
}

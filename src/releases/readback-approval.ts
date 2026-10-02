/**
 * Phase 4.11 — separate approval contract for exact Track read-back.
 *
 * Layer A (`applications.tracks.releases.list`) is read-only and never uses this
 * binding. Layer B uses it because `edits.insert` may invalidate another active
 * edit owned by the same API user for the same application.
 */
import { createHash } from "node:crypto";
import {
  normalizeReleaseVersionCode,
  RELEASE_STATUSES,
  ReleaseError,
  validateReleasePackageName,
  validateReleaseTargetTrack,
  type LocalizedReleaseNote,
  type ReleaseStatus,
} from "./index.js";
import type { ReleaseCommitIntent } from "./commit-approval.js";

export const RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME = "releases.verify_committed_release";
export const RELEASE_VERIFICATION_OPERATION_KIND = "exact_track_state_readback" as const;

export interface ReleaseVerificationIntent {
  readonly version: 1;
  readonly operationKind: typeof RELEASE_VERIFICATION_OPERATION_KIND;
  readonly packageName: string;
  readonly targetTrack: string;
  readonly versionCode: string;
  readonly expectedReleaseName: string;
  readonly expectedStatus: ReleaseStatus;
  readonly expectedUserFraction?: number;
  readonly expectedReleaseNotes: readonly LocalizedReleaseNote[];
}

export interface ReleaseVerificationApprovalBinding {
  readonly permission: "destructive";
  readonly createRequestDigest: (validatedInput: unknown) => string;
  readonly createSafeSummary: (validatedInput: unknown) => string;
}

function invalid(message: string): ReleaseError {
  return new ReleaseError("INVALID_COMMIT_INTENT", message);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalNotes(notes: readonly LocalizedReleaseNote[]): readonly LocalizedReleaseNote[] {
  if (!Array.isArray(notes)) throw invalid("Expected release notes are invalid.");
  const normalized = notes.map((note) => {
    if (
      typeof note !== "object" ||
      note === null ||
      typeof note.language !== "string" ||
      typeof note.text !== "string"
    ) {
      throw invalid("Expected release notes are invalid.");
    }
    let language: string | undefined;
    try {
      language = Intl.getCanonicalLocales(note.language)[0];
    } catch (cause) {
      throw new ReleaseError("INVALID_COMMIT_INTENT", "Expected release-note locale is invalid.", {
        cause,
      });
    }
    if (!language) throw invalid("Expected release-note locale is invalid.");
    return { language, text: note.text };
  });
  const seen = new Set<string>();
  for (const note of normalized) {
    if (seen.has(note.language)) throw invalid("Expected release notes contain duplicate locales.");
    seen.add(note.language);
  }
  normalized.sort((left, right) => compare(left.language, right.language));
  return Object.freeze(normalized.map((note) => Object.freeze(note)));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid("Verification intent contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compare)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  throw invalid("Verification intent contains an unsupported value.");
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function validateFraction(status: ReleaseStatus, fraction: number | undefined): void {
  if (fraction !== undefined && (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1)) {
    throw invalid("Expected rollout fraction is invalid.");
  }
  if ((status === "completed" || status === "draft") && fraction !== undefined) {
    throw invalid("Completed and draft releases must not have a rollout fraction.");
  }
  if (status === "inProgress" && fraction === undefined) {
    throw invalid("An in-progress release requires an expected rollout fraction.");
  }
}

/** Build trusted Layer-B identity from the immutable Phase 4.9 commit intent. */
export function createReleaseVerificationIntent(
  intent: ReleaseCommitIntent,
): ReleaseVerificationIntent {
  if (!intent || intent.version !== 1) throw invalid("Commit intent is invalid.");
  const packageName = validateReleasePackageName(intent.packageName);
  const targetTrack = validateReleaseTargetTrack(intent.targetTrack);
  const versionCode = normalizeReleaseVersionCode(intent.versionCode);
  if (typeof intent.releaseName !== "string" || intent.releaseName.trim() === "") {
    throw invalid("Expected release name is invalid.");
  }
  if (!RELEASE_STATUSES.includes(intent.releaseStatus)) {
    throw invalid("Expected release status is invalid.");
  }
  validateFraction(intent.releaseStatus, intent.rolloutFraction);
  const expectedReleaseNotes = canonicalNotes(intent.releaseNotes);
  return Object.freeze({
    version: 1,
    operationKind: RELEASE_VERIFICATION_OPERATION_KIND,
    packageName,
    targetTrack,
    versionCode,
    expectedReleaseName: intent.releaseName,
    expectedStatus: intent.releaseStatus,
    ...(intent.rolloutFraction !== undefined
      ? { expectedUserFraction: intent.rolloutFraction }
      : {}),
    expectedReleaseNotes,
  });
}

/** Digest includes exact notes; the human summary intentionally does not. */
export function createReleaseVerificationRequestDigest(intent: ReleaseVerificationIntent): string {
  return digest({
    expectedReleaseName: intent.expectedReleaseName,
    expectedReleaseNotes: intent.expectedReleaseNotes,
    expectedStatus: intent.expectedStatus,
    expectedUserFraction: intent.expectedUserFraction ?? null,
    operationKind: intent.operationKind,
    packageName: intent.packageName,
    targetTrack: intent.targetTrack,
    version: intent.version,
    versionCode: intent.versionCode,
  });
}

/** Separate destructive approval; it never authorizes commit or any release mutation. */
export function createReleaseVerificationApprovalBinding(
  intent: ReleaseVerificationIntent,
): ReleaseVerificationApprovalBinding {
  const requestDigest = createReleaseVerificationRequestDigest(intent);
  const rollout =
    intent.expectedUserFraction === undefined ? "absent" : String(intent.expectedUserFraction);
  const languages =
    intent.expectedReleaseNotes.length === 0
      ? "(none)"
      : intent.expectedReleaseNotes.map((note) => note.language).join(", ");
  const summary = [
    "DESTRUCTIVE read-back verification of a committed Google Play release.",
    `App: ${intent.packageName}`,
    `Track: ${intent.targetTrack}`,
    `Version: ${intent.versionCode}`,
    `Expected release: ${intent.expectedReleaseName}`,
    `Expected status: ${intent.expectedStatus}`,
    `Expected rollout fraction: ${rollout}`,
    `Expected release-note languages: ${languages}`,
    "A temporary Google Play edit will be created only to inspect the exact Track state.",
    "Creating this edit may invalidate another active edit owned by this API user for the same application.",
    "No release mutation or edits.commit will be performed.",
    "The temporary edit will be deleted exactly once after inspection when its identity is trustworthy.",
    "This approval is separate from the Phase 4.9 publish approval.",
  ].join("\n");
  return Object.freeze({
    permission: "destructive" as const,
    createRequestDigest: () => requestDigest,
    createSafeSummary: () => summary,
  });
}

/**
 * Phase 4.11 / Stage 3E.1 — exact committed-release verification contracts.
 *
 * Layer A (`applications.tracks.releases.list`) is read-only and carries no
 * approval: `ReleaseVerificationIntent` below is the Layer-A identity
 * expectation and the dry-run plan intent.
 *
 * Layer B (create one temporary edit, read the exact track, delete it) is
 * destructive because `edits.insert` may invalidate another active edit owned by
 * the same API user for the same application.
 *
 * Stage 3E.1 replaced the Phase 4.11 field-comparison approval domain
 * (`exact_track_state_readback`, version 1) with the durable commit-state digest
 * domain (`exact_commit_state_readback`, version 2): after a commit is
 * acknowledged the field-level expectation (release notes, rollout fraction)
 * is not durably stored anywhere, while
 * `ReleaseCommitAttemptJournalRecord.expectedStateDigest` is. The old approval
 * constructors were removed, so an old-domain approval can never authorize the
 * new semantics.
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

/**
 * Layer-A identity / dry-run plan operation kind. Since Stage 3E.1 this is NOT an
 * approval domain: the Layer-B approval binds
 * `RELEASE_STATE_VERIFICATION_OPERATION_KIND` instead.
 */
export const RELEASE_VERIFICATION_OPERATION_KIND = "exact_track_state_readback" as const;

/** Stage 3E.1 Layer-B approval domain: durable commit-state digest verification. */
export const RELEASE_STATE_VERIFICATION_OPERATION_KIND = "exact_commit_state_readback" as const;
export const RELEASE_STATE_VERIFICATION_INTENT_VERSION = 2 as const;

/**
 * Layer-A identity expectation for one committed release: which app, track,
 * version and release name must appear in the direct deployed-release summary.
 * It is never an approval domain and never an exact-state proof.
 */
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

/**
 * Stage 3E.1 Layer-B intent: the durable expectation that survives an
 * acknowledged commit.
 *
 * `expectedStateDigest` is the decisive authority and is compared against
 * `createReleaseCommitStateDigest(observedTrack)` and nothing else.
 * `expectedReleaseName` is a durable Layer-A cross-check (the commit-attempt
 * journal record's release name); it is never an exact-proof substitute.
 * Release-note text and rollout fraction are deliberately absent: they are not
 * durably stored and are already covered by the digest.
 */
export interface ReleaseStateVerificationIntent {
  readonly version: typeof RELEASE_STATE_VERIFICATION_INTENT_VERSION;
  readonly operationKind: typeof RELEASE_STATE_VERIFICATION_OPERATION_KIND;
  readonly packageName: string;
  readonly targetTrack: string;
  readonly versionCode: string;
  readonly expectedReleaseName: string;
  readonly expectedStateDigest: string;
}

/** Durable server-owned evidence accepted by the Stage 3E.1 intent builder. */
export interface ReleaseStateVerificationIntentInput {
  readonly packageName: string;
  readonly targetTrack: string;
  readonly versionCode: string;
  readonly expectedReleaseName: string;
  readonly expectedStateDigest: string;
}

export interface ReleaseStateVerificationApprovalBinding {
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

/**
 * Stage 3E.1: build the Layer-B intent from durable commit evidence only.
 *
 * The only accepted inputs are values that survive an acknowledged commit
 * (package, track, version, the journal's release name and its
 * `expectedStateDigest`). Release-note text and rollout fraction are neither
 * required nor accepted.
 */
export function createReleaseStateVerificationIntent(
  input: ReleaseStateVerificationIntentInput,
): ReleaseStateVerificationIntent {
  if (typeof input !== "object" || input === null) {
    throw invalid("Verification evidence is invalid.");
  }
  const packageName = validateReleasePackageName(input.packageName);
  const targetTrack = validateReleaseTargetTrack(input.targetTrack);
  const versionCode = normalizeReleaseVersionCode(input.versionCode);
  if (typeof input.expectedReleaseName !== "string" || input.expectedReleaseName.trim() === "") {
    throw invalid("Expected committed release name is invalid.");
  }
  if (
    typeof input.expectedStateDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(input.expectedStateDigest)
  ) {
    throw invalid("Expected committed-state digest is invalid.");
  }
  return Object.freeze({
    version: RELEASE_STATE_VERIFICATION_INTENT_VERSION,
    operationKind: RELEASE_STATE_VERIFICATION_OPERATION_KIND,
    packageName,
    targetTrack,
    versionCode,
    expectedReleaseName: input.expectedReleaseName,
    expectedStateDigest: input.expectedStateDigest,
  });
}

/**
 * Digest of the exact Stage 3E.1 Layer-B verification request. It binds the
 * durable commit-state digest, so it can never collide with the retired
 * Phase 4.11 field-comparison domain (different version and operation kind).
 */
export function createReleaseStateVerificationRequestDigest(
  intent: ReleaseStateVerificationIntent,
): string {
  return digest({
    expectedReleaseName: intent.expectedReleaseName,
    expectedStateDigest: intent.expectedStateDigest,
    operationKind: intent.operationKind,
    packageName: intent.packageName,
    targetTrack: intent.targetTrack,
    version: intent.version,
    versionCode: intent.versionCode,
  });
}

/** Separate destructive approval; it never authorizes commit, publish, or notes. */
export function createReleaseStateVerificationApprovalBinding(
  intent: ReleaseStateVerificationIntent,
): ReleaseStateVerificationApprovalBinding {
  const requestDigest = createReleaseStateVerificationRequestDigest(intent);
  const summary = [
    "DESTRUCTIVE read-back verification of the committed Google Play release state.",
    `App: ${intent.packageName}`,
    `Track: ${intent.targetTrack}`,
    `Version: ${intent.versionCode}`,
    `Expected release: ${intent.expectedReleaseName}`,
    `Expected committed-state digest: ${intent.expectedStateDigest}`,
    "Success requires the observed committed track state to digest-match that durable expected digest exactly; no release-note or rollout-fraction comparison is performed.",
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

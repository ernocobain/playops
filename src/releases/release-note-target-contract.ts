/**
 * Stage 2.4.1 — PINNED targeting contract for the future `attach_notes` daemon
 * operation.
 *
 * DOCUMENTATION AND DATA ONLY. This module performs no derivation, no I/O, no
 * Google call and no `tracks.update`. It exists so the contract agreed for
 * Stage 3C is assertable rather than buried in a comment: a future
 * implementation must satisfy every step and every fail-closed condition below,
 * and changing any of them requires deliberately editing this file (and the
 * tests that pin it).
 *
 * OPERATOR INPUT (daemon protocol v4, semantic only):
 *   track, versionCode, locale, noteText
 *
 * The client never supplies `packageName`, `editId`, a release object, a bundle
 * object, a bundle sha256, `stateDigest`, `requestDigest`, a validation expiry,
 * `configuredRelease`, `uploadedBundle` or a filesystem path — the protocol
 * rejects those as forbidden client fields.
 */

/**
 * The exact derivation the daemon must perform. Selected by CONTAINMENT on the
 * release and by EQUALITY on the bundle; never by position, recency or size.
 */
export const RELEASE_NOTE_TARGET_DERIVATION_STEPS: readonly string[] = Object.freeze([
  "load the daemon-owned managed edit",
  "fresh-read the requested track inside that edit",
  "find exactly one release whose versionCodes CONTAINS the requested versionCode",
  "configuredRelease.versionCodes = that release's COMPLETE canonical versionCode set (never just the requested versionCode)",
  "configuredRelease.releaseName = that fresh release's name",
  "configuredRelease.status = that fresh release's status",
  "configuredRelease.userFraction = that fresh release's userFraction, preserving presence/absence exactly",
  "listBundles(managed edit)",
  "find exactly one ReleaseBundle whose versionCode equals the requested versionCode",
  "use that bundle's trusted sha256/sha1 values directly",
]);

/**
 * Heuristics that are explicitly NOT authorised. Each would invent product
 * semantics the operator did not express.
 */
export const RELEASE_NOTE_TARGET_FORBIDDEN_HEURISTICS: readonly string[] = Object.freeze([
  "first release on the track",
  "last release on the track",
  "latest release on the track",
  "largest versionCode on the track",
  "using only the requested versionCode as configuredRelease.versionCodes",
]);

export type ReleaseNoteTargetFailClosedCondition =
  | "NO_MATCHING_RELEASE"
  | "MULTIPLE_MATCHING_RELEASES"
  | "RELEASE_NAME_ABSENT"
  | "RELEASE_STATUS_HALTED"
  | "RELEASE_STATUS_UNSPECIFIED"
  | "NO_MATCHING_BUNDLE"
  | "MULTIPLE_MATCHING_BUNDLES"
  | "BUNDLE_NORMALIZATION_FAILED";

/**
 * Every condition under which the future operation MUST fail closed with zero
 * remote mutation. There is no heuristic fallback for any of them.
 */
export const RELEASE_NOTE_TARGET_FAIL_CLOSED_CONDITIONS: readonly {
  readonly code: ReleaseNoteTargetFailClosedCondition;
  readonly reason: string;
}[] = Object.freeze([
  {
    code: "NO_MATCHING_RELEASE",
    reason: "No release on the fresh track contains the requested versionCode.",
  },
  {
    code: "MULTIPLE_MATCHING_RELEASES",
    reason: "More than one release contains the requested versionCode; the target is ambiguous.",
  },
  {
    code: "RELEASE_NAME_ABSENT",
    reason:
      "The matched release has no name, so configuredRelease.releaseName (a required string) cannot be constructed to match it.",
  },
  {
    code: "RELEASE_STATUS_HALTED",
    reason:
      "A halted release is not a valid configuration status, so no legal configuredRelease.status exists.",
  },
  {
    code: "RELEASE_STATUS_UNSPECIFIED",
    reason:
      "statusUnspecified is not a valid configuration status, so no legal configuredRelease.status exists.",
  },
  {
    code: "NO_MATCHING_BUNDLE",
    reason: "No bundle in the managed edit carries the requested versionCode.",
  },
  {
    code: "MULTIPLE_MATCHING_BUNDLES",
    reason: "More than one bundle carries the requested versionCode.",
  },
  {
    code: "BUNDLE_NORMALIZATION_FAILED",
    reason:
      "The bundle metadata could not be normalized to trusted ReleaseBundle identity (including sha256).",
  },
]);

/**
 * The verification contract the future operation must satisfy before any
 * mutation, and the exact expectation the production tool enforces.
 *
 * Version-code strictness, deliberately NOT restated here as a duplicate rule:
 * the wire protocol accepts its canonical semantic form, while trusted bundle
 * normalization in `normalizeReleaseBundle` is stricter (positive canonical
 * Google bundle versionCode within the repository's production bound, with
 * normalized bundle metadata). A protocol-valid value that cannot resolve to a
 * trusted bundle therefore fails closed during derivation. No bundle identity is
 * ever fabricated or normalized from such input. Reuse that helper; do not
 * re-implement its bound here.
 */
export const RELEASE_NOTE_TARGET_VERSION_CODE_NOTE =
  "Protocol validation is not bundle resolution: an unresolvable versionCode fails closed at derivation, it is never normalized into a bundle identity.";

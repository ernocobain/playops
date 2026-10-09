/**
 * Stage 2.4.2 — the EXACT release-notes track-state semantics, shared.
 *
 * This module is the single source of truth for three things the production
 * `releases.attach_release_notes` tool and the future daemon write-intent logic
 * must agree on, byte for byte:
 *
 *   1. the expected-track construction (the note merge)
 *   2. exact track equality
 *   3. a track-state digest whose equivalence semantics match that equality
 *
 * Why it exists: `sameTrack` in the production tool is RELEASE-ORDER-SENSITIVE,
 * while `createReleaseCommitStateDigest` sorts releases and is therefore
 * order-insensitive. Those are different relations, so the commit digest cannot
 * stand in as the write-intent's prior/expected digest without the daemon's
 * settlement decision disagreeing with the production verifier. Rather than
 * write a second algorithm, the production logic is extracted here verbatim and
 * both callers consume it.
 *
 * PURE LOGIC ONLY: no gateway, filesystem, session store, audit, approval,
 * clock, Google or daemon dependency. The merge and equality bodies below are
 * moved unchanged from `release-notes-tool.ts`; only their names changed.
 */
import { createHash } from "node:crypto";
import {
  normalizeReleaseVersionCode,
  ReleaseError,
  type LocalizedReleaseNote,
  type ReleaseCountryTargeting,
  type ReleaseState,
  type ReleaseTrackState,
} from "./index.js";

/** Maximum Unicode code points in one localized release note (moved verbatim). */
export const RELEASE_NOTE_MAX_UNICODE_CODE_POINTS = 500;

/** Message used when existing notes cannot be round-tripped (moved verbatim). */
const NOT_ROUNDTRIPPABLE_MESSAGE =
  "Existing target-track release notes cannot be safely round-tripped.";

/** Local type guard. `isRecord` stays in the tool for unrelated input parsing. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exported because the production tool also uses it for its own input errors. */
export function invalidNotes(message = "Localized release notes are invalid."): ReleaseError {
  return new ReleaseError("INVALID_RELEASE_NOTES", message);
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
    throw new ReleaseError("TRACK_STATE_NOT_ROUNDTRIPPABLE", NOT_ROUNDTRIPPABLE_MESSAGE);
  }
  try {
    const notes = value.map(normalizeOneNote);
    rejectDuplicateLanguages(notes);
    return Object.freeze(notes);
  } catch (cause) {
    if (cause instanceof ReleaseError && cause.code === "TRACK_STATE_NOT_ROUNDTRIPPABLE") {
      throw cause;
    }
    throw new ReleaseError("TRACK_STATE_NOT_ROUNDTRIPPABLE", NOT_ROUNDTRIPPABLE_MESSAGE, { cause });
  }
}

export function canonicalVersionCodeSet(values: readonly unknown[]): readonly string[] {
  const normalized = values.map((value) => normalizeReleaseVersionCode(value));
  const unique = [...new Set(normalized)];
  unique.sort((left, right) => {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return Object.freeze(unique);
}

export function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
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

/** Exported because the production tool calls it directly for its no-op check. */
export function sameReleaseNotes(
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
    sameReleaseNotes(left.releaseNotes, right.releaseNotes) &&
    sameCountryTargeting(left.countryTargeting, right.countryTargeting) &&
    left.inAppUpdatePriority === right.inAppUpdatePriority
  );
}

/**
 * Exact track equality, moved verbatim from the production tool.
 *
 * Release ARRAY ORDER IS SIGNIFICANT. Do not substitute the commit tool's
 * order-insensitive canonical equality here.
 */
export function sameReleaseNotesTrackState(
  left: ReleaseTrackState,
  right: ReleaseTrackState,
): boolean {
  return (
    left.track === right.track &&
    left.releases.length === right.releases.length &&
    left.releases.every((release, index) => {
      const expected = right.releases[index];
      return expected !== undefined && sameRelease(release, expected);
    })
  );
}

/** Exported because the production tool clones releases when building updates. */
export function cloneReleaseState(release: ReleaseState): ReleaseState {
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

/** Exported because the production tool clones tracks for read-back comparison. */
export function cloneReleaseNotesTrack(track: ReleaseTrackState): ReleaseTrackState {
  return Object.freeze({
    track: track.track,
    releases: Object.freeze(track.releases.map(cloneReleaseState)),
  });
}

/**
 * The exact expected state after attaching `notes` to the release at
 * `targetIndex`: the note merge, moved verbatim from the production tool.
 *
 * Release order, identity, name, status, the complete versionCode list,
 * userFraction presence/value, countryTargeting, inAppUpdatePriority, every
 * unrelated release and every unrelated note locale are preserved. Only the
 * targeted release's `releaseNotes` is replaced.
 */
export function createExpectedReleaseNotesTrack(
  track: ReleaseTrackState,
  targetIndex: number,
  notes: readonly LocalizedReleaseNote[],
): ReleaseTrackState {
  return Object.freeze({
    track: track.track,
    releases: Object.freeze(
      track.releases.map((release, index) =>
        index === targetIndex
          ? Object.freeze({ ...cloneReleaseState(release), releaseNotes: notes })
          : cloneReleaseState(release),
      ),
    ),
  });
}

/**
 * Canonical projection consumed by `createReleaseNotesTrackStateDigest`.
 *
 * Every part of it is derived from the SAME private helpers `sameRelease` uses
 * (`canonicalVersionCodeSet`, `notesMap`, the same `undefined` semantics), so
 * there is one set of rules rather than two. It is built with a fixed key order
 * and contains only primitives and arrays, so `JSON.stringify` is deterministic.
 *
 * Release array order is preserved, which is what makes the digest
 * order-sensitive exactly like `sameReleaseNotesTrackState`.
 */
function canonicalTrackProjection(track: ReleaseTrackState): unknown {
  return {
    track: track.track,
    releases: track.releases.map((release) => ({
      countryTargeting:
        release.countryTargeting === undefined
          ? null
          : {
              countries: [...release.countryTargeting.countries].sort(),
              includeRestOfWorld: release.countryTargeting.includeRestOfWorld,
            },
      inAppUpdatePriority: release.inAppUpdatePriority ?? null,
      name: release.name ?? null,
      releaseNotes: canonicalNotesForProjection(release.releaseNotes),
      status: release.status,
      userFraction: release.userFraction ?? null,
      versionCodes: canonicalVersionCodeSet(release.versionCodes),
    })),
  };
}

function canonicalNotesForProjection(
  notes: readonly LocalizedReleaseNote[] | undefined,
): readonly (readonly [string, string])[] {
  let map: Map<string, string>;
  try {
    map = notesMap(notes);
  } catch (cause) {
    // `sameReleaseNotes` answers `false` for duplicate languages. A digest cannot
    // mirror a non-reflexive relation, so it rejects the state instead — which is
    // the same stance the tool's round-trip clone already takes.
    throw new ReleaseError("TRACK_STATE_NOT_ROUNDTRIPPABLE", NOT_ROUNDTRIPPABLE_MESSAGE, { cause });
  }
  return [...map.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * SHA-256 of a canonical representation whose equivalence semantics match
 * `sameReleaseNotesTrackState`, including release order.
 *
 * This is deliberately NOT `createReleaseCommitStateDigest`: that helper sorts
 * releases, so for a release-order permutation it produces an EQUAL digest where
 * this one (and the production verifier) correctly reports a difference.
 */
export function createReleaseNotesTrackStateDigest(track: ReleaseTrackState): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalTrackProjection(track)), "utf8")
    .digest("hex");
}

/** Human-verifiable semantic approval preimages. No signing or file access.
 * Identifiers/integrity fingerprints are explicitly separate from human facts.
 * Request id, nonce and expiry remain solely in the unchanged signed payload.
 */
import { createHash } from "node:crypto";
import {
  normalizeReleaseVersionCode,
  RELEASE_STATUSES,
  validateReleasePackageName,
  validateReleaseTargetTrack,
} from "../releases/index.js";
import { stableStringify } from "./canonical-json.js";

export const APPROVAL_STATEMENT_VERSION = 1 as const;
export type ApprovalOperation = "open_edit" | "commit" | "verify_committed" | "reconcile_commit";
export interface ApprovalStatement {
  readonly statementVersion: typeof APPROVAL_STATEMENT_VERSION;
  readonly operation: ApprovalOperation;
  readonly toolName: string;
  readonly permission: "destructive" | "publish" | "read";
  readonly packageName: string;
  readonly facts: Readonly<Record<string, unknown>>;
  readonly integrity?: Readonly<Record<string, unknown>>;
  readonly consequences: readonly string[];
}
/** Versioned, closed semantic vocabulary; a parser cannot accept false safety claims. */
export const APPROVAL_CONSEQUENCES: Readonly<Record<ApprovalOperation, readonly string[]>> =
  Object.freeze({
    open_edit: Object.freeze([
      "Open one Google Play edit and track its identity locally; refuses a tracked unexpired session.",
      "Creating this edit may invalidate another active edit owned by this API user for this app and lose uncommitted work.",
      "This action does not publish or commit, upload, validate, or change a track; no insert retry.",
    ]),
    commit: Object.freeze([
      "PUBLISH: commit the entire validated edit, not only the named track or selected version; exactly one commit transport, no retry.",
      "All target-track releases and exact localized notes are shown. Other app-edit contents are not enumerated; trust the managed edit provenance.",
      "Committing may invalidate other active edits for this app, including other users' uncommitted work.",
      "If changes are already in review, fail rather than cancel that review (ERROR_IF_IN_REVIEW).",
      "Commit acknowledgement is not remote verification or serving/device propagation proof.",
    ]),
    verify_committed: Object.freeze([
      "Verify the named committed release: direct deployed-summary identity cross-check, then exact target-track fingerprint comparison against durable commit evidence.",
      "Create at most one temporary Google Play edit to inspect the track; inserting may invalidate this API user's other active edit and lose uncommitted work.",
      "Delete only that exact temporary edit once after inspection with an identity guard and retries disabled; uncertain identity or cleanup requires recovery, not another insert/delete.",
      "Historical exact notes, rollout and status are not available from the verification intent; the recorded candidate fingerprint does not reveal their text.",
      "No commit, publication, upload, track or release-note write is authorized. This read-back is not serving/device propagation proof or a second publish approval.",
    ]),
    reconcile_commit: Object.freeze([
      "Recover only this exact durable commit attempt: inspect the original edit first; never delete the original and never retry or perform a commit.",
      "Probe mode is read-only. verify_expired may create at most one temporary edit only after original expiry is established and no prior insert was attempted; an insert may invalidate this API user's active edit and lose uncommitted work.",
      "If a temporary identity already exists, recover only that identity; delete it only if not already attempted, with exact identity pre-read and no retries. Confirm cleanup before accepting durable track proof.",
      "Expected candidate state plus verified cleanup can establish committed. Exact active original edit, transport never attempted, or a known negative outcome can establish not committed.",
      "Prior or unrelated observed state, missing proof, unavailable original read, lost temporary identity or unconfirmed cleanup stays ambiguous; cleanup alone does not prove publication.",
      "Historical exact notes are not available; fingerprints bind the full journal snapshot, not readable note text. No release writes, uploads, or serving/device propagation claim.",
    ]),
  });
export function canonicalApprovalStatement(statement: ApprovalStatement): string {
  return stableStringify(statement);
}
export function approvalStatementDigest(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
/** Recognize former opaque domains against freshly derived trusted evidence.
 * No schema marker is invented: all other drift is still refused by the existing digest check.
 */
export function isLegacyOpaqueApproval(requestDigest: string, canonical: string): boolean {
  const statement = parseApprovalStatementCanonical(canonical);
  const integrity = statement.integrity;
  return (
    integrity !== undefined &&
    [
      integrity.commitBindingFingerprint,
      integrity.verificationBindingFingerprint,
      integrity.candidateFingerprint,
    ].includes(requestDigest)
  );
}
function requireFact(condition: boolean, detail: string): asserts condition {
  if (!condition) throw new TypeError(`Approval statement is invalid: ${detail}.`);
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireFact(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "expected object",
  );
  const r = value as Record<string, unknown>;
  requireFact(
    Object.keys(r).length === keys.length && keys.every((k) => Object.hasOwn(r, k)),
    "unexpected fields",
  );
  return r;
}
function text(value: unknown, blank = false): asserts value is string {
  requireFact(typeof value === "string" && (blank || value.trim().length > 0), "expected text");
}
function hex(value: unknown): void {
  requireFact(
    typeof value === "string" && /^[0-9a-f]{64}$/u.test(value),
    "expected SHA256 fingerprint",
  );
}
function nullableHex(value: unknown): void {
  if (value !== null) hex(value);
}
function bool(value: unknown): void {
  requireFact(typeof value === "boolean", "expected boolean");
}
function choice(value: unknown, choices: readonly unknown[]): void {
  requireFact(choices.includes(value), "unsupported value");
}
function code(value: unknown): void {
  normalizeReleaseVersionCode(value);
}
function trackName(value: unknown): void {
  validateReleaseTargetTrack(value);
}
function orderedStrings(
  value: unknown,
  compare: (a: string, b: string) => number = (a, b) => (a < b ? -1 : a > b ? 1 : 0),
): string[] {
  requireFact(Array.isArray(value), "expected ordered set");
  const strings: string[] = [];
  for (const item of value as unknown[]) {
    text(item);
    strings.push(item);
  }
  requireFact(
    strings.every((s, i) => i === 0 || compare(strings[i - 1] ?? "", s) < 0),
    "noncanonical set order",
  );
  return strings;
}
const STATUSES = RELEASE_STATUSES;
function fraction(value: unknown): void {
  requireFact(
    value === null ||
      (typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1),
    "invalid rollout fraction",
  );
}
function validateCandidate(value: unknown): Record<string, unknown> {
  const candidate = record(value, ["track", "releases"]);
  trackName(candidate.track);
  requireFact(Array.isArray(candidate.releases), "expected candidate releases");
  const releases = candidate.releases as unknown[];
  let last: string | undefined;
  for (const item of releases) {
    const release = record(item, [
      "countryTargeting",
      "inAppUpdatePriority",
      "name",
      "releaseNotes",
      "status",
      "userFraction",
      "versionCodes",
    ]);
    if (release.name !== null) text(release.name);
    choice(release.status, STATUSES);
    fraction(release.userFraction);
    if (release.status !== "inProgress" && release.status !== "halted")
      requireFact(release.userFraction === null, "unexpected rollout");
    requireFact(
      release.inAppUpdatePriority === null ||
        (Number.isInteger(release.inAppUpdatePriority) &&
          Number(release.inAppUpdatePriority) >= 0 &&
          Number(release.inAppUpdatePriority) <= 5),
      "invalid priority",
    );
    const codes = orderedStrings(release.versionCodes, (a, b) => {
      code(a);
      code(b);
      return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
    });
    codes.forEach(code);
    if (release.countryTargeting !== null) {
      const countries = record(release.countryTargeting, ["countries", "includeRestOfWorld"]);
      orderedStrings(countries.countries).forEach((c) =>
        requireFact(/^[A-Za-z]{2}$/u.test(c), "invalid country"),
      );
      bool(countries.includeRestOfWorld);
    }
    requireFact(Array.isArray(release.releaseNotes), "expected localized notes");
    const languages: string[] = [];
    for (const item of release.releaseNotes as unknown[]) {
      const note = record(item, ["language", "text"]);
      text(note.language);
      text(note.text, true);
      requireFact(
        Intl.getCanonicalLocales(note.language)[0] === note.language,
        "noncanonical locale",
      );
      languages.push(note.language);
    }
    orderedStrings(languages);
    const canonical = stableStringify(release);
    requireFact(last === undefined || last <= canonical, "noncanonical release order");
    last = canonical;
  }
  return candidate;
}
/** Strict canonical JSON parser at the new semantic trust boundary. */
export function parseApprovalStatementCanonical(canonical: unknown): ApprovalStatement {
  text(canonical);
  const parsed: unknown = JSON.parse(canonical);
  const preliminary =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const operation = preliminary.operation;
  choice(operation, ["open_edit", "commit", "verify_committed", "reconcile_commit"]);
  const r = record(parsed, [
    "statementVersion",
    "operation",
    "toolName",
    "permission",
    "packageName",
    "facts",
    "consequences",
    ...(operation === "open_edit" ? [] : ["integrity"]),
  ]);
  requireFact(r.statementVersion === 1, "unsupported statement version");
  requireFact(stableStringify(r) === canonical, "noncanonical JSON encoding");
  validateReleasePackageName(r.packageName);
  const names = {
    open_edit: "releases.open_edit",
    commit: "releases.commit_edit",
    verify_committed: "releases.verify_committed_release",
    reconcile_commit: "releases.reconcile_commit",
  };
  const op = operation as ApprovalOperation;
  requireFact(r.toolName === names[op], "operation/tool mismatch");
  requireFact(
    stableStringify(r.consequences) === stableStringify(APPROVAL_CONSEQUENCES[op]),
    "unsupported consequences",
  );
  if (op === "open_edit") {
    requireFact(r.permission === "destructive", "permission mismatch");
    const f = record(r.facts, ["expectedLocalSession"]);
    requireFact(f.expectedLocalSession === "none", "unexpected local-session expectation");
  } else if (op === "commit") {
    requireFact(r.permission === "publish", "permission mismatch");
    const f = record(r.facts, [
      "targetTrack",
      "versionCode",
      "releaseName",
      "releaseStatus",
      "rolloutFraction",
      "noteLanguages",
      "changesInReviewBehavior",
      "changesNotSentForReview",
      "targetTrackCandidate",
    ]);
    trackName(f.targetTrack);
    code(f.versionCode);
    text(f.releaseName);
    choice(f.releaseStatus, STATUSES);
    fraction(f.rolloutFraction);
    choice(f.changesInReviewBehavior, ["ERROR_IF_IN_REVIEW"]);
    bool(f.changesNotSentForReview);
    orderedStrings(f.noteLanguages);
    const candidate = validateCandidate(f.targetTrackCandidate);
    requireFact(candidate.track === f.targetTrack, "target track mismatch");
    const releases = candidate.releases as Record<string, unknown>[];
    const selected = releases.filter((release) =>
      (release.versionCodes as string[]).includes(String(f.versionCode)),
    );
    const release = selected[0];
    requireFact(selected.length === 1 && release !== undefined, "selected release ambiguous");
    requireFact(
      release.name === f.releaseName &&
        release.status === f.releaseStatus &&
        release.userFraction === f.rolloutFraction,
      "selected release mismatch",
    );
    requireFact(
      stableStringify(
        (release.releaseNotes as Record<string, unknown>[]).map((note) => note.language),
      ) === stableStringify(f.noteLanguages),
      "note languages mismatch",
    );
    const integrity = record(r.integrity, ["stateDigest", "commitBindingFingerprint"]);
    hex(integrity.stateDigest);
    hex(integrity.commitBindingFingerprint);
    requireFact(
      approvalStatementDigest(stableStringify(candidate)) === integrity.stateDigest,
      "visible candidate fingerprint mismatch",
    );
  } else if (op === "verify_committed") {
    requireFact(r.permission === "destructive", "permission mismatch");
    const f = record(r.facts, [
      "targetTrack",
      "versionCode",
      "expectedReleaseName",
      "archivedNoteTextAvailable",
    ]);
    trackName(f.targetTrack);
    code(f.versionCode);
    text(f.expectedReleaseName);
    requireFact(f.archivedNoteTextAvailable === false, "unavailable historical note text");
    const integrity = record(r.integrity, [
      "expectedStateDigest",
      "verificationBindingFingerprint",
    ]);
    hex(integrity.expectedStateDigest);
    hex(integrity.verificationBindingFingerprint);
  } else {
    const f = record(r.facts, [
      "targetTrack",
      "versionCode",
      "releaseName",
      "releaseStatus",
      "attemptId",
      "attemptState",
      "mode",
      "originalEditStatus",
      "commitAcknowledged",
      "archivedNoteTextAvailable",
      "verificationInsertAttempted",
      "temporaryEditIdentityAvailable",
      "verificationPreDeleteReadVerified",
      "verificationDeleteAttempted",
      "verificationDeleteAcknowledged",
      "verificationCleanupVerified",
      "observedClassification",
    ]);
    trackName(f.targetTrack);
    code(f.versionCode);
    text(f.releaseName);
    choice(f.releaseStatus, STATUSES);
    text(f.attemptId);
    requireFact(
      /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(f.attemptId),
      "invalid attempt identifier",
    );
    choice(f.attemptState, [
      "PREPARED",
      "TRANSPORT_ATTEMPTED",
      "ACKNOWLEDGED",
      "AMBIGUOUS",
      "REMOTE_VERIFIED",
      "RECONCILED_COMMITTED",
      "RECONCILED_NOT_COMMITTED",
    ]);
    choice(f.mode, ["probe", "verify_expired"]);
    requireFact(
      r.permission === (f.mode === "probe" ? "read" : "destructive"),
      "permission mismatch",
    );
    requireFact(
      f.originalEditStatus === "not_yet_probed" && f.archivedNoteTextAvailable === false,
      "unobserved facts",
    );
    for (const key of [
      "commitAcknowledged",
      "verificationInsertAttempted",
      "temporaryEditIdentityAvailable",
      "verificationPreDeleteReadVerified",
      "verificationDeleteAttempted",
      "verificationDeleteAcknowledged",
      "verificationCleanupVerified",
    ])
      bool(f[key]);
    const integrity = record(r.integrity, [
      "candidateFingerprint",
      "expectedStateDigest",
      "priorStateDigest",
      "observedStateDigest",
    ]);
    hex(integrity.candidateFingerprint);
    hex(integrity.expectedStateDigest);
    nullableHex(integrity.priorStateDigest);
    nullableHex(integrity.observedStateDigest);
    const observed = integrity.observedStateDigest;
    const classification =
      observed === null
        ? "not_observed"
        : observed === integrity.expectedStateDigest
          ? "expected_state"
          : observed === integrity.priorStateDigest
            ? "prior_state"
            : "unrelated_state";
    requireFact(f.observedClassification === classification, "observation classification mismatch");
  }
  return r as unknown as ApprovalStatement;
}

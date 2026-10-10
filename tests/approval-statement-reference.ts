/** Test-only independent off-host reference. Imports NO PlayOps implementation,
 * candidate, gateway, store, intent, journal or parser. Authorization input is
 * only the serialized challenge. It neither signs nor accesses files/keys.
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export function referenceCanonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    assert(Number.isFinite(value));
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(referenceCanonical).join(",")}]`;
  assert(value !== null && typeof value === "object");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${referenceCanonical(record[k])}`)
    .join(",")}}`;
}
function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}
function string(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}
export interface ReferenceApproval {
  readonly bytesToSign: Buffer;
  readonly nonce: string;
  readonly requestId: string;
  readonly statement: {
    readonly operation: string;
    readonly facts: Record<string, unknown>;
    readonly integrity?: Record<string, unknown>;
    readonly consequences: readonly string[];
  };
}
export function validateSerializedApproval(serialized: string): ReferenceApproval {
  const a = object(JSON.parse(serialized));
  exact(a, [
    "requestId",
    "toolName",
    "permission",
    "packageName",
    "requestDigest",
    "expiresAtUtc",
    "canonicalPayload",
    "approvalStatementVersion",
    "approvalStatementCanonical",
  ]);
  assert.equal(a.approvalStatementVersion, 1);
  const canonical = string(a.approvalStatementCanonical);
  const s = object(JSON.parse(canonical));
  const operation = string(s.operation);
  const spec: Record<
    string,
    { tool: string; permission: string; facts: string[]; integrity: string[] }
  > = {
    open_edit: {
      tool: "releases.open_edit",
      permission: "destructive",
      facts: ["expectedLocalSession"],
      integrity: [],
    },
    commit: {
      tool: "releases.commit_edit",
      permission: "publish",
      facts: [
        "targetTrack",
        "versionCode",
        "releaseName",
        "releaseStatus",
        "rolloutFraction",
        "noteLanguages",
        "changesInReviewBehavior",
        "changesNotSentForReview",
        "targetTrackCandidate",
      ],
      integrity: ["stateDigest", "commitBindingFingerprint"],
    },
    verify_committed: {
      tool: "releases.verify_committed_release",
      permission: "destructive",
      facts: ["targetTrack", "versionCode", "expectedReleaseName", "archivedNoteTextAvailable"],
      integrity: ["expectedStateDigest", "verificationBindingFingerprint"],
    },
    reconcile_commit: {
      tool: "releases.reconcile_commit",
      permission: "destructive",
      facts: [
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
      ],
      integrity: [
        "candidateFingerprint",
        "expectedStateDigest",
        "priorStateDigest",
        "observedStateDigest",
      ],
    },
  };
  const expected = spec[operation];
  assert(expected);
  exact(s, [
    "statementVersion",
    "operation",
    "toolName",
    "permission",
    "packageName",
    "facts",
    "consequences",
    ...(expected.integrity.length ? ["integrity"] : []),
  ]);
  assert.equal(s.statementVersion, 1);
  assert.equal(referenceCanonical(s), canonical);
  assert.equal(s.toolName, expected.tool);
  assert.equal(s.permission, expected.permission);
  for (const k of ["toolName", "permission", "packageName"]) assert.equal(s[k], a[k]);
  const facts = object(s.facts);
  exact(facts, expected.facts);
  const integrity = expected.integrity.length ? object(s.integrity) : undefined;
  if (integrity) {
    exact(integrity, expected.integrity);
    for (const value of Object.values(integrity))
      if (value !== null) assert.match(string(value), /^[0-9a-f]{64}$/u);
  }
  assert(
    Array.isArray(s.consequences) &&
      s.consequences.length > 0 &&
      s.consequences.every((c) => typeof c === "string"),
  );
  if (operation === "open_edit") assert.equal(facts.expectedLocalSession, "none");
  if (operation === "commit") {
    const track = object(facts.targetTrackCandidate);
    exact(track, ["track", "releases"]);
    assert.equal(track.track, facts.targetTrack);
    assert(Array.isArray(track.releases));
    const selected = track.releases
      .map(object)
      .filter((r) => Array.isArray(r.versionCodes) && r.versionCodes.includes(facts.versionCode));
    assert.equal(selected.length, 1);
    const release = selected[0];
    assert(release);
    assert.equal(release.name, facts.releaseName);
    assert.equal(release.status, facts.releaseStatus);
    assert.equal(release.userFraction, facts.rolloutFraction);
    assert.equal(
      createHash("sha256").update(referenceCanonical(track), "utf8").digest("hex"),
      integrity?.stateDigest,
    );
    for (const release of track.releases.map(object)) {
      exact(release, [
        "countryTargeting",
        "inAppUpdatePriority",
        "name",
        "releaseNotes",
        "status",
        "userFraction",
        "versionCodes",
      ]);
      assert(Array.isArray(release.releaseNotes));
      for (const note of release.releaseNotes.map(object)) {
        exact(note, ["language", "text"]);
        string(note.text);
        assert.equal(Intl.getCanonicalLocales(string(note.language))[0], note.language);
      }
    }
  }
  assert.match(string(a.requestDigest), /^[0-9a-f]{64}$/u);
  assert.equal(createHash("sha256").update(canonical, "utf8").digest("hex"), a.requestDigest);
  const bytes = Buffer.from(string(a.canonicalPayload), "utf8");
  const prefix = Buffer.from("PLAYOPS_OPERATOR_APPROVAL_V1\nversion=1\n");
  assert(bytes.subarray(0, prefix.length).equals(prefix));
  let cursor = prefix.length;
  const fields = [
    "requestId",
    "nonce",
    "toolName",
    "permission",
    "packageName",
    "requestDigest",
    "expiresAtUtc",
  ];
  const values: Record<string, string> = {};
  for (const name of fields) {
    const label = Buffer.from(`${name}=`);
    assert(bytes.subarray(cursor, cursor + label.length).equals(label));
    cursor += label.length;
    const colon = bytes.indexOf(58, cursor);
    assert(colon >= cursor);
    const count = bytes.subarray(cursor, colon).toString("ascii");
    assert.match(count, /^[1-9][0-9]{0,2}$/u);
    assert(Number(count) <= 512);
    cursor = colon + 1;
    const raw = bytes.subarray(cursor, cursor + Number(count));
    assert.equal(raw.length, Number(count));
    cursor += Number(count);
    assert.equal(bytes[cursor], 10);
    cursor++;
    const value = raw.toString("utf8");
    assert(Buffer.from(value, "utf8").equals(raw));
    assert(value.trim());
    for (const point of value) {
      const codePoint = point.codePointAt(0);
      assert(codePoint !== undefined && codePoint >= 32 && codePoint !== 127);
    }
    values[name] = value;
    if (name !== "nonce") assert.equal(value, a[name]);
  }
  assert.equal(cursor, bytes.length);
  assert.equal(new Date(string(values.expiresAtUtc)).toISOString(), values.expiresAtUtc);
  assert.match(string(values.requestId), /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u);
  const regenerated = Buffer.from(
    `PLAYOPS_OPERATOR_APPROVAL_V1\nversion=1\n${fields.map((name) => `${name}=${Buffer.byteLength(string(values[name]), "utf8")}:${string(values[name])}\n`).join("")}`,
    "utf8",
  );
  assert(regenerated.equals(bytes));
  return {
    bytesToSign: regenerated,
    nonce: string(values.nonce),
    requestId: string(values.requestId),
    statement: { operation, facts, integrity, consequences: s.consequences as string[] },
  };
}

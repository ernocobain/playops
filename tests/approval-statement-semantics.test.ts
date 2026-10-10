import { generateKeyPairSync, sign, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  createReleaseCommitIntent,
  createReleaseCommitStatement,
} from "../src/releases/commit-approval.js";
import {
  createReleaseStateVerificationIntent,
  createReleaseStateVerificationStatement,
} from "../src/releases/readback-approval.js";
import { parseApprovalStatementCanonical } from "../src/approvals/statement.js";
import { encodeOperatorApprovalPayload } from "../src/runtime/approvals/operator-signature.js";
import { parseDaemonResponse, PLAYOPS_DAEMON_PROTOCOL_VERSION } from "../src/daemon/protocol.js";
import type { ReleaseState } from "../src/releases/index.js";
import type { ReleaseCommitIntentInput } from "../src/releases/commit-approval.js";
import { referenceCanonical, validateSerializedApproval } from "./approval-statement-reference.js";

type MutableInput = {
  -readonly [K in keyof ReleaseCommitIntentInput]: ReleaseCommitIntentInput[K];
};
function input(): MutableInput {
  return {
    packageName: "com.example.app",
    editId: "binding-only-edit",
    targetTrack: "internal",
    versionCode: "42",
    targetTrackState: {
      track: "internal",
      releases: [
        {
          name: "Candidate",
          status: "inProgress",
          userFraction: 0.05,
          versionCodes: ["42", "41", "42"],
          releaseNotes: [
            { language: "ja", text: "東京\n更新" },
            { language: "en-us", text: "" },
            { language: "id", text: "e\u0301" },
          ],
          countryTargeting: { countries: ["US", "ID", "US"], includeRestOfWorld: false },
          inAppUpdatePriority: 5,
        },
        { name: "Older", status: "draft", versionCodes: [], releaseNotes: [] },
      ],
    },
    validatedEdit: { valid: true, expiryTimeSeconds: "1900000000" },
  };
}
function challenge(value: ReleaseCommitIntentInput) {
  const intent = createReleaseCommitIntent(value),
    canonical = createReleaseCommitStatement(intent);
  const payload = {
    protocolVersion: 1,
    requestId: "11111111-2222-4333-8444-555555555555",
    nonce: "n".repeat(43),
    toolName: "releases.commit_edit",
    permission: "publish" as const,
    packageName: intent.packageName,
    requestDigest: intent.requestDigest,
    expiresAtUtc: "2026-10-10T00:10:00.000Z",
  };
  return {
    approvalStatementVersion: 1 as const,
    approvalStatementCanonical: canonical,
    requestId: payload.requestId,
    toolName: payload.toolName,
    permission: payload.permission,
    packageName: payload.packageName,
    requestDigest: payload.requestDigest,
    expiresAtUtc: payload.expiresAtUtc,
    canonicalPayload: encodeOperatorApprovalPayload(payload).toString("utf8"),
  };
}
describe("Stage4B.1 semantic determinism and integrity", () => {
  it("deep freezes the transient full-track candidate so approval authority cannot mutate", () => {
    const intent = createReleaseCommitIntent(input());
    const candidate = intent.targetTrackCandidate as {
      releases: { releaseNotes: unknown[]; versionCodes: string[]; countryTargeting: unknown }[];
    };
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate.releases)).toBe(true);
    expect(
      candidate.releases.every(
        (r) =>
          Object.isFrozen(r) && Object.isFrozen(r.releaseNotes) && Object.isFrozen(r.versionCodes),
      ),
    ).toBe(true);
    const firstRelease = candidate.releases[0];
    if (!firstRelease) throw new Error("Missing fixture release");
    expect(() => candidate.releases.push(firstRelease)).toThrow();
  });
  it("reuses existing canonical set/locale ordering, exact UTF8 text and independent reconstruction", () => {
    const a = input(),
      b = structuredClone(a);
    (b.targetTrackState.releases as ReleaseState[]).reverse();
    for (const r of b.targetTrackState.releases) {
      (r.versionCodes as string[]).reverse();
      (r.releaseNotes as unknown[])?.reverse();
      (r.countryTargeting?.countries as string[] | undefined)?.reverse();
    }
    const first = challenge(a),
      second = challenge(b);
    expect(second.approvalStatementCanonical).toBe(first.approvalStatementCanonical);
    expect(challenge(input()).approvalStatementCanonical).toBe(first.approvalStatementCanonical);
    const reference = validateSerializedApproval(JSON.stringify(first));
    expect(referenceCanonical(JSON.parse(first.approvalStatementCanonical))).toBe(
      first.approvalStatementCanonical,
    );
    expect(reference.nonce).toBe("n".repeat(43));
    const recomposed = structuredClone(a),
      selected = recomposed.targetTrackState.releases[0];
    if (!selected) throw new Error("Missing fixture release");
    const notes = selected.releaseNotes as { language: string; text: string }[];
    const id = notes.find((n) => n.language === "id");
    if (!id) throw new Error("Missing fixture note");
    id.text = "é";
    expect(challenge(recomposed).requestDigest).not.toBe(first.requestDigest);
    // Fresh process independently reconstructs the exact JSON/hash from serialized authorization input only.
    const script = `import {createHash} from 'node:crypto'; let text=''; for await(const chunk of process.stdin) text+=chunk; const a=JSON.parse(text); const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v); const rebuilt=canonical(JSON.parse(a.approvalStatementCanonical)); if(rebuilt!==a.approvalStatementCanonical) throw Error('noncanonical'); const hash=createHash('sha256').update(rebuilt,'utf8').digest('hex'); if(hash!==a.requestDigest) throw Error('digest'); process.stdout.write(hash);`;
    expect(
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        input: JSON.stringify(first),
        encoding: "utf8",
      }),
    ).toBe(first.requestDigest);
  });
  it.each([
    "note",
    "locale",
    "track",
    "code",
    "status",
    "fraction",
    "name",
    "package",
    "edit",
    "validation",
  ])("invalidates a genuine signature when %s changes", (field) => {
    const original = challenge(input()),
      verified = validateSerializedApproval(JSON.stringify(original));
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const signature = sign(null, verified.bytesToSign, privateKey);
    expect(verify(null, verified.bytesToSign, publicKey, signature)).toBe(true);
    const changed = input(),
      release = changed.targetTrackState.releases[0] as
        { -readonly [K in keyof ReleaseState]: ReleaseState[K] } | undefined;
    if (!release) throw new Error("Missing fixture release");
    const notes = release.releaseNotes as { language: string; text: string }[];
    const firstNote = notes[0];
    if (!firstNote) throw new Error("Missing fixture note");
    if (field === "note") firstNote.text += "!";
    if (field === "locale") firstNote.language = "fr";
    if (field === "track") {
      changed.targetTrackState = { ...changed.targetTrackState, track: "beta" };
      changed.targetTrack = "beta";
    }
    if (field === "code") (release.versionCodes as string[]).push("43");
    if (field === "status") release.status = "halted";
    if (field === "fraction") release.userFraction = 0.1;
    if (field === "name") release.name = "Changed";
    if (field === "package") changed.packageName = "com.example.other";
    if (field === "edit") changed.editId = "changed-edit";
    if (field === "validation")
      changed.validatedEdit = { valid: true, expiryTimeSeconds: "1900000010" };
    const newApproval = challenge(changed);
    const newBytes = validateSerializedApproval(JSON.stringify(newApproval)).bytesToSign;
    expect(newApproval.requestDigest).not.toBe(original.requestDigest);
    expect(verify(null, newBytes, publicKey, signature)).toBe(false);
  });
  it("strictly rejects rehashed unknown semantic fields and false consequences", () => {
    const a = challenge(input());
    const parsed = JSON.parse(a.approvalStatementCanonical) as {
      facts: Record<string, unknown>;
      integrity: Record<string, unknown>;
      consequences: string[];
    };
    for (const mutate of [
      () => {
        parsed.facts.hidden = true;
      },
      () => {
        delete parsed.facts.hidden;
        parsed.integrity.hidden = true;
      },
      () => {
        delete parsed.integrity.hidden;
        parsed.consequences = ["Safe; no destructive effect"];
      },
    ]) {
      mutate();
      expect(() => parseApprovalStatementCanonical(referenceCanonical(parsed))).toThrow();
    }
    const envelope = {
      protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
      correlationId: "tamper",
      outcome: "approval_required",
      approval: a,
    };
    for (const key of ["toolName", "permission", "packageName", "requestDigest"])
      expect(() =>
        parseDaemonResponse({ ...envelope, approval: { ...a, [key]: "wrong" } }),
      ).toThrow();
  });
  it("labels verification as a lifecycle approval, never historical note reconstruction", () => {
    const s = createReleaseStateVerificationStatement(
      createReleaseStateVerificationIntent({
        packageName: "com.example.app",
        targetTrack: "internal",
        versionCode: "42",
        expectedReleaseName: "Candidate",
        expectedStateDigest: "a".repeat(64),
      }),
    );
    expect(parseApprovalStatementCanonical(s).facts.archivedNoteTextAvailable).toBe(false);
    expect(s).not.toContain("binding-only-edit");
  });
});

/**
 * Client renderers: required fields per operation, verbatim multi-byte note
 * text, labelled integrity fingerprints, unverified summary and byte-exact JSON.
 */
import { describe, expect, it } from "vitest";
import {
  approvalStatementDigest,
  parseApprovalStatementCanonical,
} from "../src/approvals/statement.js";
import { approvalChallengeFor } from "../src/daemon/pending-view.js";
import type { DaemonApprovalChallenge, DaemonResponseEnvelope } from "../src/daemon/protocol.js";
import {
  createReleaseCommitIntent,
  createReleaseCommitStatement,
} from "../src/releases/commit-approval.js";
import {
  createReleaseStateVerificationIntent,
  createReleaseStateVerificationStatement,
} from "../src/releases/readback-approval.js";
import { createReleaseCommitReconciliationStatement } from "../src/releases/reconcile-commit-tool.js";
import { createReleaseEditOpenStatement } from "../src/releases/open-tool.js";
import {
  ATTACH_NOTES_WARNING,
  renderApprovalStatement,
  renderHumanResponse,
  renderMachineResponse,
  renderStatus,
} from "../src/client/render.js";

const PACKAGE = "com.example.render";
const ATTEMPT_ID = "11111111-2222-4333-8444-555555555555";
const EXPIRES = "2026-10-10T00:10:00.000Z";
const NONCE = "n".repeat(43);
const LONG_NOTE = "リリース🎉 完全なローカライズ済みノート\nsecond line — do not truncate. ".repeat(
  3,
);

function challengeFor(statement: string): DaemonApprovalChallenge {
  const parsed = parseApprovalStatementCanonical(statement);
  return approvalChallengeFor(
    {
      requestId: ATTEMPT_ID,
      nonce: NONCE,
      toolName: parsed.toolName,
      permission: parsed.permission,
      packageName: parsed.packageName,
      requestDigest: approvalStatementDigest(statement),
      expiresAtUtc: EXPIRES,
    },
    statement,
  );
}

function commitStatement(noteText = LONG_NOTE): string {
  const track = {
    track: "internal",
    releases: [
      {
        name: "Render Candidate",
        status: "completed" as const,
        versionCodes: ["42"],
        releaseNotes: [
          { language: "en-US", text: "Plain note" },
          { language: "ja-JP", text: noteText },
        ],
      },
    ],
  };
  const intent = createReleaseCommitIntent({
    packageName: PACKAGE,
    editId: "render-original",
    targetTrack: "internal",
    versionCode: "42",
    targetTrackState: track,
    validatedEdit: { valid: true, expiryTimeSeconds: "4102444800" },
  });
  return createReleaseCommitStatement(intent);
}

function verifyStatement(): string {
  const track = {
    track: "internal",
    releases: [{ name: "Render Candidate", status: "completed" as const, versionCodes: ["42"] }],
  };
  const intent = createReleaseCommitIntent({
    packageName: PACKAGE,
    editId: "render-original",
    targetTrack: "internal",
    versionCode: "42",
    targetTrackState: track,
    validatedEdit: { valid: true, expiryTimeSeconds: "4102444800" },
  });
  const verification = createReleaseStateVerificationIntent({
    packageName: PACKAGE,
    targetTrack: "internal",
    versionCode: "42",
    expectedReleaseName: intent.releaseName,
    expectedStateDigest: intent.stateDigest,
  });
  return createReleaseStateVerificationStatement(verification);
}

function reconcileStatement(): string {
  const track = {
    track: "internal",
    releases: [{ name: "Render Candidate", status: "completed" as const, versionCodes: ["42"] }],
  };
  const intent = createReleaseCommitIntent({
    packageName: PACKAGE,
    editId: "render-original",
    targetTrack: "internal",
    versionCode: "42",
    targetTrackState: track,
    validatedEdit: { valid: true, expiryTimeSeconds: "4102444800" },
  });
  const candidate = {
    version: 1 as const,
    attemptId: ATTEMPT_ID,
    packageName: PACKAGE,
    editId: "render-original",
    expiryTimeSeconds: "4102444800",
    targetTrack: "internal",
    versionCode: "42",
    releaseName: intent.releaseName,
    releaseStatus: "completed" as const,
    expectedStateDigest: intent.stateDigest,
    validationExpiryTimeSeconds: "4102444800",
    requestDigest: intent.requestDigest,
    attemptedAtUtc: "2026-10-10T00:00:00.000Z",
    updatedAtUtc: "2026-10-10T00:00:00.000Z",
    state: "TRANSPORT_ATTEMPTED" as const,
  };
  return createReleaseCommitReconciliationStatement(PACKAGE, candidate, "verify_expired");
}

describe("human approval renderers", () => {
  it("renders every required section for an open-edit statement", () => {
    const text = renderApprovalStatement(challengeFor(createReleaseEditOpenStatement(PACKAGE)));
    for (const heading of [
      "SEMANTIC AUTHORIZATION",
      "CONSEQUENCES",
      "INTEGRITY FINGERPRINTS",
      "REQUEST / EXPIRY",
    ]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain("expected local-session state: none");
    expect(text).toContain(`package: ${PACKAGE}`);
  });

  it("renders the full commit track and every localized note verbatim", () => {
    const text = renderApprovalStatement(challengeFor(commitStatement()), "DO NOT TRUST");
    expect(text).toContain("DAEMON SUMMARY (UNVERIFIED): DO NOT TRUST");
    expect(text).toContain("target track: internal");
    expect(text).toContain("versionCode: 42");
    expect(text).toContain("release name: Render Candidate");
    expect(text).toContain("review consequence:");
    // Exact locale + exact (multi-byte / emoji) text, untruncated.
    expect(text).toContain("[ja-JP]");
    expect(text).toContain(LONG_NOTE);
    expect(text).not.toContain("…");
    // The signed consequence is quoted verbatim.
    expect(text).toContain(
      "All target-track releases and exact localized notes are shown. Other app-edit contents are not enumerated; trust the managed edit provenance.",
    );
  });

  it("refuses terminal-control note text without rendering a partial signable statement", () => {
    const challenge = challengeFor(commitStatement("synthetic\u001b[2Jhidden"));
    const text = renderApprovalStatement(challenge);
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("SEMANTIC AUTHORIZATION");
    expect(text).toContain("--json");
    expect(text).toContain("do not automatically prepare again");
    const machine = JSON.parse(
      renderMachineResponse({
        protocolVersion: 5,
        correlationId: "corr",
        outcome: "approval_required",
        approval: challenge,
      }),
    ) as DaemonResponseEnvelope;
    expect(machine.approval?.approvalStatementCanonical).toBe(challenge.approvalStatementCanonical);
  });

  it("refuses bidi-override note text in the renderer", () => {
    const challenge = challengeFor(commitStatement("approved\u202ereversed by override"));
    const text = renderApprovalStatement(challenge);
    expect(text).not.toContain("\u202e");
    expect(text).not.toContain("SEMANTIC AUTHORIZATION");
    expect(text).toContain("cannot be shown safely");
    expect(text).toContain("--out");
  });

  it("renders the verify statement without implying a publish", () => {
    const text = renderApprovalStatement(challengeFor(verifyStatement()));
    expect(text).toContain("operation: verify committed release");
    expect(text).toContain("expected release name:");
    expect(text).toContain("this does NOT publish, commit, upload, or write release notes.");
    expect(text).toContain("temporary-edit lifecycle:");
  });

  it("renders the reconcile statement with a separately labelled candidate fingerprint", () => {
    const text = renderApprovalStatement(challengeFor(reconcileStatement()));
    expect(text).toContain(`attempt id: ${ATTEMPT_ID}`);
    expect(text).toContain("recovery mode: verify_expired");
    expect(text).toContain("original-edit inspection rule:");
    expect(text).toContain("possible outcomes:");
    expect(text).toContain("INTEGRITY FINGERPRINTS (never the semantic facts)");
    expect(text).toContain("candidateFingerprint:");
  });

  it("labels integrity fingerprints separately from semantic facts", () => {
    const challenge = challengeFor(commitStatement());
    const text = renderApprovalStatement(challenge);
    const integrityIndex = text.indexOf("INTEGRITY FINGERPRINTS");
    const digestIndex = text.indexOf(`requestDigest: ${challenge.requestDigest}`);
    expect(integrityIndex).toBeGreaterThan(-1);
    expect(digestIndex).toBeGreaterThan(integrityIndex);
  });
});

describe("machine + status renderers", () => {
  it("preserves canonical strings byte-exact in --json", () => {
    const challenge = challengeFor(commitStatement());
    const response: DaemonResponseEnvelope = {
      protocolVersion: 5,
      correlationId: "corr",
      outcome: "approval_required",
      summary: "prepare ok",
      approval: challenge,
    };
    const text = renderMachineResponse(response);
    const parsed = JSON.parse(text) as DaemonResponseEnvelope;
    expect(parsed.outcome).toBe("approval_required");
    expect(parsed.correlationId).toBe("corr");
    expect(parsed.approval?.approvalStatementCanonical).toBe(challenge.approvalStatementCanonical);
    expect(parsed.approval?.canonicalPayload).toBe(challenge.canonicalPayload);
    expect(parsed.approval?.requestDigest).toBe(challenge.requestDigest);
  });

  it("renders status as aggregate-only with an explicit caveat", () => {
    const text = renderStatus({
      protocolVersion: 5,
      correlationId: "corr",
      outcome: "status",
      summary: "pending=1 completed=0",
    });
    expect(text).toContain("pending: 1");
    expect(text).toContain("completed: 0");
    expect(text).toContain("cannot resolve a specific requestId");
    expect(text).toContain("status is NOT recovery");
  });

  it("renders a plain warning for the unsigned notes write", () => {
    expect(ATTACH_NOTES_WARNING).toContain("REAL remote Google Play release-notes update");
    expect(ATTACH_NOTES_WARNING).toContain("does NOT require a human approval signature");
    expect(ATTACH_NOTES_WARNING).toContain("NEVER");
  });

  it("renders an unknown-outcome response through the human path without inventing meaning", () => {
    const text = renderHumanResponse({
      protocolVersion: 5,
      correlationId: "corr",
      outcome: "remote_failure",
      error: { code: "X", message: "failed" },
    });
    expect(text).toContain("OUTCOME: remote_failure");
  });
});

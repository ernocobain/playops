import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFileReleaseCommitAttemptJournal,
  type ReleaseCommitAttemptJournalRecord,
  type ReleaseCommitAttemptState,
} from "../src/releases/commit-attempt-journal.js";
import { hasVerificationPrefix as daemonHasVerificationPrefix } from "../src/daemon/verify-committed-operations.js";
import { resumeCommitVerificationEvidence } from "../src/releases/commit-verification-evidence.js";

const packageName = "com.example.attemptstatus";
const at = "2026-10-09T00:00:00.000Z";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

interface Predicates {
  isCommitAttemptTerminal: (record: ReleaseCommitAttemptJournalRecord) => boolean;
  isCommitAttemptUnresolved: (record: ReleaseCommitAttemptJournalRecord) => boolean;
  hasVerificationPrefix: (record: ReleaseCommitAttemptJournalRecord) => boolean;
  hasCompleteVerifiedProof: (record: ReleaseCommitAttemptJournalRecord) => boolean;
  isVerifiedCommitLocallyFinalizable: (record: ReleaseCommitAttemptJournalRecord) => boolean;
}
async function predicates(): Promise<Predicates> {
  const path = "../src/releases/commit-attempt-status.js";
  const loaded: unknown = await import(path).catch(() => undefined);
  expect(loaded, "Stage 3F.1 pure status helper is not implemented").toBeDefined();
  return loaded as Predicates;
}

async function fixture(
  state: ReleaseCommitAttemptState,
  verification: "none" | "pending" | "complete",
) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-attempt-status-"));
  directories.push(root);
  const journal = createFileReleaseCommitAttemptJournal(join(root, "private", "attempts.json"), {
    expectedPackageName: packageName,
  });
  const input = {
    version: 1 as const,
    packageName,
    editId: "original-edit",
    expiryTimeSeconds: "4102444800",
    targetTrack: "internal",
    versionCode: "101",
    releaseName: "Candidate",
    releaseStatus: "completed" as const,
    expectedStateDigest: "a".repeat(64),
    validationExpiryTimeSeconds: "4102444800",
    requestDigest: "b".repeat(64),
    attemptedAtUtc: at,
    updatedAtUtc: at,
  };
  let record = await journal.prepare(input);
  if (state !== "PREPARED") {
    record = await journal.transition(record.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", at);
    if (state === "ACKNOWLEDGED") {
      record = await journal.transition(
        record.attemptId,
        "TRANSPORT_ATTEMPTED",
        "ACKNOWLEDGED",
        at,
        { acknowledgedAtUtc: at },
      );
    } else if (state === "AMBIGUOUS") {
      record = await journal.transition(record.attemptId, "TRANSPORT_ATTEMPTED", "AMBIGUOUS", at);
    }
  }
  if (verification !== "none") {
    record = await journal.updateVerification(record.attemptId, record.state, at, {
      verificationInsertAttempted: true,
    });
    record = await journal.updateVerification(record.attemptId, record.state, at, {
      verificationEditId: "temporary-edit",
      verificationEditExpiryTimeSeconds: "4102444900",
    });
    record = await journal.updateVerification(record.attemptId, record.state, at, {
      verificationObservedStateDigest: input.expectedStateDigest,
      verificationObservedAtUtc: at,
      verificationPreDeleteReadVerified: true,
      verificationDeleteAttempted: true,
    });
    record = await journal.updateVerification(record.attemptId, record.state, at, {
      verificationDeleteAcknowledged: true,
    });
    if (verification === "complete")
      record = await journal.updateVerification(record.attemptId, record.state, at, {
        verificationCleanupVerified: true,
      });
  }
  if (state === "REMOTE_VERIFIED" || state === "RECONCILED_COMMITTED") {
    record = await journal.transition(record.attemptId, record.state, "REMOTE_VERIFIED", at);
  }
  if (state === "RECONCILED_COMMITTED" || state === "RECONCILED_NOT_COMMITTED") {
    record = await journal.transition(record.attemptId, record.state, state, at);
  }
  return { journal, input, record };
}

const cases = [
  ["PREPARED", "none"],
  ["TRANSPORT_ATTEMPTED", "none"],
  ["ACKNOWLEDGED", "none"],
  ["AMBIGUOUS", "none"],
  ["REMOTE_VERIFIED", "pending"],
  ["REMOTE_VERIFIED", "complete"],
  ["RECONCILED_COMMITTED", "complete"],
  ["RECONCILED_NOT_COMMITTED", "none"],
  ["RECONCILED_NOT_COMMITTED", "pending"],
  ["RECONCILED_NOT_COMMITTED", "complete"],
] as const;

describe("Stage 3F.1 parsed commit-attempt status", () => {
  it.each(cases)(
    "preserves real journal unresolved semantics for %s / %s",
    async (state, verification) => {
      const built = await fixture(state, verification);
      const status = await predicates();
      const terminal = state === "RECONCILED_COMMITTED" || state === "RECONCILED_NOT_COMMITTED";
      expect(status.isCommitAttemptTerminal(built.record)).toBe(terminal);
      const unresolved = status.isCommitAttemptUnresolved(built.record);
      const preparation = built.journal.prepare(built.input);
      if (unresolved)
        await expect(preparation).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
      else await expect(preparation).resolves.toMatchObject({ state: "PREPARED" });
      expect(unresolved).toBe(!terminal || verification === "pending");
    },
  );

  it.each([
    ["ACKNOWLEDGED", "complete", true, false],
    ["TRANSPORT_ATTEMPTED", "complete", true, false],
    ["REMOTE_VERIFIED", "complete", true, true],
    ["REMOTE_VERIFIED", "pending", false, false],
    ["RECONCILED_COMMITTED", "complete", true, false],
    ["RECONCILED_NOT_COMMITTED", "complete", true, false],
  ] as const)(
    "distinguishes complete proof from local-finalizer state authority for %s / %s",
    async (state, verification, complete, locallyFinalizable) => {
      const built = await fixture(state, verification);
      const status = await predicates();
      expect(status.hasCompleteVerifiedProof(built.record)).toBe(complete);
      expect(status.isVerifiedCommitLocallyFinalizable(built.record)).toBe(locallyFinalizable);
      expect(status.hasVerificationPrefix(built.record)).toBe(
        daemonHasVerificationPrefix(built.record),
      );
    },
  );

  it.each([0, 1, 2, 3, 4, 5, 6, 7])(
    "matches the strict bridge's durable proof completeness at prefix %s",
    async (length) => {
      const built = await fixture("ACKNOWLEDGED", "none");
      const patches = [
        { verificationInsertAttempted: true as const },
        { verificationEditId: "temporary-edit", verificationEditExpiryTimeSeconds: "4102444900" },
        {
          verificationObservedStateDigest: built.record.expectedStateDigest,
          verificationObservedAtUtc: at,
        },
        { verificationPreDeleteReadVerified: true as const },
        { verificationDeleteAttempted: true as const },
        { verificationDeleteAcknowledged: true as const },
        { verificationCleanupVerified: true as const },
      ];
      let record = built.record;
      for (const patch of patches.slice(0, length))
        record = await built.journal.updateVerification(
          record.attemptId,
          "ACKNOWLEDGED",
          at,
          patch,
        );
      const status = await predicates();
      expect(status.hasVerificationPrefix(record)).toBe(daemonHasVerificationPrefix(record));
      expect(status.hasVerificationPrefix(record)).toBe(length > 0);
      const complete = status.hasCompleteVerifiedProof(record);
      const resumed = await resumeCommitVerificationEvidence({
        journal: built.journal,
        attemptId: record.attemptId,
        packageName,
        expectedStateDigest: record.expectedStateDigest,
        now: () => new Date(at),
      });
      expect(complete).toBe(resumed === "verified");
      expect(complete).toBe(length === patches.length);
    },
  );

  it("is read-only and has only a type import, not a second parser or an I/O dependency", () => {
    const source = readFileSync("src/releases/commit-attempt-status.ts", "utf8");
    expect(source.match(/^import .*$/gmu)).toEqual([
      'import type { ReleaseCommitAttemptJournalRecord } from "./commit-attempt-journal.js";',
    ]);
    expect(source).not.toMatch(/\b(?:async|await|parseReleaseCommitAttemptJournalRecord)\b/u);
  });
});

interface StatusModule extends Predicates {
  classifyAcknowledgedVerificationPrefix: (record: ReleaseCommitAttemptJournalRecord) => string;
  isSuccessProofResumableAckPrefix: (kind: string) => boolean;
}

async function statusModule(): Promise<StatusModule> {
  const loaded: unknown = await import("../src/releases/commit-attempt-status.js");
  return loaded as StatusModule;
}

const priorStateDigest = "e".repeat(64);
const unrelatedStateDigest = "f".repeat(64);

/**
 * A real ACK journal whose durable observation is exactly the requested kind.
 * Every patch goes through the production journal API; nothing is hand-written.
 */
async function acknowledgedJournal(observed: "expected" | "prior" | "unrelated") {
  const root = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-ack-prefix-"));
  directories.push(root);
  const journal = createFileReleaseCommitAttemptJournal(join(root, "private", "attempts.json"), {
    expectedPackageName: packageName,
  });
  const prepared = await journal.prepare({
    version: 1,
    packageName,
    editId: "original-edit",
    expiryTimeSeconds: "1",
    targetTrack: "internal",
    versionCode: "101",
    releaseName: "Candidate",
    releaseStatus: "completed",
    expectedStateDigest: "a".repeat(64),
    priorStateDigest,
    validationExpiryTimeSeconds: "1",
    requestDigest: "b".repeat(64),
    attemptedAtUtc: at,
    updatedAtUtc: at,
  });
  await journal.transition(prepared.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", at);
  let record = await journal.transition(
    prepared.attemptId,
    "TRANSPORT_ATTEMPTED",
    "ACKNOWLEDGED",
    at,
    {
      acknowledgedAtUtc: at,
    },
  );
  const digest =
    observed === "prior"
      ? priorStateDigest
      : observed === "unrelated"
        ? unrelatedStateDigest
        : "a".repeat(64);
  record = await journal.updateVerification(record.attemptId, "ACKNOWLEDGED", at, {
    verificationInsertAttempted: true,
  });
  record = await journal.updateVerification(record.attemptId, "ACKNOWLEDGED", at, {
    verificationEditId: "temporary-edit",
    verificationEditExpiryTimeSeconds: "4102444900",
  });
  record = await journal.updateVerification(record.attemptId, "ACKNOWLEDGED", at, {
    verificationObservedStateDigest: digest,
    verificationObservedAtUtc: at,
  });
  return { journal, record };
}

describe("Stage 3F.3 acknowledged verification-prefix classification", () => {
  it("classifies a real prefix-less ACK record as none, with no invented observation", async () => {
    const built = await fixture("ACKNOWLEDGED", "none");
    const status = await statusModule();
    expect(status.classifyAcknowledgedVerificationPrefix(built.record)).toBe("none");
    expect(status.isSuccessProofResumableAckPrefix("none")).toBe(false);
  });

  it.each([1, 2] as const)(
    "distinguishes a missing identity from a known temporary identity at prefix %s",
    async (length) => {
      const built = await fixture("ACKNOWLEDGED", "none");
      const patches = [
        { verificationInsertAttempted: true as const },
        { verificationEditId: "temporary-edit", verificationEditExpiryTimeSeconds: "4102444900" },
      ];
      let record = built.record;
      for (const patch of patches.slice(0, length))
        record = await built.journal.updateVerification(
          record.attemptId,
          "ACKNOWLEDGED",
          at,
          patch,
        );
      const status = await statusModule();
      const kind = length === 1 ? "identity_unavailable" : "no_observation";
      expect(status.classifyAcknowledgedVerificationPrefix(record)).toBe(kind);
      // Both retain the accepted bridge-first check for already-durable proof;
      // incomplete proof never invents an observation or an edit identity.
      expect(status.isSuccessProofResumableAckPrefix(kind)).toBe(true);
    },
  );

  it("classifies parser-valid cleanup evidence without an observation as production-recovery-only", async () => {
    const built = await fixture("ACKNOWLEDGED", "none");
    let record = await built.journal.updateVerification(
      built.record.attemptId,
      "ACKNOWLEDGED",
      at,
      { verificationInsertAttempted: true },
    );
    record = await built.journal.updateVerification(record.attemptId, "ACKNOWLEDGED", at, {
      verificationEditId: "temporary-edit",
      verificationEditExpiryTimeSeconds: "4102444900",
    });
    record = await built.journal.updateVerification(record.attemptId, "ACKNOWLEDGED", at, {
      verificationPreDeleteReadVerified: true,
      verificationDeleteAttempted: true,
    });
    const status = await statusModule();
    expect(status.classifyAcknowledgedVerificationPrefix(record)).toBe("observation_unavailable");
    expect(status.isSuccessProofResumableAckPrefix("observation_unavailable")).toBe(false);
    await expect(
      resumeCommitVerificationEvidence({
        journal: built.journal,
        attemptId: record.attemptId,
        packageName,
        expectedStateDigest: record.expectedStateDigest,
        now: () => new Date(at),
      }),
    ).rejects.toMatchObject({ code: "VERIFICATION_STATE_MISMATCH" });
  });

  it("classifies an expected observation as resumable success proof", async () => {
    const built = await acknowledgedJournal("expected");
    const status = await statusModule();
    expect(status.classifyAcknowledgedVerificationPrefix(built.record)).toBe("expected_observed");
    expect(status.isSuccessProofResumableAckPrefix("expected_observed")).toBe(true);
  });

  it.each(["prior", "unrelated"] as const)(
    "classifies a durable %s observation as non-resumable and keeps the bridge rejecting it",
    async (kind) => {
      const built = await acknowledgedJournal(kind);
      const status = await statusModule();
      expect(status.classifyAcknowledgedVerificationPrefix(built.record)).toBe(`${kind}_observed`);
      expect(status.isSuccessProofResumableAckPrefix(`${kind}_observed`)).toBe(false);
      expect(status.hasCompleteVerifiedProof(built.record)).toBe(false);
      // The success-proof bridge keeps refusing this evidence: the routing fix
      // must not weaken it.
      await expect(
        resumeCommitVerificationEvidence({
          journal: built.journal,
          attemptId: built.record.attemptId,
          packageName,
          expectedStateDigest: built.record.expectedStateDigest,
          now: () => new Date(at),
        }),
      ).rejects.toMatchObject({ code: "VERIFICATION_STATE_MISMATCH" });
      expect((await built.journal.list())[0]?.state).toBe("ACKNOWLEDGED");
    },
  );
});

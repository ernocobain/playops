import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFileReleaseCommitAttemptJournal,
  parseReleaseCommitAttemptJournalRecord,
  RELEASE_COMMIT_ATTEMPT_JOURNAL_VERSION,
  type ReleaseCommitAttemptJournalRecord,
  type ReleaseCommitAttemptState,
  type ReleaseCommitAttemptVerificationPatch,
} from "../src/releases/commit-attempt-journal.js";
import {
  createCommitVerificationEvidenceJournalSink,
  resumeCommitVerificationEvidence,
  type CommitVerificationEvidenceJournalOptions,
} from "../src/releases/commit-verification-evidence.js";
import type { ReleaseVerificationEvidenceEvent } from "../src/releases/verification-evidence.js";

const packageName = "com.example.evidencebridge";
const expectedStateDigest = "a".repeat(64);
const at = "2026-10-08T05:00:00.000Z";
const updatedAt = "2026-10-08T05:00:10.000Z";
const temporaryEditId = "PRIVATE-STAGE3E2B-TEMP-EDIT";
const temporaryExpiry = "4102444900";
const events = [
  { type: "verification_insert_attempted" },
  {
    type: "verification_edit_identified",
    editId: temporaryEditId,
    expiryTimeSeconds: temporaryExpiry,
  },
  {
    type: "verification_state_observed",
    observedStateDigest: expectedStateDigest,
    observedAtUtc: at,
  },
  { type: "verification_pre_delete_read_verified" },
  { type: "verification_delete_attempted" },
  { type: "verification_delete_acknowledged" },
  { type: "verification_cleanup_verified" },
] as const satisfies readonly ReleaseVerificationEvidenceEvent[];
const patches: readonly ReleaseCommitAttemptVerificationPatch[] = [
  { verificationInsertAttempted: true },
  { verificationEditId: temporaryEditId, verificationEditExpiryTimeSeconds: temporaryExpiry },
  { verificationObservedStateDigest: expectedStateDigest, verificationObservedAtUtc: at },
  { verificationPreDeleteReadVerified: true },
  { verificationDeleteAttempted: true },
  { verificationDeleteAcknowledged: true },
  { verificationCleanupVerified: true },
];
const directories: string[] = [];
const forbiddenFetch = vi.fn(() => {
  throw new Error("Network operations are forbidden in bridge tests");
});
beforeEach(() => {
  forbiddenFetch.mockClear();
  vi.stubGlobal("fetch", forbiddenFetch);
});
afterEach(() => {
  const networkCalls = [...forbiddenFetch.mock.calls];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  expect(networkCalls).toEqual([]);
});

async function acknowledged() {
  const root = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-evidence-bridge-"));
  directories.push(root);
  const path = join(root, "private", "attempts.json");
  const journal = createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName });
  const prepared = await journal.prepare({
    version: RELEASE_COMMIT_ATTEMPT_JOURNAL_VERSION,
    packageName,
    editId: "original-commit-edit",
    expiryTimeSeconds: "4102444800",
    targetTrack: "wear:production",
    versionCode: "101",
    releaseName: "Candidate 101",
    releaseStatus: "completed",
    expectedStateDigest,
    validationExpiryTimeSeconds: "4102444800",
    requestDigest: "c".repeat(64),
    attemptedAtUtc: at,
    updatedAtUtc: at,
  });
  await journal.transition(prepared.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", at);
  const record = await journal.transition(
    prepared.attemptId,
    "TRANSPORT_ATTEMPTED",
    "ACKNOWLEDGED",
    at,
    {
      acknowledgedAtUtc: at,
    },
  );
  return {
    path,
    journal: {
      list: vi.fn(journal.list),
      prepare: vi.fn(journal.prepare),
      transition: vi.fn(journal.transition),
      updateVerification: vi.fn(journal.updateVerification),
    },
    record,
  };
}

function restart(path: string) {
  return createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName });
}

async function onlyRecord(path: string): Promise<ReleaseCommitAttemptJournalRecord> {
  const records = await restart(path).list();
  expect(records).toHaveLength(1);
  const [record] = records;
  if (record === undefined) throw new Error("The test journal record is missing");
  return record;
}

async function prefix(length: number) {
  const built = await acknowledged();
  const options = {
    journal: built.journal,
    attemptId: built.record.attemptId,
    packageName,
    expectedStateDigest,
    now: vi.fn(() => new Date(updatedAt)),
  };
  const sink = createCommitVerificationEvidenceJournalSink(options);
  for (const event of events.slice(0, length)) await sink.record(event);
  return { ...built, options, sink };
}

function expectedPrefix(record: ReleaseCommitAttemptJournalRecord, length: number) {
  return {
    ...record,
    updatedAtUtc: length === 0 ? at : updatedAt,
    ...Object.assign({}, ...patches.slice(0, length)),
  };
}

describe("Stage 3E.2B strict commit verification journal bridge", () => {
  it("persists only the insert marker into the exact acknowledged attempt using a trusted clock", async () => {
    const built = await acknowledged();
    const now = vi.fn(() => new Date(updatedAt));
    const sink = createCommitVerificationEvidenceJournalSink({
      journal: built.journal,
      attemptId: built.record.attemptId,
      packageName,
      expectedStateDigest,
      now,
    });
    await sink.record({ type: "verification_insert_attempted" });
    const durable = { ...built.record, updatedAtUtc: updatedAt, verificationInsertAttempted: true };
    expect(await restart(built.path).list()).toEqual([durable]);
    expect(JSON.parse(readFileSync(built.path, "utf8")).records).toEqual([durable]);
    expect(now).toHaveBeenCalledTimes(1);
  });

  it("persists the paired temporary identity once and makes insert/identity replay a byte-preserving no-op", async () => {
    const built = await acknowledged();
    const now = vi.fn(() => new Date(updatedAt));
    const update = built.journal.updateVerification;
    const sink = createCommitVerificationEvidenceJournalSink({
      journal: built.journal,
      attemptId: built.record.attemptId,
      packageName,
      expectedStateDigest,
      now,
    });
    await sink.record({ type: "verification_insert_attempted" });
    const inserted = readFileSync(built.path, "utf8");
    await sink.record({ type: "verification_insert_attempted" });
    expect(readFileSync(built.path, "utf8")).toBe(inserted);
    const event = {
      type: "verification_edit_identified",
      editId: temporaryEditId,
      expiryTimeSeconds: temporaryExpiry,
    } as const;
    await sink.record(event);
    const identified = readFileSync(built.path, "utf8");
    await sink.record(event);
    expect(readFileSync(built.path, "utf8")).toBe(identified);
    expect(await restart(built.path).list()).toEqual([
      {
        ...built.record,
        updatedAtUtc: updatedAt,
        verificationInsertAttempted: true,
        verificationEditId: temporaryEditId,
        verificationEditExpiryTimeSeconds: temporaryExpiry,
      },
    ]);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith(built.record.attemptId, "ACKNOWLEDGED", updatedAt, {
      verificationEditId: temporaryEditId,
      verificationEditExpiryTimeSeconds: temporaryExpiry,
    });
    expect(now).toHaveBeenCalledTimes(2);
  });

  it("durably pins the successful observation through acknowledged deletion without advancing", async () => {
    const built = await acknowledged();
    const now = vi.fn(() => new Date(updatedAt));
    const sink = createCommitVerificationEvidenceJournalSink({
      journal: built.journal,
      attemptId: built.record.attemptId,
      packageName,
      expectedStateDigest,
      now,
    });
    for (const event of events.slice(0, 6)) {
      await sink.record(event);
      const persisted = readFileSync(built.path, "utf8");
      await sink.record(event);
      expect(readFileSync(built.path, "utf8")).toBe(persisted);
      expect((await onlyRecord(built.path)).state).toBe("ACKNOWLEDGED");
    }
    expect(await restart(built.path).list()).toEqual([
      {
        ...built.record,
        updatedAtUtc: updatedAt,
        verificationInsertAttempted: true,
        verificationEditId: temporaryEditId,
        verificationEditExpiryTimeSeconds: temporaryExpiry,
        verificationObservedStateDigest: expectedStateDigest,
        verificationObservedAtUtc: at,
        verificationPreDeleteReadVerified: true,
        verificationDeleteAttempted: true,
        verificationDeleteAcknowledged: true,
      },
    ]);
    const before = readFileSync(built.path, "utf8");
    for (const event of [
      {
        type: "verification_state_observed",
        observedStateDigest: "b".repeat(64),
        observedAtUtc: at,
      },
      {
        type: "verification_state_observed",
        observedStateDigest: expectedStateDigest,
        observedAtUtc: updatedAt,
      },
    ] as const) {
      await expect(sink.record(event)).rejects.toMatchObject({
        code: "VERIFICATION_STATE_MISMATCH",
      });
      expect(readFileSync(built.path, "utf8")).toBe(before);
    }
    expect(built.journal.updateVerification).toHaveBeenCalledTimes(6);
    expect(built.journal.prepare).not.toHaveBeenCalled();
    expect(built.journal.transition).not.toHaveBeenCalled();
    expect(now).toHaveBeenCalledTimes(6);
  });

  it("awaits durable cleanup, re-reads complete proof, and only then advances once to REMOTE_VERIFIED", async () => {
    const built = await acknowledged();
    const now = vi.fn(() => new Date(updatedAt));
    const sink = createCommitVerificationEvidenceJournalSink({
      journal: built.journal,
      attemptId: built.record.attemptId,
      packageName,
      expectedStateDigest,
      now,
    });
    for (const event of events.slice(0, 6)) await sink.record(event);
    const timeline: string[] = [];
    built.journal.list.mockImplementation(async () => {
      timeline.push("read");
      return restart(built.path).list();
    });
    built.journal.updateVerification.mockImplementation(async (...args) => {
      const result = await restart(built.path).updateVerification(...args);
      timeline.push("cleanup_durable");
      return result;
    });
    built.journal.transition.mockImplementation(async (...args) => {
      const records = await restart(built.path).list();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        attemptId: built.record.attemptId,
        state: "ACKNOWLEDGED",
        verificationObservedStateDigest: expectedStateDigest,
        verificationObservedAtUtc: at,
        verificationCleanupVerified: true,
      });
      expect(timeline).toEqual(["read", "cleanup_durable", "read"]);
      timeline.push("transition");
      return restart(built.path).transition(...args);
    });
    await sink.record(events[6]);
    expect(timeline).toEqual(["read", "cleanup_durable", "read", "transition", "read"]);
    expect(await restart(built.path).list()).toEqual([
      {
        ...built.record,
        updatedAtUtc: updatedAt,
        state: "REMOTE_VERIFIED",
        verificationInsertAttempted: true,
        verificationEditId: temporaryEditId,
        verificationEditExpiryTimeSeconds: temporaryExpiry,
        verificationObservedStateDigest: expectedStateDigest,
        verificationObservedAtUtc: at,
        verificationPreDeleteReadVerified: true,
        verificationDeleteAttempted: true,
        verificationDeleteAcknowledged: true,
        verificationCleanupVerified: true,
      },
    ]);
    expect(built.journal.transition).toHaveBeenCalledExactlyOnceWith(
      built.record.attemptId,
      "ACKNOWLEDGED",
      "REMOTE_VERIFIED",
      updatedAt,
    );
    const durable = readFileSync(built.path, "utf8");
    await sink.record(events[6]);
    expect(readFileSync(built.path, "utf8")).toBe(durable);
    expect(built.journal.updateVerification).toHaveBeenCalledTimes(7);
    expect(built.journal.transition).toHaveBeenCalledTimes(1);
    expect(built.journal.prepare).not.toHaveBeenCalled();
    expect(now).toHaveBeenCalledTimes(8);
  });

  it("recovers a cleanup-durable transition crash locally and then returns already_verified without another mutation", async () => {
    const built = await acknowledged();
    const options = {
      journal: built.journal,
      attemptId: built.record.attemptId,
      packageName,
      expectedStateDigest,
      now: vi.fn(() => new Date(updatedAt)),
    };
    const sink = createCommitVerificationEvidenceJournalSink(options);
    for (const event of events.slice(0, 6)) await sink.record(event);
    const failure = new Error("Local transition durability failed");
    built.journal.transition.mockRejectedValueOnce(failure);
    await expect(sink.record(events[6])).rejects.toBe(failure);
    expect((await restart(built.path).list())[0]).toMatchObject({
      state: "ACKNOWLEDGED",
      verificationObservedStateDigest: expectedStateDigest,
      verificationObservedAtUtc: at,
      verificationCleanupVerified: true,
    });
    const completeBefore = readFileSync(built.path, "utf8");
    const freshJournal = restart(built.path);
    const recoveredOptions = {
      ...options,
      journal: {
        list: vi.fn(freshJournal.list),
        prepare: vi.fn(freshJournal.prepare),
        transition: vi.fn(freshJournal.transition),
        updateVerification: vi.fn(freshJournal.updateVerification),
      },
    };
    await expect(resumeCommitVerificationEvidence(recoveredOptions)).resolves.toBe("verified");
    const verified = (await restart(built.path).list())[0];
    expect(verified).toEqual({
      ...JSON.parse(completeBefore).records[0],
      state: "REMOTE_VERIFIED",
    });
    const durable = readFileSync(built.path, "utf8");
    await expect(resumeCommitVerificationEvidence(recoveredOptions)).resolves.toBe(
      "already_verified",
    );
    expect(readFileSync(built.path, "utf8")).toBe(durable);
    expect(recoveredOptions.journal.transition).toHaveBeenCalledExactlyOnceWith(
      built.record.attemptId,
      "ACKNOWLEDGED",
      "REMOTE_VERIFIED",
      updatedAt,
    );
    expect(recoveredOptions.journal.updateVerification).not.toHaveBeenCalled();
    expect(recoveredOptions.journal.prepare).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2, 3, 4, 5, 6])(
    "reports durable prefix %i as verification_evidence_incomplete without fabricating facts",
    async (length) => {
      const built = await acknowledged();
      const now = vi.fn(() => new Date(updatedAt));
      const options = {
        journal: built.journal,
        attemptId: built.record.attemptId,
        packageName,
        expectedStateDigest,
        now,
      };
      const sink = createCommitVerificationEvidenceJournalSink(options);
      for (const event of events.slice(0, length)) await sink.record(event);
      built.journal.updateVerification.mockClear();
      now.mockClear();
      const before = readFileSync(built.path, "utf8");
      await expect(resumeCommitVerificationEvidence(options)).resolves.toBe(
        "verification_evidence_incomplete",
      );
      expect(readFileSync(built.path, "utf8")).toBe(before);
      expect((await onlyRecord(built.path)).state).toBe("ACKNOWLEDGED");
      expect(built.journal.updateVerification).not.toHaveBeenCalled();
      expect(built.journal.transition).not.toHaveBeenCalled();
      expect(built.journal.prepare).not.toHaveBeenCalled();
      expect(now).not.toHaveBeenCalled();
    },
  );

  it("rejects a journal-permitted pre-delete flag without observation instead of extending a nonmonotonic prefix", async () => {
    const built = await acknowledged();
    const options = {
      journal: built.journal,
      attemptId: built.record.attemptId,
      packageName,
      expectedStateDigest,
      now: () => new Date(updatedAt),
    };
    const sink = createCommitVerificationEvidenceJournalSink(options);
    for (const event of events.slice(0, 2)) await sink.record(event);
    await restart(built.path).updateVerification(
      built.record.attemptId,
      "ACKNOWLEDGED",
      updatedAt,
      {
        verificationPreDeleteReadVerified: true,
      },
    );
    // This is valid lower-level journal data, but invalid successful lifecycle proof.
    const durable = readFileSync(built.path, "utf8");
    built.journal.updateVerification.mockClear();
    await expect(sink.record(events[4])).rejects.toMatchObject({
      code: "VERIFICATION_STATE_MISMATCH",
      message: "Verification lifecycle order is invalid.",
    });
    await expect(resumeCommitVerificationEvidence(options)).rejects.toMatchObject({
      code: "VERIFICATION_STATE_MISMATCH",
    });
    expect(readFileSync(built.path, "utf8")).toBe(durable);
    expect(built.journal.updateVerification).not.toHaveBeenCalled();
    expect(built.journal.transition).not.toHaveBeenCalled();
  });

  it("serializes competing observed timestamps across sinks sharing a journal and never takes the permissive overwrite path", async () => {
    const built = await acknowledged();
    const options = {
      journal: built.journal,
      attemptId: built.record.attemptId,
      packageName,
      expectedStateDigest,
      now: () => new Date(updatedAt),
    };
    const first = createCommitVerificationEvidenceJournalSink(options);
    const second = createCommitVerificationEvidenceJournalSink(options);
    for (const event of events.slice(0, 2)) await first.record(event);
    const outcomes = await Promise.allSettled([
      first.record(events[2]),
      second.record({
        type: "verification_state_observed",
        observedStateDigest: expectedStateDigest,
        observedAtUtc: updatedAt,
      }),
    ]);
    expect(outcomes[0]).toMatchObject({ status: "fulfilled" });
    expect(outcomes[1]).toMatchObject({
      status: "rejected",
      reason: { code: "VERIFICATION_STATE_MISMATCH" },
    });
    expect((await restart(built.path).list())[0]).toMatchObject({
      verificationObservedStateDigest: expectedStateDigest,
      verificationObservedAtUtc: at,
    });
    expect(built.journal.updateVerification).toHaveBeenCalledTimes(3);
    const durable = readFileSync(built.path, "utf8");
    await second.record(events[2]);
    expect(readFileSync(built.path, "utf8")).toBe(durable);
  });

  it.each(events.slice(1).map((event, index) => ({ event, prefixLength: index })))(
    "rejects $event.type after only $prefixLength preceding markers before touching the journal",
    async ({ event, prefixLength }) => {
      const built = await prefix(prefixLength);
      built.journal.updateVerification.mockClear();
      built.options.now.mockClear();
      const durable = readFileSync(built.path, "utf8");
      await expect(built.sink.record(event)).rejects.toMatchObject({
        code: "VERIFICATION_STATE_MISMATCH",
        message: "Verification lifecycle order is invalid.",
        externalStateUncertain: false,
      });
      expect(readFileSync(built.path, "utf8")).toBe(durable);
      expect(built.journal.updateVerification).not.toHaveBeenCalled();
      expect(built.journal.transition).not.toHaveBeenCalled();
      expect(built.journal.prepare).not.toHaveBeenCalled();
      expect(built.options.now).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      field: "verificationEditId",
      event: {
        type: "verification_edit_identified",
        editId: "DIFFERENT-PRIVATE-ID",
        expiryTimeSeconds: temporaryExpiry,
      },
    },
    {
      field: "verificationEditExpiryTimeSeconds",
      event: {
        type: "verification_edit_identified",
        editId: temporaryEditId,
        expiryTimeSeconds: "4102444901",
      },
    },
    {
      field: "verificationObservedStateDigest",
      event: {
        type: "verification_state_observed",
        observedStateDigest: "b".repeat(64),
        observedAtUtc: at,
      },
    },
    {
      field: "verificationObservedAtUtc",
      event: {
        type: "verification_state_observed",
        observedStateDigest: expectedStateDigest,
        observedAtUtc: updatedAt,
      },
    },
  ] satisfies readonly { field: string; event: ReleaseVerificationEvidenceEvent }[])(
    "never replaces pinned $field before cleanup",
    async ({ event }) => {
      const built = await prefix(3);
      built.journal.updateVerification.mockClear();
      const durable = readFileSync(built.path, "utf8");
      await expect(built.sink.record(event)).rejects.toMatchObject({
        code: "VERIFICATION_STATE_MISMATCH",
        message: "Verification evidence conflicts with durable proof.",
        externalStateUncertain: false,
      });
      expect(readFileSync(built.path, "utf8")).toBe(durable);
      expect(built.journal.updateVerification).not.toHaveBeenCalled();
      expect(built.journal.transition).not.toHaveBeenCalled();
    },
  );

  it.each([
    { field: "packageName", override: { packageName: "com.example.wrong" } },
    { field: "expectedStateDigest", override: { expectedStateDigest: "b".repeat(64) } },
    { field: "attemptId", override: { attemptId: "00000000-0000-4000-8000-000000000000" } },
  ])(
    "binds all event/recovery reads to exact trusted $field without fallback",
    async ({ override }) => {
      const built = await prefix(0);
      const options = { ...built.options, ...override };
      const sink = createCommitVerificationEvidenceJournalSink(options);
      const durable = readFileSync(built.path, "utf8");
      for (const event of events)
        await expect(sink.record(event)).rejects.toMatchObject({
          code: "COMMIT_STATE_CHANGED",
          externalStateUncertain: false,
        });
      await expect(resumeCommitVerificationEvidence(options)).rejects.toMatchObject({
        code: "COMMIT_STATE_CHANGED",
      });
      expect(readFileSync(built.path, "utf8")).toBe(durable);
      expect(built.journal.prepare).not.toHaveBeenCalled();
      expect(built.journal.updateVerification).not.toHaveBeenCalled();
      expect(built.journal.transition).not.toHaveBeenCalled();
    },
  );

  it("rejects an ambiguous duplicate attemptId rather than selecting either record", async () => {
    const built = await prefix(0);
    built.journal.list.mockResolvedValue([built.record, built.record]);
    const durable = readFileSync(built.path, "utf8");
    await expect(built.sink.record(events[0])).rejects.toMatchObject({
      code: "COMMIT_STATE_CHANGED",
    });
    await expect(resumeCommitVerificationEvidence(built.options)).rejects.toMatchObject({
      code: "COMMIT_STATE_CHANGED",
    });
    expect(readFileSync(built.path, "utf8")).toBe(durable);
    expect(built.journal.updateVerification).not.toHaveBeenCalled();
    expect(built.journal.transition).not.toHaveBeenCalled();
  });

  it("uses an exact match surrounded by ACKNOWLEDGED decoys, never first/last/latest", async () => {
    const built = await prefix(0);
    built.journal.list.mockImplementation(async () => [
      {
        ...built.record,
        attemptId: "00000000-0000-4000-8000-000000000001",
        expectedStateDigest: "b".repeat(64),
      },
      ...(await restart(built.path).list()),
      {
        ...built.record,
        attemptId: "00000000-0000-4000-8000-000000000002",
        expectedStateDigest: "d".repeat(64),
      },
    ]);
    await built.sink.record(events[0]);
    expect(await restart(built.path).list()).toEqual([expectedPrefix(built.record, 1)]);
    expect(built.journal.updateVerification).toHaveBeenCalledExactlyOnceWith(
      built.record.attemptId,
      "ACKNOWLEDGED",
      updatedAt,
      patches[0],
    );
    expect(built.journal.prepare).not.toHaveBeenCalled();
  });

  it("blocks the real journal's permissive digest-and-timestamp overwrite path in the bridge", async () => {
    const built = await prefix(3);
    const durable = readFileSync(built.path, "utf8");
    built.journal.updateVerification.mockClear();
    await expect(
      built.sink.record({
        type: "verification_state_observed",
        observedStateDigest: "b".repeat(64),
        observedAtUtc: updatedAt,
      }),
    ).rejects.toMatchObject({ code: "VERIFICATION_STATE_MISMATCH" });
    expect(readFileSync(built.path, "utf8")).toBe(durable);
    expect(built.journal.updateVerification).not.toHaveBeenCalled();
    // The intentionally lower-level primitive really allows this overwrite.
    await restart(built.path).updateVerification(
      built.record.attemptId,
      "ACKNOWLEDGED",
      updatedAt,
      {
        verificationObservedStateDigest: "b".repeat(64),
        verificationObservedAtUtc: updatedAt,
      },
    );
    expect((await restart(built.path).list())[0]).toMatchObject({
      verificationObservedStateDigest: "b".repeat(64),
      verificationObservedAtUtc: updatedAt,
    });
    const conflicting = readFileSync(built.path, "utf8");
    await expect(built.sink.record(events[2])).rejects.toMatchObject({
      code: "VERIFICATION_STATE_MISMATCH",
    });
    await expect(resumeCommitVerificationEvidence(built.options)).rejects.toMatchObject({
      code: "VERIFICATION_STATE_MISMATCH",
    });
    expect(readFileSync(built.path, "utf8")).toBe(conflicting);
    expect(built.journal.updateVerification).not.toHaveBeenCalled();
    expect(built.journal.transition).not.toHaveBeenCalled();
  });

  it("replays all six earlier events at an advanced ACKNOWLEDGED prefix without replacement or another attempt", async () => {
    const built = await prefix(6);
    const durable = readFileSync(built.path, "utf8");
    built.journal.updateVerification.mockClear();
    built.options.now.mockClear();
    const freshSink = createCommitVerificationEvidenceJournalSink(built.options);
    for (const event of events.slice(0, 6)) await freshSink.record(event);
    expect(readFileSync(built.path, "utf8")).toBe(durable);
    expect(built.journal.updateVerification).not.toHaveBeenCalled();
    expect(built.journal.transition).not.toHaveBeenCalled();
    expect(built.journal.prepare).not.toHaveBeenCalled();
    expect(built.options.now).not.toHaveBeenCalled();
  });

  it.each(
    events.flatMap((event, index) => ["before", "after"].map((when) => ({ event, index, when }))),
  )(
    "keeps valid durable prefix at update $index failure $when write, and safely resumes same-event replay",
    async ({ event, index, when }) => {
      const built = await prefix(index);
      const failure = new Error("Injected local journal mutation failure");
      const before = readFileSync(built.path, "utf8");
      built.journal.updateVerification.mockImplementationOnce(async (...args) => {
        if (when === "after") await restart(built.path).updateVerification(...args);
        throw failure;
      });
      await expect(built.sink.record(event)).rejects.toBe(failure);
      const durableLength = index + (when === "after" ? 1 : 0);
      expect(await restart(built.path).list()).toEqual([
        expectedPrefix(built.record, durableLength),
      ]);
      if (when === "before") expect(readFileSync(built.path, "utf8")).toBe(before);
      expect(built.journal.transition).not.toHaveBeenCalled();
      expect(built.journal.prepare).not.toHaveBeenCalled();
      if (when === "after" && (index === 1 || index === 2)) {
        const conflictEvent: ReleaseVerificationEvidenceEvent =
          index === 1
            ? {
                type: "verification_edit_identified",
                editId: "CONFLICTING-PRIVATE-ID",
                expiryTimeSeconds: temporaryExpiry,
              }
            : {
                type: "verification_state_observed",
                observedStateDigest: expectedStateDigest,
                observedAtUtc: updatedAt,
              };
        const durable = readFileSync(built.path, "utf8");
        const calls = built.journal.updateVerification.mock.calls.length;
        await expect(built.sink.record(conflictEvent)).rejects.toMatchObject({
          code: "VERIFICATION_STATE_MISMATCH",
        });
        expect(readFileSync(built.path, "utf8")).toBe(durable);
        expect(built.journal.updateVerification).toHaveBeenCalledTimes(calls);
      }
      await built.sink.record(event);
      for (const next of events.slice(index + 1)) await built.sink.record(next);
      expect(await restart(built.path).list()).toEqual([
        { ...expectedPrefix(built.record, 7), state: "REMOTE_VERIFIED" },
      ]);
      expect(built.journal.transition).toHaveBeenCalledExactlyOnceWith(
        built.record.attemptId,
        "ACKNOWLEDGED",
        "REMOTE_VERIFIED",
        updatedAt,
      );
      expect(built.journal.prepare).not.toHaveBeenCalled();
    },
  );

  it.each([
    "PREPARED",
    "TRANSPORT_ATTEMPTED",
    "AMBIGUOUS",
    "REMOTE_VERIFIED",
    "RECONCILED_COMMITTED",
    "RECONCILED_NOT_COMMITTED",
  ] satisfies readonly ReleaseCommitAttemptState[])(
    "never starts a verification lifecycle or normalizes source state $0",
    async (state) => {
      const built = await prefix(0);
      const { acknowledgedAtUtc: _ack, ...base } = built.record;
      const record = {
        ...base,
        state,
        ...(state === "REMOTE_VERIFIED" || state === "RECONCILED_COMMITTED"
          ? { acknowledgedAtUtc: at, ...Object.assign({}, ...patches) }
          : {}),
      };
      // Read projection fixture is schema-valid; the bridge, not the parser,
      // owns rejection of this source state. No reconciliation tool is executed.
      expect(parseReleaseCommitAttemptJournalRecord(record, packageName).state).toBe(state);
      built.journal.list.mockResolvedValue([record]);
      const before = readFileSync(built.path, "utf8");
      for (const event of state === "REMOTE_VERIFIED" ? events.slice(0, 6) : events) {
        await expect(built.sink.record(event)).rejects.toMatchObject({
          code: "COMMIT_STATE_CHANGED",
          externalStateUncertain: false,
        });
      }
      if (state === "REMOTE_VERIFIED") {
        await expect(resumeCommitVerificationEvidence(built.options)).resolves.toBe(
          "already_verified",
        );
        await built.sink.record(events[6]);
      } else
        await expect(resumeCommitVerificationEvidence(built.options)).rejects.toMatchObject({
          code: "COMMIT_STATE_CHANGED",
        });
      expect(readFileSync(built.path, "utf8")).toBe(before);
      expect(built.journal.updateVerification).not.toHaveBeenCalled();
      expect(built.journal.transition).not.toHaveBeenCalled();
      expect(built.journal.prepare).not.toHaveBeenCalled();
      expect(built.options.now).not.toHaveBeenCalled();
    },
  );

  it("rejects lower-level cleanup evidence without a successful observation instead of fabricating missing proof", async () => {
    const built = await prefix(2);
    const real = restart(built.path);
    await real.updateVerification(built.record.attemptId, "ACKNOWLEDGED", updatedAt, {
      verificationPreDeleteReadVerified: true,
      verificationDeleteAttempted: true,
    });
    await real.updateVerification(built.record.attemptId, "ACKNOWLEDGED", updatedAt, {
      verificationDeleteAcknowledged: true,
      verificationCleanupVerified: true,
    });
    expect((await real.list())[0]).toMatchObject({
      state: "ACKNOWLEDGED",
      verificationCleanupVerified: true,
    });
    built.journal.updateVerification.mockClear();
    const before = readFileSync(built.path, "utf8");
    await expect(built.sink.record(events[6])).rejects.toMatchObject({
      code: "VERIFICATION_STATE_MISMATCH",
    });
    await expect(resumeCommitVerificationEvidence(built.options)).rejects.toMatchObject({
      code: "VERIFICATION_STATE_MISMATCH",
    });
    expect(readFileSync(built.path, "utf8")).toBe(before);
    expect(built.journal.updateVerification).not.toHaveBeenCalled();
    expect(built.journal.transition).not.toHaveBeenCalled();
  });

  it("rejects a real REMOTE_VERIFIED record created by the permissive primitive without cleanup", async () => {
    const built = await prefix(3);
    await restart(built.path).transition(
      built.record.attemptId,
      "ACKNOWLEDGED",
      "REMOTE_VERIFIED",
      updatedAt,
    );
    const before = readFileSync(built.path, "utf8");
    built.journal.updateVerification.mockClear();
    await expect(resumeCommitVerificationEvidence(built.options)).rejects.toMatchObject({
      code: "VERIFICATION_STATE_MISMATCH",
    });
    await expect(built.sink.record(events[6])).rejects.toMatchObject({
      code: "VERIFICATION_STATE_MISMATCH",
    });
    await expect(built.sink.record(events[0])).rejects.toMatchObject({
      code: "COMMIT_STATE_CHANGED",
    });
    expect(readFileSync(built.path, "utf8")).toBe(before);
    expect(built.journal.transition).not.toHaveBeenCalled();
    expect(built.journal.updateVerification).not.toHaveBeenCalled();
  });

  it.each(["before", "after"])(
    "preserves complete proof on transition failure $0 its durable write",
    async (when) => {
      const built = await prefix(6);
      const failure = new Error("Injected transition response failure");
      built.journal.transition.mockImplementationOnce(async (...args) => {
        if (when === "after") await restart(built.path).transition(...args);
        throw failure;
      });
      await expect(built.sink.record(events[6])).rejects.toBe(failure);
      const state = when === "before" ? "ACKNOWLEDGED" : "REMOTE_VERIFIED";
      expect(await restart(built.path).list()).toEqual([
        { ...expectedPrefix(built.record, 7), state },
      ]);
      const fresh = restart(built.path);
      const journal = {
        list: vi.fn(fresh.list),
        prepare: vi.fn(fresh.prepare),
        updateVerification: vi.fn(fresh.updateVerification),
        transition: vi.fn(fresh.transition),
      };
      await expect(resumeCommitVerificationEvidence({ ...built.options, journal })).resolves.toBe(
        when === "before" ? "verified" : "already_verified",
      );
      expect(journal.transition).toHaveBeenCalledTimes(when === "before" ? 1 : 0);
      expect(journal.updateVerification).not.toHaveBeenCalled();
      expect(journal.prepare).not.toHaveBeenCalled();
      const durable = readFileSync(built.path, "utf8");
      await built.sink.record(events[6]);
      expect(readFileSync(built.path, "utf8")).toBe(durable);
      expect(
        built.journal.transition.mock.calls.every(
          (args) => args[1] === "ACKNOWLEDGED" && args[2] === "REMOTE_VERIFIED",
        ),
      ).toBe(true);
      expect(built.journal.prepare).not.toHaveBeenCalled();
    },
  );

  it.each(["read_failure", "missing", "package", "digest"])(
    "fails closed on $0 during the required read after durable cleanup",
    async (kind) => {
      const built = await prefix(6);
      const failure = new Error("Local journal read failed");
      built.journal.updateVerification.mockImplementationOnce(async (...args) => {
        const record = await restart(built.path).updateVerification(...args);
        if (kind === "read_failure") built.journal.list.mockRejectedValueOnce(failure);
        else
          built.journal.list.mockResolvedValueOnce(
            kind === "missing"
              ? []
              : [
                  {
                    ...record,
                    ...(kind === "package"
                      ? { packageName: "com.example.changed" }
                      : { expectedStateDigest: "b".repeat(64) }),
                  },
                ],
          );
        return record;
      });
      if (kind === "read_failure") await expect(built.sink.record(events[6])).rejects.toBe(failure);
      else
        await expect(built.sink.record(events[6])).rejects.toMatchObject({
          code: "COMMIT_STATE_CHANGED",
        });
      expect(await restart(built.path).list()).toEqual([expectedPrefix(built.record, 7)]);
      expect(built.journal.transition).not.toHaveBeenCalled();
      const fresh = restart(built.path);
      await expect(
        resumeCommitVerificationEvidence({ ...built.options, journal: fresh }),
      ).resolves.toBe("verified");
      expect((await onlyRecord(built.path)).state).toBe("REMOTE_VERIFIED");
    },
  );

  it("uses a fresh exact journal read on every event, not a cached ACKNOWLEDGED record", async () => {
    const built = await prefix(2);
    const before = readFileSync(built.path, "utf8");
    const record = await onlyRecord(built.path);
    built.journal.list.mockResolvedValueOnce([{ ...record, expectedStateDigest: "b".repeat(64) }]);
    const calls = built.journal.updateVerification.mock.calls.length;
    await expect(built.sink.record(events[2])).rejects.toMatchObject({
      code: "COMMIT_STATE_CHANGED",
    });
    expect(readFileSync(built.path, "utf8")).toBe(before);
    expect(built.journal.updateVerification).toHaveBeenCalledTimes(calls);
  });

  it("propagates pre-event read failure without mutation or remote ambiguity", async () => {
    const built = await prefix(0);
    const failure = new Error("Journal unreadable");
    const before = readFileSync(built.path, "utf8");
    built.journal.list.mockRejectedValueOnce(failure);
    await expect(built.sink.record(events[0])).rejects.toBe(failure);
    built.journal.list.mockRejectedValueOnce(failure);
    await expect(resumeCommitVerificationEvidence(built.options)).rejects.toBe(failure);
    expect(readFileSync(built.path, "utf8")).toBe(before);
    expect(built.journal.updateVerification).not.toHaveBeenCalled();
    expect(built.journal.transition).not.toHaveBeenCalled();
    expect(built.journal.prepare).not.toHaveBeenCalled();
  });

  it("re-reads the final transition and allows local terminal recovery after its read response fails", async () => {
    const built = await prefix(6);
    const failure = new Error("Post-transition journal read failed");
    built.journal.transition.mockImplementationOnce(async (...args) => {
      const record = await restart(built.path).transition(...args);
      built.journal.list.mockRejectedValueOnce(failure);
      return record;
    });
    await expect(built.sink.record(events[6])).rejects.toBe(failure);
    expect(await restart(built.path).list()).toEqual([
      { ...expectedPrefix(built.record, 7), state: "REMOTE_VERIFIED" },
    ]);
    const before = readFileSync(built.path, "utf8");
    await expect(resumeCommitVerificationEvidence(built.options)).resolves.toBe("already_verified");
    await built.sink.record(events[6]);
    expect(readFileSync(built.path, "utf8")).toBe(before);
    expect(built.journal.transition).toHaveBeenCalledTimes(1);
    expect(built.journal.updateVerification).toHaveBeenCalledTimes(7);
  });

  it("captures trusted constructor identity and event values before awaiting local I/O", async () => {
    const built = await prefix(1);
    const options = { ...built.options };
    const sink = createCommitVerificationEvidenceJournalSink(options);
    options.attemptId = "00000000-0000-4000-8000-000000000000";
    options.packageName = "com.example.changed";
    options.expectedStateDigest = "b".repeat(64);
    const event = {
      type: "verification_edit_identified" as const,
      editId: temporaryEditId,
      expiryTimeSeconds: temporaryExpiry,
    };
    const recording = sink.record(event);
    event.editId = "MUTATED-PRIVATE-ID";
    event.expiryTimeSeconds = "4102444901";
    await recording;
    expect(await restart(built.path).list()).toEqual([expectedPrefix(built.record, 2)]);
  });

  it("keeps an invalid trusted clock from mutating the journal or replacing observation time", async () => {
    const built = await prefix(0);
    const sink = createCommitVerificationEvidenceJournalSink({
      ...built.options,
      now: () => new Date(NaN),
    });
    const before = readFileSync(built.path, "utf8");
    await expect(sink.record(events[0])).rejects.toBeInstanceOf(RangeError);
    expect(readFileSync(built.path, "utf8")).toBe(before);
    expect(built.journal.updateVerification).not.toHaveBeenCalled();
  });

  it("produces precisely the existing reconcile digest/cleanup proof on a real record without executing reconciliation", async () => {
    const built = await prefix(7);
    const records = await restart(built.path).list();
    expect(records).toHaveLength(1);
    const record = await onlyRecord(built.path);
    expect(record.state).toBe("REMOTE_VERIFIED");
    expect(record.verificationObservedStateDigest).toBe(record.expectedStateDigest);
    expect(record.verificationCleanupVerified).toBe(true);
    const source = readFileSync(
      new URL("../src/releases/reconcile-commit-tool.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(
      /record\.verificationObservedStateDigest !== candidate\.expectedStateDigest \|\|\s*record\.verificationCleanupVerified !== true/u,
    );
    expect(built.journal.transition.mock.calls.map((args) => args[2])).toEqual(["REMOTE_VERIFIED"]);
  });

  it("has only allowed releases-domain dependencies and adds no gateway, verifier, audit or disclosure surface", async () => {
    const source = readFileSync(
      new URL("../src/releases/commit-verification-evidence.ts", import.meta.url),
      "utf8",
    );
    const dependencies = Array.from(
      source.matchAll(/\bfrom\s+["']([^"']+)["']/gu),
      (match) => match[1],
    ).sort();
    expect(dependencies).toEqual([
      "./commit-attempt-journal.js",
      "./index.js",
      "./verification-evidence.js",
    ]);
    expect(source).not.toMatch(/\bimport\s*\(/u);
    expect(source).not.toContain("serializeResult");
    expect(source).not.toContain("auditLedger");
    const journalSource = readFileSync(
      new URL("../src/releases/commit-attempt-journal.ts", import.meta.url),
      "utf8",
    );
    expect(
      Array.from(journalSource.matchAll(/\bfrom\s+["']([^"']+)["']/gu), (match) => match[1]).sort(),
    ).toEqual(["./index.js", "node:crypto", "node:fs/promises", "node:path"]);
    const primitiveSource = readFileSync(
      new URL("../src/releases/index.ts", import.meta.url),
      "utf8",
    );
    expect(Array.from(primitiveSource.matchAll(/\bfrom\s+["']([^"']+)["']/gu))).toEqual([]);
    const built = await prefix(3);
    expect(Object.keys(built.sink)).toEqual(["record"]);
    const failure = await built.sink
      .record({
        type: "verification_edit_identified",
        editId: "SECRET-CONFLICT-EDIT",
        expiryTimeSeconds: temporaryExpiry,
      })
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    for (const marker of [temporaryEditId, "SECRET-CONFLICT-EDIT", temporaryExpiry]) {
      expect((failure as Error).message).not.toContain(marker);
    }
    await expect(resumeCommitVerificationEvidence(built.options)).resolves.toBe(
      "verification_evidence_incomplete",
    );
  });

  it.each([
    { field: "attemptId", override: { attemptId: " 00000000-0000-4000-8000-000000000000 " } },
    { field: "expectedStateDigest", override: { expectedStateDigest: "A".repeat(64) } },
    { field: "packageName", override: { packageName: " com.example.app " } },
    { field: "clock", override: { now: "client timestamp is not a clock" } },
  ])(
    "rejects malformed trusted $field before lookup, without repairing its literal value",
    async ({ override }) => {
      const built = await prefix(0);
      const options = {
        ...built.options,
        ...override,
      } as unknown as CommitVerificationEvidenceJournalOptions;
      expect(() => createCommitVerificationEvidenceJournalSink(options)).toThrowError(
        expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      );
      await expect(resumeCommitVerificationEvidence(options)).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      expect(built.journal.list).not.toHaveBeenCalled();
      expect(built.journal.updateVerification).not.toHaveBeenCalled();
      expect(built.journal.transition).not.toHaveBeenCalled();
    },
  );

  it.each(["before", "after"])(
    "preserves complete durable facts if local recovery's transition fails $0 its write",
    async (when) => {
      const built = await prefix(6);
      built.journal.transition.mockRejectedValueOnce(new Error("Crash before initial transition"));
      await expect(built.sink.record(events[6])).rejects.toThrow("Crash before initial transition");
      const complete = readFileSync(built.path, "utf8");
      const failure = new Error("Recovery transition failed locally");
      built.journal.transition.mockImplementationOnce(async (...args) => {
        if (when === "after") await restart(built.path).transition(...args);
        throw failure;
      });
      await expect(resumeCommitVerificationEvidence(built.options)).rejects.toBe(failure);
      expect(await restart(built.path).list()).toEqual([
        {
          ...expectedPrefix(built.record, 7),
          state: when === "before" ? "ACKNOWLEDGED" : "REMOTE_VERIFIED",
        },
      ]);
      if (when === "before") expect(readFileSync(built.path, "utf8")).toBe(complete);
      await expect(
        resumeCommitVerificationEvidence({ ...built.options, journal: restart(built.path) }),
      ).resolves.toBe(when === "before" ? "verified" : "already_verified");
      expect(await restart(built.path).list()).toEqual([
        { ...expectedPrefix(built.record, 7), state: "REMOTE_VERIFIED" },
      ]);
      expect(built.journal.updateVerification).toHaveBeenCalledTimes(7);
      expect(built.journal.prepare).not.toHaveBeenCalled();
    },
  );

  it("serializes concurrent local recovery and terminal cleanup replay without a duplicate transition", async () => {
    const built = await prefix(6);
    built.journal.transition.mockRejectedValueOnce(new Error("Crash before transition"));
    await expect(built.sink.record(events[6])).rejects.toThrow("Crash before transition");
    built.journal.transition.mockClear();
    built.journal.updateVerification.mockClear();
    const results = await Promise.all([
      resumeCommitVerificationEvidence(built.options),
      built.sink.record(events[6]),
      resumeCommitVerificationEvidence(built.options),
    ]);
    expect(results).toEqual(["verified", undefined, "already_verified"]);
    expect(built.journal.transition).toHaveBeenCalledExactlyOnceWith(
      built.record.attemptId,
      "ACKNOWLEDGED",
      "REMOTE_VERIFIED",
      updatedAt,
    );
    expect(built.journal.updateVerification).not.toHaveBeenCalled();
    expect(built.journal.prepare).not.toHaveBeenCalled();
  });

  it("uses exactly one trusted clock value per mutation while preserving the verifier's observation timestamp", async () => {
    const built = await acknowledged();
    let tick = 0;
    const now = vi.fn(() => new Date(Date.parse(updatedAt) + tick++ * 1000));
    const sink = createCommitVerificationEvidenceJournalSink({
      journal: built.journal,
      attemptId: built.record.attemptId,
      packageName,
      expectedStateDigest,
      now,
    });
    for (const event of events) await sink.record(event);
    const expectedTimes = Array.from({ length: 8 }, (_, index) =>
      new Date(Date.parse(updatedAt) + index * 1000).toISOString(),
    );
    expect(built.journal.updateVerification.mock.calls.map((args) => args[2])).toEqual(
      expectedTimes.slice(0, 7),
    );
    expect(built.journal.transition.mock.calls.map((args) => args[3])).toEqual(
      expectedTimes.slice(7),
    );
    const record = await onlyRecord(built.path);
    expect(record.verificationObservedAtUtc).toBe(at);
    expect(record.updatedAtUtc).toBe(expectedTimes[7]);
    expect(now).toHaveBeenCalledTimes(8);
  });

  it.each(["list", "updateVerification", "transition"] as const)(
    "rejects a missing journal $0 dependency before any event is admitted",
    async (method) => {
      const built = await prefix(0);
      const options = {
        ...built.options,
        journal: { ...built.journal, [method]: undefined },
      } as unknown as CommitVerificationEvidenceJournalOptions;
      expect(() => createCommitVerificationEvidenceJournalSink(options)).toThrowError(
        expect.objectContaining({ code: "INVALID_ARGUMENT" }),
      );
      await expect(resumeCommitVerificationEvidence(options)).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      expect(built.journal.list).not.toHaveBeenCalled();
      expect(built.journal.updateVerification).not.toHaveBeenCalled();
      expect(built.journal.transition).not.toHaveBeenCalled();
      expect(built.journal.prepare).not.toHaveBeenCalled();
    },
  );
});

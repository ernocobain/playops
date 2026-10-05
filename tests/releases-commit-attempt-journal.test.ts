import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  open as openFile,
  readFile as readJournalFile,
  rename as renameFile,
} from "node:fs/promises";
import type * as FileSystemPromises from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFileReleaseCommitAttemptJournal,
  parseReleaseCommitAttemptJournalRecord,
  RELEASE_COMMIT_ATTEMPT_JOURNAL_VERSION,
  RELEASE_COMMIT_ATTEMPT_STATES,
  type ReleaseCommitAttemptPreparedInput,
  type ReleaseCommitAttemptVerificationPatch,
} from "../src/releases/commit-attempt-journal.js";

// Real filesystem by default; only deterministic I/O failures use these seams.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystemPromises>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    readFile: vi.fn(actual.readFile),
    rename: vi.fn(actual.rename),
  };
});
const packageName = "com.example.recovery";
const at = "2026-10-05T10:00:00.000Z";
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof FileSystemPromises>("node:fs/promises");
  vi.mocked(openFile).mockReset().mockImplementation(actual.open);
  vi.mocked(readJournalFile).mockReset().mockImplementation(actual.readFile);
  vi.mocked(renameFile).mockReset().mockImplementation(actual.rename);
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function location() {
  const root = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-commit-journal-"));
  directories.push(root);
  return join(root, "private", "attempts.json");
}
async function cleanedVerification() {
  const ready = await verificationReady();
  await ready.store.updateVerification(ready.original.attemptId, "TRANSPORT_ATTEMPTED", at, {
    verificationObservedStateDigest: ready.original.expectedStateDigest,
    verificationObservedAtUtc: at,
    verificationPreDeleteReadVerified: true,
    verificationDeleteAttempted: true,
  });
  const cleaned = await ready.store.updateVerification(
    ready.original.attemptId,
    "TRANSPORT_ATTEMPTED",
    at,
    {
      verificationDeleteAcknowledged: true,
      verificationCleanupVerified: true,
    },
  );
  return { ...ready, cleaned };
}
async function verificationReady() {
  const path = location();
  const store = createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName });
  const original = await store.prepare(prepared());
  await store.transition(original.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", at);
  await store.updateVerification(original.attemptId, "TRANSPORT_ATTEMPTED", at, {
    verificationInsertAttempted: true,
  });
  const identified = await store.updateVerification(original.attemptId, "TRANSPORT_ATTEMPTED", at, {
    verificationEditId: "verification-edit",
    verificationEditExpiryTimeSeconds: "9223372036854775807",
  });
  return { path, store, original, identified };
}
function prepared() {
  return {
    version: RELEASE_COMMIT_ATTEMPT_JOURNAL_VERSION,
    packageName,
    editId: "original-edit",
    expiryTimeSeconds: "1900000000",
    targetTrack: "internal",
    versionCode: "3",
    releaseName: "3 (1.1)",
    releaseStatus: "completed" as const,
    expectedStateDigest: "a".repeat(64),
    priorStateDigest: "b".repeat(64),
    validationExpiryTimeSeconds: "1900000000",
    requestDigest: "c".repeat(64),
    attemptedAtUtc: at,
    updatedAtUtc: at,
  };
}

describe("R6 durable commit-attempt authority", () => {
  it("durably retains PREPARED identity across a fresh store with private permissions", async () => {
    const path = location();
    const store = createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName });
    expect(await store.list()).toEqual([]);
    const record = await store.prepare(prepared());
    expect(record).toMatchObject({ ...prepared(), state: "PREPARED" });
    expect(record.attemptId).toBeTypeOf("string");
    const restarted = createFileReleaseCommitAttemptJournal(path, {
      expectedPackageName: packageName,
    });
    expect(await restarted.list()).toEqual([record]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    const disk = readFileSync(path, "utf8");
    expect(disk).not.toContain("releaseNotes");
    expect(disk).not.toContain("authorization");
    expect(disk).not.toContain("privateKey");
  });

  it("durably advances transport and acknowledgment across fresh journal instances", async () => {
    const path = location();
    const store = createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName });
    const original = await store.prepare(prepared());
    const transported = await store.transition(
      original.attemptId,
      "PREPARED",
      "TRANSPORT_ATTEMPTED",
      at,
    );
    expect(transported).toEqual({ ...original, state: "TRANSPORT_ATTEMPTED" });
    const restarted = createFileReleaseCommitAttemptJournal(path, {
      expectedPackageName: packageName,
    });
    expect(await restarted.list()).toEqual([transported]);
    const acknowledged = await restarted.transition(
      original.attemptId,
      "TRANSPORT_ATTEMPTED",
      "ACKNOWLEDGED",
      at,
      { acknowledgedAtUtc: at },
    );
    expect(acknowledged).toEqual({ ...original, state: "ACKNOWLEDGED", acknowledgedAtUtc: at });
    expect(await store.list()).toEqual([acknowledged]);
  });
  it.each([
    ["PREPARED", "RECONCILED_NOT_COMMITTED"],
    ["TRANSPORT_ATTEMPTED", "AMBIGUOUS"],
    ["TRANSPORT_ATTEMPTED", "RECONCILED_NOT_COMMITTED"],
    ["AMBIGUOUS", "RECONCILED_NOT_COMMITTED"],
  ] as const)("retains the allowed %s → %s transition", async (from, to) => {
    const path = location();
    const store = createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName });
    const original = await store.prepare(prepared());
    if (from !== "PREPARED")
      await store.transition(original.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", at);
    if (from === "AMBIGUOUS")
      await store.transition(original.attemptId, "TRANSPORT_ATTEMPTED", "AMBIGUOUS", at);
    const result = await store.transition(original.attemptId, from, to, at);
    expect(result).toEqual({ ...original, state: to });
    expect(
      await createFileReleaseCommitAttemptJournal(path, {
        expectedPackageName: packageName,
      }).list(),
    ).toEqual([result]);
  });

  it("blocks a second unresolved attempt and appends a fresh UUID only after terminal reconciliation", async () => {
    const path = location();
    const store = createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName });
    const original = await store.prepare(prepared());
    const bytes = readFileSync(path, "utf8");
    await expect(store.prepare(prepared())).rejects.toMatchObject({
      code: "COMMIT_ATTEMPT_JOURNAL_INVALID",
    });
    expect(readFileSync(path, "utf8")).toBe(bytes);
    const terminal = await store.transition(
      original.attemptId,
      "PREPARED",
      "RECONCILED_NOT_COMMITTED",
      at,
    );
    const next = await store.prepare(prepared());
    expect(next.attemptId).not.toBe(original.attemptId);
    expect(await store.list()).toEqual([terminal, next]);
    await expect(
      store.transition(original.attemptId, "RECONCILED_NOT_COMMITTED", "PREPARED", at),
    ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
    expect(await store.list()).toEqual([terminal, next]);
  });

  it("retains durable acknowledgement evidence across later states and a fresh instance", async () => {
    const { path, store, original } = await verificationReady();
    const acknowledged = await store.transition(
      original.attemptId,
      "TRANSPORT_ATTEMPTED",
      "ACKNOWLEDGED",
      at,
      { acknowledgedAtUtc: at },
    );
    expect(acknowledged.acknowledgedAtUtc).toBe(at);
    const verified = await store.transition(
      original.attemptId,
      "ACKNOWLEDGED",
      "REMOTE_VERIFIED",
      at,
      {
        verificationObservedStateDigest: original.expectedStateDigest,
        verificationObservedAtUtc: at,
      },
    );
    expect(verified.acknowledgedAtUtc).toBe(at);
    await store.updateVerification(original.attemptId, "REMOTE_VERIFIED", at, {
      verificationPreDeleteReadVerified: true,
      verificationDeleteAttempted: true,
    });
    await store.updateVerification(original.attemptId, "REMOTE_VERIFIED", at, {
      verificationDeleteAcknowledged: true,
      verificationCleanupVerified: true,
    });
    const committed = await store.transition(
      original.attemptId,
      "REMOTE_VERIFIED",
      "RECONCILED_COMMITTED",
      at,
    );
    expect(committed.acknowledgedAtUtc).toBe(at);
    const [restarted] = await createFileReleaseCommitAttemptJournal(path, {
      expectedPackageName: packageName,
    }).list();
    expect(restarted?.state).toBe("RECONCILED_COMMITTED");
    expect(restarted?.acknowledgedAtUtc).toBe(at);
  });

  it("rejects acknowledgement evidence outside the ACKNOWLEDGED transition or any rewrite", async () => {
    const { path, store, original } = await verificationReady();
    const untouched = readFileSync(path, "utf8");
    await expect(
      store.transition(original.attemptId, "TRANSPORT_ATTEMPTED", "REMOTE_VERIFIED", at, {
        verificationObservedStateDigest: original.expectedStateDigest,
        verificationObservedAtUtc: at,
        acknowledgedAtUtc: at,
      }),
    ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
    await expect(
      store.updateVerification(original.attemptId, "TRANSPORT_ATTEMPTED", at, {
        acknowledgedAtUtc: at,
      }),
    ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
    await expect(
      store.transition(original.attemptId, "TRANSPORT_ATTEMPTED", "ACKNOWLEDGED", at, {
        acknowledgedAtUtc: "not-a-timestamp",
      } as unknown as ReleaseCommitAttemptVerificationPatch),
    ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
    expect(readFileSync(path, "utf8")).toBe(untouched);
    const acknowledged = await store.transition(
      original.attemptId,
      "TRANSPORT_ATTEMPTED",
      "ACKNOWLEDGED",
      at,
      { acknowledgedAtUtc: at },
    );
    expect(acknowledged.acknowledgedAtUtc).toBe(at);
    const written = readFileSync(path, "utf8");
    await expect(
      store.transition(original.attemptId, "ACKNOWLEDGED", "REMOTE_VERIFIED", at, {
        acknowledgedAtUtc: "2026-10-05T11:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
    await expect(
      store.updateVerification(original.attemptId, "ACKNOWLEDGED", at, {
        acknowledgedAtUtc: "2026-10-05T11:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
    expect(readFileSync(path, "utf8")).toBe(written);
    expect((await store.list())[0]?.acknowledgedAtUtc).toBe(at);
  });

  it("rejects stale state, missing attempt identity, same-state transitions, and acknowledgment downgrade without writing", async () => {
    const path = location();
    const store = createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName });
    const original = await store.prepare(prepared());
    await store.transition(original.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", at);
    await store.transition(original.attemptId, "TRANSPORT_ATTEMPTED", "ACKNOWLEDGED", at, {
      acknowledgedAtUtc: at,
    });
    const bytes = readFileSync(path, "utf8");
    for (const [id, from, to] of [
      [original.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED"],
      ["untracked", "ACKNOWLEDGED", "REMOTE_VERIFIED"],
      [original.attemptId, "ACKNOWLEDGED", "ACKNOWLEDGED"],
      [original.attemptId, "ACKNOWLEDGED", "AMBIGUOUS"],
      [original.attemptId, "ACKNOWLEDGED", "RECONCILED_NOT_COMMITTED"],
      [original.attemptId, "ACKNOWLEDGED", "RECONCILED_COMMITTED"],
    ] as const) {
      await expect(store.transition(id, from, to, at)).rejects.toMatchObject({
        code: "COMMIT_ATTEMPT_JOURNAL_INVALID",
      });
      expect(readFileSync(path, "utf8")).toBe(bytes);
    }
  });
  it("durably tracks one verification insert and its exact lossless identity across restarts", async () => {
    const path = location();
    const store = createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName });
    const original = await store.prepare(prepared());
    await store.transition(original.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", at);
    const inserted = await store.updateVerification(original.attemptId, "TRANSPORT_ATTEMPTED", at, {
      verificationInsertAttempted: true,
    });
    expect(inserted).toEqual({
      ...original,
      state: "TRANSPORT_ATTEMPTED",
      verificationInsertAttempted: true,
    });
    const restarted = createFileReleaseCommitAttemptJournal(path, {
      expectedPackageName: packageName,
    });
    expect(await restarted.list()).toEqual([inserted]);
    const identified = await restarted.updateVerification(
      original.attemptId,
      "TRANSPORT_ATTEMPTED",
      at,
      {
        verificationEditId: "verification-edit",
        verificationEditExpiryTimeSeconds: "9223372036854775807",
      },
    );
    expect(identified).toEqual({
      ...inserted,
      verificationEditId: "verification-edit",
      verificationEditExpiryTimeSeconds: "9223372036854775807",
    });
    expect(await store.list()).toEqual([identified]);
    const bytes = readFileSync(path, "utf8");
    await expect(store.prepare(prepared())).rejects.toMatchObject({
      code: "COMMIT_ATTEMPT_JOURNAL_INVALID",
    });
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  it.each([
    { verificationInsertAttempted: false },
    { verificationEditId: "verification-edit", verificationEditExpiryTimeSeconds: "1900000000" },
    {
      verificationInsertAttempted: true,
      verificationEditId: "verification-edit",
      verificationEditExpiryTimeSeconds: "1900000000",
    },
    { state: "ACKNOWLEDGED" },
    { editId: "replacement-original" },
    { expectedStateDigest: "d".repeat(64) },
    { releaseNotes: "must never be stored" },
    { authorization: "must never be stored" },
    { privateKey: "must never be stored" },
  ])(
    "rejects premature or non-operational verification patches %j without writing",
    async (patch) => {
      const path = location();
      const store = createFileReleaseCommitAttemptJournal(path, {
        expectedPackageName: packageName,
      });
      const original = await store.prepare(prepared());
      await store.transition(original.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", at);
      const bytes = readFileSync(path, "utf8");
      await expect(
        store.updateVerification(
          original.attemptId,
          "TRANSPORT_ATTEMPTED",
          at,
          patch as unknown as ReleaseCommitAttemptVerificationPatch,
        ),
      ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
      expect(readFileSync(path, "utf8")).toBe(bytes);
    },
  );

  it.each([
    { attemptId: "11111111-1111-4111-8111-111111111111" },
    { state: "ACKNOWLEDGED" },
    { verificationInsertAttempted: true },
  ])("rejects caller-supplied preparation authority %j without creating a file", async (extra) => {
    const path = location();
    const store = createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName });
    await expect(
      store.prepare({ ...prepared(), ...extra } as unknown as ReleaseCommitAttemptPreparedInput),
    ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
    expect(await store.list()).toEqual([]);
  });
  it.each(["TRANSPORT_ATTEMPTED", "ACKNOWLEDGED", "AMBIGUOUS"] as const)(
    "requires exact proof then acknowledged cleanup before reconciling %s as committed",
    async (from) => {
      const { path, store, original, identified } = await verificationReady();
      if (from !== "TRANSPORT_ATTEMPTED")
        await store.transition(
          original.attemptId,
          "TRANSPORT_ATTEMPTED",
          from,
          at,
          from === "ACKNOWLEDGED" ? { acknowledgedAtUtc: at } : {},
        );
      let bytes = readFileSync(path, "utf8");
      await expect(
        store.transition(original.attemptId, from, "REMOTE_VERIFIED", at),
      ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
      expect(readFileSync(path, "utf8")).toBe(bytes);
      const proof = {
        verificationObservedStateDigest: original.expectedStateDigest,
        verificationObservedAtUtc: at,
      };
      const verified = await store.transition(
        original.attemptId,
        from,
        "REMOTE_VERIFIED",
        at,
        proof,
      );
      expect(verified).toEqual({
        ...identified,
        state: "REMOTE_VERIFIED",
        ...(from === "ACKNOWLEDGED" ? { acknowledgedAtUtc: at } : {}),
        ...proof,
      });
      expect(
        await createFileReleaseCommitAttemptJournal(path, {
          expectedPackageName: packageName,
        }).list(),
      ).toEqual([verified]);
      bytes = readFileSync(path, "utf8");
      await expect(
        store.transition(original.attemptId, "REMOTE_VERIFIED", "RECONCILED_COMMITTED", at),
      ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
      expect(readFileSync(path, "utf8")).toBe(bytes);
      await store.updateVerification(original.attemptId, "REMOTE_VERIFIED", at, {
        verificationPreDeleteReadVerified: true,
      });
      const deleting = await store.updateVerification(original.attemptId, "REMOTE_VERIFIED", at, {
        verificationDeleteAttempted: true,
      });
      expect(
        await createFileReleaseCommitAttemptJournal(path, {
          expectedPackageName: packageName,
        }).list(),
      ).toEqual([deleting]);
      const cleaned = await store.updateVerification(original.attemptId, "REMOTE_VERIFIED", at, {
        verificationDeleteAcknowledged: true,
        verificationCleanupVerified: true,
      });
      const committed = await store.transition(
        original.attemptId,
        "REMOTE_VERIFIED",
        "RECONCILED_COMMITTED",
        at,
      );
      expect(committed).toEqual({ ...cleaned, state: "RECONCILED_COMMITTED" });
      expect(committed).toMatchObject({
        ...prepared(),
        ...proof,
        verificationInsertAttempted: true,
        verificationEditId: "verification-edit",
        verificationEditExpiryTimeSeconds: "9223372036854775807",
        verificationPreDeleteReadVerified: true,
        verificationDeleteAttempted: true,
        verificationDeleteAcknowledged: true,
        verificationCleanupVerified: true,
      });
      const next = await store.prepare(prepared());
      expect(next.attemptId).not.toBe(original.attemptId);
      expect(await store.list()).toEqual([committed, next]);
      bytes = readFileSync(path, "utf8");
      await expect(
        store.transition(original.attemptId, "RECONCILED_COMMITTED", "REMOTE_VERIFIED", at),
      ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
      expect(readFileSync(path, "utf8")).toBe(bytes);
    },
  );

  it.each([
    { verificationObservedStateDigest: "a".repeat(64) },
    { verificationObservedAtUtc: at },
    { verificationObservedStateDigest: "not-a-digest", verificationObservedAtUtc: at },
    { verificationObservedStateDigest: "a".repeat(64), verificationObservedAtUtc: "2026-10-05" },
    { verificationPreDeleteReadVerified: false },
    { verificationDeleteAttempted: true },
    { verificationDeleteAcknowledged: true },
    {
      verificationPreDeleteReadVerified: true,
      verificationDeleteAttempted: true,
      verificationDeleteAcknowledged: true,
    },
    { verificationCleanupVerified: true },
    { verificationDeleteAttempted: false },
    { verificationDeleteAcknowledged: false },
    { verificationCleanupVerified: false },
  ])("rejects invalid proof or out-of-order cleanup %j without writing", async (patch) => {
    const { path, store, original } = await verificationReady();
    const bytes = readFileSync(path, "utf8");
    await expect(
      store.updateVerification(
        original.attemptId,
        "TRANSPORT_ATTEMPTED",
        at,
        patch as unknown as ReleaseCommitAttemptVerificationPatch,
      ),
    ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  it("retains mismatch proof without claiming remote verification", async () => {
    const { path, store, original, identified } = await verificationReady();
    const proof = {
      verificationObservedStateDigest: "d".repeat(64),
      verificationObservedAtUtc: at,
    };
    const mismatched = await store.updateVerification(
      original.attemptId,
      "TRANSPORT_ATTEMPTED",
      at,
      proof,
    );
    expect(mismatched).toEqual({ ...identified, ...proof });
    const bytes = readFileSync(path, "utf8");
    await expect(
      store.transition(original.attemptId, "TRANSPORT_ATTEMPTED", "REMOTE_VERIFIED", at),
    ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(
      await createFileReleaseCommitAttemptJournal(path, {
        expectedPackageName: packageName,
      }).list(),
    ).toEqual([mismatched]);
  });
  it("rejects original edit identity before recording a verification edit", async () => {
    const path = location();
    const store = createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName });
    const original = await store.prepare(prepared());
    await store.transition(original.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", at);
    await store.updateVerification(original.attemptId, "TRANSPORT_ATTEMPTED", at, {
      verificationInsertAttempted: true,
    });
    const bytes = readFileSync(path, "utf8");
    await expect(
      store.updateVerification(original.attemptId, "TRANSPORT_ATTEMPTED", at, {
        verificationEditId: original.editId,
        verificationEditExpiryTimeSeconds: original.expiryTimeSeconds,
      }),
    ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  it.each([
    [
      "replacement edit",
      {
        verificationEditId: "replacement-verification-edit",
        verificationEditExpiryTimeSeconds: "9223372036854775807",
      },
    ],
    ["replacement expiry", { verificationEditExpiryTimeSeconds: "9223372036854775806" }],
    [
      "numeric-equivalent replacement expiry",
      { verificationEditExpiryTimeSeconds: "09223372036854775807" },
    ],
    [
      "cleared identity",
      { verificationEditId: undefined, verificationEditExpiryTimeSeconds: undefined },
    ],
    ["cleared insert marker", { verificationInsertAttempted: undefined }],
    ["false insert marker", { verificationInsertAttempted: false }],
  ] as const)("retains immutable verification identity against %s", async (_label, patch) => {
    const { path, store, original, identified } = await verificationReady();
    const bytes = readFileSync(path, "utf8");
    await expect(
      store.updateVerification(
        original.attemptId,
        "TRANSPORT_ATTEMPTED",
        at,
        patch as unknown as ReleaseCommitAttemptVerificationPatch,
      ),
    ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(
      await createFileReleaseCommitAttemptJournal(path, {
        expectedPackageName: packageName,
      }).list(),
    ).toEqual([identified]);
  });

  it.each([
    ["cleared preread", { verificationPreDeleteReadVerified: undefined }],
    ["false preread", { verificationPreDeleteReadVerified: false }],
    ["cleared delete attempt", { verificationDeleteAttempted: undefined }],
    ["false delete attempt", { verificationDeleteAttempted: false }],
    ["cleared delete acknowledgment", { verificationDeleteAcknowledged: undefined }],
    ["false delete acknowledgment", { verificationDeleteAcknowledged: false }],
    ["cleared cleanup", { verificationCleanupVerified: undefined }],
    ["false cleanup", { verificationCleanupVerified: false }],
    [
      "replaced observed proof",
      { verificationObservedStateDigest: "d".repeat(64), verificationObservedAtUtc: at },
    ],
    ["replaced observation time", { verificationObservedAtUtc: "2026-10-05T10:00:01.000Z" }],
    [
      "cleared observed proof",
      { verificationObservedStateDigest: undefined, verificationObservedAtUtc: undefined },
    ],
  ] as const)("retains cleaned historical evidence against %s", async (_label, patch) => {
    const { path, store, original, cleaned } = await cleanedVerification();
    const bytes = readFileSync(path, "utf8");
    await expect(
      store.updateVerification(
        original.attemptId,
        "TRANSPORT_ATTEMPTED",
        "2026-10-05T10:00:01.000Z",
        patch as unknown as ReleaseCommitAttemptVerificationPatch,
      ),
    ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(await store.list()).toEqual([cleaned]);
  });

  it.each(["PREPARED", "RECONCILED_NOT_COMMITTED"] as const)(
    "cannot start verification from %s",
    async (from) => {
      const path = location();
      const store = createFileReleaseCommitAttemptJournal(path, {
        expectedPackageName: packageName,
      });
      const original = await store.prepare(prepared());
      if (from !== "PREPARED") await store.transition(original.attemptId, "PREPARED", from, at);
      const bytes = readFileSync(path, "utf8");
      await expect(
        store.updateVerification(original.attemptId, from, at, {
          verificationInsertAttempted: true,
        }),
      ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
      expect(readFileSync(path, "utf8")).toBe(bytes);
    },
  );

  it("keeps pending verification cleanup blocking fresh attempts even after not-committed reconciliation", async () => {
    const { path, store, original } = await verificationReady();
    await store.transition(
      original.attemptId,
      "TRANSPORT_ATTEMPTED",
      "RECONCILED_NOT_COMMITTED",
      at,
    );
    const bytes = readFileSync(path, "utf8");
    await expect(store.prepare(prepared())).rejects.toMatchObject({
      code: "COMMIT_ATTEMPT_JOURNAL_INVALID",
    });
    expect(readFileSync(path, "utf8")).toBe(bytes);
    await store.updateVerification(original.attemptId, "RECONCILED_NOT_COMMITTED", at, {
      verificationPreDeleteReadVerified: true,
      verificationDeleteAttempted: true,
    });
    const cleaned = await store.updateVerification(
      original.attemptId,
      "RECONCILED_NOT_COMMITTED",
      at,
      {
        verificationDeleteAcknowledged: true,
        verificationCleanupVerified: true,
      },
    );
    const next = await store.prepare(prepared());
    expect(await store.list()).toEqual([cleaned, next]);
    expect(Object.keys(store).sort()).toEqual([
      "list",
      "prepare",
      "transition",
      "updateVerification",
    ]);
  });
  it.each([
    ["file version", "file", { version: 2 }],
    ["file package", "file", { packageName: "com.example.other" }],
    ["file unknown key", "file", { unexpected: true }],
    ["file secret key", "file", { authorization: "sentinel-never-store" }],
    ["record version", "record", { version: 2 }],
    ["record package", "record", { packageName: "com.example.other" }],
    ["attempt identity", "record", { attemptId: "not-a-uuid" }],
    ["unknown state", "record", { state: "RETRY" }],
    ["unknown status", "record", { releaseStatus: "released" }],
    ["original edit identity", "record", { editId: "unsafe/edit" }],
    ["numeric expiry", "record", { expiryTimeSeconds: 1900000000 }],
    ["invalid expiry", "record", { expiryTimeSeconds: "1e9" }],
    ["validation mismatch", "record", { validationExpiryTimeSeconds: "1900000001" }],
    ["unsafe track", "record", { targetTrack: " internal" }],
    ["noncanonical version code", "record", { versionCode: "03" }],
    ["blank release name", "record", { releaseName: " " }],
    ["bad expected digest", "record", { expectedStateDigest: "not-a-digest" }],
    ["bad request digest", "record", { requestDigest: "not-a-digest" }],
    ["null prior digest", "record", { priorStateDigest: null }],
    ["noncanonical preparation time", "record", { attemptedAtUtc: "2026-10-05" }],
    ["noncanonical update time", "record", { updatedAtUtc: "2026-10-05T10:00:00Z" }],
    ["unknown record key", "record", { unexpected: true }],
    ["release note text", "record", { releaseNotes: "sentinel-never-store" }],
    ["authorization", "record", { authorization: "sentinel-never-store" }],
    ["private key", "record", { privateKey: "sentinel-never-store" }],
    ["credential", "record", { credentials: "sentinel-never-store" }],
    ["token", "record", { token: "sentinel-never-store" }],
    ["unproven remote verification", "record", { state: "REMOTE_VERIFIED" }],
    ["unproven committed reconciliation", "record", { state: "RECONCILED_COMMITTED" }],
    ["verification before transport", "record", { verificationInsertAttempted: true }],
    [
      "unpaired verification id",
      "record",
      {
        state: "TRANSPORT_ATTEMPTED",
        verificationInsertAttempted: true,
        verificationEditId: "verification-edit",
      },
    ],
    [
      "unpaired verification expiry",
      "record",
      {
        state: "TRANSPORT_ATTEMPTED",
        verificationInsertAttempted: true,
        verificationEditExpiryTimeSeconds: "1900000000",
      },
    ],
    [
      "unpaired observation",
      "record",
      { state: "TRANSPORT_ATTEMPTED", verificationObservedStateDigest: "a".repeat(64) },
    ],
    [
      "unattempted delete acknowledgment",
      "record",
      { state: "TRANSPORT_ATTEMPTED", verificationDeleteAcknowledged: true },
    ],
    [
      "unacknowledged cleanup",
      "record",
      { state: "TRANSPORT_ATTEMPTED", verificationCleanupVerified: true },
    ],
  ] as const)(
    "fails closed on persisted %s and preserves invalid bytes",
    async (_label, scope, extra) => {
      const path = location();
      const store = createFileReleaseCommitAttemptJournal(path, {
        expectedPackageName: packageName,
      });
      const original = await store.prepare(prepared());
      const file = {
        version: RELEASE_COMMIT_ATTEMPT_JOURNAL_VERSION,
        packageName,
        records: [original],
      };
      const corrupted =
        scope === "file"
          ? { ...file, ...extra }
          : { ...file, records: [{ ...original, ...extra }] };
      const bytes = `${JSON.stringify(corrupted)}\n`;
      writeFileSync(path, bytes);
      await expect(store.list()).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
      await expect(store.prepare(prepared())).rejects.toMatchObject({
        code: "COMMIT_ATTEMPT_JOURNAL_INVALID",
      });
      await expect(
        store.transition(original.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", at),
      ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
      await expect(
        store.updateVerification(original.attemptId, "PREPARED", at, {}),
      ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
      expect(readFileSync(path, "utf8")).toBe(bytes);
    },
  );

  it.each(["duplicate attempt", "two unresolved", "unresolved history"] as const)(
    "rejects persisted %s without overwriting history",
    async (kind) => {
      const path = location();
      const store = createFileReleaseCommitAttemptJournal(path, {
        expectedPackageName: packageName,
      });
      const original = await store.prepare(prepared());
      const second = {
        ...original,
        attemptId:
          kind === "duplicate attempt"
            ? original.attemptId
            : "11111111-1111-4111-8111-111111111111",
        state: kind === "unresolved history" ? "RECONCILED_NOT_COMMITTED" : "PREPARED",
      };
      const bytes = JSON.stringify({
        version: RELEASE_COMMIT_ATTEMPT_JOURNAL_VERSION,
        packageName,
        records: [original, second],
      });
      writeFileSync(path, bytes);
      await expect(store.list()).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
      await expect(store.prepare(prepared())).rejects.toMatchObject({
        code: "COMMIT_ATTEMPT_JOURNAL_INVALID",
      });
      expect(readFileSync(path, "utf8")).toBe(bytes);
    },
  );

  it.each(["prototype identity", "symbol key", "nonenumerable key", "accessor identity"] as const)(
    "rejects untrusted %s before projecting a record",
    async (kind) => {
      const path = location();
      const store = createFileReleaseCommitAttemptJournal(path, {
        expectedPackageName: packageName,
      });
      const original = await store.prepare(prepared());
      let candidate: unknown;
      if (kind === "prototype identity") candidate = Object.create(original) as unknown;
      else if (kind === "symbol key")
        candidate = { ...original, [Symbol("token")]: "sentinel-never-store" };
      else if (kind === "nonenumerable key")
        candidate = Object.defineProperty({ ...original }, "authorization", {
          value: "sentinel-never-store",
        });
      else
        candidate = Object.defineProperty({ ...original }, "expectedStateDigest", {
          get: () => original.expectedStateDigest,
          enumerable: true,
        });
      expect(() => parseReleaseCommitAttemptJournalRecord(candidate, packageName)).toThrowError(
        expect.objectContaining({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" }),
      );
    },
  );

  it("keeps int64-scale original expiry and validation proof lossless", async () => {
    const path = location();
    const store = createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName });
    const input = {
      ...prepared(),
      expiryTimeSeconds: "9223372036854775807",
      validationExpiryTimeSeconds: "9223372036854775807",
    };
    const original = await store.prepare(input);
    expect(original).toMatchObject(input);
    expect(
      await createFileReleaseCommitAttemptJournal(path, {
        expectedPackageName: packageName,
      }).list(),
    ).toEqual([original]);
    const bytes = readFileSync(path, "utf8");
    await expect(
      store.prepare({ ...input, validationExpiryTimeSeconds: "9223372036854775806" }),
    ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });
  it.each([0o400, 0o640, 0o700])(
    "refuses non-0600 journal file mode %s without repairing it",
    async (mode) => {
      const path = location();
      const store = createFileReleaseCommitAttemptJournal(path, {
        expectedPackageName: packageName,
      });
      await store.prepare(prepared());
      const bytes = readFileSync(path, "utf8");
      chmodSync(path, mode);
      await expect(store.list()).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
      await expect(store.prepare(prepared())).rejects.toMatchObject({
        code: "COMMIT_ATTEMPT_JOURNAL_INVALID",
      });
      expect(readFileSync(path, "utf8")).toBe(bytes);
      expect(statSync(path).mode & 0o777).toBe(mode);
    },
  );

  it.each([false, true])(
    "refuses a non-private existing leaf directory (file present: %s)",
    async (existingFile) => {
      const path = location();
      const store = createFileReleaseCommitAttemptJournal(path, {
        expectedPackageName: packageName,
      });
      if (existingFile) await store.prepare(prepared());
      else mkdirSync(dirname(path), { mode: 0o700 });
      const bytes = existingFile ? readFileSync(path, "utf8") : undefined;
      chmodSync(dirname(path), 0o755);
      await expect(store.list()).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
      await expect(store.prepare(prepared())).rejects.toMatchObject({
        code: "COMMIT_ATTEMPT_JOURNAL_INVALID",
      });
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o755);
      if (existingFile) expect(readFileSync(path, "utf8")).toBe(bytes);
    },
  );

  it.each([false, true])(
    "refuses a symlinked leaf directory (file present: %s)",
    async (existingFile) => {
      const path = location();
      const actual = join(dirname(dirname(path)), "actual-private");
      const store = createFileReleaseCommitAttemptJournal(path, {
        expectedPackageName: packageName,
      });
      if (existingFile) {
        await store.prepare(prepared());
        renameSync(dirname(path), actual);
      } else mkdirSync(actual, { mode: 0o700 });
      const target = join(actual, "attempts.json");
      const bytes = existingFile ? readFileSync(target, "utf8") : undefined;
      symlinkSync(actual, dirname(path), "dir");
      await expect(store.list()).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
      await expect(store.prepare(prepared())).rejects.toMatchObject({
        code: "COMMIT_ATTEMPT_JOURNAL_INVALID",
      });
      expect(lstatSync(dirname(path)).isSymbolicLink()).toBe(true);
      if (existingFile) expect(readFileSync(target, "utf8")).toBe(bytes);
    },
  );

  it("refuses a symlinked journal file without replacing its target", async () => {
    const path = location();
    const store = createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName });
    await store.prepare(prepared());
    const target = join(dirname(path), "actual-attempts.json");
    renameSync(path, target);
    const bytes = readFileSync(target, "utf8");
    symlinkSync(target, path);
    await expect(store.list()).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
    await expect(store.prepare(prepared())).rejects.toMatchObject({
      code: "COMMIT_ATTEMPT_JOURNAL_INVALID",
    });
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(bytes);
  });

  it("creates private nested leaves without chmodding an existing ancestor", async () => {
    const originalPath = location();
    const ancestor = dirname(dirname(originalPath));
    chmodSync(ancestor, 0o755);
    const path = join(dirname(originalPath), "nested", "attempts.json");
    const store = createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName });
    await store.prepare(prepared());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(originalPath)).mode & 0o777).toBe(0o700);
    expect(statSync(ancestor).mode & 0o777).toBe(0o755);
  });
  it.each(["ENOENT", "EIO"])(
    "never interprets a failed existing-file read (%s) as an empty journal",
    async (code) => {
      const path = location();
      const store = createFileReleaseCommitAttemptJournal(path, {
        expectedPackageName: packageName,
      });
      await store.prepare(prepared());
      const bytes = readFileSync(path, "utf8");
      vi.mocked(readJournalFile).mockRejectedValue(
        Object.assign(new Error("injected-read-failure"), { code }),
      );
      await expect(store.list()).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
      await expect(store.prepare(prepared())).rejects.toMatchObject({
        code: "COMMIT_ATTEMPT_JOURNAL_INVALID",
      });
      expect(readFileSync(path, "utf8")).toBe(bytes);
    },
  );

  it("never unlinks an unowned temporary-file collision", async () => {
    const path = location();
    const store = createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName });
    const original = await store.prepare(prepared());
    const bytes = readFileSync(path, "utf8");
    let collision = "";
    const actual = await vi.importActual<typeof FileSystemPromises>("node:fs/promises");
    vi.mocked(openFile).mockImplementation(async (file, flags, mode) => {
      if (flags === "wx") {
        collision = String(file);
        writeFileSync(collision, "unowned-collision-sentinel", { mode: 0o600 });
        throw Object.assign(new Error("injected-collision"), { code: "EEXIST" });
      }
      return actual.open(file, flags, mode);
    });
    await expect(
      store.transition(original.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", at),
    ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(existsSync(collision)).toBe(true);
    expect(readFileSync(collision, "utf8")).toBe("unowned-collision-sentinel");
  });

  it.each(["write", "file-sync", "rename"] as const)(
    "preserves trusted bytes after %s failure before atomic publication",
    async (failure) => {
      const path = location();
      const store = createFileReleaseCommitAttemptJournal(path, {
        expectedPackageName: packageName,
      });
      const original = await store.prepare(prepared());
      const bytes = readFileSync(path, "utf8");
      const actual = await vi.importActual<typeof FileSystemPromises>("node:fs/promises");
      if (failure === "rename")
        vi.mocked(renameFile).mockRejectedValueOnce(new Error("injected-rename-failure"));
      else
        vi.mocked(openFile).mockImplementation(async (file, flags, mode) => {
          const handle = await actual.open(file, flags, mode);
          if (flags === "wx") {
            expect((await handle.stat()).mode & 0o777).toBe(0o600);
            if (failure === "file-sync")
              vi.spyOn(handle, "sync").mockRejectedValueOnce(
                new Error("injected-file-sync-failure"),
              );
            else
              vi.spyOn(handle, "writeFile").mockRejectedValueOnce(
                new Error("injected-write-failure"),
              );
          }
          return handle;
        });
      await expect(
        store.transition(original.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", at),
      ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
      expect(readFileSync(path, "utf8")).toBe(bytes);
      expect(
        await createFileReleaseCommitAttemptJournal(path, {
          expectedPackageName: packageName,
        }).list(),
      ).toEqual([original]);
      expect(readdirSync(dirname(path))).toEqual(["attempts.json"]);
    },
  );

  it("does not report a durable success when directory fsync fails after atomic publication", async () => {
    const path = location();
    const store = createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName });
    const original = await store.prepare(prepared());
    const actual = await vi.importActual<typeof FileSystemPromises>("node:fs/promises");
    vi.mocked(openFile).mockImplementation(async (file, flags, mode) => {
      const handle = await actual.open(file, flags, mode);
      if (String(file) === dirname(path))
        vi.spyOn(handle, "sync").mockRejectedValueOnce(
          new Error("injected-directory-sync-failure"),
        );
      return handle;
    });
    await expect(
      store.transition(original.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", at),
    ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
    expect(
      await createFileReleaseCommitAttemptJournal(path, {
        expectedPackageName: packageName,
      }).list(),
    ).toEqual([{ ...original, state: "TRANSPORT_ATTEMPTED" }]);
    expect(readdirSync(dirname(path))).toEqual(["attempts.json"]);
  });

  it("fsyncs a private complete temp file before rename and the directory after rename", async () => {
    const path = location();
    const store = createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName });
    const order: string[] = [];
    const actual = await vi.importActual<typeof FileSystemPromises>("node:fs/promises");
    vi.mocked(openFile).mockImplementation(async (file, flags, mode) => {
      const handle = await actual.open(file, flags, mode);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        order.push(flags === "wx" ? "file-sync" : "directory-sync");
        if (flags === "wx") {
          expect((await handle.stat()).mode & 0o777).toBe(0o600);
          const tempRecord = JSON.parse(readFileSync(String(file), "utf8")) as {
            records: unknown[];
          };
          expect(tempRecord.records).toHaveLength(1);
        }
        await sync();
      });
      return handle;
    });
    vi.mocked(renameFile).mockImplementation(async (...args) => {
      order.push("rename");
      await actual.rename(...args);
    });
    const record = await store.prepare(prepared());
    expect(order).toEqual(["file-sync", "rename", "directory-sync"]);
    expect(
      await createFileReleaseCommitAttemptJournal(path, {
        expectedPackageName: packageName,
      }).list(),
    ).toEqual([record]);
    expect(readdirSync(dirname(path))).toEqual(["attempts.json"]);
  });
  it("rejects a persisted ACKNOWLEDGED record without durable acknowledgement evidence", async () => {
    const { path, store, cleaned } = await cleanedVerification();
    const write = (record: unknown): void =>
      writeFileSync(
        path,
        JSON.stringify({
          version: RELEASE_COMMIT_ATTEMPT_JOURNAL_VERSION,
          packageName,
          records: [record],
        }),
      );
    write({ ...cleaned, state: "ACKNOWLEDGED" });
    await expect(store.list()).rejects.toMatchObject({
      code: "COMMIT_ATTEMPT_JOURNAL_INVALID",
    });
    write({ ...cleaned, state: "ACKNOWLEDGED", acknowledgedAtUtc: "not-a-timestamp" });
    await expect(store.list()).rejects.toMatchObject({
      code: "COMMIT_ATTEMPT_JOURNAL_INVALID",
    });
    write({ ...cleaned, state: "ACKNOWLEDGED", acknowledgedAtUtc: at });
    const [accepted] = await store.list();
    expect(accepted?.state).toBe("ACKNOWLEDGED");
    expect(accepted?.acknowledgedAtUtc).toBe(at);
  });

  it.each(["PREPARED", "TRANSPORT_ATTEMPTED", "AMBIGUOUS", "RECONCILED_NOT_COMMITTED"] as const)(
    "rejects persisted acknowledgement evidence on an unacknowledged %s record",
    async (state) => {
      const { path, store, original, cleaned } = await cleanedVerification();
      const base = state === "PREPARED" ? original : cleaned;
      writeFileSync(
        path,
        JSON.stringify({
          version: RELEASE_COMMIT_ATTEMPT_JOURNAL_VERSION,
          packageName,
          records: [{ ...base, state, acknowledgedAtUtc: at }],
        }),
      );
      await expect(store.list()).rejects.toMatchObject({
        code: "COMMIT_ATTEMPT_JOURNAL_INVALID",
      });
    },
  );

  it.each(["REMOTE_VERIFIED", "RECONCILED_COMMITTED"] as const)(
    "accepts %s that never observed a durable acknowledgement",
    async (state) => {
      const { path, store, cleaned } = await cleanedVerification();
      writeFileSync(
        path,
        JSON.stringify({
          version: RELEASE_COMMIT_ATTEMPT_JOURNAL_VERSION,
          packageName,
          records: [{ ...cleaned, state }],
        }),
      );
      const [record] = await store.list();
      expect(record?.state).toBe(state);
      expect(record?.acknowledgedAtUtc).toBeUndefined();
      expect(record?.verificationObservedStateDigest).toBe(cleaned.expectedStateDigest);
    },
  );

  it.each(RELEASE_COMMIT_ATTEMPT_STATES)(
    "enforces the complete transition matrix from %s without jumps",
    async (from) => {
      const { path, store, original, identified, cleaned } = await cleanedVerification();
      const allowed = new Set([
        "PREPARED/TRANSPORT_ATTEMPTED",
        "PREPARED/RECONCILED_NOT_COMMITTED",
        "TRANSPORT_ATTEMPTED/ACKNOWLEDGED",
        "TRANSPORT_ATTEMPTED/AMBIGUOUS",
        "TRANSPORT_ATTEMPTED/RECONCILED_NOT_COMMITTED",
        "TRANSPORT_ATTEMPTED/REMOTE_VERIFIED",
        "ACKNOWLEDGED/REMOTE_VERIFIED",
        "AMBIGUOUS/REMOTE_VERIFIED",
        "AMBIGUOUS/RECONCILED_NOT_COMMITTED",
        "REMOTE_VERIFIED/RECONCILED_COMMITTED",
      ]);
      const fixture =
        from === "PREPARED"
          ? original
          : {
              ...cleaned,
              state: from,
              ...(from === "ACKNOWLEDGED" ? { acknowledgedAtUtc: at } : {}),
            };
      const bytes = JSON.stringify({
        version: RELEASE_COMMIT_ATTEMPT_JOURNAL_VERSION,
        packageName,
        records: [fixture],
      });
      for (const to of RELEASE_COMMIT_ATTEMPT_STATES) {
        writeFileSync(path, bytes);
        expect(await store.list()).toEqual([fixture]);
        if (allowed.has(`${from}/${to}`)) {
          // TA -> ACK happens before cleanup work, so use that pre-cleanup record.
          const base = to === "ACKNOWLEDGED" ? identified : fixture;
          if (base !== fixture) {
            writeFileSync(
              path,
              JSON.stringify({
                version: RELEASE_COMMIT_ATTEMPT_JOURNAL_VERSION,
                packageName,
                records: [base],
              }),
            );
            expect(await store.list()).toEqual([base]);
          }
          const next = await store.transition(
            original.attemptId,
            from,
            to,
            at,
            to === "ACKNOWLEDGED" ? { acknowledgedAtUtc: at } : {},
          );
          expect(next).toEqual({
            ...base,
            state: to,
            ...(to === "ACKNOWLEDGED" ? { acknowledgedAtUtc: at } : {}),
          });
          expect(
            await createFileReleaseCommitAttemptJournal(path, {
              expectedPackageName: packageName,
            }).list(),
          ).toEqual([next]);
        } else {
          await expect(store.transition(original.attemptId, from, to, at)).rejects.toMatchObject({
            code: "COMMIT_ATTEMPT_JOURNAL_INVALID",
          });
          expect(readFileSync(path, "utf8")).toBe(bytes);
        }
      }
    },
  );

  it("rejects stale same-state metadata authority without touching trusted proof", async () => {
    const { path, store, original, identified } = await verificationReady();
    const bytes = readFileSync(path, "utf8");
    for (const [id, from] of [
      [original.attemptId, "ACKNOWLEDGED"],
      ["untracked", "TRANSPORT_ATTEMPTED"],
    ] as const) {
      await expect(
        store.updateVerification(id, from, at, { verificationPreDeleteReadVerified: true }),
      ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
      expect(readFileSync(path, "utf8")).toBe(bytes);
    }
    expect(await store.list()).toEqual([identified]);
  });

  it("keeps unknown verification-insert identity blocked after restart without reset or reinsertion", async () => {
    const path = location();
    const store = createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName });
    const original = await store.prepare(prepared());
    await store.transition(original.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", at);
    const uncertain = await store.updateVerification(
      original.attemptId,
      "TRANSPORT_ATTEMPTED",
      at,
      { verificationInsertAttempted: true },
    );
    const restarted = createFileReleaseCommitAttemptJournal(path, {
      expectedPackageName: packageName,
    });
    expect(await restarted.list()).toEqual([uncertain]);
    const bytes = readFileSync(path, "utf8");
    await expect(restarted.prepare(prepared())).rejects.toMatchObject({
      code: "COMMIT_ATTEMPT_JOURNAL_INVALID",
    });
    await expect(
      restarted.updateVerification(original.attemptId, "TRANSPORT_ATTEMPTED", at, {
        verificationInsertAttempted: undefined,
      }),
    ).rejects.toMatchObject({ code: "COMMIT_ATTEMPT_JOURNAL_INVALID" });
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  it("returns immutable parsed records and list snapshots", async () => {
    const path = location();
    const store = createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName });
    const original = await store.prepare(prepared());
    const records = await store.list();
    expect(Object.isFrozen(original)).toBe(true);
    expect(Object.isFrozen(records)).toBe(true);
    expect(Object.isFrozen(records[0])).toBe(true);
    expect(records).toEqual([original]);
  });
});

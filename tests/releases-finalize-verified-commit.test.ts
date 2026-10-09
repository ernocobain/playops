import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { open as openFile } from "node:fs/promises";
import type * as FileSystemPromises from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendAuditEntry, readAuditEntries, type NewAuditEntry } from "../src/audit/index.js";
import {
  createFileReleaseCommitAttemptJournal,
  parseReleaseCommitAttemptJournalRecord,
  type ReleaseCommitAttemptJournal,
} from "../src/releases/commit-attempt-journal.js";
import {
  createCommitVerificationEvidenceJournalSink,
  resumeCommitVerificationEvidence,
} from "../src/releases/commit-verification-evidence.js";
import { createFileReleaseEditSessionStore } from "../src/releases/session-store.js";
import { createPackageOperationSingleFlightCoordinator } from "../src/daemon/package-operation-singleflight.js";
import {
  finalizeVerifiedCommit,
  type FinalizeVerifiedCommitOptions,
} from "../src/releases/finalize-verified-commit.js";

// Real files and handles; only the particular persistence barrier is injected.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystemPromises>();
  return { ...actual, open: vi.fn(actual.open) };
});

const packageName = "com.example.localfinalization";
const at = "2026-10-09T00:00:00.000Z";
const finalAt = "2026-10-09T00:00:10.000Z";
const expectedStateDigest = "a".repeat(64);
const temporaryEditId = "PRIVATE-STAGE3F-TEMP-ID";
const temporaryExpiry = "4102444900";
const directories: string[] = [];
let networkCalls: string[] = [];
function forbiddenNetwork(operation: string): never {
  networkCalls.push(operation);
  throw new Error("NETWORK-FORBIDDEN-IN-LOCAL-FINALIZATION");
}
beforeEach(() => {
  networkCalls = [];
  vi.stubGlobal("fetch", () => forbiddenNetwork("fetch"));
  vi.spyOn(http, "request").mockImplementation(() => forbiddenNetwork("http.request"));
  vi.spyOn(https, "request").mockImplementation(() => forbiddenNetwork("https.request"));
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() =>
    forbiddenNetwork("net.connect"),
  );
  vi.spyOn(tls, "connect").mockImplementation(() => forbiddenNetwork("tls.connect"));
  vi.spyOn(dns, "lookup").mockImplementation(() => forbiddenNetwork("dns.lookup"));
  vi.spyOn(dns.promises, "lookup").mockImplementation(() =>
    forbiddenNetwork("dns.promises.lookup"),
  );
});
afterEach(async () => {
  const observedNetworkCalls = [...networkCalls];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof FileSystemPromises>("node:fs/promises");
  vi.mocked(openFile).mockReset().mockImplementation(actual.open);
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  expect(observedNetworkCalls).toEqual([]);
});

async function fixture(acknowledgedWithCompleteProof = false) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-local-finalize-"));
  directories.push(root);
  const path = join(root, "private", "attempts.json");
  const auditPath = join(root, "audit.jsonl");
  const real = createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName });
  const prepared = await real.prepare({
    version: 1,
    packageName,
    editId: "original-commit-edit",
    expiryTimeSeconds: "4102444800",
    targetTrack: "wear:production",
    versionCode: "101",
    releaseName: "Candidate 101",
    releaseStatus: "completed",
    expectedStateDigest,
    priorStateDigest: "b".repeat(64),
    validationExpiryTimeSeconds: "4102444800",
    requestDigest: "c".repeat(64),
    attemptedAtUtc: at,
    updatedAtUtc: at,
  });
  await real.transition(prepared.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", at);
  await real.transition(prepared.attemptId, "TRANSPORT_ATTEMPTED", "ACKNOWLEDGED", at, {
    acknowledgedAtUtc: at,
  });
  const bridgeJournal: ReleaseCommitAttemptJournal = {
    ...real,
    async transition(id, from, to, time, patch) {
      if (acknowledgedWithCompleteProof && to === "REMOTE_VERIFIED")
        throw new Error("Fixture stops before the Stage-3E transition");
      return real.transition(id, from, to, time, patch);
    },
  };
  const sink = createCommitVerificationEvidenceJournalSink({
    journal: bridgeJournal,
    attemptId: prepared.attemptId,
    packageName,
    expectedStateDigest,
    now: () => new Date(at),
  });
  await sink.record({ type: "verification_insert_attempted" });
  await sink.record({
    type: "verification_edit_identified",
    editId: temporaryEditId,
    expiryTimeSeconds: temporaryExpiry,
  });
  await sink.record({
    type: "verification_state_observed",
    observedStateDigest: expectedStateDigest,
    observedAtUtc: at,
  });
  await sink.record({ type: "verification_pre_delete_read_verified" });
  await sink.record({ type: "verification_delete_attempted" });
  await sink.record({ type: "verification_delete_acknowledged" });
  const completion = sink.record({ type: "verification_cleanup_verified" });
  if (acknowledgedWithCompleteProof)
    await expect(completion).rejects.toThrow("Fixture stops before the Stage-3E transition");
  else await completion;
  const [candidate] = await real.list();
  if (candidate === undefined) throw new Error("Missing real fixture journal record");
  const coordinator = createPackageOperationSingleFlightCoordinator();
  const journal = {
    list: vi.fn(async () =>
      createFileReleaseCommitAttemptJournal(path, { expectedPackageName: packageName }).list(),
    ),
    transition: vi.fn(real.transition),
  };
  const store = createFileReleaseEditSessionStore(join(root, "session.json"), {
    expectedPackageName: packageName,
  });
  const sessionStore = {
    load: vi.fn(store.load),
    clear: vi.fn(() => {
      throw new Error("A local finalizer must never clear any session");
    }),
  };
  const auditLedger = {
    append: vi.fn(async (entry: NewAuditEntry) => {
      appendAuditEntry(auditPath, entry, { durable: true });
    }),
  };
  return {
    root,
    path,
    auditPath,
    real,
    journal,
    store,
    sessionStore,
    auditLedger,
    candidate,
    coordinator,
  };
}

async function invoke(
  built: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<FinalizeVerifiedCommitOptions> = {},
) {
  const acquired = built.coordinator.tryAcquirePackageOperation(packageName);
  if (!acquired.acquired) throw new Error("Test caller package lease is busy");
  try {
    return await finalizeVerifiedCommit({
      journal: built.journal,
      sessionStore: built.sessionStore,
      candidate: built.candidate,
      auditLedger: built.auditLedger,
      now: () => new Date(finalAt),
      ...overrides,
    });
  } finally {
    built.coordinator.releasePackageOperation(acquired.lease);
  }
}

describe("Stage 3F.1 local verified-commit finalization", () => {
  it("does not promote a visible terminal rename to durable success after directory-fsync failure", async () => {
    const built = await fixture();
    const actual = await vi.importActual<typeof FileSystemPromises>("node:fs/promises");
    let injected = false;
    vi.mocked(openFile).mockImplementation(async (file, flags, mode) => {
      const handle = await actual.open(file, flags, mode);
      if (!injected && String(file) === dirname(built.path)) {
        injected = true;
        vi.spyOn(handle, "sync").mockRejectedValueOnce(
          new Error("Injected directory-fsync failure"),
        );
      }
      return handle;
    });
    expect(await invoke(built)).toMatchObject({
      outcome: "local_state_failure",
      code: "COMMIT_FINALIZATION_TRANSITION_FAILED",
      durableState: "unavailable",
      observedState: "RECONCILED_COMMITTED",
    });
    expect(injected).toBe(true);
    expect((await built.real.list())[0]).toEqual({
      ...built.candidate,
      state: "RECONCILED_COMMITTED",
      updatedAtUtc: finalAt,
    });
    expect(built.auditLedger.append).not.toHaveBeenCalled();
    expect(built.sessionStore.clear).not.toHaveBeenCalled();
    // Recognition of current terminal authority is not a claim that retry
    // repaired the prior failed barrier; it performs no further journal write.
    expect(await invoke(built)).toMatchObject({ outcome: "already_finalized" });
    expect(built.journal.transition).toHaveBeenCalledTimes(1);
  });
  it("closes real Stage-3E proof without an original probe or expiry wait and retains all evidence", async () => {
    const built = await fixture();
    const result = await invoke(built);
    expect(result).toMatchObject({ outcome: "finalized", attemptId: built.candidate.attemptId });
    const [record] = await built.real.list();
    expect(record).toEqual({
      ...built.candidate,
      state: "RECONCILED_COMMITTED",
      updatedAtUtc: finalAt,
    });
    expect(built.journal.transition).toHaveBeenCalledExactlyOnceWith(
      built.candidate.attemptId,
      "REMOTE_VERIFIED",
      "RECONCILED_COMMITTED",
      finalAt,
    );
    expect(built.sessionStore.clear).not.toHaveBeenCalled();
    expect(readAuditEntries(built.auditPath)).toHaveLength(1);
    expect(readFileSync(built.path, "utf8")).toContain(temporaryEditId);
  });

  it("requires the exact current candidate before making any transition", async () => {
    const built = await fixture();
    await built.real.updateVerification(built.candidate.attemptId, "REMOTE_VERIFIED", finalAt, {});
    expect(await invoke(built)).toMatchObject({ outcome: "refused", code: "COMMIT_STATE_CHANGED" });
    expect(built.journal.transition).not.toHaveBeenCalled();
    expect(built.auditLedger.append).not.toHaveBeenCalled();
  });

  it("refuses an existing exact original session rather than clearing it", async () => {
    const built = await fixture();
    const session = {
      version: 1 as const,
      packageName,
      editId: built.candidate.editId,
      expiryTimeSeconds: built.candidate.expiryTimeSeconds,
      createdAt: at,
    };
    await built.store.save(session);
    expect(await invoke(built)).toMatchObject({
      outcome: "refused",
      code: "MANAGED_EDIT_ALREADY_OPEN",
    });
    expect(built.journal.transition).not.toHaveBeenCalled();
    expect(built.sessionStore.clear).not.toHaveBeenCalled();
    expect(await built.store.load()).toEqual(session);
  });

  it("refuses a parsed REMOTE_VERIFIED record whose cleanup proof is incomplete", async () => {
    const built = await fixture();
    const { verificationCleanupVerified: _cleanup, ...candidate } = built.candidate;
    expect(
      await invoke(built, {
        candidate,
        journal: { ...built.journal, list: async () => [candidate] },
      }),
    ).toMatchObject({ outcome: "refused", code: "VERIFICATION_EVIDENCE_INCOMPLETE" });
    expect(built.journal.transition).not.toHaveBeenCalled();
  });

  it("checks session absence again after a session appears under the future caller lease harness", async () => {
    const built = await fixture();
    const session = {
      version: 1 as const,
      packageName,
      editId: "later-managed-edit",
      expiryTimeSeconds: "4102445000",
      createdAt: finalAt,
    };
    built.sessionStore.load.mockImplementationOnce(async () => {
      expect(built.coordinator.isPackageOperationHeld(packageName)).toBe(true);
      const absent = await built.store.load();
      await built.store.save(session);
      return absent;
    });
    expect(await invoke(built)).toMatchObject({
      outcome: "refused",
      code: "MANAGED_EDIT_ALREADY_OPEN",
    });
    expect(built.journal.transition).not.toHaveBeenCalled();
    expect(built.sessionStore.clear).not.toHaveBeenCalled();
    expect(await built.store.load()).toEqual(session);
    expect((await built.real.list())[0]?.state).toBe("REMOTE_VERIFIED");
  });

  it("rejects legal journal drift between the first snapshot and final recheck", async () => {
    const built = await fixture();
    built.sessionStore.load.mockImplementationOnce(async () => {
      await built.real.updateVerification(
        built.candidate.attemptId,
        "REMOTE_VERIFIED",
        finalAt,
        {},
      );
      return undefined;
    });
    expect(await invoke(built)).toMatchObject({ outcome: "refused", code: "COMMIT_STATE_CHANGED" });
    expect(built.journal.transition).not.toHaveBeenCalled();
    expect(built.auditLedger.append).not.toHaveBeenCalled();
    expect((await built.real.list())[0]?.state).toBe("REMOTE_VERIFIED");
  });

  it("recognizes already-finalized lineage with the original candidate without any second write or audit", async () => {
    const built = await fixture();
    await invoke(built);
    const bytes = readFileSync(built.path, "utf8");
    const audit = readFileSync(built.auditPath, "utf8");
    const now = vi.fn(() => {
      throw new Error("Idempotent recognition needs no new timestamp");
    });
    expect(await invoke(built, { now })).toMatchObject({
      outcome: "already_finalized",
      attemptId: built.candidate.attemptId,
    });
    const [terminal] = await built.real.list();
    if (terminal === undefined) throw new Error("Missing terminal fixture");
    expect(await invoke(built, { candidate: terminal, now })).toMatchObject({
      outcome: "already_finalized",
    });
    expect(built.journal.transition).toHaveBeenCalledTimes(1);
    expect(built.auditLedger.append).toHaveBeenCalledTimes(1);
    expect(now).not.toHaveBeenCalled();
    expect(readFileSync(built.path, "utf8")).toBe(bytes);
    expect(readFileSync(built.auditPath, "utf8")).toBe(audit);
  });

  it("leaves complete ACK proof to the Stage-3E bridge before admitting a fresh REMOTE_VERIFIED candidate", async () => {
    const built = await fixture(true);
    expect(built.candidate.state).toBe("ACKNOWLEDGED");
    expect(await invoke(built)).toMatchObject({
      outcome: "refused",
      code: "COMMIT_STATE_NOT_FINALIZABLE",
    });
    expect(built.journal.transition).not.toHaveBeenCalled();
    const acquired = built.coordinator.tryAcquirePackageOperation(packageName);
    if (!acquired.acquired) throw new Error("Fixture package lease is busy");
    try {
      expect(
        await resumeCommitVerificationEvidence({
          journal: built.real,
          attemptId: built.candidate.attemptId,
          packageName,
          expectedStateDigest,
          now: () => new Date(at),
        }),
      ).toBe("verified");
    } finally {
      built.coordinator.releasePackageOperation(acquired.lease);
    }
    const [candidate] = await built.real.list();
    if (candidate === undefined) throw new Error("Missing resumed fixture");
    expect(await invoke(built, { candidate })).toMatchObject({ outcome: "finalized" });
  });

  it("reports a failed transition before durable write and safely retries locally", async () => {
    const built = await fixture();
    built.journal.transition.mockImplementationOnce(async () => {
      throw new Error("Transition failed before durable write");
    });
    expect(await invoke(built)).toMatchObject({
      outcome: "local_state_failure",
      code: "COMMIT_FINALIZATION_TRANSITION_FAILED",
      durableState: "REMOTE_VERIFIED",
    });
    expect((await built.real.list())[0]?.state).toBe("REMOTE_VERIFIED");
    expect(built.auditLedger.append).not.toHaveBeenCalled();
    expect(await invoke(built)).toMatchObject({ outcome: "finalized" });
    expect(await invoke(built)).toMatchObject({ outcome: "already_finalized" });
  });

  it("re-reads and audits an actual durable transition whose response was lost", async () => {
    const built = await fixture();
    built.journal.transition.mockImplementationOnce(async (...args) => {
      await built.real.transition(...args);
      throw new Error("Transition response lost after durable write");
    });
    expect(await invoke(built)).toMatchObject({ outcome: "finalized" });
    expect((await built.real.list())[0]?.state).toBe("RECONCILED_COMMITTED");
    expect(built.journal.transition).toHaveBeenCalledTimes(1);
    expect(readAuditEntries(built.auditPath)).toHaveLength(1);
    expect(await invoke(built)).toMatchObject({ outcome: "already_finalized" });
    expect(built.journal.transition).toHaveBeenCalledTimes(1);
  });

  it("reports audit failure after terminal write without pretending rollback or appending on idempotent retry", async () => {
    const built = await fixture();
    built.auditLedger.append.mockRejectedValueOnce(new Error("Audit append failed"));
    expect(await invoke(built)).toMatchObject({
      outcome: "local_state_failure",
      code: "COMMIT_FINALIZATION_AUDIT_FAILED",
      durableState: "RECONCILED_COMMITTED",
    });
    expect((await built.real.list())[0]?.state).toBe("RECONCILED_COMMITTED");
    expect(await invoke(built)).toMatchObject({ outcome: "already_finalized" });
    expect(built.journal.transition).toHaveBeenCalledTimes(1);
    expect(built.auditLedger.append).toHaveBeenCalledTimes(1);
  });

  it("refuses missing audit infrastructure before changing the real journal", async () => {
    const built = await fixture();
    expect(
      await invoke(built, {
        auditLedger: undefined as unknown as FinalizeVerifiedCommitOptions["auditLedger"],
      }),
    ).toMatchObject({ outcome: "refused", code: "INVALID_ARGUMENT" });
    expect(built.journal.transition).not.toHaveBeenCalled();
    expect((await built.real.list())[0]?.state).toBe("REMOTE_VERIFIED");
  });

  it("does not trust a transition's successful response without a durable terminal receipt", async () => {
    const built = await fixture();
    built.journal.transition.mockImplementationOnce(async () => ({
      ...built.candidate,
      state: "RECONCILED_COMMITTED",
      updatedAtUtc: finalAt,
    }));
    expect(await invoke(built)).toMatchObject({
      outcome: "local_state_failure",
      code: "COMMIT_FINALIZATION_RECEIPT_UNCONFIRMED",
      durableState: "REMOTE_VERIFIED",
    });
    expect(built.auditLedger.append).not.toHaveBeenCalled();
    expect(await invoke(built)).toMatchObject({ outcome: "finalized" });
  });

  it.each([
    ["before first journal read", "journal", 1, "before"],
    ["after first journal read", "journal", 1, "after"],
    ["after first session check", "session", 1, "after"],
    ["before second journal read", "journal", 2, "before"],
    ["after second journal read", "journal", 2, "after"],
    ["after second session check", "session", 2, "after"],
  ] as const)(
    "survives a local crash %s with no write, then recognizes terminal retry idempotently",
    async (_label, boundary, occurrence, phase) => {
      const built = await fixture();
      let reads = 0;
      let sessions = 0;
      let interrupted = false;
      const failAt = (kind: string, count: number, side: string) => {
        if (!interrupted && kind === boundary && count === occurrence && side === phase) {
          interrupted = true;
          throw new Error("Injected local pre-transition crash");
        }
      };
      built.journal.list.mockImplementation(async () => {
        expect(built.coordinator.isPackageOperationHeld(packageName)).toBe(true);
        failAt("journal", ++reads, "before");
        const records = await createFileReleaseCommitAttemptJournal(built.path, {
          expectedPackageName: packageName,
        }).list();
        failAt("journal", reads, "after");
        return records;
      });
      built.sessionStore.load.mockImplementation(async () => {
        expect(built.coordinator.isPackageOperationHeld(packageName)).toBe(true);
        failAt("session", ++sessions, "before");
        const session = await built.store.load();
        failAt("session", sessions, "after");
        return session;
      });
      const before = readFileSync(built.path, "utf8");
      expect(await invoke(built)).toMatchObject({
        outcome: "refused",
        code: boundary === "journal" ? "COMMIT_ATTEMPT_JOURNAL_INVALID" : "MANAGED_EDIT_UNREADABLE",
      });
      expect(interrupted).toBe(true);
      expect(readFileSync(built.path, "utf8")).toBe(before);
      expect(built.journal.transition).not.toHaveBeenCalled();
      expect(built.sessionStore.clear).not.toHaveBeenCalled();
      expect(await invoke(built)).toMatchObject({ outcome: "finalized" });
      expect(await invoke(built)).toMatchObject({ outcome: "already_finalized" });
      expect(built.journal.transition).toHaveBeenCalledTimes(1);
      expect((await built.real.list())[0]).toEqual({
        ...built.candidate,
        state: "RECONCILED_COMMITTED",
        updatedAtUtc: finalAt,
      });
    },
  );

  it("does not fabricate receipt confirmation when the post-write journal read fails", async () => {
    const built = await fixture();
    let reads = 0;
    built.journal.list.mockImplementation(async () => {
      if (++reads === 3) throw new Error("Terminal receipt read failed");
      return built.real.list();
    });
    expect(await invoke(built)).toMatchObject({
      outcome: "local_state_failure",
      code: "COMMIT_FINALIZATION_RECEIPT_UNCONFIRMED",
      durableState: "unavailable",
    });
    expect((await built.real.list())[0]?.state).toBe("RECONCILED_COMMITTED");
    expect(await invoke(built)).toMatchObject({ outcome: "already_finalized" });
    expect(built.journal.transition).toHaveBeenCalledTimes(1);
  });

  it("preserves a durable audit entry even if its append response fails", async () => {
    const built = await fixture();
    built.auditLedger.append.mockImplementationOnce(async (entry) => {
      appendAuditEntry(built.auditPath, entry, { durable: true });
      throw new Error("Audit response failed after durable append");
    });
    expect(await invoke(built)).toMatchObject({
      outcome: "local_state_failure",
      code: "COMMIT_FINALIZATION_AUDIT_FAILED",
      durableState: "RECONCILED_COMMITTED",
    });
    expect(readAuditEntries(built.auditPath)).toHaveLength(1);
    expect(await invoke(built)).toMatchObject({ outcome: "already_finalized" });
    expect(readAuditEntries(built.auditPath)).toHaveLength(1);
  });

  it.each([
    "PREPARED",
    "TRANSPORT_ATTEMPTED",
    "ACKNOWLEDGED",
    "AMBIGUOUS",
    "RECONCILED_NOT_COMMITTED",
  ] as const)(
    "never finalizes source state %s, even when verification evidence exists",
    async (state) => {
      const built = await fixture();
      const {
        acknowledgedAtUtc: _ack,
        verificationInsertAttempted: _insert,
        verificationEditId: _id,
        verificationEditExpiryTimeSeconds: _expiry,
        verificationObservedStateDigest: _digest,
        verificationObservedAtUtc: _observed,
        verificationPreDeleteReadVerified: _preRead,
        verificationDeleteAttempted: _delete,
        verificationDeleteAcknowledged: _deleteAck,
        verificationCleanupVerified: _cleanup,
        ...identity
      } = built.candidate;
      const { acknowledgedAtUtc: _acknowledgement, ...withoutAcknowledgement } = built.candidate;
      const candidate = parseReleaseCommitAttemptJournalRecord(
        state === "PREPARED"
          ? { ...identity, state }
          : { ...(state === "ACKNOWLEDGED" ? built.candidate : withoutAcknowledgement), state },
        packageName,
      );
      expect(await invoke(built, { candidate })).toMatchObject({
        outcome: "refused",
        code:
          state === "RECONCILED_NOT_COMMITTED"
            ? "COMMIT_ALREADY_RECONCILED_NOT_COMMITTED"
            : "COMMIT_STATE_NOT_FINALIZABLE",
      });
      expect(built.journal.transition).not.toHaveBeenCalled();
      expect(built.auditLedger.append).not.toHaveBeenCalled();
    },
  );

  it.each([
    "verificationInsertAttempted",
    "verificationEditId",
    "verificationEditExpiryTimeSeconds",
    "verificationObservedStateDigest",
    "verificationObservedAtUtc",
    "verificationPreDeleteReadVerified",
    "verificationDeleteAttempted",
    "verificationDeleteAcknowledged",
    "verificationCleanupVerified",
  ] as const)("cannot weaken the production parser or finalize without %s", async (field) => {
    const built = await fixture();
    const { [field]: _removedEvidence, ...candidate } = built.candidate;
    const result = await invoke(built, { candidate });
    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") throw new Error("Incomplete proof unexpectedly finalized");
    expect(["COMMIT_ATTEMPT_JOURNAL_INVALID", "VERIFICATION_EVIDENCE_INCOMPLETE"]).toContain(
      result.code,
    );
    expect(built.journal.transition).not.toHaveBeenCalled();
    expect(built.auditLedger.append).not.toHaveBeenCalled();
  });

  it.each(["absent", "duplicate"] as const)(
    "requires one exact attempt match, refusing %s authority",
    async (kind) => {
      const built = await fixture();
      built.journal.list.mockResolvedValueOnce(
        kind === "absent" ? [] : [built.candidate, built.candidate],
      );
      expect(await invoke(built)).toMatchObject({
        outcome: "refused",
        code: "COMMIT_STATE_CHANGED",
      });
      expect(built.journal.transition).not.toHaveBeenCalled();
    },
  );

  it.each([
    { editId: "different-original-edit" },
    { expiryTimeSeconds: "4102445100", validationExpiryTimeSeconds: "4102445100" },
    { targetTrack: "internal" },
    { versionCode: "102" },
    { releaseName: "Other candidate" },
    { releaseStatus: "halted" as const },
    { expectedStateDigest: "d".repeat(64), verificationObservedStateDigest: "d".repeat(64) },
    { priorStateDigest: "e".repeat(64) },
    { requestDigest: "f".repeat(64) },
    { attemptedAtUtc: finalAt },
    { acknowledgedAtUtc: finalAt },
    { verificationEditId: "different-temporary-identity" },
    { verificationEditExpiryTimeSeconds: "4102445200" },
    { verificationObservedAtUtc: finalAt },
  ])("refuses changed immutable identity/proof on idempotent recognition %#", async (patch) => {
    const built = await fixture();
    await invoke(built);
    const candidate = parseReleaseCommitAttemptJournalRecord(
      { ...built.candidate, ...patch },
      packageName,
    );
    expect(await invoke(built, { candidate })).toMatchObject({
      outcome: "refused",
      code: "COMMIT_STATE_CHANGED",
    });
    expect(built.journal.transition).toHaveBeenCalledTimes(1);
    expect(built.auditLedger.append).toHaveBeenCalledTimes(1);
  });

  it.each(["1", "4102445000"])(
    "retains a different managed session with expiry %s without reinterpretation",
    async (expiryTimeSeconds) => {
      const built = await fixture();
      const session = {
        version: 1 as const,
        packageName,
        editId: "different-managed-lifecycle",
        expiryTimeSeconds,
        createdAt: at,
      };
      await built.store.save(session);
      expect(await invoke(built)).toMatchObject({
        outcome: "refused",
        code: "MANAGED_EDIT_ALREADY_OPEN",
      });
      expect(await built.store.load()).toEqual(session);
      expect(built.sessionStore.clear).not.toHaveBeenCalled();
      expect(built.journal.transition).not.toHaveBeenCalled();
    },
  );

  it("keeps the caller's same package lease through asynchronous audit settlement", async () => {
    const built = await fixture();
    let enterAudit: () => void = () => {
      throw new Error("Audit latch is not initialized");
    };
    let finishAudit: () => void = () => {
      throw new Error("Audit release latch is not initialized");
    };
    const entered = new Promise<void>((resolve) => {
      enterAudit = resolve;
    });
    const release = new Promise<void>((resolve) => {
      finishAudit = resolve;
    });
    const execution = invoke(built, {
      auditLedger: {
        async append(entry) {
          expect(built.coordinator.isPackageOperationHeld(packageName)).toBe(true);
          enterAudit();
          await release;
          await built.auditLedger.append(entry);
        },
      },
    });
    await entered;
    expect(built.coordinator.tryAcquirePackageOperation(packageName)).toMatchObject({
      acquired: false,
    });
    finishAudit();
    expect(await execution).toMatchObject({ outcome: "finalized" });
    expect(built.coordinator.isPackageOperationHeld(packageName)).toBe(false);
  });

  it("records only safe finalization correlation and no raw verification identity", async () => {
    const built = await fixture();
    await invoke(built);
    const [entry] = readAuditEntries(built.auditPath);
    expect(entry).toMatchObject({
      type: "release.commit.local_finalization.completed",
      actor: "agent",
      status: "success",
      metadata: {
        attemptId: built.candidate.attemptId,
        packageName,
        sourceState: "REMOTE_VERIFIED",
        targetState: "RECONCILED_COMMITTED",
        expectedObservedDigestEqual: true,
        local_finalization: true,
        googleCalls: 0,
      },
    });
    expect(Object.keys(entry?.metadata ?? {}).sort()).toEqual(
      [
        "attemptId",
        "packageName",
        "sourceState",
        "targetState",
        "expectedObservedDigestEqual",
        "local_finalization",
        "googleCalls",
      ].sort(),
    );
    const bytes = readFileSync(built.auditPath, "utf8");
    expect(bytes).not.toContain(temporaryEditId);
    expect(bytes).not.toContain(temporaryExpiry);
    expect(bytes).not.toContain(built.candidate.editId);
    expect(bytes).not.toContain("verificationEditId");
  });

  it("uses only local domain imports and has no gateway, model tool, approval or session-clear capability", () => {
    const source = readFileSync("src/releases/finalize-verified-commit.ts", "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map((match) => match[1]);
    expect(imports.sort()).toEqual(
      [
        "../audit/index.js",
        "./commit-attempt-journal.js",
        "./commit-attempt-status.js",
        "./index.js",
        "./session-store.js",
      ].sort(),
    );
    expect(source).not.toMatch(
      /\b(?:getEdit|createEdit|getTrack|deleteEdit|commitEdit|updateTrack|listReleaseSummaries|fetch)\s*\(/u,
    );
    expect(source).not.toContain("sessionStore.clear");
    expect(source).not.toMatch(
      /(?:ToolDefinition|AgentToolBinding|createApproval|createPackageOperation)/u,
    );
  });
});

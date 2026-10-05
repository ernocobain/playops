import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { NewAuditEntry } from "../src/audit/index.js";
import type { ReleaseEditReadback } from "../src/releases/gateway.js";
import {
  createFileReleaseCommitAttemptJournal,
  type ReleaseCommitAttemptJournalRecord,
} from "../src/releases/commit-attempt-journal.js";
import { createReleaseCommitStateDigest } from "../src/releases/commit-approval.js";
import { createReleaseCommitReconciliationTool } from "../src/releases/reconcile-commit-tool.js";
import { createFileReleaseEditSessionStore } from "../src/releases/session-store.js";
import {
  ReleaseError,
  type GooglePlayEditSession,
  type ReleaseTrackState,
} from "../src/releases/index.js";

const packageName = "com.example.recovery";
const now = new Date("2026-10-05T00:00:00.000Z");
const original = { packageName, editId: "original-edit", expiryTimeSeconds: "1900000000" };
const temp = { packageName, editId: "verification-edit", expiryTimeSeconds: "2000000000" };
const expected: ReleaseTrackState = {
  track: "production",
  releases: [
    {
      name: "Candidate",
      status: "completed",
      versionCodes: ["101"],
      releaseNotes: [{ language: "en-US", text: "PRIVATE-NOTE" }],
    },
  ],
};
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function inactiveRead(): ReleaseError {
  return new ReleaseError("EDIT_INVALID", "PRIVATE-UPSTREAM", {
    classification: {
      publisherCode: "API_REQUEST_FAILED",
      status: 400,
      googleStatus: "FAILED_PRECONDITION",
      googleReasons: ["failedPrecondition"],
    },
  });
}
const prior: ReleaseTrackState = {
  track: "production",
  releases: [{ name: "Previous", status: "completed", versionCodes: ["100"] }],
};
async function fixture(
  options: {
    expired?: boolean;
    state?: "PREPARED" | "TRANSPORT_ATTEMPTED" | "AMBIGUOUS" | "ACKNOWLEDGED";
    /** Proves absent durable prior evidence is never treated as a wildcard. */
    omitPriorStateDigest?: boolean;
  } = {},
) {
  const identity = {
    ...original,
    expiryTimeSeconds: options.expired ? "1" : original.expiryTimeSeconds,
  };
  const dir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "commit-reconcile-unit-"));
  dirs.push(dir);
  const journal = createFileReleaseCommitAttemptJournal(join(dir, "attempts.json"), {
    expectedPackageName: packageName,
  });
  const sessionStore = createFileReleaseEditSessionStore(join(dir, "session.json"), {
    expectedPackageName: packageName,
  });
  await sessionStore.save({ version: 1, ...identity, createdAt: now.toISOString() });
  let candidate: ReleaseCommitAttemptJournalRecord = await journal.prepare({
    version: 1,
    ...identity,
    targetTrack: expected.track,
    versionCode: "101",
    releaseName: "Candidate",
    releaseStatus: "completed",
    expectedStateDigest: createReleaseCommitStateDigest(expected),
    ...(options.omitPriorStateDigest === true
      ? {}
      : { priorStateDigest: createReleaseCommitStateDigest(prior) }),
    validationExpiryTimeSeconds: identity.expiryTimeSeconds,
    requestDigest: "a".repeat(64),
    attemptedAtUtc: now.toISOString(),
    updatedAtUtc: now.toISOString(),
  });
  if (options.state && options.state !== "PREPARED") {
    candidate = await journal.transition(
      candidate.attemptId,
      "PREPARED",
      "TRANSPORT_ATTEMPTED",
      now.toISOString(),
    );
    if (options.state !== "TRANSPORT_ATTEMPTED")
      candidate = await journal.transition(
        candidate.attemptId,
        "TRANSPORT_ATTEMPTED",
        options.state,
        now.toISOString(),
        options.state === "ACKNOWLEDGED" ? { acknowledgedAtUtc: now.toISOString() } : {},
      );
  }
  const events: string[] = [];
  let deleted = false;
  const getEdit = vi.fn(async (session: GooglePlayEditSession): Promise<ReleaseEditReadback> => {
    events.push(`get:${session.editId}`);
    if (
      (session.editId === identity.editId && options.expired) ||
      (session.editId === temp.editId && deleted)
    )
      throw inactiveRead();
    return { id: session.editId, expiryTimeSeconds: session.expiryTimeSeconds };
  });
  const gateway = {
    getEdit,
    createEdit: vi.fn(async () => {
      expect((await journal.list())[0]?.verificationInsertAttempted).toBe(true);
      events.push("insert");
      return temp;
    }),
    getTrack: vi.fn(async () => {
      expect((await journal.list())[0]).toMatchObject({
        verificationEditId: temp.editId,
        verificationEditExpiryTimeSeconds: temp.expiryTimeSeconds,
      });
      events.push("track");
      return expected;
    }),
    deleteEdit: vi.fn(async (session: GooglePlayEditSession) => {
      events.push(`delete:${session.editId}`);
      if (session.editId === identity.editId) throw new Error("Original deletion forbidden");
      expect((await journal.list())[0]).toMatchObject({
        verificationPreDeleteReadVerified: true,
        verificationDeleteAttempted: true,
      });
      deleted = true;
    }),
  };
  const poisoned = vi.fn(() => {
    throw new Error("Commit/update/upload access forbidden");
  });
  for (const name of ["commitEdit", "updateTrack", "uploadBundle"])
    Object.defineProperty(gateway, name, { get: poisoned });
  const auditLedger = { append: vi.fn(async (_entry: NewAuditEntry) => undefined) };
  const build = (bound = candidate, mode: "probe" | "verify_expired" = "probe") =>
    createReleaseCommitReconciliationTool({
      packageName,
      candidate: bound,
      mode,
      gateway,
      journal,
      sessionStore,
      auditLedger,
      now: () => now,
    });
  return {
    journal,
    sessionStore,
    candidate,
    gateway,
    events,
    auditLedger,
    build,
    poisoned,
    identity,
  };
}

describe("releases.reconcile_commit original-edit probe", () => {
  it("uses PREPARED as no-transport proof only after the mandatory original probe, even when expired", async () => {
    const f = await fixture({ expired: true });
    const result = await f.build(f.candidate, "verify_expired").tool.execute({}, {});
    expect(result).toMatchObject({
      case: "CASE_2",
      basis: "COMMIT_TRANSPORT_NOT_ATTEMPTED",
      externalStateUncertain: false,
      pendingCleanup: false,
      liveReleaseVerified: false,
      attemptState: "RECONCILED_NOT_COMMITTED",
    });
    expect(f.events).toEqual([`get:${original.editId}`]);
    expect(f.gateway.createEdit).not.toHaveBeenCalled();
    expect(f.gateway.deleteEdit).not.toHaveBeenCalled();
    expect(await f.sessionStore.load()).toMatchObject(f.identity);
  });

  it("probes the original first and retains an exact active edit without insert, delete, or commit", async () => {
    const f = await fixture();
    const pair = f.build();
    expect(pair.tool.name).toBe("releases.reconcile_commit");
    expect(pair.tool.permission).toBe("read");
    const result = await pair.tool.execute({}, {});
    expect(result).toMatchObject({
      case: "CASE_2",
      basis: "ORIGINAL_EDIT_ACTIVE",
      externalStateUncertain: false,
      pendingCleanup: false,
      commitAcknowledged: false,
      liveReleaseVerified: false,
      servingPropagationVerified: false,
    });
    expect(f.events).toEqual([`get:${original.editId}`]);
    expect(f.gateway.createEdit).not.toHaveBeenCalled();
    expect(f.gateway.deleteEdit).not.toHaveBeenCalled();
    expect(f.gateway.getTrack).not.toHaveBeenCalled();
    expect(await f.sessionStore.load()).toMatchObject(original);
    expect((await f.journal.list())[0]?.state).toBe("RECONCILED_NOT_COMMITTED");
  });

  it("resolves the expired expected state while the original managed session still exists", async () => {
    const f = await fixture({ expired: true, state: "AMBIGUOUS" });
    const pair = f.build(f.candidate, "verify_expired");
    expect(pair.tool.permission).toBe("destructive");
    const result = await pair.tool.execute({}, {});
    expect(result).toMatchObject({
      case: "CASE_1",
      basis: "EXPECTED_STATE_OBSERVED",
      liveReleaseVerified: true,
      servingPropagationVerified: false,
      commitAcknowledged: false,
      externalStateUncertain: false,
      pendingCleanup: false,
      attemptState: "RECONCILED_COMMITTED",
    });
    expect(f.events).toEqual([
      `get:${original.editId}`,
      "insert",
      "track",
      `get:${temp.editId}`,
      `delete:${temp.editId}`,
      `get:${temp.editId}`,
    ]);
    expect(f.gateway.createEdit).toHaveBeenCalledTimes(1);
    expect(f.gateway.deleteEdit).toHaveBeenCalledExactlyOnceWith(temp);
    expect(f.poisoned).not.toHaveBeenCalled();
    expect(await f.sessionStore.load()).toBeUndefined();
    expect((await f.journal.list())[0]).toMatchObject({
      state: "RECONCILED_COMMITTED",
      verificationObservedStateDigest: f.candidate.expectedStateDigest,
      verificationObservedAtUtc: now.toISOString(),
      verificationCleanupVerified: true,
      verificationDeleteAcknowledged: true,
    });
    expect(await pair.tool.verify?.({}, result, {})).toBe(true);
  });

  it("cleans the exact temporary edit on wrong-track response but never records false track proof", async () => {
    const f = await fixture({ expired: true, state: "AMBIGUOUS" });
    f.gateway.getTrack.mockResolvedValueOnce({ ...expected, track: "internal" });
    const result = await f.build(f.candidate, "verify_expired").tool.execute({}, {});
    expect(result).toMatchObject({
      case: "CASE_3",
      basis: "VERIFICATION_PROOF_UNAVAILABLE",
      externalStateUncertain: true,
      pendingCleanup: false,
      liveReleaseVerified: false,
    });
    expect((await f.journal.list())[0]?.verificationObservedStateDigest).toBeUndefined();
    expect((await f.journal.list())[0]?.verificationCleanupVerified).toBe(true);
    expect(f.gateway.deleteEdit).toHaveBeenCalledExactlyOnceWith(temp);
    expect(await f.sessionStore.load()).toMatchObject(f.identity);
  });

  it("retains the original handle and records an unrelated exact track state as CASE_3", async () => {
    const f = await fixture({ expired: true, state: "AMBIGUOUS" });
    const unrelated: ReleaseTrackState = {
      ...expected,
      releases: [{ name: "Other", status: "completed", versionCodes: ["202"] }],
    };
    f.gateway.getTrack.mockResolvedValueOnce(unrelated);
    const result = await f.build(f.candidate, "verify_expired").tool.execute({}, {});
    expect(result).toMatchObject({
      case: "CASE_3",
      basis: "UNRELATED_STATE_OBSERVED",
      externalStateUncertain: true,
      pendingCleanup: false,
      liveReleaseVerified: false,
    });
    expect((await f.journal.list())[0]).toMatchObject({
      state: "AMBIGUOUS",
      verificationCleanupVerified: true,
      verificationObservedStateDigest: createReleaseCommitStateDigest(unrelated),
    });
    expect(await f.sessionStore.load()).toMatchObject(f.identity);
    expect(f.poisoned).not.toHaveBeenCalled();
  });

  it("records prior state without claiming the historical commit failed and retains the original handle", async () => {
    const f = await fixture({ expired: true, state: "TRANSPORT_ATTEMPTED" });
    f.gateway.getTrack.mockResolvedValueOnce(prior);
    const result = await f.build(f.candidate, "verify_expired").tool.execute({}, {});
    expect(result).toMatchObject({
      case: "CASE_3",
      basis: "PRIOR_STATE_OBSERVED",
      externalStateUncertain: true,
      liveReleaseVerified: false,
      pendingCleanup: false,
      commitAcknowledged: false,
      attemptState: "AMBIGUOUS",
    });
    expect(await f.sessionStore.load()).toMatchObject(f.identity);
    expect((await f.journal.list())[0]).toMatchObject({
      state: "AMBIGUOUS",
      verificationObservedStateDigest: createReleaseCommitStateDigest(prior),
      verificationCleanupVerified: true,
    });
    expect(f.gateway.deleteEdit).toHaveBeenCalledExactlyOnceWith(temp);
    expect(f.poisoned).not.toHaveBeenCalled();
    const [restarted] = await f.journal.list();
    if (!restarted) throw new Error("Missing durable fixture");
    f.events.splice(0);
    expect(await f.build(restarted, "verify_expired").tool.execute({}, {})).toMatchObject({
      case: "CASE_3",
      basis: "PRIOR_STATE_OBSERVED",
      externalStateUncertain: true,
      pendingCleanup: false,
    });
    expect(f.events).toEqual([`get:${original.editId}`]);
    expect(f.gateway.createEdit).toHaveBeenCalledTimes(1);
    expect(f.gateway.deleteEdit).toHaveBeenCalledTimes(1);
  });
});

describe("commit reconciliation safety boundaries", () => {
  it.each(["TRANSPORT_ATTEMPTED", "AMBIGUOUS"] as const)(
    "retains exact unexpired original in %s with zero destructive activity",
    async (state) => {
      const f = await fixture({ state });
      const result = await f.build(f.candidate, "verify_expired").tool.execute({}, {});
      expect(result).toMatchObject({
        case: "CASE_2",
        externalStateUncertain: false,
        liveReleaseVerified: false,
      });
      expect(f.events).toEqual([`get:${original.editId}`]);
      expect(await f.sessionStore.load()).toMatchObject(f.identity);
      expect((await f.journal.list())[0]?.state).toBe("RECONCILED_NOT_COMMITTED");
    },
  );

  it("does not treat an inaccessible unexpired original as commit or inactivity proof", async () => {
    const f = await fixture({ state: "TRANSPORT_ATTEMPTED" });
    f.gateway.getEdit.mockRejectedValueOnce(inactiveRead());
    const result = await f.build(f.candidate, "verify_expired").tool.execute({}, {});
    expect(result).toMatchObject({
      case: "CASE_3",
      basis: "LOCAL_EXPIRY_NOT_ESTABLISHED",
      externalStateUncertain: true,
    });
    expect(f.gateway.createEdit).not.toHaveBeenCalled();
    expect(f.gateway.deleteEdit).not.toHaveBeenCalled();
    expect((await f.journal.list())[0]?.state).toBe("TRANSPORT_ATTEMPTED");
  });

  it.each([
    new Error("PRIVATE-network FAILED_PRECONDITION failedPrecondition"),
    Object.assign(new Error("PRIVATE-RESET"), { code: "ECONNRESET" }),
    { status: 400, googleStatus: "FAILED_PRECONDITION", googleReasons: ["failedPrecondition"] },
    new ReleaseError("EDIT_INVALID", "PRIVATE-403", {
      classification: {
        publisherCode: "API_REQUEST_FAILED",
        status: 403,
        googleStatus: "PERMISSION_DENIED",
        googleReasons: ["forbidden"],
      },
    }),
    new ReleaseError("EDIT_INVALID", "PRIVATE-404", {
      classification: {
        publisherCode: "API_REQUEST_FAILED",
        status: 404,
        googleStatus: "NOT_FOUND",
        googleReasons: ["notFound"],
      },
    }),
    new ReleaseError("EDIT_INVALID", "PRIVATE-429", {
      classification: { publisherCode: "API_REQUEST_FAILED", status: 429 },
    }),
    new ReleaseError("EDIT_INVALID", "PRIVATE-500", {
      classification: { publisherCode: "API_REQUEST_FAILED", status: 500 },
    }),
    new ReleaseError("EDIT_INVALID", "PRIVATE-wrong-reason", {
      classification: {
        publisherCode: "API_REQUEST_FAILED",
        status: 400,
        googleStatus: "FAILED_PRECONDITION",
        googleReasons: ["other"],
      },
    }),
    new ReleaseError("EDIT_INVALID", "PRIVATE-network-tuple", {
      classification: {
        publisherCode: "API_REQUEST_FAILED",
        status: 400,
        googleStatus: "FAILED_PRECONDITION",
        googleReasons: ["failedPrecondition"],
        transportCode: "ECONNRESET",
      },
    }),
  ])(
    "never performs destructive verification after a generic/unsafe original read failure %#, even expired",
    async (error) => {
      const f = await fixture({ expired: true, state: "AMBIGUOUS" });
      f.gateway.getEdit.mockRejectedValueOnce(error);
      const result = await f.build(f.candidate, "verify_expired").tool.execute({}, {});
      expect(result).toMatchObject({
        case: "CASE_3",
        basis: "ORIGINAL_READ_UNAVAILABLE",
        externalStateUncertain: true,
      });
      expect(f.gateway.createEdit).not.toHaveBeenCalled();
      expect(f.gateway.deleteEdit).not.toHaveBeenCalled();
      expect(await f.sessionStore.load()).toMatchObject(f.identity);
      expect(JSON.stringify(f.auditLedger.append.mock.calls)).not.toContain("PRIVATE");
    },
  );

  it.each([
    { id: "other", expiryTimeSeconds: "1" },
    { id: original.editId, expiryTimeSeconds: "2" },
    { id: original.editId },
  ])("protects mismatched original read identity %#", async (remote) => {
    const f = await fixture({ expired: true, state: "AMBIGUOUS" });
    f.gateway.getEdit.mockResolvedValueOnce(remote);
    expect(await f.build(f.candidate, "verify_expired").tool.execute({}, {})).toMatchObject({
      case: "CASE_3",
      basis: "ORIGINAL_IDENTITY_MISMATCH",
    });
    expect(f.gateway.createEdit).not.toHaveBeenCalled();
    expect(f.gateway.deleteEdit).not.toHaveBeenCalled();
  });

  it("keeps an active-edit conflict with durable ACKNOWLEDGED conservative", async () => {
    const f = await fixture({ state: "ACKNOWLEDGED" });
    expect(await f.build(f.candidate, "verify_expired").tool.execute({}, {})).toMatchObject({
      case: "CASE_3",
      commitAcknowledged: true,
      liveReleaseVerified: false,
      externalStateUncertain: true,
    });
    expect(f.gateway.createEdit).not.toHaveBeenCalled();
    expect((await f.journal.list())[0]?.state).toBe("ACKNOWLEDGED");
  });

  it("requires the separately destructive descriptor even after locally proven expiry", async () => {
    const f = await fixture({ expired: true, state: "AMBIGUOUS" });
    const pair = f.build();
    expect(pair.tool.permission).toBe("read");
    expect(pair.binding.approval).toBeUndefined();
    expect(await pair.tool.execute({}, {})).toMatchObject({
      case: "CASE_3",
      basis: "DESTRUCTIVE_APPROVAL_REQUIRED",
    });
    expect(f.gateway.createEdit).not.toHaveBeenCalled();
    expect(f.gateway.deleteEdit).not.toHaveBeenCalled();
  });

  it("permits exact expected verification after an exact expired successful original read", async () => {
    const f = await fixture({ expired: true, state: "TRANSPORT_ATTEMPTED" });
    f.gateway.getEdit.mockResolvedValueOnce({
      id: f.identity.editId,
      expiryTimeSeconds: f.identity.expiryTimeSeconds,
    });
    expect(await f.build(f.candidate, "verify_expired").tool.execute({}, {})).toMatchObject({
      case: "CASE_1",
      liveReleaseVerified: true,
    });
    expect(f.gateway.createEdit).toHaveBeenCalledTimes(1);
    expect(f.poisoned).not.toHaveBeenCalled();
  });

  it.each([{ editId: "another-managed-edit" }, { expiryTimeSeconds: "2" }])(
    "never replaces or clears a mismatched managed original handle %#",
    async (change) => {
      const f = await fixture({ expired: true, state: "AMBIGUOUS" });
      const other = { version: 1 as const, ...f.identity, ...change, createdAt: now.toISOString() };
      await f.sessionStore.save(other);
      expect(await f.build(f.candidate, "verify_expired").tool.execute({}, {})).toMatchObject({
        case: "CASE_3",
        basis: "LOCAL_SESSION_CHANGED",
      });
      expect(f.events).toEqual([`get:${original.editId}`]);
      expect(f.gateway.createEdit).not.toHaveBeenCalled();
      expect(f.gateway.deleteEdit).not.toHaveBeenCalled();
      expect(await f.sessionStore.load()).toEqual(other);
    },
  );

  it("rejects a stale or invented candidate snapshot before transport", async () => {
    const f = await fixture();
    const pair = f.build({ ...f.candidate, state: "TRANSPORT_ATTEMPTED" }, "verify_expired");
    await expect(pair.tool.execute({}, {})).rejects.toMatchObject({ code: "COMMIT_STATE_CHANGED" });
    expect(f.events).toEqual([]);
  });

  it.each([
    null,
    [],
    { mode: "verify_expired" },
    { editId: original.editId },
    { attemptId: "any" },
  ])("rejects model-selected lifecycle parameters %# before transport", async (value) => {
    const f = await fixture();
    const pair = f.build();
    expect(() => pair.tool.inputSchema.parse(value)).toThrow();
    await expect(
      pair.tool.execute(value as unknown as Record<string, never>, {}),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(f.events).toEqual([]);
  });

  it("copies a parsed immutable candidate and freezes mode rather than following mutable options", async () => {
    const f = await fixture({ expired: true, state: "AMBIGUOUS" });
    const mutable = { ...f.candidate };
    const options = {
      packageName,
      candidate: mutable,
      mode: "probe" as "probe" | "verify_expired",
      gateway: f.gateway,
      journal: f.journal,
      sessionStore: f.sessionStore,
      auditLedger: f.auditLedger,
      now: () => now,
    };
    const pair = createReleaseCommitReconciliationTool(options);
    options.mode = "verify_expired";
    mutable.editId = "changed";
    expect(pair.tool.permission).toBe("read");
    expect(await pair.tool.execute({}, {})).toMatchObject({
      basis: "DESTRUCTIVE_APPROVAL_REQUIRED",
    });
    expect(f.events).toEqual([`get:${original.editId}`]);
  });

  it("never treats absent prior evidence as a wildcard for a prior-looking state", async () => {
    const f = await fixture({
      expired: true,
      state: "AMBIGUOUS",
      omitPriorStateDigest: true,
    });
    f.gateway.getTrack.mockResolvedValueOnce(prior);
    const result = await f.build(f.candidate, "verify_expired").tool.execute({}, {});
    expect(result).toMatchObject({
      case: "CASE_3",
      basis: "UNRELATED_STATE_OBSERVED",
      externalStateUncertain: true,
      liveReleaseVerified: false,
    });
    expect((await f.journal.list())[0]?.priorStateDigest).toBeUndefined();
    expect(await f.sessionStore.load()).toMatchObject(f.identity);
  });

  it("always pairs a certain CASE_2 with a known not-committed basis", async () => {
    const active = await fixture();
    const activeResult = await active
      .build(active.candidate, "verify_expired")
      .tool.execute({}, {});
    expect(activeResult).toMatchObject({
      case: "CASE_2",
      basis: "ORIGINAL_EDIT_ACTIVE",
      externalStateUncertain: false,
      liveReleaseVerified: false,
    });
    const attempted = await fixture({ state: "PREPARED", expired: true });
    const attemptedResult = await attempted
      .build(attempted.candidate, "verify_expired")
      .tool.execute({}, {});
    expect(attemptedResult).toMatchObject({
      case: "CASE_2",
      basis: "COMMIT_TRANSPORT_NOT_ATTEMPTED",
      externalStateUncertain: false,
    });
  });

  it("separates durable acknowledgement from live verification with an already absent managed session", async () => {
    const f = await fixture({ expired: true, state: "ACKNOWLEDGED" });
    await f.sessionStore.clear();
    const result = await f.build(f.candidate, "verify_expired").tool.execute({}, {});
    expect(result).toMatchObject({
      case: "CASE_1",
      commitAcknowledged: true,
      liveReleaseVerified: true,
      servingPropagationVerified: false,
    });
    expect(JSON.stringify(f.auditLedger.append.mock.calls)).not.toContain("PRIVATE-NOTE");
  });

  it.each([
    { packageName, editId: original.editId, expiryTimeSeconds: temp.expiryTimeSeconds },
    { packageName, editId: temp.editId },
    { packageName, editId: "bad/id", expiryTimeSeconds: temp.expiryTimeSeconds },
    {
      packageName: "com.example.other",
      editId: temp.editId,
      expiryTimeSeconds: temp.expiryTimeSeconds,
    },
    { ...temp, expiryTimeSeconds: "1" },
    null,
  ])(
    "protects lost/malformed insert identity %# without guessing or reinserting",
    async (response) => {
      const f = await fixture({ expired: true, state: "AMBIGUOUS" });
      f.gateway.createEdit.mockResolvedValueOnce(response as typeof temp);
      const result = await f.build(f.candidate, "verify_expired").tool.execute({}, {});
      expect(result).toMatchObject({
        case: "CASE_3",
        pendingCleanup: true,
        liveReleaseVerified: false,
        externalStateUncertain: true,
      });
      expect(f.gateway.createEdit).toHaveBeenCalledTimes(1);
      expect(f.gateway.getTrack).not.toHaveBeenCalled();
      expect(f.gateway.deleteEdit).not.toHaveBeenCalled();
      const [candidate] = await f.journal.list();
      if (!candidate) throw new Error("Missing durable fixture");
      expect(candidate.verificationInsertAttempted).toBe(true);
      expect(candidate.verificationEditId).toBeUndefined();
      expect(await f.build(candidate, "verify_expired").tool.execute({}, {})).toMatchObject({
        case: "CASE_3",
        pendingCleanup: true,
      });
      expect(f.gateway.createEdit).toHaveBeenCalledTimes(1);
      expect(await f.sessionStore.load()).toMatchObject(f.identity);
    },
  );

  it("retains a durable insert claim when its transport response is lost", async () => {
    const f = await fixture({ expired: true, state: "AMBIGUOUS" });
    f.gateway.createEdit.mockRejectedValueOnce(new Error("PRIVATE insert response lost"));
    expect(await f.build(f.candidate, "verify_expired").tool.execute({}, {})).toMatchObject({
      case: "CASE_3",
      pendingCleanup: true,
    });
    const [candidate] = await f.journal.list();
    if (!candidate) throw new Error("Missing durable fixture");
    expect(await f.build(candidate, "verify_expired").tool.execute({}, {})).toMatchObject({
      case: "CASE_3",
      pendingCleanup: true,
    });
    expect(f.gateway.createEdit).toHaveBeenCalledTimes(1);
    expect(f.gateway.deleteEdit).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    new Error("PRIVATE postdelete reset"),
    new ReleaseError("EDIT_INVALID", "PRIVATE 404", {
      classification: {
        publisherCode: "API_REQUEST_FAILED",
        status: 404,
        googleStatus: "NOT_FOUND",
        googleReasons: ["notFound"],
      },
    }),
    new ReleaseError("EDIT_INVALID", "PRIVATE 500", {
      classification: { publisherCode: "API_REQUEST_FAILED", status: 500 },
    }),
  ])(
    "retains the original recovery handle for an unverified post-delete outcome %#",
    async (postFailure) => {
      const f = await fixture({ expired: true, state: "AMBIGUOUS" });
      let tempReads = 0;
      f.gateway.getEdit.mockImplementation(async (session) => {
        f.events.push(`get:${session.editId}`);
        if (session.editId === original.editId) throw inactiveRead();
        if (++tempReads >= 2 && postFailure !== undefined) throw postFailure;
        return { id: temp.editId, expiryTimeSeconds: temp.expiryTimeSeconds };
      });
      expect(await f.build(f.candidate, "verify_expired").tool.execute({}, {})).toMatchObject({
        case: "CASE_3",
        basis: "VERIFICATION_CLEANUP_PENDING",
        pendingCleanup: true,
        liveReleaseVerified: false,
      });
      const [candidate] = await f.journal.list();
      if (!candidate) throw new Error("Missing durable fixture");
      expect(candidate).toMatchObject({
        state: "REMOTE_VERIFIED",
        verificationDeleteAttempted: true,
        verificationDeleteAcknowledged: true,
      });
      expect(candidate.verificationCleanupVerified).toBeUndefined();
      expect(await f.build(candidate, "verify_expired").tool.execute({}, {})).toMatchObject({
        case: "CASE_3",
        pendingCleanup: true,
      });
      expect(f.gateway.deleteEdit).toHaveBeenCalledExactlyOnceWith(temp);
      expect(f.gateway.createEdit).toHaveBeenCalledTimes(1);
      expect(await f.sessionStore.load()).toMatchObject(f.identity);
    },
  );

  it.each([
    { id: "other-temp", expiryTimeSeconds: temp.expiryTimeSeconds },
    { id: temp.editId, expiryTimeSeconds: "1" },
  ])("never deletes a temp with mismatched exact pre-delete identity %#", async (before) => {
    const f = await fixture({ expired: true, state: "AMBIGUOUS" });
    f.gateway.getEdit.mockRejectedValueOnce(inactiveRead()).mockResolvedValueOnce(before);
    expect(await f.build(f.candidate, "verify_expired").tool.execute({}, {})).toMatchObject({
      case: "CASE_3",
      pendingCleanup: true,
    });
    expect(f.gateway.deleteEdit).not.toHaveBeenCalled();
    expect((await f.journal.list())[0]?.verificationDeleteAttempted).toBeUndefined();
    expect(await f.sessionStore.load()).toMatchObject(f.identity);
  });

  it("keeps a durable reconciled negative outcome terminal after expiry without creating another verification lifecycle", async () => {
    const f = await fixture({ expired: true, state: "AMBIGUOUS" });
    const candidate = await f.journal.transition(
      f.candidate.attemptId,
      "AMBIGUOUS",
      "RECONCILED_NOT_COMMITTED",
      now.toISOString(),
    );
    expect(await f.build(candidate, "verify_expired").tool.execute({}, {})).toMatchObject({
      case: "CASE_2",
      basis: "KNOWN_NEGATIVE_COMMIT_OUTCOME",
      externalStateUncertain: false,
      pendingCleanup: false,
      liveReleaseVerified: false,
    });
    expect(f.events).toEqual([`get:${original.editId}`]);
    expect(f.gateway.createEdit).not.toHaveBeenCalled();
    expect(f.gateway.deleteEdit).not.toHaveBeenCalled();
    expect(await f.sessionStore.load()).toMatchObject(f.identity);
  });

  it("fails the destructive verifier if another managed session appears after reconciliation", async () => {
    const f = await fixture({ expired: true, state: "AMBIGUOUS" });
    const pair = f.build(f.candidate, "verify_expired");
    const result = await pair.tool.execute({}, {});
    const other = {
      version: 1 as const,
      ...original,
      editId: "another-session",
      createdAt: now.toISOString(),
    };
    await f.sessionStore.save(other);
    expect(await pair.tool.verify?.({}, result, {})).toBe(false);
    expect(await f.sessionStore.load()).toEqual(other);
  });

  it("refuses malformed managed store data before starting temporary verification", async () => {
    const f = await fixture({ expired: true, state: "AMBIGUOUS" });
    const clear = vi.fn(async () => undefined);
    const sessionStore = {
      ...f.sessionStore,
      clear,
      load: async () => ({ version: 1 as const, ...f.identity, createdAt: "invalid" }),
    };
    const pair = createReleaseCommitReconciliationTool({
      packageName,
      candidate: f.candidate,
      mode: "verify_expired",
      gateway: f.gateway,
      journal: f.journal,
      sessionStore,
      auditLedger: f.auditLedger,
      now: () => now,
    });
    expect(await pair.tool.execute({}, {})).toMatchObject({
      case: "CASE_3",
      basis: "LOCAL_SESSION_CHANGED",
    });
    expect(f.events).toEqual([`get:${original.editId}`]);
    expect(f.gateway.createEdit).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it.each(["gateway", "journal", "sessionStore", "auditLedger"] as const)(
    "fails closed during composition for an invalid %s dependency",
    async (key) => {
      const f = await fixture();
      const options = {
        packageName,
        candidate: f.candidate,
        mode: "probe",
        gateway: f.gateway,
        journal: f.journal,
        sessionStore: f.sessionStore,
        auditLedger: f.auditLedger,
      };
      expect(() =>
        createReleaseCommitReconciliationTool({ ...options, [key]: {} } as unknown as Parameters<
          typeof createReleaseCommitReconciliationTool
        >[0]),
      ).toThrow();
      expect(f.events).toEqual([]);
    },
  );

  it("retains uncertainty when the trusted journal becomes unreadable before execution", async () => {
    const f = await fixture({ expired: true, state: "AMBIGUOUS" });
    const journal = {
      ...f.journal,
      list: async () => {
        throw new ReleaseError("COMMIT_ATTEMPT_JOURNAL_INVALID", "PRIVATE journal failure", {
          externalStateUncertain: false,
        });
      },
    };
    const pair = createReleaseCommitReconciliationTool({
      packageName,
      candidate: f.candidate,
      mode: "verify_expired",
      gateway: f.gateway,
      journal,
      sessionStore: f.sessionStore,
      auditLedger: f.auditLedger,
      now: () => now,
    });
    await expect(pair.tool.execute({}, {})).rejects.toMatchObject({
      code: "COMMIT_ATTEMPT_JOURNAL_INVALID",
      externalStateUncertain: true,
    });
    expect(f.events).toEqual([]);
    expect(await f.sessionStore.load()).toMatchObject(f.identity);
  });

  it("does not erase a verification lifecycle claim when the original unexpectedly reads active", async () => {
    const f = await fixture({ state: "TRANSPORT_ATTEMPTED" });
    const candidate = await f.journal.updateVerification(
      f.candidate.attemptId,
      f.candidate.state,
      now.toISOString(),
      { verificationInsertAttempted: true },
    );
    expect(await f.build(candidate, "verify_expired").tool.execute({}, {})).toMatchObject({
      case: "CASE_3",
      pendingCleanup: true,
      externalStateUncertain: true,
    });
    expect((await f.journal.list())[0]?.state).toBe("TRANSPORT_ATTEMPTED");
    expect(f.gateway.createEdit).not.toHaveBeenCalled();
    expect(f.gateway.deleteEdit).not.toHaveBeenCalled();
    expect(await f.sessionStore.load()).toMatchObject(f.identity);
  });

  it("rejects object coercion at the closed result case/state boundary", async () => {
    const f = await fixture();
    const pair = f.build();
    const output = await pair.tool.execute({}, {});
    const unknown = {
      ...output,
      case: "CASE_3",
      basis: "ORIGINAL_READ_UNAVAILABLE",
      externalStateUncertain: true,
    };
    expect(() =>
      pair.tool.outputSchema.parse({ ...unknown, case: { toString: () => "CASE_3" } }),
    ).toThrow();
    expect(() =>
      pair.tool.outputSchema.parse({
        ...unknown,
        attemptState: { toString: () => "RECONCILED_NOT_COMMITTED" },
      }),
    ).toThrow();
  });

  it("keeps a recovered prior observation ambiguous when interruption preceded the AMBIGUOUS transition", async () => {
    const f = await fixture({ expired: true, state: "TRANSPORT_ATTEMPTED" });
    await f.journal.updateVerification(
      f.candidate.attemptId,
      f.candidate.state,
      now.toISOString(),
      { verificationInsertAttempted: true },
    );
    await f.journal.updateVerification(
      f.candidate.attemptId,
      f.candidate.state,
      now.toISOString(),
      {
        verificationEditId: temp.editId,
        verificationEditExpiryTimeSeconds: temp.expiryTimeSeconds,
      },
    );
    const candidate = await f.journal.updateVerification(
      f.candidate.attemptId,
      f.candidate.state,
      now.toISOString(),
      {
        verificationObservedStateDigest: createReleaseCommitStateDigest(prior),
        verificationObservedAtUtc: now.toISOString(),
      },
    );
    expect(await f.build(candidate, "verify_expired").tool.execute({}, {})).toMatchObject({
      case: "CASE_3",
      basis: "PRIOR_STATE_OBSERVED",
      externalStateUncertain: true,
      pendingCleanup: false,
      attemptState: "AMBIGUOUS",
    });
    expect(f.gateway.createEdit).not.toHaveBeenCalled();
    expect(f.gateway.getTrack).not.toHaveBeenCalled();
    expect(f.gateway.deleteEdit).toHaveBeenCalledExactlyOnceWith(temp);
    expect(await f.sessionStore.load()).toMatchObject(f.identity);
  });

  it("rejects contradictory reconciliation success shapes instead of accepting fabricated liveness", async () => {
    const f = await fixture();
    const pair = f.build();
    const result = await pair.tool.execute({}, {});
    expect(() =>
      pair.tool.outputSchema.parse({ ...result, case: "CASE_1", liveReleaseVerified: false }),
    ).toThrow();
    expect(() =>
      pair.tool.outputSchema.parse({ ...result, case: "CASE_3", externalStateUncertain: false }),
    ).toThrow();
    expect(() =>
      pair.tool.outputSchema.parse({ ...result, case: "CASE_2", liveReleaseVerified: true }),
    ).toThrow();
    expect(() =>
      pair.tool.outputSchema.parse({ ...result, servingPropagationVerified: true }),
    ).toThrow();
    expect(() => pair.tool.outputSchema.parse({ ...result, rawError: "PRIVATE" })).toThrow();
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  fixture,
  inactiveRead,
  latch,
  priorDigest,
  priorTrack,
  unrelatedDigest,
} from "./daemon-reconcile-fixture.js";
import { PENDING_RECORD_SCHEMA_VERSION } from "../src/daemon/pending-store.js";
import { readAuditEntries } from "../src/audit/index.js";
import { createCommitVerificationEvidenceJournalSink } from "../src/releases/commit-verification-evidence.js";

afterEach(cleanupFixtures);
const UNCERTAIN = ["PREPARED", "TRANSPORT_ATTEMPTED", "AMBIGUOUS"] as const;

describe("Stage 3F.2 signed destructive recovery", () => {
  it.each(UNCERTAIN)(
    "prepares a destructive signed approval for %s with zero Google",
    async (state) => {
      const h = await fixture({ state });
      h.faults.originalFailure = inactiveRead();
      const response = await h.prepare();
      expect(response).toMatchObject({
        outcome: "approval_required",
        approval: { permission: "destructive", toolName: "releases.reconcile_commit" },
      });
      expect(approvalDigest(response)).toMatch(/^[0-9a-f]{64}$/u);
      const [record] = await h.pendingStore.list();
      expect(record).toMatchObject({
        schemaVersion: PENDING_RECORD_SCHEMA_VERSION,
        operation: "reconcile_commit",
        permission: "destructive",
        packageName: h.packageName,
        intent: { kind: "reconcile_commit" },
        state: "PENDING",
      });
      expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
      expect(h.claimExists(record?.requestId ?? "")).toBe(false);
    },
  );

  it("prepares recovery for a partial ACK prefix without starting a second Stage-3E verification", async () => {
    const h = await fixture({ state: "ACKNOWLEDGED", prefix: 2 });
    const bytes = h.journalBytes();
    const response = await h.prepare();
    expect(response).toMatchObject({
      outcome: "approval_required",
      approval: { permission: "destructive" },
    });
    const [record] = await h.rawJournal().list();
    expect(record).toMatchObject({
      verificationInsertAttempted: true,
      verificationEditId: expect.any(String),
    });
    expect(record?.verificationCleanupVerified).toBeUndefined();
    expect(h.journalBytes()).toBe(bytes);
    expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
  });

  it("refuses recovery while an independent verification cleanup record is unresolved", async () => {
    const h = await fixture({ state: "TRANSPORT_ATTEMPTED" });
    h.faults.originalFailure = inactiveRead();
    await h.cleanupJournal.record({
      editId: "PRIVATE-LEFTOVER-EDIT",
      expiryTimeSeconds: "1",
      source: "exact_release_verification",
      createdAt: "2026-10-09T00:00:00.000Z",
    });
    expect(await h.prepare()).toMatchObject({
      outcome: "cleanup_pending",
      error: { code: "RECONCILIATION_CLEANUP_UNRESOLVED" },
    });
    expect(await h.cleanupJournal.list()).toHaveLength(1);
    expect(await h.pendingStore.list()).toEqual([]);
    expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
  });

  it("rejects a conflicting managed session before authorizing recovery", async () => {
    const h = await fixture({ state: "TRANSPORT_ATTEMPTED" });
    h.faults.originalFailure = inactiveRead();
    await h.sessionStore.save({
      version: 1,
      packageName: h.packageName,
      editId: "different-managed-edit",
      expiryTimeSeconds: h.originalExpiry,
      createdAt: "2026-10-09T00:00:00.000Z",
    });
    expect(await h.prepare()).toMatchObject({
      outcome: "local_state_failure",
      error: { code: "RECONCILIATION_SESSION_CONFLICT" },
    });
    expect(await h.pendingStore.list()).toEqual([]);
    expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
  });

  it("rejects a bad signature before any claim, consumption, journal mutation or Google call", async () => {
    const h = await fixture({ state: "TRANSPORT_ATTEMPTED" });
    h.faults.originalFailure = inactiveRead();
    const challenge = await h.prepare();
    const requestId = challengeId(challenge);
    const bytes = h.journalBytes();
    expect(await h.execute(requestId, "AAAA")).toMatchObject({
      outcome: "approval_mismatch",
      error: { code: "SIGNATURE_INVALID" },
    });
    expect(h.claimExists(requestId)).toBe(false);
    expect(h.consumptions()).toBe(0);
    expect(h.journalBytes()).toBe(bytes);
    expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
    expect(await h.pendingStore.state(requestId)).toBe("pending");
  });

  it("rejects a stale approval when the durable attempt changed instead of rebinding it", async () => {
    const h = await fixture({ state: "TRANSPORT_ATTEMPTED" });
    h.faults.originalFailure = inactiveRead();
    const challenge = await h.prepare();
    const requestId = challengeId(challenge);
    const signature = await h.signRequest(requestId);
    await h
      .rawJournal()
      .transition(
        h.attemptId ?? "",
        "TRANSPORT_ATTEMPTED",
        "AMBIGUOUS",
        "2026-10-09T00:00:05.000Z",
      );
    const bytes = h.journalBytes();
    const response = await h.execute(requestId, signature);
    expect(response).toMatchObject({ outcome: "local_state_failure" });
    expect(response.error?.code).toMatch(
      /RECONCILIATION_INTENT_DRIFT|RECONCILIATION_|COMMIT_STATE_CHANGED/u,
    );
    expect(h.consumptions()).toBe(0);
    expect(h.journalBytes()).toBe(bytes);
    expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
  });

  it("runs the production expired-verification recovery and settles COMPLETED with the exact temporary-edit budget", async () => {
    const h = await fixture({ state: "TRANSPORT_ATTEMPTED" });
    h.faults.originalFailure = inactiveRead();
    const challenge = await h.prepare();
    const requestId = challengeId(challenge);
    const response = await h.execute(requestId, await h.signRequest(requestId));
    expect(response).toMatchObject({ outcome: "success", summary: "reconciliation_committed" });
    const [record] = await h.rawJournal().list();
    expect(record).toMatchObject({
      state: "RECONCILED_COMMITTED",
      verificationCleanupVerified: true,
      verificationObservedStateDigest: record?.expectedStateDigest,
    });
    expect(await h.pendingStore.state(requestId)).toBe("completed");
    expect(h.consumptions()).toBeGreaterThan(0);
    expect(h.calls).toMatchObject({
      getEdit: 3,
      createEdit: 1,
      getTrack: 1,
      deleteEdit: 1,
      commitEdit: 0,
      updateTrack: 0,
      uploadBundle: 0,
    });
    expect(h.events.indexOf("createEdit")).toBeLessThan(h.events.indexOf("deleteEdit"));
    expect(h.coordinator.isPackageOperationHeld(h.packageName)).toBe(false);
  });

  it("closes PREPARED as RECONCILED_NOT_COMMITTED without inserting any temporary edit", async () => {
    const h = await fixture({ state: "PREPARED" });
    h.faults.originalFailure = inactiveRead();
    const challenge = await h.prepare();
    const requestId = challengeId(challenge);
    const response = await h.execute(requestId, await h.signRequest(requestId));
    expect(response).toMatchObject({ outcome: "success", summary: "reconciliation_not_committed" });
    expect((await h.rawJournal().list())[0]?.state).toBe("RECONCILED_NOT_COMMITTED");
    expect(h.calls).toMatchObject({
      getEdit: 1,
      createEdit: 0,
      getTrack: 0,
      deleteEdit: 0,
      updateTrack: 0,
    });
  });

  it.each([
    ["PRIOR_STATE_OBSERVED", priorTrack()],
    [
      "UNRELATED_STATE_OBSERVED",
      {
        track: "internal",
        releases: [{ name: "Other", status: "draft" as const, versionCodes: ["7"] }],
      },
    ],
  ] as const)(
    "never converts an observed %s digest into a negative terminal",
    async (basis, observed) => {
      const h = await fixture({ state: "TRANSPORT_ATTEMPTED" });
      h.faults.originalFailure = inactiveRead();
      h.faults.observedTrack = observed;
      const challenge = await h.prepare();
      const requestId = challengeId(challenge);
      const response = await h.execute(requestId, await h.signRequest(requestId));
      expect(response).toMatchObject({ outcome: "external_state_ambiguous" });
      const [record] = await h.rawJournal().list();
      expect(record).not.toMatchObject({ state: "RECONCILED_NOT_COMMITTED" });
      expect(await h.pendingStore.state(requestId)).toBe("recovery_required");
      expect(h.claimExists(requestId)).toBe(true);
      expect(h.calls.createEdit).toBe(1);
      expect(h.calls.getTrack).toBe(1);
      expect(h.calls.commitEdit).toBe(0);
      expect(h.calls.updateTrack).toBe(0);
      expect(basis).toMatch(/STATE_OBSERVED/u);
    },
  );

  it("does not retry the temporary delete when its acknowledgement is uncertain", async () => {
    const h = await fixture({ state: "TRANSPORT_ATTEMPTED" });
    h.faults.originalFailure = inactiveRead();
    h.faults.deleteFailure = true;
    const challenge = await h.prepare();
    const requestId = challengeId(challenge);
    const response = await h.execute(requestId, await h.signRequest(requestId));
    expect(response.outcome).toBe("external_state_ambiguous");
    expect(h.calls.deleteEdit).toBe(1);
    expect(h.calls.createEdit).toBe(1);
    expect(h.claimExists(requestId)).toBe(true);
    expect(await h.pendingStore.state(requestId)).toBe("recovery_required");
  });

  it("reports a known-terminal remote outcome as a definite local failure when the production audit fails, without retrying", async () => {
    const h = await fixture({ state: "TRANSPORT_ATTEMPTED" });
    h.faults.originalFailure = inactiveRead();
    h.faults.auditFailure = true;
    const challenge = await h.prepare();
    const requestId = challengeId(challenge);
    const response = await h.execute(requestId, await h.signRequest(requestId));
    // The durable journal proves the reconciled outcome, so this is a local
    // failure rather than remote ambiguity.
    expect(response).toMatchObject({ outcome: "local_state_failure" });
    expect(response.error?.code).toMatch(/AUDIT|EXECUTION_FAILED/u);
    expect((await h.rawJournal().list())[0]?.state).toBe("RECONCILED_COMMITTED");
    expect(await h.pendingStore.state(requestId)).toBe("recovery_required");
    expect(h.calls.createEdit).toBe(1);
    expect(h.calls.deleteEdit).toBe(1);
    expect(h.claimExists(requestId)).toBe(true);
    // A later invocation observes the durable goal state and performs no retry.
    expect(await h.prepare()).toMatchObject({
      outcome: "success",
      summary: "reconciliation_not_required",
    });
    expect(h.calls.createEdit).toBe(1);
    expect(h.calls.deleteEdit).toBe(1);
  });
  it.each([
    ["prior", priorDigest],
    ["unrelated", unrelatedDigest],
  ] as const)(
    "routes a durable %s observation on ACK to signed recovery without a second temporary edit or track read",
    async (_kind, digest) => {
      const h = await fixture({
        state: "ACKNOWLEDGED",
        prefix: 7,
        observed: _kind,
      });
      h.faults.originalFailure = inactiveRead();
      const [before] = await h.rawJournal().list();
      expect(before?.verificationObservedStateDigest).toBe(digest);
      expect(before?.verificationCleanupVerified).toBe(true);
      const response = await h.prepare();
      expect(response).toMatchObject({
        outcome: "approval_required",
        approval: { permission: "destructive", toolName: "releases.reconcile_commit" },
      });
      expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
      const requestId = challengeId(response);
      const executed = await h.execute(requestId, await h.signRequest(requestId));
      // Production recovery keeps CASE_3 semantics: complete cleanup does NOT
      // turn the wrong observation into the expected one.
      expect(executed).toMatchObject({ outcome: "external_state_ambiguous" });
      const [after] = await h.rawJournal().list();
      expect(after?.state).toBe("ACKNOWLEDGED");
      expect(after?.state).not.toBe("REMOTE_VERIFIED");
      expect(after?.state).not.toBe("RECONCILED_COMMITTED");
      expect(h.calls).toMatchObject({
        createEdit: 0,
        getTrack: 0,
        deleteEdit: 0,
        commitEdit: 0,
        updateTrack: 0,
      });
      expect(h.calls.getEdit).toBe(1);
      expect(await h.pendingStore.state(requestId)).toBe("recovery_required");
      expect(h.claimExists(requestId)).toBe(true);
    },
  );

  it("moves TRANSPORT_ATTEMPTED with a durable prior observation to AMBIGUOUS through production recovery", async () => {
    const h = await fixture({ state: "TRANSPORT_ATTEMPTED", prefix: 3, observed: "prior" });
    h.faults.originalFailure = inactiveRead();
    const response = await h.prepare();
    expect(response).toMatchObject({ outcome: "approval_required" });
    const requestId = challengeId(response);
    const executed = await h.execute(requestId, await h.signRequest(requestId));
    expect(executed).toMatchObject({ outcome: "external_state_ambiguous" });
    const [after] = await h.rawJournal().list();
    expect(after?.state).toBe("AMBIGUOUS");
    expect(h.calls).toMatchObject({ createEdit: 0, getTrack: 0, deleteEdit: 1 });
    expect(await h.pendingStore.state(requestId)).toBe("recovery_required");
    expect(h.claimExists(requestId)).toBe(true);
  });

  it("reports failed unused-request retirement when an approved transport attempt advances to fresh ACK", async () => {
    const h = await fixture({ state: "TRANSPORT_ATTEMPTED" });
    const prepared = await h.prepare();
    const requestId = challengeId(prepared);
    const signature = await h.signRequest(requestId);
    const id = h.attemptId;
    if (id === undefined) throw new Error("Missing fixture attempt");
    await h
      .rawJournal()
      .transition(id, "TRANSPORT_ATTEMPTED", "ACKNOWLEDGED", "2026-10-09T00:00:00.000Z", {
        acknowledgedAtUtc: "2026-10-09T00:00:00.000Z",
      });
    const bytes = h.journalBytes();
    h.failTransitions.add("PENDING->RECOVERY_REQUIRED");
    expect(await h.execute(requestId, signature)).toMatchObject({
      outcome: "local_state_failure",
      error: { code: "RECONCILIATION_REQUEST_RETIRE_FAILED" },
    });
    expect(await h.pendingStore.state(requestId)).toBe("pending");
    expect(h.claimExists(requestId)).toBe(false);
    expect(h.consumptions()).toBe(0);
    expect(h.journalBytes()).toBe(bytes);
    expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
  });

  it("does not report success when local finalization succeeds but unused-request retirement fails", async () => {
    const h = await fixture({ state: "ACKNOWLEDGED", prefix: 2 });
    const prepared = await h.prepare();
    const requestId = challengeId(prepared);
    const signature = await h.signRequest(requestId);
    const [candidate] = await h.rawJournal().list();
    if (candidate === undefined) throw new Error("Missing fixture candidate");
    // Simulate successful Stage-3E evidence arriving after preparation through
    // the REAL strict bridge, rather than forging a verified record.
    const sink = createCommitVerificationEvidenceJournalSink({
      journal: h.rawJournal(),
      attemptId: candidate.attemptId,
      packageName: h.packageName,
      expectedStateDigest: candidate.expectedStateDigest,
      now: () => new Date("2026-10-09T00:00:00.000Z"),
    });
    await sink.record({
      type: "verification_state_observed",
      observedStateDigest: candidate.expectedStateDigest,
      observedAtUtc: "2026-10-09T00:00:00.000Z",
    });
    await sink.record({ type: "verification_pre_delete_read_verified" });
    await sink.record({ type: "verification_delete_attempted" });
    await sink.record({ type: "verification_delete_acknowledged" });
    await sink.record({ type: "verification_cleanup_verified" });
    h.failTransitions.add("PENDING->RECOVERY_REQUIRED");
    expect(await h.execute(requestId, signature)).toMatchObject({
      outcome: "local_state_failure",
      error: { code: "RECONCILIATION_REQUEST_RETIRE_FAILED" },
    });
    expect((await h.rawJournal().list())[0]?.state).toBe("RECONCILED_COMMITTED");
    expect(await h.pendingStore.state(requestId)).toBe("pending");
    expect(h.claimExists(requestId)).toBe(false);
    expect(h.consumptions()).toBe(0);
    expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
    expect(await h.prepare()).toMatchObject({
      outcome: "success",
      summary: "reconciliation_not_required",
    });
  });

  it("reports terminal-with-unresolved-cleanup as cleanup_pending during execute, never as no-op", async () => {
    const h = await fixture({ state: "TRANSPORT_ATTEMPTED", prefix: 2 });
    const prepared = await h.prepare();
    const requestId = challengeId(prepared);
    const signature = await h.signRequest(requestId);
    const id = h.attemptId;
    if (id === undefined) throw new Error("Missing fixture attempt");
    // This is a parser-valid terminal record that still owns cleanup evidence.
    await h
      .rawJournal()
      .transition(
        id,
        "TRANSPORT_ATTEMPTED",
        "RECONCILED_NOT_COMMITTED",
        "2026-10-09T00:00:00.000Z",
      );
    const bytes = h.journalBytes();
    expect(await h.execute(requestId, signature)).toMatchObject({
      outcome: "cleanup_pending",
      error: { code: "RECONCILIATION_TERMINAL_CLEANUP_PENDING" },
    });
    expect(h.journalBytes()).toBe(bytes);
    expect(await h.pendingStore.state(requestId)).toBe("recovery_required");
    expect(h.claimExists(requestId)).toBe(false);
    expect(h.consumptions()).toBe(0);
    expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
  });

  it("holds the shared package lease until asynchronous unused-request retirement settles", async () => {
    const h = await fixture({ state: "TRANSPORT_ATTEMPTED" });
    const prepared = await h.prepare();
    const requestId = challengeId(prepared);
    const signature = await h.signRequest(requestId);
    const id = h.attemptId;
    if (id === undefined) throw new Error("Missing fixture attempt");
    await h
      .rawJournal()
      .transition(id, "TRANSPORT_ATTEMPTED", "ACKNOWLEDGED", "2026-10-09T00:00:00.000Z", {
        acknowledgedAtUtc: "2026-10-09T00:00:00.000Z",
      });
    const entered = latch();
    const release = latch();
    const transition = h.pendingStore.transition;
    h.pendingStore.transition = async (...args) => {
      if (args[1] === "PENDING" && args[2] === "RECOVERY_REQUIRED") {
        entered.release();
        await release.promise;
      }
      return transition(...args);
    };
    const execution = h.execute(requestId, signature);
    await entered.promise;
    try {
      expect(h.coordinator.isPackageOperationHeld(h.packageName)).toBe(true);
      expect(h.coordinator.tryAcquirePackageOperation(h.packageName)).toMatchObject({
        acquired: false,
      });
    } finally {
      release.release();
    }
    expect(await execution).toMatchObject({
      outcome: "local_state_failure",
      error: { code: "VERIFY_COMMITTED_REQUIRED" },
    });
    expect(await h.pendingStore.state(requestId)).toBe("recovery_required");
    expect(h.coordinator.isPackageOperationHeld(h.packageName)).toBe(false);
  });

  it.each(["attempted_unacknowledged", "acknowledged_unconfirmed"] as const)(
    "routes parser-valid no-observation cleanup %s to production without replaying delete or insert",
    async (phase) => {
      const h = await fixture({ state: "ACKNOWLEDGED", prefix: 2 });
      const id = h.attemptId;
      if (id === undefined) throw new Error("Missing fixture attempt");
      await h.rawJournal().updateVerification(id, "ACKNOWLEDGED", "2026-10-09T00:00:00.000Z", {
        verificationPreDeleteReadVerified: true,
        verificationDeleteAttempted: true,
      });
      if (phase === "acknowledged_unconfirmed") {
        await h.rawJournal().updateVerification(id, "ACKNOWLEDGED", "2026-10-09T00:00:00.000Z", {
          verificationDeleteAcknowledged: true,
        });
      }
      const bytes = h.journalBytes();
      const prepared = await h.prepare();
      expect(prepared).toMatchObject({
        outcome: "approval_required",
        approval: { permission: "destructive" },
      });
      expect(h.journalBytes()).toBe(bytes);
      expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
      const requestId = challengeId(prepared);
      expect(await h.execute(requestId, await h.signRequest(requestId))).toMatchObject({
        outcome: "external_state_ambiguous",
      });
      expect(h.calls).toMatchObject({
        getEdit: phase === "attempted_unacknowledged" ? 1 : 2,
        createEdit: 0,
        getTrack: 0,
        deleteEdit: 0,
        commitEdit: 0,
        updateTrack: 0,
      });
      const [after] = await h.rawJournal().list();
      expect(after?.state).toBe("ACKNOWLEDGED");
      expect(after?.verificationObservedStateDigest).toBeUndefined();
      expect(await h.pendingStore.state(requestId)).toBe("recovery_required");
      expect(h.claimExists(requestId)).toBe(true);
    },
  );

  it.each([
    {
      prefix: 1,
      reads: 1,
      deletes: 0,
      outcome: "external_state_ambiguous",
      basis: "VERIFICATION_IDENTITY_UNAVAILABLE",
    },
    {
      prefix: 2,
      reads: 3,
      deletes: 1,
      outcome: "external_state_ambiguous",
      basis: "VERIFICATION_PROOF_UNAVAILABLE",
    },
    {
      prefix: 5,
      reads: 1,
      deletes: 0,
      outcome: "external_state_ambiguous",
      basis: "VERIFICATION_CLEANUP_PENDING",
    },
    { prefix: 6, reads: 2, deletes: 0, outcome: "success", basis: "EXPECTED_STATE_OBSERVED" },
  ])(
    "pins exact production recovery budgets for durable ACK prefix $prefix",
    async ({ prefix, reads, deletes, outcome, basis }) => {
      const h = await fixture({ state: "ACKNOWLEDGED", prefix });
      h.faults.originalFailure = inactiveRead();
      const before = (await h.rawJournal().list())[0];
      const prepared = await h.prepare();
      const requestId = challengeId(prepared);
      expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
      expect(await h.execute(requestId, await h.signRequest(requestId))).toMatchObject({ outcome });
      expect(h.calls).toMatchObject({
        getEdit: reads,
        createEdit: 0,
        getTrack: 0,
        deleteEdit: deletes,
        commitEdit: 0,
        updateTrack: 0,
        uploadBundle: 0,
      });
      const [after] = await h.rawJournal().list();
      expect(after?.verificationEditId).toBe(before?.verificationEditId);
      expect(readAuditEntries(h.remoteAuditPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ metadata: expect.objectContaining({ basis }) }),
        ]),
      );
      if (prefix < 3) expect(after?.verificationObservedStateDigest).toBeUndefined();
      expect(await h.pendingStore.state(requestId)).toBe(
        outcome === "success" ? "completed" : "recovery_required",
      );
      expect(h.claimExists(requestId)).toBe(outcome !== "success");
      if (prefix === 2) {
        const counters = { ...h.calls };
        // Production cleanup can persist legally without a successful observation.
        // A later prepare must not hand that prefix to the success-proof bridge.
        expect(await h.prepare()).toMatchObject({
          outcome: "approval_required",
          approval: { permission: "destructive" },
        });
        expect(h.calls).toEqual(counters);
      }
    },
  );

  it("never invokes the production tool, Google or the journal when approval-consumption persistence fails", async () => {
    const h = await fixture({ state: "TRANSPORT_ATTEMPTED" });
    h.faults.originalFailure = inactiveRead();
    h.failTransitions.add("CLAIMED->CONSUMED");
    const challenge = await h.prepare();
    const requestId = challengeId(challenge);
    const bytes = h.journalBytes();
    const response = await h.execute(requestId, await h.signRequest(requestId));
    expect(response).toMatchObject({
      outcome: "local_state_failure",
      error: { code: "APPROVAL_CONSUMPTION_PERSIST_FAILED" },
    });
    expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
    expect(h.journalBytes()).toBe(bytes);
    expect(h.consumptions()).toBe(0);
    expect(await h.pendingStore.state(requestId)).toBe("recovery_required");
    expect(h.claimExists(requestId)).toBe(true);
  });

  it("reports a failed COMPLETED settlement as a local failure while the reconciled journal outcome stays durable", async () => {
    const h = await fixture({ state: "TRANSPORT_ATTEMPTED" });
    h.faults.originalFailure = inactiveRead();
    h.failTransitions.add("CONSUMED->COMPLETED");
    const challenge = await h.prepare();
    const requestId = challengeId(challenge);
    const response = await h.execute(requestId, await h.signRequest(requestId));
    expect(response).toMatchObject({
      outcome: "local_state_failure",
      error: { code: "TERMINAL_TRANSITION_FAILED" },
    });
    expect((await h.rawJournal().list())[0]?.state).toBe("RECONCILED_COMMITTED");
    expect(await h.pendingStore.state(requestId)).toBe("recovery_required");
    expect(h.claimExists(requestId)).toBe(true);
    const createEditAfter = h.calls.createEdit;
    expect(await h.prepare()).toMatchObject({
      outcome: "success",
      summary: "reconciliation_not_required",
    });
    expect(h.calls.createEdit).toBe(createEditAfter);
  });

  it("reports a failed RECOVERY_REQUIRED settlement as a local persistence failure without retrying Google", async () => {
    const h = await fixture({ state: "ACKNOWLEDGED", prefix: 7, observed: "unrelated" });
    h.faults.originalFailure = inactiveRead();
    h.failTransitions.add("CONSUMED->RECOVERY_REQUIRED");
    const challenge = await h.prepare();
    const requestId = challengeId(challenge);
    const response = await h.execute(requestId, await h.signRequest(requestId));
    expect(response).toMatchObject({
      outcome: "local_state_failure",
      error: { code: "RECOVERY_SETTLEMENT_PERSIST_FAILED" },
    });
    // The consumed request could not be retired; it is pinned in its actual
    // durable state and the claim stays held.
    expect(await h.pendingStore.state(requestId)).toBe("consumed");
    expect(h.claimExists(requestId)).toBe(true);
    expect(h.calls.createEdit).toBe(0);
    expect(h.calls.getTrack).toBe(0);
  });
});

function approvalDigest(response: { approval?: { requestDigest?: string } }): string {
  return response.approval?.requestDigest ?? "";
}
function challengeId(response: { approval?: { requestId?: string } }): string {
  const id = response.approval?.requestId;
  if (id === undefined) throw new Error("Missing approval challenge id");
  return id;
}

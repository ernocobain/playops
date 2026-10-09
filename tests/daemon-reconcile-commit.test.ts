import { afterEach, describe, expect, it } from "vitest";
import { cleanupFixtures, fixture } from "./daemon-reconcile-fixture.js";
import { ReleaseError } from "../src/releases/index.js";
import { readAuditEntries } from "../src/audit/index.js";

afterEach(cleanupFixtures);
describe("Stage 3F.2 daemon reconciliation", () => {
  it("reports reconciliation_not_required without a pending request, claim, approval or Google when no unresolved attempt exists", async () => {
    const h = await fixture({ state: "none" });
    expect(await h.prepare()).toMatchObject({
      outcome: "success",
      summary: "reconciliation_not_required",
    });
    expect(await h.pendingStore.list()).toEqual([]);
    expect(h.consumptions()).toBe(0);
    expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
    expect(h.journalBytes()).toBe("");
  });
  it.each(["ACKNOWLEDGED", "REMOTE_VERIFIED"] as const)(
    "locally completes full Stage-3E proof from %s with zero Google, approval or pending creation",
    async (state) => {
      const h = await fixture({ state, prefix: 7 });
      const [candidate] = await h.rawJournal().list();
      expect(await h.prepare()).toMatchObject({ outcome: "success" });
      const [terminal] = await h.rawJournal().list();
      expect(terminal).toMatchObject({ ...candidate, state: "RECONCILED_COMMITTED" });
      expect(await h.pendingStore.list()).toEqual([]);
      expect(h.consumptions()).toBe(0);
      expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
      expect(h.coordinator.isPackageOperationHeld(h.packageName)).toBe(false);
    },
  );
  it.each(["prior", "unrelated"] as const)(
    "routes a durable %s observation on ACK straight to signed recovery instead of the success-proof bridge",
    async (observed) => {
      const h = await fixture({ state: "ACKNOWLEDGED", prefix: 7, observed });
      const bytes = h.journalBytes();
      const [before] = await h.rawJournal().list();
      const response = await h.prepare();
      expect(response).toMatchObject({
        outcome: "approval_required",
        approval: { permission: "destructive", toolName: "releases.reconcile_commit" },
      });
      expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
      expect(h.journalBytes()).toBe(bytes);
      const [after] = await h.rawJournal().list();
      expect(after).toMatchObject({
        state: "ACKNOWLEDGED",
        verificationObservedStateDigest: before?.verificationObservedStateDigest,
        verificationObservedAtUtc: before?.verificationObservedAtUtc,
      });
      expect(after?.verificationObservedStateDigest).not.toBe(after?.expectedStateDigest);
    },
  );
  it.each([1, 2, 3, 4, 5, 6] as const)(
    "keeps the Stage-3F.2 policy for a partial ACK prefix of %s markers",
    async (prefix) => {
      const h = await fixture({ state: "ACKNOWLEDGED", prefix });
      const bytes = h.journalBytes();
      const response = await h.prepare();
      expect(response.outcome).not.toBe("operation_unavailable");
      expect(h.journalBytes()).toBe(bytes);
      const [after] = await h.rawJournal().list();
      expect(after?.state).toBe("ACKNOWLEDGED");
      // A prefix without an observation is continued by the bridge first and
      // then, when that cannot complete it, routed to signed recovery exactly
      // like a prefix that already carries a non-expected observation.
      expect(response).toMatchObject({ outcome: "approval_required" });
      expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
    },
  );
  it("leaves fresh ACK verification to Stage 3E without a reconcile pending or Google readback", async () => {
    const h = await fixture({ state: "ACKNOWLEDGED" });
    const bytes = h.journalBytes();
    expect(await h.prepare()).toMatchObject({
      outcome: "local_state_failure",
      error: { code: "VERIFY_COMMITTED_REQUIRED" },
    });
    expect(h.journalBytes()).toBe(bytes);
    expect(await h.pendingStore.list()).toEqual([]);
    expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
  });
  it.each(["RECONCILED_COMMITTED", "RECONCILED_NOT_COMMITTED"] as const)(
    "never selects clean historical terminal %s for recovery",
    async (state) => {
      const h = await fixture({
        state,
        ...(state === "RECONCILED_COMMITTED" ? { prefix: 7 } : {}),
      });
      const bytes = h.journalBytes();
      expect(await h.prepare()).toMatchObject({
        outcome: "success",
        summary: "reconciliation_not_required",
      });
      expect(h.journalBytes()).toBe(bytes);
      expect(await h.pendingStore.list()).toEqual([]);
      expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
    },
  );
  it("preserves unresolved terminal cleanup without authorizing terminal history", async () => {
    const h = await fixture({ state: "RECONCILED_NOT_COMMITTED", prefix: 2 });
    const bytes = h.journalBytes();
    expect(await h.prepare()).toMatchObject({ outcome: "cleanup_pending" });
    expect(h.journalBytes()).toBe(bytes);
    expect(await h.pendingStore.list()).toEqual([]);
    expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
  });
  it.each(["ACKNOWLEDGED", "REMOTE_VERIFIED"] as const)(
    "does not mutate local %s proof if the shared package lease is busy",
    async (state) => {
      const h = await fixture({ state, prefix: 7 });
      const bytes = h.journalBytes();
      const lease = h.coordinator.tryAcquirePackageOperation(h.packageName);
      if (!lease.acquired) throw new Error("Test lease busy");
      try {
        expect(await h.prepare()).toMatchObject({
          outcome: "operation_in_progress",
          error: { code: "PACKAGE_OPERATION_IN_PROGRESS" },
        });
      } finally {
        h.coordinator.releasePackageOperation(lease.lease);
      }
      expect(h.journalBytes()).toBe(bytes);
      expect(await h.pendingStore.list()).toEqual([]);
      expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
    },
  );
  it.each(["ACKNOWLEDGED", "REMOTE_VERIFIED"] as const)(
    "does not fall through to signed Google recovery when local %s finalization refuses an original managed session",
    async (state) => {
      const h = await fixture({ state, prefix: 7 });
      await h.saveOriginalSession();
      const session = await h.sessionStore.load();
      expect(await h.prepare()).toMatchObject({
        outcome: "local_state_failure",
        error: { code: "MANAGED_EDIT_ALREADY_OPEN" },
      });
      expect(await h.sessionStore.load()).toEqual(session);
      expect((await h.rawJournal().list())[0]?.state).toBe("REMOTE_VERIFIED");
      expect(await h.pendingStore.list()).toEqual([]);
      expect(h.consumptions()).toBe(0);
      expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
    },
  );
  it("reports local audit failure truthfully, then no-ops on terminal authority without inventing missing audit", async () => {
    const h = await fixture({ state: "REMOTE_VERIFIED", prefix: 7 });
    h.faults.localAuditFailure = true;
    expect(await h.prepare()).toMatchObject({
      outcome: "local_state_failure",
      error: { code: "COMMIT_FINALIZATION_AUDIT_FAILED" },
    });
    expect((await h.rawJournal().list())[0]?.state).toBe("RECONCILED_COMMITTED");
    expect(await h.prepare()).toMatchObject({
      outcome: "success",
      summary: "reconciliation_not_required",
    });
    expect(readAuditEntries(h.localAuditPath)).toEqual([]);
    expect(await h.pendingStore.list()).toEqual([]);
    expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
  });
  it.each(["ACKNOWLEDGED", "REMOTE_VERIFIED"] as const)(
    "never falls through from local %s transition failure to Google recovery",
    async (state) => {
      const h = await fixture({
        state,
        prefix: 7,
        wrapJournal: (real) => ({
          ...real,
          async transition(...args) {
            throw new ReleaseError(
              "COMMIT_ATTEMPT_JOURNAL_INVALID",
              `Injected local transition ${args[2]} failure`,
            );
          },
        }),
      });
      expect(await h.prepare()).toMatchObject({ outcome: "local_state_failure" });
      expect((await h.rawJournal().list())[0]?.state).toBe(state);
      expect(await h.pendingStore.list()).toEqual([]);
      expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
    },
  );
});

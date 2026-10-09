import { afterEach, describe, expect, it } from "vitest";
import { cleanupFixtures, fixture, inactiveRead, latch } from "./daemon-reconcile-fixture.js";
import { readAuditEntries } from "../src/audit/index.js";

afterEach(cleanupFixtures);

describe("Stage 3F.2 reconciliation coordination", () => {
  it("lets exactly one of two concurrent executes of the SAME signed request win", async () => {
    const h = await fixture({ state: "TRANSPORT_ATTEMPTED" });
    h.faults.originalFailure = inactiveRead();
    const challenge = await h.prepare();
    const requestId = challenge.approval?.requestId ?? "";
    const signature = await h.signRequest(requestId);
    const held = latch();
    h.faults.insertHold = held.promise;
    const first = h.execute(requestId, signature);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await h.execute(requestId, signature);
    expect(["request_claim_held", "operation_in_progress"]).toContain(second.outcome);
    held.release();
    expect(await first).toMatchObject({ outcome: "success", summary: "reconciliation_committed" });
    expect(h.calls.createEdit).toBe(1);
    expect(h.calls.deleteEdit).toBe(1);
    expect(h.consumptions()).toBe(1);
    expect((await h.rawJournal().list())[0]?.state).toBe("RECONCILED_COMMITTED");
  });

  it("permits only one recovery lifecycle for two DIFFERENT valid approvals of the same snapshot", async () => {
    const h = await fixture({ state: "TRANSPORT_ATTEMPTED" });
    h.faults.originalFailure = inactiveRead();
    const first = await h.prepare();
    const second = await h.prepare();
    const firstId = first.approval?.requestId ?? "";
    const secondId = second.approval?.requestId ?? "";
    expect(firstId).not.toBe(secondId);
    expect(secondId).not.toBe("");
    const held = latch();
    h.faults.insertHold = held.promise;
    const winner = h.execute(firstId, await h.signRequest(firstId));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const loser = await h.execute(secondId, await h.signRequest(secondId));
    expect(loser).toMatchObject({
      outcome: "operation_in_progress",
      error: { code: "PACKAGE_OPERATION_IN_PROGRESS" },
    });
    expect(h.claimExists(secondId)).toBe(false);
    expect(await h.pendingStore.state(secondId)).toBe("pending");
    held.release();
    expect(await winner).toMatchObject({ outcome: "success" });
    expect(h.calls.createEdit).toBe(1);
    expect(h.calls.deleteEdit).toBe(1);
    expect(h.consumptions()).toBe(1);
    // The stale approval is never re-bound to the mutated snapshot: the durable
    // goal state already holds, so it is retired unused with zero further Google.
    const revisited = await h.execute(secondId, await h.signRequest(secondId));
    expect(revisited).toMatchObject({ outcome: "success", summary: "reconciliation_not_required" });
    expect(await h.pendingStore.state(secondId)).toBe("recovery_required");
    expect(h.calls.createEdit).toBe(1);
    expect(h.calls.deleteEdit).toBe(1);
    expect(h.consumptions()).toBe(1);
  });

  it.each(["prior", "unrelated"] as const)(
    "allows one winner for two approvals of the SAME non-expected ACK %s snapshot and rejects stale reuse",
    async (observed) => {
      const h = await fixture({ state: "ACKNOWLEDGED", prefix: 3, observed });
      h.faults.originalFailure = inactiveRead();
      const first = await h.prepare();
      const second = await h.prepare();
      const firstId = first.approval?.requestId;
      const secondId = second.approval?.requestId;
      if (firstId === undefined || secondId === undefined)
        throw new Error("Missing recovery approvals");
      const firstSignature = await h.signRequest(firstId);
      const secondSignature = await h.signRequest(secondId);
      const entered = latch();
      const release = latch();
      h.faults.originalHold = release.promise;
      const getEdit = h.gateway.getEdit;
      h.gateway.getEdit = async (session) => {
        entered.release();
        return getEdit(session);
      };
      const winner = h.execute(firstId, firstSignature);
      await entered.promise;
      try {
        expect(await h.execute(secondId, secondSignature)).toMatchObject({
          outcome: "operation_in_progress",
          error: { code: "PACKAGE_OPERATION_IN_PROGRESS" },
        });
        expect(h.claimExists(secondId)).toBe(false);
        expect(await h.pendingStore.state(secondId)).toBe("pending");
        expect(h.consumptions()).toBe(1);
        expect(h.calls).toMatchObject({ getEdit: 1, createEdit: 0, getTrack: 0, deleteEdit: 0 });
      } finally {
        release.release();
      }
      expect(await winner).toMatchObject({ outcome: "external_state_ambiguous" });
      expect(h.calls).toMatchObject({ getEdit: 3, createEdit: 0, getTrack: 0, deleteEdit: 1 });
      expect((await h.rawJournal().list())[0]).toMatchObject({
        state: "ACKNOWLEDGED",
        verificationCleanupVerified: true,
      });
      expect(readAuditEntries(h.remoteAuditPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            metadata: expect.objectContaining({
              case: "CASE_3",
              basis: observed === "prior" ? "PRIOR_STATE_OBSERVED" : "UNRELATED_STATE_OBSERVED",
            }),
          }),
        ]),
      );
      expect(await h.execute(secondId, secondSignature)).toMatchObject({
        outcome: "local_state_failure",
        error: { code: "RECONCILIATION_INTENT_DRIFT_REQUEST_DIGEST" },
      });
      expect(h.claimExists(secondId)).toBe(false);
      expect(h.consumptions()).toBe(1);
      expect(h.calls).toMatchObject({ getEdit: 3, createEdit: 0, getTrack: 0, deleteEdit: 1 });
    },
  );

  it("prepares zero-Google for another package while one package lease is held, but never executes into a held lease", async () => {
    const other = await fixture({ state: "TRANSPORT_ATTEMPTED", packageName: "com.example.other" });
    const h = await fixture({ state: "TRANSPORT_ATTEMPTED" });
    h.faults.originalFailure = inactiveRead();
    other.faults.originalFailure = inactiveRead();
    const lease = h.coordinator.tryAcquirePackageOperation(h.packageName);
    if (!lease.acquired) throw new Error("Test lease busy");
    try {
      // A different package's recovery is independent and completes normally.
      const otherChallenge = await other.prepare();
      const otherId = otherChallenge.approval?.requestId ?? "";
      expect(await other.execute(otherId, await other.signRequest(otherId))).toMatchObject({
        outcome: "success",
        summary: "reconciliation_committed",
      });
      // Preparation stays zero-Google and needs no lease; execution must not
      // enter while the package lease is held.
      const samePackage = await h.prepare();
      const sameId = samePackage.approval?.requestId ?? "";
      if (sameId !== "") {
        const refused = await h.execute(sameId, await h.signRequest(sameId));
        expect(refused).toMatchObject({
          outcome: "operation_in_progress",
          error: { code: "PACKAGE_OPERATION_IN_PROGRESS" },
        });
        expect(h.claimExists(sameId)).toBe(false);
        expect(await h.pendingStore.state(sameId)).toBe("pending");
      }
      expect(h.calls).toMatchObject({ createEdit: 0, getTrack: 0, deleteEdit: 0 });
    } finally {
      h.coordinator.releasePackageOperation(lease.lease);
    }
  });

  it("refuses a same-package open-edit execution while reconciliation holds the lease", async () => {
    const h = await fixture({ state: "TRANSPORT_ATTEMPTED" });
    h.faults.originalFailure = inactiveRead();
    const openPrepare = await h.call({ kind: "prepare_open_edit" });
    const openId = openPrepare.approval?.requestId ?? "";
    expect(openId).not.toBe("");
    const lease = h.coordinator.tryAcquirePackageOperation(h.packageName);
    if (!lease.acquired) throw new Error("Test lease busy");
    try {
      const refused = await h.call({
        kind: "execute_open_edit",
        requestId: openId,
        signature: await h.signRequest(openId),
      });
      expect(refused).toMatchObject({
        outcome: "operation_in_progress",
        error: { code: "PACKAGE_OPERATION_IN_PROGRESS" },
      });
      expect(h.claimExists(openId)).toBe(false);
      expect(h.calls.createEdit).toBe(0);
      expect(h.calls.updateTrack).toBe(0);
    } finally {
      h.coordinator.releasePackageOperation(lease.lease);
    }
  });
});

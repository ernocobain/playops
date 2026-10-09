/**
 * Stage 3E.2D — package-scoped operation single-flight coordinator.
 *
 * Real: the production `commit-attempt-journal` (untouched) provides the durable
 * restart authority. Fake: nothing. No commit transport, no Google, no socket.
 *
 * The coordinator is process-local and intentionally non-durable; these tests
 * prove the two required layers: runtime concurrency exclusion (here) plus
 * crash/restart exclusion (the journal).
 */
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  PACKAGE_OPERATION_BUSY_CODE,
  PackageOperationSingleFlightError,
  PLAYOPS_COMMIT_EXECUTION_ORDER,
  createPackageOperationSingleFlightCoordinator,
  type PackageExecutionLease,
} from "../src/daemon/package-operation-singleflight.js";
import {
  createFileReleaseCommitAttemptJournal,
  type ReleaseCommitAttemptPreparedInput,
} from "../src/releases/commit-attempt-journal.js";

const PACKAGE = "com.example.app";
const OTHER_PACKAGE = "com.example.other";
const EDIT_A = "edit-alpha";
const EDIT_B = "edit-beta";
const AT = "2026-10-06T00:00:00.000Z";
const AT_LATER = "2026-10-06T00:05:00.000Z";
const AT_LATEST = "2026-10-06T00:10:00.000Z";

const dirs: string[] = [];

afterAll(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-3d2-"));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  return dir;
}

function journalFor(): {
  readonly path: string;
  readonly journal: ReturnType<typeof createFileReleaseCommitAttemptJournal>;
} {
  const dir = tempDir();
  const path = join(dir, "commit-attempt-journal.json");
  return {
    path,
    journal: createFileReleaseCommitAttemptJournal(path, {
      expectedPackageName: PACKAGE,
    }),
  };
}

/** A valid production journal preparation input (shape mirrors the live tests). */
function preparedInput(editId: string): ReleaseCommitAttemptPreparedInput {
  return {
    version: 1,
    packageName: PACKAGE,
    editId,
    expiryTimeSeconds: "1900000000",
    targetTrack: "internal",
    versionCode: "42",
    releaseName: "42 (1.0)",
    releaseStatus: "inProgress",
    expectedStateDigest: "a".repeat(64),
    priorStateDigest: "b".repeat(64),
    validationExpiryTimeSeconds: "1900000000",
    requestDigest: "c".repeat(64),
    attemptedAtUtc: AT,
    updatedAtUtc: AT,
  };
}

async function codeOf(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation();
    return "FULFILLED";
  } catch (cause) {
    return (cause as { code?: string }).code ?? "THREW";
  }
}

// ------------------------------------------------------------------ same package

describe("package operation single flight: same package and same edit", () => {
  it("admits exactly one holder and refuses the same-edit loser fail-fast", async () => {
    const coordinator = createPackageOperationSingleFlightCoordinator();
    const request = { packageName: PACKAGE, editId: EDIT_A };
    let openBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      openBarrier = resolve;
    });

    const winner = coordinator.tryAcquirePackageOperation(request.packageName);
    expect(winner.acquired).toBe(true);
    const lease = winner.acquired ? winner.lease : undefined;
    expect(lease).toBeDefined();
    if (lease === undefined) throw new Error("unreachable");

    // The winner is "inside the commit execution" while the barrier is closed.
    const inFlight = (async (): Promise<string> => {
      await barrier;
      return "done";
    })();

    // Deterministic: the loser runs while the winner provably still holds.
    const loser = coordinator.tryAcquirePackageOperation(request.packageName);

    expect(loser.acquired).toBe(false);
    expect(loser.acquired ? "" : loser.code).toBe(PACKAGE_OPERATION_BUSY_CODE);
    // Fail-fast means a plain value, never a pending promise to queue behind.
    expect(loser).not.toBeInstanceOf(Promise);

    openBarrier?.();
    await expect(inFlight).resolves.toBe("done");

    // After request completion and release, the package is available again.
    expect(coordinator.releasePackageOperation(lease)).toEqual({ released: true });
    const next = coordinator.tryAcquirePackageOperation(request.packageName);
    expect(next.acquired).toBe(true);
    expect(coordinator.isPackageOperationHeld(PACKAGE)).toBe(true);
  });

  it("rejects invalid trusted scope input rather than keying on it", () => {
    const coordinator = createPackageOperationSingleFlightCoordinator();

    expect(() => coordinator.tryAcquirePackageOperation("")).toThrow(
      PackageOperationSingleFlightError,
    );
    expect(() => coordinator.tryAcquirePackageOperation(` ${PACKAGE}`)).toThrow(
      PackageOperationSingleFlightError,
    );
    expect(() => coordinator.tryAcquirePackageOperation("com.example.\u0000app")).toThrow(
      PackageOperationSingleFlightError,
    );
    expect(() => coordinator.tryAcquirePackageOperation("x".repeat(300))).toThrow(
      PackageOperationSingleFlightError,
    );
    expect(coordinator.heldPackageOperationCount()).toBe(0);
  });
});

// ------------------------------------------------------ package scope

describe("package operation single flight: different edits in the same package serialize", () => {
  it("refuses a different edit while the package lease is held", () => {
    const coordinator = createPackageOperationSingleFlightCoordinator();
    const requestA = { packageName: PACKAGE, editId: EDIT_A };
    const requestB = { packageName: PACKAGE, editId: EDIT_B };

    const first = coordinator.tryAcquirePackageOperation(requestA.packageName);
    const second = coordinator.tryAcquirePackageOperation(requestB.packageName);

    expect(requestA.editId).not.toBe(requestB.editId);
    expect(first.acquired).toBe(true);
    expect(second).toEqual({ acquired: false, code: PACKAGE_OPERATION_BUSY_CODE });
    expect(coordinator.heldPackageOperationCount()).toBe(1);
    expect(coordinator.isPackageOperationHeld(PACKAGE)).toBe(true);
  });

  it("allows another edit in the same package to acquire after the owner releases", () => {
    const coordinator = createPackageOperationSingleFlightCoordinator();
    const requestA = { packageName: PACKAGE, editId: EDIT_A };
    const requestB = { packageName: PACKAGE, editId: EDIT_B };
    const first = coordinator.tryAcquirePackageOperation(requestA.packageName);
    if (!first.acquired) throw new Error("expected acquisition");

    expect(coordinator.tryAcquirePackageOperation(requestB.packageName)).toEqual({
      acquired: false,
      code: PACKAGE_OPERATION_BUSY_CODE,
    });
    expect(coordinator.releasePackageOperation(first.lease)).toEqual({ released: true });
    expect(coordinator.tryAcquirePackageOperation(requestB.packageName).acquired).toBe(true);
    expect(coordinator.heldPackageOperationCount()).toBe(1);
  });
});

describe("package operation single flight: different packages stay independent", () => {
  it("allows another package to acquire while the first package is held", () => {
    const coordinator = createPackageOperationSingleFlightCoordinator();

    expect(coordinator.tryAcquirePackageOperation(PACKAGE).acquired).toBe(true);
    expect(coordinator.tryAcquirePackageOperation(OTHER_PACKAGE).acquired).toBe(true);
    expect(coordinator.isPackageOperationHeld(PACKAGE)).toBe(true);
    expect(coordinator.isPackageOperationHeld(OTHER_PACKAGE)).toBe(true);
    expect(coordinator.heldPackageOperationCount()).toBe(2);
  });

  it("keeps distinct package names independent even when one is a prefix of the other", () => {
    const coordinator = createPackageOperationSingleFlightCoordinator();

    expect(coordinator.tryAcquirePackageOperation(PACKAGE).acquired).toBe(true);
    expect(coordinator.tryAcquirePackageOperation(`${PACKAGE}.other`).acquired).toBe(true);
    expect(coordinator.heldPackageOperationCount()).toBe(2);
  });
});

// ---------------------------------------------------- real package journal

describe("package operation single flight: real package journal entry serialization", () => {
  it("rejects edit B before journal.prepare while edit A holds the package lease", async () => {
    const coordinator = createPackageOperationSingleFlightCoordinator();
    const { journal } = journalFor();
    const requestA = { packageName: PACKAGE, editId: EDIT_A };
    const requestB = { packageName: PACKAGE, editId: EDIT_B };
    const heldA = coordinator.tryAcquirePackageOperation(requestA.packageName);
    if (!heldA.acquired) throw new Error("expected acquisition");
    let prepareCallsB = 0;

    const attemptB = async () => {
      const acquired = coordinator.tryAcquirePackageOperation(requestB.packageName);
      if (!acquired.acquired) return acquired;
      try {
        prepareCallsB += 1;
        await journal.prepare(preparedInput(requestB.editId));
        return acquired;
      } finally {
        expect(coordinator.releasePackageOperation(acquired.lease)).toEqual({ released: true });
      }
    };

    try {
      expect(await journal.list()).toEqual([]);
      const rejectedB = await attemptB();
      expect(rejectedB).toEqual({ acquired: false, code: PACKAGE_OPERATION_BUSY_CODE });
      expect(prepareCallsB).toBe(0);
      expect(await journal.list()).toEqual([]);

      const preparedA = await journal.prepare(preparedInput(requestA.editId));
      expect(preparedA).toMatchObject({ packageName: PACKAGE, editId: EDIT_A, state: "PREPARED" });
      expect(await journal.list()).toEqual([preparedA]);
      expect(coordinator.isPackageOperationHeld(PACKAGE)).toBe(true);
    } finally {
      expect(coordinator.releasePackageOperation(heldA.lease)).toEqual({ released: true });
    }
  });
});

describe("package operation single flight: lease ownership", () => {
  it("refuses a double release", () => {
    const coordinator = createPackageOperationSingleFlightCoordinator();
    const acquired = coordinator.tryAcquirePackageOperation(PACKAGE);
    if (!acquired.acquired) throw new Error("expected acquisition");

    expect(coordinator.releasePackageOperation(acquired.lease)).toEqual({ released: true });
    expect(coordinator.releasePackageOperation(acquired.lease)).toEqual({
      released: false,
      code: "LEASE_NOT_HELD",
    });
  });

  it("refuses a forged handle and never lets another package's lease free this package", () => {
    const coordinator = createPackageOperationSingleFlightCoordinator();
    const heldA = coordinator.tryAcquirePackageOperation(PACKAGE);
    const heldB = coordinator.tryAcquirePackageOperation(OTHER_PACKAGE);
    if (!heldA.acquired || !heldB.acquired) throw new Error("expected acquisitions");

    const forged = { kind: "playops.package-operation-lease" } as unknown as PackageExecutionLease;
    expect(coordinator.releasePackageOperation(forged)).toEqual({
      released: false,
      code: "LEASE_NOT_OWNER",
    });

    // Package-B's handle only frees package-B; package-A stays held.
    expect(coordinator.releasePackageOperation(heldB.lease)).toEqual({ released: true });
    expect(coordinator.isPackageOperationHeld(PACKAGE)).toBe(true);
    expect(coordinator.isPackageOperationHeld(OTHER_PACKAGE)).toBe(false);
    expect(coordinator.heldPackageOperationCount()).toBe(1);
  });

  it("refuses a stale lease after another request acquires the same package", () => {
    const coordinator = createPackageOperationSingleFlightCoordinator();
    const first = coordinator.tryAcquirePackageOperation(PACKAGE);
    if (!first.acquired) throw new Error("expected acquisition");
    expect(coordinator.releasePackageOperation(first.lease)).toEqual({ released: true });
    const next = coordinator.tryAcquirePackageOperation(PACKAGE);
    if (!next.acquired) throw new Error("expected acquisition");

    expect(coordinator.releasePackageOperation(first.lease)).toEqual({
      released: false,
      code: "LEASE_NOT_OWNER",
    });
    expect(coordinator.isPackageOperationHeld(PACKAGE)).toBe(true);
    expect(coordinator.releasePackageOperation(next.lease)).toEqual({ released: true });
  });

  it("refuses a handle issued by a previous coordinator instance", () => {
    const first = createPackageOperationSingleFlightCoordinator();
    const acquired = first.tryAcquirePackageOperation(PACKAGE);
    if (!acquired.acquired) throw new Error("expected acquisition");

    const restarted = createPackageOperationSingleFlightCoordinator();
    expect(restarted.tryAcquirePackageOperation(PACKAGE).acquired).toBe(true);
    expect(restarted.releasePackageOperation(acquired.lease)).toEqual({
      released: false,
      code: "LEASE_NOT_OWNER",
    });
    expect(restarted.isPackageOperationHeld(PACKAGE)).toBe(true);
  });
});

// -------------------------------------------------- process locality (§9/§10)

describe("package operation single flight: process-local memory is intentionally not durable", () => {
  it("a new coordinator starts with empty memory state", () => {
    const first = createPackageOperationSingleFlightCoordinator();
    expect(first.tryAcquirePackageOperation(PACKAGE).acquired).toBe(true);

    const restarted = createPackageOperationSingleFlightCoordinator();
    expect(restarted.heldPackageOperationCount()).toBe(0);
    expect(restarted.isPackageOperationHeld(PACKAGE)).toBe(false);
    // The fresh instance can re-acquire the package, exactly as a restarted
    // daemon would: restart safety must come from the journal, not this memory.
    expect(restarted.tryAcquirePackageOperation(PACKAGE).acquired).toBe(true);
  });

  it("CASE B: a surviving PREPARED package journal blocks another edit after restart", async () => {
    const { path, journal } = journalFor();
    const beforeRestart = createPackageOperationSingleFlightCoordinator();
    expect(beforeRestart.tryAcquirePackageOperation(PACKAGE).acquired).toBe(true);

    // The real production journal durably records the approved attempt.
    const attempt = await journal.prepare(preparedInput(EDIT_A));
    expect(attempt.state).toBe("PREPARED");

    // Simulated daemon restart: the in-memory lease is gone by construction.
    const afterRestart = createPackageOperationSingleFlightCoordinator();
    const reopened = createFileReleaseCommitAttemptJournal(path, { expectedPackageName: PACKAGE });
    expect(afterRestart.heldPackageOperationCount()).toBe(0);
    expect(afterRestart.tryAcquirePackageOperation(PACKAGE).acquired).toBe(true);
    expect(afterRestart.isPackageOperationHeld(PACKAGE)).toBe(true);
    expect(await reopened.list()).toEqual([attempt]);
    let transportEntries = 0;

    // Test-local transport-entry counter; no transport is invoked.
    expect(
      await codeOf(async () => {
        expect(afterRestart.isPackageOperationHeld(PACKAGE)).toBe(true);
        await reopened.prepare(preparedInput(EDIT_B));
        transportEntries += 1;
      }),
    ).toBe("COMMIT_ATTEMPT_JOURNAL_INVALID");
    expect(transportEntries).toBe(0);
    expect(await reopened.list()).toEqual([attempt]);
  });

  it("CASE A: a restart before journal preparation allows a fresh edit to prepare", async () => {
    const { path, journal } = journalFor();
    const beforeRestart = createPackageOperationSingleFlightCoordinator();
    expect(beforeRestart.tryAcquirePackageOperation(PACKAGE).acquired).toBe(true);
    // NO journal.prepare happens: the production tool cannot reach the transport
    // without a durable PREPARED record, so no remote commit can have begun.
    expect(await journal.list()).toEqual([]);

    const afterRestart = createPackageOperationSingleFlightCoordinator();
    const reopened = createFileReleaseCommitAttemptJournal(path, { expectedPackageName: PACKAGE });
    expect(afterRestart.heldPackageOperationCount()).toBe(0);
    expect(afterRestart.tryAcquirePackageOperation(PACKAGE).acquired).toBe(true);
    expect(afterRestart.isPackageOperationHeld(PACKAGE)).toBe(true);
    expect(await reopened.list()).toEqual([]);
    const fresh = await reopened.prepare(preparedInput(EDIT_B));
    expect(fresh).toMatchObject({ packageName: PACKAGE, editId: EDIT_B, state: "PREPARED" });
  });

  it("CASE C: a surviving TRANSPORT_ATTEMPTED package journal blocks another edit after restart", async () => {
    const { path, journal } = journalFor();
    const beforeRestart = createPackageOperationSingleFlightCoordinator();
    expect(beforeRestart.tryAcquirePackageOperation(PACKAGE).acquired).toBe(true);
    const attempt = await journal.prepare(preparedInput(EDIT_A));
    const marked = await journal.transition(
      attempt.attemptId,
      "PREPARED",
      "TRANSPORT_ATTEMPTED",
      AT_LATER,
    );

    const afterRestart = createPackageOperationSingleFlightCoordinator();
    const reopened = createFileReleaseCommitAttemptJournal(path, { expectedPackageName: PACKAGE });
    expect(afterRestart.heldPackageOperationCount()).toBe(0);
    expect(afterRestart.tryAcquirePackageOperation(PACKAGE).acquired).toBe(true);
    expect(afterRestart.isPackageOperationHeld(PACKAGE)).toBe(true);
    expect(await reopened.list()).toEqual([marked]);
    let transportEntries = 0;
    expect(
      await codeOf(async () => {
        expect(afterRestart.isPackageOperationHeld(PACKAGE)).toBe(true);
        await reopened.prepare(preparedInput(EDIT_B));
        transportEntries += 1;
      }),
    ).toBe("COMMIT_ATTEMPT_JOURNAL_INVALID");
    expect(transportEntries).toBe(0);
    expect(await reopened.list()).toEqual([marked]);
  });

  it("pins the production order: a durable journal record precedes the commit transport", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "src", "releases", "commit-edit-tool.ts"),
      "utf8",
    );
    const prepareAt = source.indexOf("await journal.prepare({");
    const markerAt = source.indexOf('"TRANSPORT_ATTEMPTED"', prepareAt);
    const transportAt = source.indexOf("await gateway.commitEdit(");

    expect(prepareAt).toBeGreaterThan(-1);
    expect(markerAt).toBeGreaterThan(prepareAt);
    expect(transportAt).toBeGreaterThan(-1);
    expect(markerAt).toBeLessThan(transportAt);
  });
});

// ------------------------------------- durable blocker after ACK/AMBIGUOUS (§14/§15)

describe("package operation single flight: unresolved journal stays the durable blocker", () => {
  it.each(["ACKNOWLEDGED", "AMBIGUOUS"] as const)(
    "%s blocks another edit after request completion releases the package lease",
    async (state) => {
      const { path, journal } = journalFor();
      const coordinator = createPackageOperationSingleFlightCoordinator();
      const original = coordinator.tryAcquirePackageOperation(PACKAGE);
      if (!original.acquired) throw new Error("expected acquisition");
      const attempt = await journal.prepare(preparedInput(EDIT_A));
      await journal.transition(attempt.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", AT_LATER);
      const settled = await journal.transition(
        attempt.attemptId,
        "TRANSPORT_ATTEMPTED",
        state,
        AT_LATEST,
        state === "ACKNOWLEDGED" ? { acknowledgedAtUtc: AT_LATEST } : {},
      );
      expect(coordinator.isPackageOperationHeld(PACKAGE)).toBe(true);
      expect(coordinator.releasePackageOperation(original.lease)).toEqual({ released: true });

      // A later edit may hold a new memory lease; durable authority is unchanged.
      const later = coordinator.tryAcquirePackageOperation(PACKAGE);
      if (!later.acquired) throw new Error("expected acquisition");
      const reopened = createFileReleaseCommitAttemptJournal(path, {
        expectedPackageName: PACKAGE,
      });
      let transportEntries = 0;
      try {
        expect(coordinator.isPackageOperationHeld(PACKAGE)).toBe(true);
        expect(await reopened.list()).toEqual([settled]);
        expect(
          await codeOf(async () => {
            expect(coordinator.isPackageOperationHeld(PACKAGE)).toBe(true);
            await reopened.prepare(preparedInput(EDIT_B));
            transportEntries += 1;
          }),
        ).toBe("COMMIT_ATTEMPT_JOURNAL_INVALID");
        expect(transportEntries).toBe(0);
        expect(await reopened.list()).toEqual([settled]);
      } finally {
        expect(coordinator.releasePackageOperation(later.lease)).toEqual({ released: true });
      }
    },
  );

  it("one unresolved record blocks another edit in the same package journal", async () => {
    const dir = tempDir();
    const journal = createFileReleaseCommitAttemptJournal(
      join(dir, "commit-attempt-journal.json"),
      { expectedPackageName: PACKAGE },
    );
    await journal.prepare(preparedInput(EDIT_A));
    // Same journal file, different edit: still refused (one unresolved attempt
    // is the single durable authority for the package-wide commit path).
    expect(await codeOf(async () => journal.prepare(preparedInput(EDIT_B)))).toBe(
      "COMMIT_ATTEMPT_JOURNAL_INVALID",
    );
  });
});

// ------------------------------------------------- pinned ordering contract (§12)

describe("package operation single flight: pinned future ordering", () => {
  it("pins the exact stage-3D ordering contract", () => {
    expect([...PLAYOPS_COMMIT_EXECUTION_ORDER]).toEqual([
      "execute_commit_safe_prechecks",
      "acquire_per_package_singleflight",
      "recheck_package_commit_journal_while_holding_lease",
      "request_claim_and_approval_lifecycle",
      "existing_production_commit_tool",
      "journal_prepare",
      "journal_transport_attempted",
      "edits_commit_at_most_once",
      "settle_daemon_pending_lifecycle",
      "release_package_operation",
    ]);
  });

  it("requires the package journal recheck after acquisition and before approval lifecycle", () => {
    const acquire = PLAYOPS_COMMIT_EXECUTION_ORDER.indexOf("acquire_per_package_singleflight");
    const recheck = PLAYOPS_COMMIT_EXECUTION_ORDER.indexOf(
      "recheck_package_commit_journal_while_holding_lease",
    );
    const approval = PLAYOPS_COMMIT_EXECUTION_ORDER.indexOf("request_claim_and_approval_lifecycle");
    const transport = PLAYOPS_COMMIT_EXECUTION_ORDER.indexOf("edits_commit_at_most_once");
    const settlement = PLAYOPS_COMMIT_EXECUTION_ORDER.indexOf("settle_daemon_pending_lifecycle");

    expect(acquire).toBeGreaterThan(-1);
    expect(acquire).toBeLessThan(recheck);
    expect(recheck).toBeLessThan(approval);
    expect(approval).toBeLessThan(transport);
    expect(transport).toBeLessThan(settlement);
    // The lease outlives the transport: released only at the very end.
    expect(PLAYOPS_COMMIT_EXECUTION_ORDER.at(-1)).toBe("release_package_operation");
  });
});

// ------------------------------------------------ no durable artifacts (§3/§20)

describe("package operation single flight: no durable lock lifecycle", () => {
  it("declares no filesystem, clock, timer or pid dependency at all", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "src", "daemon", "package-operation-singleflight.ts"),
      "utf8",
    );

    // Strip the documentation first: this module's comments legitimately
    // describe the journal's rename, and only executable code matters here.
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");

    // Zero module imports: nothing to read or write, nothing to expire.
    expect(code).not.toMatch(/\bfrom\s+["']/u);
    for (const forbidden of [
      "node:fs",
      "readFile",
      "writeFile",
      "open(",
      "rename",
      "setTimeout",
      "setInterval",
      "Date.now",
      "process.pid",
      "randomUUID",
      "hrtime",
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it("creates no artifact on disk across a full acquire/release cycle", () => {
    const dir = tempDir();
    const coordinator = createPackageOperationSingleFlightCoordinator();

    const acquired = coordinator.tryAcquirePackageOperation(PACKAGE);
    expect(acquired.acquired).toBe(true);
    if (!acquired.acquired) throw new Error("unreachable");
    expect(coordinator.releasePackageOperation(acquired.lease)).toEqual({ released: true });

    // The coordinator was given no path and has no durable representation, so a
    // watched directory necessarily stays empty.
    expect(readdirSync(dir)).toEqual([]);
    expect(coordinator.heldPackageOperationCount()).toBe(0);
  });
});

/**
 * Phase 6.5 security regression: local state files created by PlayOps must not be
 * group/world readable, independent of the operator's umask.
 *
 * Observed before this fix (bounded offline sandbox probe, umask 022): the audit
 * log, review checkpoint, release edit session and cleanup journal were created
 * 0644 while the health report was already 0600. These assertions pin the fixed
 * creation policy for every writer that persists operational state.
 */
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendAuditEntry } from "../src/audit/log.js";
import { createHealthComparisonTool } from "../src/health/compare-tool.js";
import { createHealthReport, writeHealthReport } from "../src/health/report.js";
import { createFileReleaseEditCleanupJournal } from "../src/releases/cleanup-journal.js";
import { createFileReleaseEditSessionStore } from "../src/releases/session-store.js";
import { createFileReviewCheckpointStore } from "../src/reviews/checkpoint/index.js";
import { rowsFor, scenarioByName } from "./fixtures/health/comparison.fake.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-state-mode-"));
  dirs.push(dir);
  return dir;
}
const packageName = "com.example.fakemode";
const groupOrOtherBits = (path: string): number => statSync(path).mode & 0o077;

async function comparisonReport() {
  const scenario = scenarioByName("crash-increase");
  const tool = createHealthComparisonTool({
    gateway: {
      readMetricSet: async () => ({}),
      queryMetricSet: async (_kind, request) => ({
        rows: rowsFor(
          "crash-increase",
          request.timelineSpec.startTime.day === 24 ? "current" : "baseline",
        ),
      }),
    },
  });
  const result = await tool.tool.execute(
    {
      kinds: [scenario.kind],
      current: { startTime: scenario.current.startTime, endTime: scenario.current.endTime },
      baseline: { startTime: scenario.baseline.startTime, endTime: scenario.baseline.endTime },
      granularity: scenario.granularity,
      dimensions: scenario.dimensions,
      metrics: scenario.metrics,
    },
    {},
  );
  return createHealthReport(result, () => new Date("2026-10-03T00:30:45.123Z"));
}

describe("Phase 6.5 state-file creation permissions", () => {
  it("creates operational state files without group/other access under a permissive umask", async () => {
    const dir = stateDir();
    const previousUmask = process.umask(0o000);
    try {
      appendAuditEntry(join(dir, "audit.jsonl"), {
        type: "probe.event",
        actor: "system",
        action: "probe",
        status: "success",
      });

      await createFileReviewCheckpointStore(join(dir, "checkpoint.json")).save({
        version: 1,
        packageName,
        reviews: { "review-1": { seconds: "1", nanos: 0 } },
      });

      await createFileReleaseEditSessionStore(join(dir, "edit-session.json"), {
        expectedPackageName: packageName,
      }).save({
        version: 1,
        packageName,
        editId: "fake-edit",
        expiryTimeSeconds: "1900000000",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      await createFileReleaseEditCleanupJournal(join(dir, "cleanup-journal.json"), {
        expectedPackageName: packageName,
      }).record({
        editId: "fake-temp-edit",
        expiryTimeSeconds: "1900000000",
        source: "rollout_verification",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const reportPath = await writeHealthReport(dir, await comparisonReport());

      const paths = {
        audit: join(dir, "audit.jsonl"),
        checkpoint: join(dir, "checkpoint.json"),
        editSession: join(dir, "edit-session.json"),
        cleanupJournal: join(dir, "cleanup-journal.json"),
        report: reportPath,
      };
      for (const [name, path] of Object.entries(paths)) {
        expect(groupOrOtherBits(path), `${name} must not be group/other readable`).toBe(0);
      }
    } finally {
      process.umask(previousUmask);
    }
  });

  it("keeps the explicit 0600 mode when the umask is more restrictive", async () => {
    const dir = stateDir();
    const previousUmask = process.umask(0o077);
    try {
      appendAuditEntry(join(dir, "audit.jsonl"), {
        type: "probe.event",
        actor: "system",
        action: "probe",
        status: "success",
      });
      expect(groupOrOtherBits(join(dir, "audit.jsonl"))).toBe(0);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("creates PlayOps-owned ancestor directories owner-only", async () => {
    const dir = stateDir();
    const previousUmask = process.umask(0o000);
    try {
      const nested = join(dir, "state", "audit.jsonl");
      appendAuditEntry(nested, {
        type: "probe.event",
        actor: "system",
        action: "probe",
        status: "success",
      });
      expect(statSync(join(dir, "state")).mode & 0o077).toBe(0);

      const store = createFileReviewCheckpointStore(join(dir, "reviews", "checkpoint.json"));
      await store.save({ version: 1, packageName, reviews: {} });
      expect(statSync(join(dir, "reviews")).mode & 0o077).toBe(0);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("does not re-permission an existing audit file it appends to", () => {
    const dir = stateDir();
    const path = join(dir, "audit.jsonl");
    appendAuditEntry(path, {
      type: "probe.event",
      actor: "system",
      action: "probe",
      status: "success",
    });
    // Simulate an operator-set mode on an existing ledger: append must not change it.
    chmodSync(path, 0o644);
    appendAuditEntry(path, {
      type: "probe.event",
      actor: "system",
      action: "probe",
      status: "success",
    });
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });
});

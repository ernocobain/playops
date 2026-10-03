import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendAuditEntry, readAuditEntries } from "../src/audit/log.js";
import { createHealthThresholdTool } from "../src/health/threshold-tool.js";
import type { HealthMetricGateway, HealthMetricQueryRequest } from "../src/health/gateway.js";
import { HealthError, HEALTH_METRIC_SPECS, type HealthMetricKind } from "../src/health/index.js";
import type { VerificationResult } from "../src/runtime/verification/index.js";
import { THRESHOLD_QUERY, thresholdConfig } from "./fixtures/health/thresholds.fake.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});
function auditPath() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-threshold-tool-"));
  dirs.push(dir);
  return join(dir, "audit.jsonl");
}
function rawRow(kind: HealthMetricKind, request: HealthMetricQueryRequest, value: string) {
  return {
    aggregationPeriod: request.timelineSpec.aggregationPeriod,
    startTime: {
      ...request.timelineSpec.startTime,
      timeZone: { id: request.timelineSpec.startTime.timeZoneId ?? "America/Los_Angeles" },
    },
    dimensions: [],
    metrics: [{ metric: HEALTH_METRIC_SPECS[kind].primaryMetric, decimalValue: { value } }],
    rawExtra: "RAW-PAYLOAD-MARKER",
  };
}
function fakeGateway(value: string): HealthMetricGateway {
  return {
    readMetricSet: async () => ({}),
    queryMetricSet: async (kind, request) => ({ rows: [rawRow(kind, request, value)] }),
  };
}

describe("threshold tool uses the real fetcher and audit log", () => {
  it("one actual breach appends one explicit exact audit alert", async () => {
    const path = auditPath();
    const { tool } = createHealthThresholdTool({
      health: thresholdConfig({ crashRateReportedThreshold: "0.010000000000000000001" }),
      gateway: fakeGateway("0.010000000000000000002"),
      auditLogPath: path,
    });
    const result = await tool.execute(THRESHOLD_QUERY, {});
    expect(result.recordedAlertCount).toBe(1);
    const entries = readAuditEntries(path);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: "health.threshold.alert",
      action: "health.check_thresholds",
      actor: "system",
      status: "success",
      metadata: {
        metricKind: "crash_rate",
        metricName: "crashRate",
        observedValue: "0.010000000000000000002",
        thresholdValue: "0.010000000000000000001",
        operator: ">",
        result: "BREACHED",
      },
    });
    expect(JSON.stringify(entries)).not.toContain("RAW-PAYLOAD-MARKER");
  });

  it.each(["0", "0.010000000000000000000", "0.010000000000000000001"])(
    "no alert for non-breach %s",
    async (value) => {
      const path = auditPath();
      const { tool } = createHealthThresholdTool({
        health: thresholdConfig({ crashRateReportedThreshold: "0.010000000000000000001" }),
        gateway: fakeGateway(value),
        auditLogPath: path,
      });
      const result = await tool.execute(THRESHOLD_QUERY, {});
      expect(result.recordedAlertCount).toBe(0);
      expect(readAuditEntries(path)).toEqual([]);
      expect(existsSync(path)).toBe(false);
    },
  );

  it("all rules disabled means zero source calls and no alert file", async () => {
    const path = auditPath();
    const read = vi.fn();
    const query = vi.fn();
    const { tool } = createHealthThresholdTool({
      health: thresholdConfig(),
      gateway: { readMetricSet: read, queryMetricSet: query },
      auditLogPath: path,
    });
    expect(await tool.execute(THRESHOLD_QUERY, {})).toMatchObject({
      status: "DISABLED",
      recordedAlertCount: 0,
    });
    expect(read).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });

  it("empty source is explicit NO_DATA with no alert", async () => {
    const path = auditPath();
    const { tool } = createHealthThresholdTool({
      health: thresholdConfig({ crashRateReportedThreshold: "0" }),
      gateway: { readMetricSet: async () => ({}), queryMetricSet: async () => ({ rows: [] }) },
      auditLogPath: path,
    });
    expect(await tool.execute(THRESHOLD_QUERY, {})).toMatchObject({
      status: "NO_DATA",
      noDataCount: 1,
      evaluatedPointCount: 0,
      recordedAlertCount: 0,
    });
    expect(readAuditEntries(path)).toEqual([]);
  });

  it("complete fetching precedes alerts: a later source failure records zero alerts", async () => {
    const path = auditPath();
    const gateway: HealthMetricGateway = {
      readMetricSet: async () => ({}),
      queryMetricSet: async (kind, request) => {
        if (kind === "anr_rate") throw new Error("RAW-SOURCE-FAILURE");
        return { rows: [rawRow(kind, request, "2")] };
      },
    };
    const { tool } = createHealthThresholdTool({
      health: thresholdConfig({ crashRateReportedThreshold: "1", anrRateReportedThreshold: "1" }),
      gateway,
      auditLogPath: path,
    });
    await expect(tool.execute(THRESHOLD_QUERY, {})).rejects.toMatchObject({
      code: "SOURCE_FAILED",
    });
    expect(readAuditEntries(path)).toEqual([]);
  });

  it("duplicate normalized identities fail evaluation before any alert append", async () => {
    const path = auditPath();
    const gateway: HealthMetricGateway = {
      readMetricSet: async () => ({}),
      queryMetricSet: async (kind, request) => {
        const row = rawRow(kind, request, "2");
        return { rows: [row, structuredClone(row)] };
      },
    };
    const { tool } = createHealthThresholdTool({
      health: thresholdConfig({ crashRateReportedThreshold: "1" }),
      gateway,
      auditLogPath: path,
    });
    await expect(tool.execute(THRESHOLD_QUERY, {})).rejects.toMatchObject({
      code: "DUPLICATE_IDENTITY",
    });
    expect(readAuditEntries(path)).toEqual([]);
  });

  it("malformed data after an earlier breach fails with no alert", async () => {
    const path = auditPath();
    const gateway: HealthMetricGateway = {
      readMetricSet: async () => ({}),
      queryMetricSet: async (kind, request) => ({
        rows: [rawRow(kind, request, kind === "anr_rate" ? "1e-10001" : "2")],
      }),
    };
    const { tool } = createHealthThresholdTool({
      health: thresholdConfig({ crashRateReportedThreshold: "1", anrRateReportedThreshold: "1" }),
      gateway,
      auditLogPath: path,
    });
    await expect(tool.execute(THRESHOLD_QUERY, {})).rejects.toBeInstanceOf(HealthError);
    expect(readAuditEntries(path)).toEqual([]);
  });

  it("failed required audit append is fixed-message failure, not recorded success or infinite retry", async () => {
    const path = auditPath();
    const append = vi.fn(() => {
      throw new Error("RAW-APPEND-FAILURE");
    });
    const { tool } = createHealthThresholdTool({
      health: thresholdConfig({
        crashRateReportedThreshold: "1",
        anrRateReportedThreshold: "1",
        excessiveWakeupRateReportedThreshold: "1",
      }),
      gateway: fakeGateway("2"),
      auditLogPath: path,
      appendAlert: append,
    });
    await expect(tool.execute(THRESHOLD_QUERY, {})).rejects.toMatchObject({
      code: "ALERT_AUDIT_FAILED",
      message: "Health threshold alert could not be durably appended to the audit log.",
    });
    expect(append).toHaveBeenCalledTimes(1);
    expect(readAuditEntries(path)).toEqual([]);
  });

  it("partial append failure preserves earlier events and does not claim a transaction", async () => {
    const path = auditPath();
    appendAuditEntry(path, {
      type: "existing.record",
      actor: "operator",
      action: "existing",
      status: "success",
    });
    const before = readFileSync(path, "utf8");
    let calls = 0;
    const { tool } = createHealthThresholdTool({
      health: thresholdConfig({ crashRateReportedThreshold: "1", anrRateReportedThreshold: "1" }),
      gateway: fakeGateway("2"),
      auditLogPath: path,
      appendAlert: (entry) => {
        calls += 1;
        if (calls === 2) throw new Error("RAW-LATE-APPEND-FAILURE");
        appendAuditEntry(path, entry, { durable: true });
      },
    });
    await expect(tool.execute(THRESHOLD_QUERY, {})).rejects.toMatchObject({
      code: "ALERT_AUDIT_FAILED",
    });
    expect(calls).toBe(2);
    expect(readFileSync(path, "utf8").startsWith(before)).toBe(true);
    expect(
      readAuditEntries(path).filter((entry) => entry.type === "health.threshold.alert"),
    ).toHaveLength(1);
  });

  it("each separate operator execution may append the same real breach again", async () => {
    const path = auditPath();
    const { tool } = createHealthThresholdTool({
      health: thresholdConfig({ crashRateReportedThreshold: "1" }),
      gateway: fakeGateway("2"),
      auditLogPath: path,
    });
    await tool.execute(THRESHOLD_QUERY, {});
    await tool.execute(THRESHOLD_QUERY, {});
    expect(readAuditEntries(path)).toHaveLength(2);
  });

  it("operator settings are snapshotted and caller inputs are not mutated", async () => {
    const path = auditPath();
    const health = thresholdConfig({ crashRateReportedThreshold: "1" });
    const { tool } = createHealthThresholdTool({
      health,
      gateway: fakeGateway("2"),
      auditLogPath: path,
    });
    health.crashRateReportedThreshold = "3";
    const input = Object.freeze({ ...THRESHOLD_QUERY, dimensions: Object.freeze([]) });
    const before = JSON.stringify(input);
    expect((await tool.execute(input, {})).recordedAlertCount).toBe(1);
    expect(JSON.stringify(input)).toBe(before);
    expect(readAuditEntries(path)[0]?.metadata?.thresholdValue).toBe("1");
  });

  it.each([
    "threshold",
    "thresholds",
    "crashRateReportedThreshold",
    "crashRateThreshold",
    "health",
    "metrics",
    "kinds",
    "packageName",
    "credentials",
    "pageSize",
    "filter",
    "RAW-UNKNOWN-FIELD",
  ])("rejects caller field %s before source access", async (field) => {
    const read = vi.fn();
    const { tool } = createHealthThresholdTool({
      health: thresholdConfig({ crashRateReportedThreshold: "1" }),
      gateway: { readMetricSet: read, queryMetricSet: vi.fn() },
      auditLogPath: auditPath(),
    });
    const args = { ...THRESHOLD_QUERY, [field]: "RAW-CALLER-MARKER" };
    expect(() => tool.inputSchema.parse(args)).toThrowError(HealthError);
    await expect(tool.execute(args, {})).rejects.toBeInstanceOf(HealthError);
    expect(read).not.toHaveBeenCalled();
  });

  it("preflights DAILY-only wakeups before fetching an earlier enabled crash rule", async () => {
    const read = vi.fn();
    const { tool } = createHealthThresholdTool({
      health: thresholdConfig({
        crashRateReportedThreshold: "1",
        excessiveWakeupRateReportedThreshold: "1",
      }),
      gateway: { readMetricSet: read, queryMetricSet: vi.fn() },
      auditLogPath: auditPath(),
    });
    await expect(
      tool.execute(
        {
          startTime: "2026-09-23T00:00:00Z",
          endTime: "2026-09-23T01:00:00Z",
          granularity: "HOURLY",
        },
        {},
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(read).not.toHaveBeenCalled();
  });

  it("bounded pagination stays in the existing fetcher, with one fetch sequence", async () => {
    const calls: string[] = [];
    const gateway: HealthMetricGateway = {
      readMetricSet: async (kind) => {
        calls.push(`${kind}:read`);
        return {};
      },
      queryMetricSet: async (kind, request) => {
        calls.push(`${kind}:${request.pageToken ?? "first"}`);
        if (request.pageToken) return { rows: [rawRow(kind, request, "2")] };
        return { rows: [], nextPageToken: "second" };
      },
    };
    const { tool } = createHealthThresholdTool({
      health: thresholdConfig({ crashRateReportedThreshold: "1" }),
      gateway,
      auditLogPath: auditPath(),
      pageSize: 1,
      maxPages: 2,
    });
    expect((await tool.execute(THRESHOLD_QUERY, {})).recordedAlertCount).toBe(1);
    expect(calls).toEqual(["crash_rate:read", "crash_rate:first", "crash_rate:second"]);
  });

  it("serializer requires a real skipped-read result and returns only safe counts", async () => {
    const { tool, binding } = createHealthThresholdTool({
      health: thresholdConfig({ crashRateReportedThreshold: "1" }),
      gateway: fakeGateway("2"),
      auditLogPath: auditPath(),
    });
    const output = await tool.execute(THRESHOLD_QUERY, {});
    const verification: VerificationResult = {
      toolName: tool.name,
      permission: "read",
      required: false,
      status: "skipped",
      code: "VERIFICATION_SKIPPED",
      verified: false,
    };
    expect(JSON.parse(binding.serializeResult(output, verification))).toEqual({
      status: "EVALUATED",
      enabledRuleCount: 1,
      evaluatedPointCount: 1,
      noDataCount: 0,
      breachedPointCount: 1,
      recordedAlertCount: 1,
    });
    expect(() =>
      binding.serializeResult(output, { ...verification, code: "VERIFIED", verified: true }),
    ).toThrowError(HealthError);
    expect(() => tool.outputSchema.parse({ ...output, recordedAlertCount: 0 })).toThrowError(
      HealthError,
    );
    expect(() => tool.outputSchema.parse({ ...output, token: "RAW-PAYLOAD-MARKER" })).toThrowError(
      HealthError,
    );
  });

  it("rejects fabricated nested output facts and inconsistent overall states", async () => {
    const { tool } = createHealthThresholdTool({
      health: thresholdConfig({ crashRateReportedThreshold: "1" }),
      gateway: fakeGateway("2"),
      auditLogPath: auditPath(),
    });
    const output = await tool.execute(THRESHOLD_QUERY, {});
    const evaluation = output.evaluations[0];
    for (const patch of [
      { observedValue: "NaN" },
      { thresholdValue: "999" },
      { metricName: "crashRate7dUserWeighted" },
      { secret: "RAW-PAYLOAD-MARKER" },
    ]) {
      const changed = { ...evaluation, ...patch };
      expect(() =>
        tool.outputSchema.parse({ ...output, evaluations: [changed], breaches: [changed] }),
      ).toThrowError(HealthError);
    }
    expect(() => tool.outputSchema.parse({ ...output, status: "DISABLED" })).toThrowError(
      HealthError,
    );
    expect(() => tool.outputSchema.parse({ ...output, breaches: [{}] })).toThrowError(HealthError);
  });
});

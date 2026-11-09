import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAuditEntries } from "../src/audit/log.js";
import type { HealthMetricGateway, HealthMetricQueryRequest } from "../src/health/gateway.js";
import { HealthError, HEALTH_METRIC_SPECS, type HealthMetricKind } from "../src/health/index.js";
import {
  createHealthThresholdTool,
  createThresholdInputParser,
  evaluateThresholdWindow,
} from "../src/health/threshold-tool.js";
import { buildHealthThresholdRules } from "../src/health/thresholds.js";
import { THRESHOLD_QUERY, thresholdConfig } from "./fixtures/health/thresholds.fake.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});
function auditPath() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-threshold-core-"));
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
function captureHealthError(action: () => unknown): HealthError {
  try {
    action();
  } catch (error) {
    if (error instanceof HealthError) return error;
    throw error;
  }
  throw new Error("Expected HealthError to be thrown.");
}

describe("shared read-only threshold evaluation core", () => {
  it("matches tool.inputSchema.parse for valid and invalid inputs", () => {
    const health = thresholdConfig({
      crashRateReportedThreshold: "1",
      excessiveWakeupRateReportedThreshold: "1",
    });
    const rules = buildHealthThresholdRules(health);
    const parseInput = createThresholdInputParser(rules);
    const { tool } = createHealthThresholdTool({
      health,
      gateway: fakeGateway("0"),
      auditLogPath: auditPath(),
    });

    const parsedCore = parseInput(THRESHOLD_QUERY);
    const parsedTool = tool.inputSchema.parse(THRESHOLD_QUERY);
    expect(parsedCore).toEqual(parsedTool);
    expect(Object.isFrozen(parsedCore)).toBe(true);

    const invalidCases: readonly unknown[] = Object.freeze([
      Object.freeze({ ...THRESHOLD_QUERY, unknownKey: "RAW-CALLER-MARKER" }),
      Object.freeze({ startTime: THRESHOLD_QUERY.startTime, granularity: "DAILY" }),
      Object.freeze({
        startTime: "2026-09-23T00:00:00Z",
        endTime: "2026-09-23T01:00:00Z",
        granularity: "HOURLY",
      }),
      Object.freeze({ ...THRESHOLD_QUERY, startTime: 12345 }),
    ]);

    for (const invalidInput of invalidCases) {
      const coreError = captureHealthError(() => parseInput(invalidInput));
      const toolError = captureHealthError(() => tool.inputSchema.parse(invalidInput));
      expect(coreError.code).toBe("INVALID_ARGUMENT");
      expect(coreError.code).toBe(toolError.code);
      expect(coreError.message).toBe(toolError.message);
    }
  });

  it("returns DISABLED with zero rules and makes zero gateway calls", async () => {
    const rules = buildHealthThresholdRules(thresholdConfig());
    const parseInput = createThresholdInputParser(rules);
    const readMetricSet = vi.fn();
    const queryMetricSet = vi.fn();

    const result = await evaluateThresholdWindow(
      { rules, gateway: { readMetricSet, queryMetricSet } },
      parseInput(THRESHOLD_QUERY),
    );

    expect(result).toEqual({
      status: "DISABLED",
      enabledRuleCount: 0,
      evaluatedPointCount: 0,
      noDataCount: 0,
      evaluations: [],
      breaches: [],
    });
    expect(readMetricSet).not.toHaveBeenCalled();
    expect(queryMetricSet).not.toHaveBeenCalled();
  });

  it("returns NO_DATA for an enabled rule with an empty source", async () => {
    const rules = buildHealthThresholdRules(thresholdConfig({ crashRateReportedThreshold: "0" }));
    const parseInput = createThresholdInputParser(rules);

    const result = await evaluateThresholdWindow(
      {
        rules,
        gateway: {
          readMetricSet: async () => ({}),
          queryMetricSet: async () => ({ rows: [] }),
        },
      },
      parseInput(THRESHOLD_QUERY),
    );

    expect(result).toMatchObject({
      status: "NO_DATA",
      enabledRuleCount: 1,
      noDataCount: 1,
      evaluatedPointCount: 0,
      breaches: [],
    });
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0]?.status).toBe("NO_DATA");
  });

  it("matches tool.execute evaluation fields for a breaching fixture", async () => {
    const health = thresholdConfig({
      crashRateReportedThreshold: "0.010000000000000000001",
    });
    const rules = buildHealthThresholdRules(health);
    const parseInput = createThresholdInputParser(rules);
    const gateway = fakeGateway("0.010000000000000000002");

    const coreResult = await evaluateThresholdWindow(
      { rules, gateway },
      parseInput(THRESHOLD_QUERY),
    );
    const { tool } = createHealthThresholdTool({
      health,
      gateway,
      auditLogPath: auditPath(),
    });
    const { recordedAlertCount, ...toolEvaluationResult } = await tool.execute(THRESHOLD_QUERY, {});

    expect(coreResult.status).toBe("EVALUATED");
    expect(coreResult).toEqual(toolEvaluationResult);
    expect(coreResult.enabledRuleCount).toBe(toolEvaluationResult.enabledRuleCount);
    expect(coreResult.evaluatedPointCount).toBe(toolEvaluationResult.evaluatedPointCount);
    expect(coreResult.noDataCount).toBe(toolEvaluationResult.noDataCount);
    expect(coreResult.evaluations).toEqual(toolEvaluationResult.evaluations);
    expect(coreResult.breaches).toEqual(toolEvaluationResult.breaches);
    expect("recordedAlertCount" in coreResult).toBe(false);
    expect(recordedAlertCount).toBe(1);
  });

  it("is read-only and creates no audit file when a breach occurs", async () => {
    const path = auditPath();
    const rules = buildHealthThresholdRules(
      thresholdConfig({ crashRateReportedThreshold: "0.010000000000000000001" }),
    );
    const parseInput = createThresholdInputParser(rules);

    const result = await evaluateThresholdWindow(
      { rules, gateway: fakeGateway("0.010000000000000000002") },
      parseInput(THRESHOLD_QUERY),
    );

    expect(result.status).toBe("EVALUATED");
    expect(result.breaches).toHaveLength(1);
    expect(existsSync(path)).toBe(false);
    expect(readAuditEntries(path)).toEqual([]);
  });

  it("preserves tool.execute alert recording for the same breaching fixture", async () => {
    const path = auditPath();
    const { tool } = createHealthThresholdTool({
      health: thresholdConfig({ crashRateReportedThreshold: "0.010000000000000000001" }),
      gateway: fakeGateway("0.010000000000000000002"),
      auditLogPath: path,
    });

    const result = await tool.execute(THRESHOLD_QUERY, {});

    expect(result.status).toBe("EVALUATED");
    expect(result.breaches).toHaveLength(1);
    expect(result.recordedAlertCount).toBe(result.breaches.length);
    expect(result.recordedAlertCount).toBe(1);
    expect(existsSync(path)).toBe(true);
    const entries = readAuditEntries(path);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: "health.threshold.alert",
      actor: "system",
      action: "health.check_thresholds",
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
  });
});

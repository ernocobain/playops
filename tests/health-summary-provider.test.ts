import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as auditLog from "../src/audit/log.js";

const auditHoisted = vi.hoisted(() => ({
  appendAuditEntry: vi.fn(),
}));

vi.mock("../src/audit/log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof auditLog>();
  auditHoisted.appendAuditEntry.mockImplementation(actual.appendAuditEntry);
  return {
    ...actual,
    appendAuditEntry: auditHoisted.appendAuditEntry,
  };
});

import { appendAuditEntry, readAuditEntries } from "../src/audit/log.js";
import {
  runHealthCheckCli,
  type HealthCheckCliIo,
  type HealthCheckInput,
} from "../src/cli/health-check.js";
import type { HealthMetricGateway, HealthMetricQueryRequest } from "../src/health/gateway.js";
import { HealthError, HEALTH_METRIC_SPECS, type HealthMetricKind } from "../src/health/index.js";
import { UnsupportedThresholdGranularityError } from "../src/health/summary-errors.js";
import { createHealthSummarySource, toHealthCheckSummary } from "../src/health/summary.js";
import {
  createHealthThresholdTool,
  evaluateThresholdWindow,
} from "../src/health/threshold-tool.js";
import {
  buildHealthThresholdRules,
  evaluateHealthThresholds,
  type HealthThresholdBreach,
  type HealthThresholdEvaluation,
  type HealthThresholdResult,
} from "../src/health/thresholds.js";
import {
  THRESHOLD_QUERY,
  thresholdConfig,
  thresholdPoint,
  thresholdSeries,
} from "./fixtures/health/thresholds.fake.js";

const dirs: string[] = [];
afterEach(() => {
  auditHoisted.appendAuditEntry.mockClear();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function createTempAuditTarget(): { readonly dir: string; readonly path: string } {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-summary-provider-"));
  dirs.push(dir);
  return { dir, path: join(dir, "audit.jsonl") };
}

const DAILY_INPUT: HealthCheckInput = Object.freeze({
  startTime: THRESHOLD_QUERY.startTime,
  endTime: THRESHOLD_QUERY.endTime,
  granularity: "DAILY",
  dimensions: [],
});

const HOURLY_INPUT: HealthCheckInput = Object.freeze({
  startTime: "2026-09-23T00:00:00Z",
  endTime: "2026-09-23T01:00:00Z",
  granularity: "HOURLY",
  dimensions: [],
});

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

function fakeGateway(
  valuesByKind: Partial<Record<HealthMetricKind, string | null>> | string,
): HealthMetricGateway {
  return {
    readMetricSet: async () => ({}),
    queryMetricSet: async (kind, request) => {
      const value = typeof valuesByKind === "string" ? valuesByKind : valuesByKind[kind];
      if (value === undefined || value === null) {
        return { rows: [] };
      }
      return { rows: [rawRow(kind, request, value)] };
    },
  };
}

function createCapturedIo(): {
  readonly io: HealthCheckCliIo;
  readonly writes: string[];
  readonly errors: string[];
} {
  const writes: string[] = [];
  const errors: string[] = [];
  return {
    writes,
    errors,
    io: {
      write(text: string): void {
        writes.push(text);
      },
      writeError(text: string): void {
        errors.push(text);
      },
    },
  };
}

function expectInconsistent(result: unknown): void {
  let caught: unknown;
  try {
    toHealthCheckSummary(result as HealthThresholdResult);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HealthError);
  expect(caught).toMatchObject({
    message: "Health threshold result is inconsistent.",
    code: "INVALID_ARGUMENT",
  });
}

describe("Phase 5.4 WP2a-2 toHealthCheckSummary status adapter and invariants", () => {
  const oneRule = buildHealthThresholdRules(
    thresholdConfig({ crashRateReportedThreshold: "1.00" }),
  );
  const twoRules = buildHealthThresholdRules(
    thresholdConfig({
      crashRateReportedThreshold: "1.00",
      anrRateReportedThreshold: "0.50",
    }),
  );

  it("maps all five summary statuses and sets recordedAlertCount to 0 in every case", () => {
    const disabledResult = evaluateHealthThresholds([], []);
    const disabledSummary = toHealthCheckSummary(disabledResult);
    expect(disabledSummary).toEqual({
      status: "DISABLED",
      enabledRuleCount: 0,
      evaluatedPointCount: 0,
      noDataCount: 0,
      breachedPointCount: 0,
      recordedAlertCount: 0,
    });

    const noDataResult = evaluateHealthThresholds([thresholdSeries("crash_rate", [])], oneRule);
    const noDataSummary = toHealthCheckSummary(noDataResult);
    expect(noDataSummary).toEqual({
      status: "NO_DATA",
      enabledRuleCount: 1,
      evaluatedPointCount: 0,
      noDataCount: 1,
      breachedPointCount: 0,
      recordedAlertCount: 0,
    });

    const breachResult = evaluateHealthThresholds(
      [thresholdSeries("crash_rate", [thresholdPoint("crash_rate", "1.50")])],
      oneRule,
    );
    const breachSummary = toHealthCheckSummary(breachResult);
    expect(breachSummary).toEqual({
      status: "BREACH_DETECTED",
      enabledRuleCount: 1,
      evaluatedPointCount: 1,
      noDataCount: 0,
      breachedPointCount: 1,
      recordedAlertCount: 0,
    });

    const incompleteResult = evaluateHealthThresholds(
      [
        thresholdSeries("crash_rate", [thresholdPoint("crash_rate", "0.50")]),
        thresholdSeries("anr_rate", []),
      ],
      twoRules,
    );
    const incompleteSummary = toHealthCheckSummary(incompleteResult);
    expect(incompleteSummary).toEqual({
      status: "INCOMPLETE_DATA",
      enabledRuleCount: 2,
      evaluatedPointCount: 1,
      noDataCount: 1,
      breachedPointCount: 0,
      recordedAlertCount: 0,
    });

    const noBreachResult = evaluateHealthThresholds(
      [thresholdSeries("crash_rate", [thresholdPoint("crash_rate", "0.50")])],
      oneRule,
    );
    const noBreachSummary = toHealthCheckSummary(noBreachResult);
    expect(noBreachSummary).toEqual({
      status: "NO_BREACH_OBSERVED",
      enabledRuleCount: 1,
      evaluatedPointCount: 1,
      noDataCount: 0,
      breachedPointCount: 0,
      recordedAlertCount: 0,
    });

    for (const summary of [
      disabledSummary,
      noDataSummary,
      breachSummary,
      incompleteSummary,
      noBreachSummary,
    ]) {
      expect(summary.recordedAlertCount).toBe(0);
      expect(Number.isSafeInteger(summary.recordedAlertCount)).toBe(true);
      expect(summary.recordedAlertCount).toBeGreaterThanOrEqual(0);
    }
  });

  it("BREACH_DETECTED wins when breaches and missing points coexist", () => {
    const mixedResult = evaluateHealthThresholds(
      [
        thresholdSeries("crash_rate", [thresholdPoint("crash_rate", "2.00")]),
        thresholdSeries("anr_rate", []),
      ],
      twoRules,
    );
    const summary = toHealthCheckSummary(mixedResult);
    expect(summary).toEqual({
      status: "BREACH_DETECTED",
      enabledRuleCount: 2,
      evaluatedPointCount: 1,
      noDataCount: 1,
      breachedPointCount: mixedResult.breaches.length,
      recordedAlertCount: 0,
    });
    expect(summary.noDataCount).toBeGreaterThan(0);
    expect(summary.breachedPointCount).toBe(1);
  });

  it("enforces invariants I1-I9 and rejects unknown source status with fixed HealthError", () => {
    const validEvaluated = evaluateHealthThresholds(
      [thresholdSeries("crash_rate", [thresholdPoint("crash_rate", "2.00")])],
      oneRule,
    );
    const validNoData = evaluateHealthThresholds([thresholdSeries("crash_rate", [])], oneRule);
    const validNotBreached = evaluateHealthThresholds(
      [thresholdSeries("crash_rate", [thresholdPoint("crash_rate", "0.50")])],
      oneRule,
    );
    const breachEval = validEvaluated.breaches[0] as HealthThresholdBreach;
    const noDataEval = validNoData.evaluations[0] as HealthThresholdEvaluation;
    const okEval = validNotBreached.evaluations[0] as HealthThresholdEvaluation;

    // Unknown source status
    expectInconsistent({ ...validEvaluated, status: "UNKNOWN" });
    expectInconsistent(null);

    // I1: enabledRuleCount, evaluatedPointCount, noDataCount non-negative safe integers
    for (const field of ["enabledRuleCount", "evaluatedPointCount", "noDataCount"] as const) {
      for (const badCount of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        expectInconsistent({ ...validEvaluated, [field]: badCount });
      }
    }

    // I2: evaluations and breaches are arrays
    expectInconsistent({ ...validEvaluated, evaluations: null });
    expectInconsistent({ ...validEvaluated, breaches: {} });

    // I3: breaches.length <= evaluatedPointCount
    expectInconsistent({
      status: "EVALUATED",
      enabledRuleCount: 1,
      evaluatedPointCount: 1,
      noDataCount: 1,
      evaluations: [breachEval, breachEval],
      breaches: [breachEval, breachEval],
    });

    // I4: evaluatedPointCount + noDataCount === evaluations.length
    expectInconsistent({
      ...validEvaluated,
      evaluatedPointCount: 1,
      noDataCount: 1,
    });
    expectInconsistent({
      ...validEvaluated,
      evaluatedPointCount: 2,
      noDataCount: 0,
    });

    // I5: status DISABLED => enabledRuleCount === 0
    expectInconsistent({
      status: "DISABLED",
      enabledRuleCount: 1,
      evaluatedPointCount: 0,
      noDataCount: 0,
      evaluations: [],
      breaches: [],
    });

    // I6: status NO_DATA => enabledRuleCount > 0 AND evaluatedPointCount === 0
    expectInconsistent({
      status: "NO_DATA",
      enabledRuleCount: 0,
      evaluatedPointCount: 0,
      noDataCount: 1,
      evaluations: [noDataEval],
      breaches: [],
    });
    expectInconsistent({
      status: "NO_DATA",
      enabledRuleCount: 1,
      evaluatedPointCount: 1,
      noDataCount: 0,
      evaluations: [okEval],
      breaches: [],
    });

    // I7: status EVALUATED => evaluatedPointCount > 0
    expectInconsistent({
      status: "EVALUATED",
      enabledRuleCount: 1,
      evaluatedPointCount: 0,
      noDataCount: 1,
      evaluations: [noDataEval],
      breaches: [],
    });

    // I8: every breaches entry has status === "BREACHED"
    expectInconsistent({
      status: "EVALUATED",
      enabledRuleCount: 1,
      evaluatedPointCount: 1,
      noDataCount: 0,
      evaluations: [okEval],
      breaches: [okEval as unknown as HealthThresholdBreach],
    });
    expectInconsistent({
      status: "EVALUATED",
      enabledRuleCount: 1,
      evaluatedPointCount: 1,
      noDataCount: 0,
      evaluations: [okEval],
      breaches: [null as unknown as HealthThresholdBreach],
    });

    // I9: produced summary.recordedAlertCount is a non-negative safe integer (0)
    const produced = toHealthCheckSummary(validEvaluated);
    expect(produced.recordedAlertCount).toBe(0);
    expect(Number.isSafeInteger(produced.recordedAlertCount)).toBe(true);
    expect(produced.recordedAlertCount).toBeGreaterThanOrEqual(0);
  });
});

describe("Phase 5.4 WP2a-2 createHealthSummarySource read-only provider", () => {
  it("produces BREACH_DETECTED and INCOMPLETE_DATA with recordedAlertCount 0", async () => {
    const rules = buildHealthThresholdRules(
      thresholdConfig({
        crashRateReportedThreshold: "1.00",
        anrRateReportedThreshold: "0.50",
      }),
    );

    const breachingSource = createHealthSummarySource({
      rules,
      gateway: fakeGateway({ crash_rate: "2.00", anr_rate: null }),
    });
    const breachSummary = await breachingSource.readSummary(DAILY_INPUT);
    expect(breachSummary).toEqual({
      status: "BREACH_DETECTED",
      enabledRuleCount: 2,
      evaluatedPointCount: 1,
      noDataCount: 1,
      breachedPointCount: 1,
      recordedAlertCount: 0,
    });

    const incompleteSource = createHealthSummarySource({
      rules,
      gateway: fakeGateway({ crash_rate: "0.50", anr_rate: null }),
    });
    const incompleteSummary = await incompleteSource.readSummary(DAILY_INPUT);
    expect(incompleteSummary).toEqual({
      status: "INCOMPLETE_DATA",
      enabledRuleCount: 2,
      evaluatedPointCount: 1,
      noDataCount: 1,
      breachedPointCount: 0,
      recordedAlertCount: 0,
    });
  });

  it("never writes audit files or calls appendAuditEntry on breach", async () => {
    const { dir, path } = createTempAuditTarget();
    const health = thresholdConfig({ crashRateReportedThreshold: "1.00" });
    const rules = buildHealthThresholdRules(health);
    const gateway = fakeGateway("2.00");

    const source = createHealthSummarySource({ rules, gateway });
    const summary = await source.readSummary(DAILY_INPUT);
    expect(summary).toEqual({
      status: "BREACH_DETECTED",
      enabledRuleCount: 1,
      evaluatedPointCount: 1,
      noDataCount: 0,
      breachedPointCount: 1,
      recordedAlertCount: 0,
    });
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    expect(appendAuditEntry).not.toHaveBeenCalled();

    // Positive control: legacy threshold tool calls appendAuditEntry and writes the durable alert.
    const { tool } = createHealthThresholdTool({
      health,
      gateway,
      auditLogPath: path,
    });
    const toolResult = await tool.execute(THRESHOLD_QUERY, {});
    expect(toolResult.recordedAlertCount).toBe(1);
    expect(appendAuditEntry).toHaveBeenCalledTimes(1);
    expect(existsSync(path)).toBe(true);
    expect(readAuditEntries(path)).toHaveLength(1);
  });

  it("G2: rejects HOURLY before fetch when excessive_wakeup_rate is enabled", async () => {
    const readMetricSet = vi.fn(async () => ({}));
    const queryMetricSet = vi.fn(async () => ({ rows: [] }));
    const gateway: HealthMetricGateway = { readMetricSet, queryMetricSet };

    const rules = buildHealthThresholdRules(
      thresholdConfig({
        crashRateReportedThreshold: "1.00",
        excessiveWakeupRateReportedThreshold: "2.00",
      }),
    );
    const source = createHealthSummarySource({ rules, gateway });
    const expectedMessage = [
      "Health check granularity HOURLY is not supported by",
      "enabled threshold metric kind(s): excessive_wakeup_rate.",
    ].join(" ");

    let caught: unknown;
    try {
      await source.readSummary(HOURLY_INPUT);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HealthError);
    expect(caught).toBeInstanceOf(UnsupportedThresholdGranularityError);
    expect(caught).toMatchObject({
      message: expectedMessage,
      code: "INVALID_ARGUMENT",
    });
    if (caught instanceof UnsupportedThresholdGranularityError) {
      expect(caught.granularity).toBe("HOURLY");
      expect(caught.metricKinds).toEqual(["excessive_wakeup_rate"]);
      expect(caught.message).toBe(
        [
          "Health check granularity HOURLY is not supported by",
          "enabled threshold metric kind(s): excessive_wakeup_rate.",
        ].join(" "),
      );
    }
    expect(readMetricSet).not.toHaveBeenCalled();
    expect(queryMetricSet).not.toHaveBeenCalled();
  });

  it("G2: accepts HOURLY for crash/anr rules and returns DISABLED for zero rules", async () => {
    const hourlyRules = buildHealthThresholdRules(
      thresholdConfig({
        crashRateReportedThreshold: "1.00",
        anrRateReportedThreshold: "0.50",
      }),
    );
    const hourlySource = createHealthSummarySource({
      rules: hourlyRules,
      gateway: fakeGateway("0.10"),
    });
    const hourlySummary = await hourlySource.readSummary(HOURLY_INPUT);
    expect(hourlySummary).toEqual({
      status: "NO_BREACH_OBSERVED",
      enabledRuleCount: 2,
      evaluatedPointCount: 2,
      noDataCount: 0,
      breachedPointCount: 0,
      recordedAlertCount: 0,
    });

    const readMetricSet = vi.fn(async () => ({}));
    const queryMetricSet = vi.fn(async () => ({ rows: [] }));
    const disabledSource = createHealthSummarySource({
      rules: buildHealthThresholdRules(thresholdConfig()),
      gateway: { readMetricSet, queryMetricSet },
    });
    const disabledHourly = await disabledSource.readSummary(HOURLY_INPUT);
    expect(disabledHourly).toEqual({
      status: "DISABLED",
      enabledRuleCount: 0,
      evaluatedPointCount: 0,
      noDataCount: 0,
      breachedPointCount: 0,
      recordedAlertCount: 0,
    });
    expect(readMetricSet).not.toHaveBeenCalled();
    expect(queryMetricSet).not.toHaveBeenCalled();
  });

  it("returns DISABLED with zero gateway calls when zero rules are active", async () => {
    const readMetricSet = vi.fn(async () => ({}));
    const queryMetricSet = vi.fn(async () => ({ rows: [] }));
    const source = createHealthSummarySource({
      rules: buildHealthThresholdRules(thresholdConfig()),
      gateway: { readMetricSet, queryMetricSet },
    });

    const summary = await source.readSummary(DAILY_INPUT);
    expect(summary).toEqual({
      status: "DISABLED",
      enabledRuleCount: 0,
      evaluatedPointCount: 0,
      noDataCount: 0,
      breachedPointCount: 0,
      recordedAlertCount: 0,
    });
    expect(readMetricSet).not.toHaveBeenCalled();
    expect(queryMetricSet).not.toHaveBeenCalled();
  });

  it("passes parsed HealthCheckInput with dimensions through runHealthCheckCli seam", async () => {
    const rules = buildHealthThresholdRules(
      thresholdConfig({ crashRateReportedThreshold: "1.00" }),
    );
    const source = createHealthSummarySource({
      rules,
      gateway: {
        readMetricSet: async () => ({}),
        queryMetricSet: async (kind, request) => ({
          rows: [
            {
              ...rawRow(kind, request, "0.50"),
              dimensions: [
                { dimension: "countryCode", stringValue: "US" },
                { dimension: "apiLevel", int64Value: "34" },
              ],
            },
          ],
        }),
      },
    });
    const readSummary = vi.fn(async (input: HealthCheckInput) => source.readSummary(input));
    const captured = createCapturedIo();

    const exitCode = await runHealthCheckCli(
      [
        "--start",
        THRESHOLD_QUERY.startTime,
        "--end",
        THRESHOLD_QUERY.endTime,
        "--granularity",
        "DAILY",
        "--dimensions",
        "countryCode,apiLevel",
        "--json",
      ],
      captured.io,
      { readSummary },
    );

    expect(exitCode).toBe(0);
    expect(readSummary).toHaveBeenCalledTimes(1);
    expect(readSummary).toHaveBeenCalledWith({
      startTime: THRESHOLD_QUERY.startTime,
      endTime: THRESHOLD_QUERY.endTime,
      granularity: "DAILY",
      dimensions: ["countryCode", "apiLevel"],
    });
    expect(captured.errors).toEqual([]);
  });

  it("handles provider errors in runHealthCheckCli without leaking sensitive details", async () => {
    const sentinel = "SENTINEL-SECRET-CREDENTIAL-98765";
    const captured = createCapturedIo();
    const exitCode = await runHealthCheckCli(
      [
        "--start",
        THRESHOLD_QUERY.startTime,
        "--end",
        THRESHOLD_QUERY.endTime,
        "--granularity",
        "DAILY",
      ],
      captured.io,
      {
        readSummary: async () => {
          throw new Error(`Auth failed for ${sentinel}`);
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(captured.writes).toEqual([]);
    expect(captured.errors).toEqual(["Health check runtime summary could not be produced.\n"]);
    expect(captured.errors.join("")).not.toContain(sentinel);
    expect(captured.writes.join("")).not.toContain(sentinel);

    const rules = buildHealthThresholdRules(
      thresholdConfig({ excessiveWakeupRateReportedThreshold: "1.00" }),
    );
    const source = createHealthSummarySource({
      rules,
      gateway: fakeGateway("2.00"),
    });
    let g2Error: unknown;
    try {
      await source.readSummary(HOURLY_INPUT);
    } catch (error) {
      g2Error = error;
    }
    expect(g2Error).toBeInstanceOf(HealthError);
    expect((g2Error as Error).message).not.toContain(sentinel);
    expect((g2Error as Error).message).not.toContain("1.00");
  });

  it("preserves parity between evaluateThresholdWindow, tool.execute and provider", async () => {
    const { path } = createTempAuditTarget();
    const health = thresholdConfig({
      crashRateReportedThreshold: "1.00",
      anrRateReportedThreshold: "0.50",
    });
    const rules = buildHealthThresholdRules(health);
    const gateway = fakeGateway({ crash_rate: "2.00", anr_rate: "0.20" });

    const windowResult = await evaluateThresholdWindow({ rules, gateway }, DAILY_INPUT);
    const { tool } = createHealthThresholdTool({
      health,
      gateway,
      auditLogPath: path,
    });
    const toolResult = await tool.execute(THRESHOLD_QUERY, {});
    const { recordedAlertCount, ...toolCore } = toolResult;

    expect(toolCore).toEqual(windowResult);
    expect(recordedAlertCount).toBe(windowResult.breaches.length);
    expect(recordedAlertCount).toBe(1);
    expect(readAuditEntries(path)).toHaveLength(1);

    const summary = await createHealthSummarySource({ rules, gateway }).readSummary(DAILY_INPUT);
    expect(summary).toEqual({
      status: "BREACH_DETECTED",
      enabledRuleCount: windowResult.enabledRuleCount,
      evaluatedPointCount: windowResult.evaluatedPointCount,
      noDataCount: windowResult.noDataCount,
      breachedPointCount: windowResult.breaches.length,
      recordedAlertCount: 0,
    });
  });
});

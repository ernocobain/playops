/**
 * Phase 5.2 — baseline comparison analyzer tests, driven by the FAKE fixtures in
 * tests/fixtures/health/comparison.fake.ts.
 *
 * Rows are normalized through the REAL Phase 5.1 validator/normalizer, so these
 * tests also pin the 5.1 → 5.2 composition contract.
 */
import { describe, expect, it } from "vitest";
import { HealthError } from "../src/health/errors.js";
import {
  analyzeHealthComparison,
  healthPeriodCount,
  HEALTH_CHANGE_DIRECTIONS,
  HEALTH_COMPARISON_REASONS,
  HEALTH_COMPARISON_TOOL_NAME,
  type HealthComparison,
  type HealthComparisonEntry,
  type HealthComparisonValue,
} from "../src/health/comparison.js";
import {
  HEALTH_METRIC_SPECS,
  normalizeHealthRows,
  validateHealthMetricQuery,
  type HealthDimension,
  type HealthGranularity,
  type HealthMetricKind,
  type HealthMetricName,
  type HealthMetricSeries,
} from "../src/health/index.js";
import { rowsFor, SCENARIO_FRESHNESS, scenarioByName } from "./fixtures/health/comparison.fake.js";

interface FixturePair {
  readonly name: string;
  readonly current: HealthMetricSeries;
  readonly baseline: HealthMetricSeries;
}

function buildSeries(name: string, side: "current" | "baseline"): HealthMetricSeries {
  const scenario = scenarioByName(name);
  const window = scenario[side];
  const query = validateHealthMetricQuery({
    kind: scenario.kind,
    granularity: scenario.granularity,
    startTime: window.startTime,
    endTime: window.endTime,
    dimensions: scenario.dimensions,
    metrics: scenario.metrics,
  });
  const points = normalizeHealthRows(rowsFor(name, side), query);
  const latest = (SCENARIO_FRESHNESS[name] ?? SCENARIO_FRESHNESS["default"] ?? [])[0];
  return {
    kind: scenario.kind,
    toolName: query.toolName,
    window: query.window,
    dimensions: query.dimensions,
    metrics: query.metrics,
    freshness:
      latest === undefined
        ? []
        : [{ aggregationPeriod: scenario.granularity, latestEndTimeUtc: latest }],
    points,
    pageCount: 1,
    rowCount: points.length,
  };
}

function fixture(name: string): FixturePair {
  return {
    name,
    current: buildSeries(name, "current"),
    baseline: buildSeries(name, "baseline"),
  };
}

function analyzeFixture(name: string): HealthComparison {
  const pair = fixture(name);
  return analyzeHealthComparison({ current: [pair.current], baseline: [pair.baseline] });
}

function firstEntry(comparison: HealthComparison): HealthComparisonEntry {
  const entry = comparison.sections[0]?.entries[0];
  if (!entry) throw new Error("fixture produced no comparison entry");
  return entry;
}

function firstValue(comparison: HealthComparison): HealthComparisonValue {
  const value = firstEntry(comparison).values[0];
  if (!value) throw new Error("fixture produced no comparison value");
  return value;
}

function seriesFor(
  kind: HealthMetricKind,
  granularity: HealthGranularity,
  dimensions: readonly HealthDimension[],
  metrics: readonly HealthMetricName[],
  window: { readonly startTime: string; readonly endTime: string },
  rows: readonly Record<string, unknown>[],
): HealthMetricSeries {
  const query = validateHealthMetricQuery({
    kind,
    granularity,
    startTime: window.startTime,
    endTime: window.endTime,
    dimensions: [...dimensions],
    metrics: [...metrics],
  });
  const points = normalizeHealthRows(rows, query);
  return {
    kind,
    toolName: query.toolName,
    window: query.window,
    dimensions: query.dimensions,
    metrics: query.metrics,
    freshness: [],
    points,
    pageCount: 1,
    rowCount: points.length,
  };
}

const DAY_23 = { startTime: "2026-09-23T07:00:00Z", endTime: "2026-09-24T07:00:00Z" };
const DAY_24 = { startTime: "2026-09-24T07:00:00Z", endTime: "2026-09-25T07:00:00Z" };

function expectIncompatible(mutate: {
  readonly current?: HealthMetricSeries;
  readonly baseline?: HealthMetricSeries;
}): void {
  const base = fixture("crash-increase");
  try {
    analyzeHealthComparison({
      current: [mutate.current ?? base.current],
      baseline: [mutate.baseline ?? base.baseline],
    });
    expect.unreachable("expected INCOMPATIBLE_WINDOWS");
  } catch (error) {
    expect(error).toBeInstanceOf(HealthError);
    expect((error as HealthError).code).toBe("INCOMPATIBLE_WINDOWS");
  }
}

describe("Phase 5.2 comparison analyzer", () => {
  it("compares a single aligned DAILY point and computes exact deltas", () => {
    const comparison = analyzeFixture("crash-increase");
    const entry = firstEntry(comparison);

    expect(comparison.toolName).toBe(HEALTH_COMPARISON_TOOL_NAME);
    expect(comparison.kinds).toEqual(["crash_rate"]);
    expect(comparison.granularity).toBe("DAILY");
    expect(comparison.current).toEqual({
      startTimeUtc: "2026-09-24T07:00:00Z",
      endTimeUtc: "2026-09-25T07:00:00Z",
      granularity: "DAILY",
    });
    expect(comparison.baseline).toEqual({
      startTimeUtc: "2026-09-23T07:00:00Z",
      endTimeUtc: "2026-09-24T07:00:00Z",
      granularity: "DAILY",
    });
    expect(entry.dimensionKey).toBe("");
    expect(entry.dimensions).toEqual([]);
    expect(entry.periodIndex).toBe(0);
    expect(entry.currentStartTimeUtc).toBe("2026-09-24T07:00:00Z");
    expect(entry.baselineStartTimeUtc).toBe("2026-09-23T07:00:00Z");
    expect(entry.values).toEqual([
      {
        metric: "crashRate",
        unit: "percent",
        currentValue: "0.0155",
        baselineValue: "0.0123",
        absoluteDelta: "0.0032",
        relativeDeltaPercent: "+26.0163",
        direction: "increased",
        reason: "comparable",
      },
    ]);
    expect(comparison.entryCount).toBe(1);
    expect(comparison.comparedValueCount).toBe(1);
    expect(comparison.unavailableValueCount).toBe(0);
    expect(Object.isFrozen(comparison)).toBe(true);
    expect(Object.isFrozen(entry.values)).toBe(true);
  });

  it("reports decreases with an exact negative delta", () => {
    const value = firstValue(analyzeFixture("crash-decrease"));
    expect(value.direction).toBe("decreased");
    expect(value.absoluteDelta).toBe("-0.0035");
    expect(value.relativeDeltaPercent).toBe("-28.4553");
    expect(value.reason).toBe("comparable");
  });

  it("reports unchanged rates without a spurious change", () => {
    const value = firstValue(analyzeFixture("crash-unchanged"));
    expect(value.direction).toBe("unchanged");
    expect(value.absoluteDelta).toBe("0");
    expect(value.relativeDeltaPercent).toBe("0");
    expect(value.reason).toBe("comparable");
  });

  it("compares every aligned period of a multi-period ANR window", () => {
    const comparison = analyzeFixture("anr-increase-multi-period");
    const entries = comparison.sections[0]?.entries ?? [];

    expect(entries.map((entry) => entry.periodIndex)).toEqual([0, 1]);
    expect(entries.map((entry) => entry.values[0]?.absoluteDelta)).toEqual(["0.0002", "0.0004"]);
    expect(entries.every((entry) => entry.values[0]?.direction === "increased")).toBe(true);
    expect(comparison.entryCount).toBe(2);
    expect(comparison.comparedValueCount).toBe(2);
  });

  it("compares excessive wakeups and an hourly window the same way", () => {
    const wakeups = firstValue(analyzeFixture("excessive-wakeups-change"));
    expect(wakeups.metric).toBe("excessiveWakeupRate");
    expect(wakeups.direction).toBe("decreased");
    expect(wakeups.absoluteDelta).toBe("-0.03");
    expect(wakeups.relativeDeltaPercent).toBe("-60");

    const hourly = analyzeFixture("hourly-multi-period");
    expect(hourly.granularity).toBe("HOURLY");
    expect(hourly.sections[0]?.entries.map((entry) => entry.periodIndex)).toEqual([0, 1]);
    expect(hourly.sections[0]?.entries.map((entry) => entry.currentStartTimeUtc)).toEqual([
      "2026-09-24T00:00:00Z",
      "2026-09-24T01:00:00Z",
    ]);
  });

  it("keeps a zero baseline comparable but leaves the relative delta undefined", () => {
    const zeroToZero = firstValue(analyzeFixture("baseline-zero-current-zero"));
    // Reported values are preserved exactly as the API returned them ("0.000" stays "0.000").
    expect(zeroToZero).toMatchObject({
      currentValue: "0",
      baselineValue: "0.000",
      absoluteDelta: "0",
      direction: "unchanged",
      reason: "baseline-zero",
    });
    expect(zeroToZero.relativeDeltaPercent).toBeUndefined();

    const zeroToPositive = firstValue(analyzeFixture("baseline-zero-current-positive"));
    expect(zeroToPositive).toMatchObject({
      currentValue: "0.0012",
      baselineValue: "0",
      absoluteDelta: "0.0012",
      direction: "increased",
      reason: "baseline-zero",
    });
    expect(zeroToPositive.relativeDeltaPercent).toBeUndefined();
    expect(JSON.stringify(zeroToPositive)).not.toContain("Infinity");
    expect(JSON.stringify(zeroToPositive)).not.toContain("NaN");
  });

  it("marks an empty current window unavailable rather than zero", () => {
    const comparison = analyzeFixture("current-window-empty");
    const values = firstEntry(comparison).values;

    expect(values.map((value) => value.metric)).toEqual(["crashRate", "distinctUsers"]);
    for (const value of values) {
      expect(value.reason).toBe("current-unavailable");
      expect(value.direction).toBe("incomparable");
      expect(value.currentValue).toBeUndefined();
      expect(value.absoluteDelta).toBeUndefined();
      expect(value.relativeDeltaPercent).toBeUndefined();
    }
    expect(values[0]?.baselineValue).toBe("0.0123");
    expect(firstEntry(comparison).currentStartTimeUtc).toBeUndefined();
    expect(firstEntry(comparison).baselineStartTimeUtc).toBe("2026-09-23T07:00:00Z");
    expect(comparison.comparedValueCount).toBe(0);
    expect(comparison.unavailableValueCount).toBe(2);
  });

  it("marks an empty baseline window unavailable rather than zero", () => {
    const comparison = analyzeFixture("baseline-window-empty");
    const values = firstEntry(comparison).values;
    for (const value of values) {
      expect(value.reason).toBe("baseline-unavailable");
      expect(value.direction).toBe("incomparable");
      expect(value.baselineValue).toBeUndefined();
    }
    expect(firstEntry(comparison).baselineStartTimeUtc).toBeUndefined();

    const bothEmpty = analyzeFixture("both-windows-empty");
    const entry = firstEntry(bothEmpty);
    expect(entry.periodIndex).toBeNull();
    expect(entry.dimensionKey).toBe("");
    expect(entry.currentStartTimeUtc).toBeUndefined();
    expect(entry.baselineStartTimeUtc).toBeUndefined();
    expect(entry.values.map((value) => value.reason)).toEqual(["both-unavailable"]);
    expect(bothEmpty.unavailableValueCount).toBe(1);
  });

  it("never compares dimension groups that exist on only one side", () => {
    const currentOnly = analyzeFixture("current-only-dimension-group");
    const entries = currentOnly.sections[0]?.entries ?? [];

    expect(entries.map((entry) => entry.dimensionKey)).toEqual([
      "deviceModel=google/coral",
      "deviceModel=google/panther",
    ]);
    expect(entries[0]?.values[0]).toMatchObject({
      currentValue: "0.02",
      direction: "incomparable",
      reason: "baseline-unavailable",
    });
    expect(entries[1]?.values[0]).toMatchObject({
      baselineValue: "0.01",
      direction: "incomparable",
      reason: "current-unavailable",
    });
    expect(currentOnly.comparedValueCount).toBe(0);

    const baselineOnly = analyzeFixture("baseline-only-dimension-group");
    expect(baselineOnly.sections[0]?.entries.map((entry) => entry.values[0]?.reason)).toEqual([
      "current-unavailable",
      "baseline-unavailable",
    ]);
  });

  it("canonicalizes dimension identity order-independently and orders entries deterministically", () => {
    const comparison = analyzeFixture("multiple-dimension-groups");
    const entries = comparison.sections[0]?.entries ?? [];

    // Current rows list versionCode before countryCode; baseline rows list the
    // reverse. Canonical keys must still pair them.
    expect(entries.map((entry) => `${entry.dimensionKey}#${entry.periodIndex}`)).toEqual([
      "countryCode=ID|versionCode=374#0",
      "countryCode=ID|versionCode=374#1",
      "countryCode=US|versionCode=375#0",
      "countryCode=US|versionCode=375#1",
    ]);
    expect(entries.every((entry) => entry.values[0]?.reason === "comparable")).toBe(true);
    // ID/374 increases by +0.01 then +0.02; US/375 falls by -0.01 then is unchanged.
    expect(entries.map((entry) => entry.values[0]?.absoluteDelta)).toEqual([
      "0.01",
      "0.02",
      "-0.01",
      "0",
    ]);
    expect(
      entries[0]?.dimensions.map((dimension) => `${dimension.name}=${dimension.value}`),
    ).toEqual(["countryCode=ID", "versionCode=374"]);
    expect(entries[0]?.dimensions.map((dimension) => dimension.valueType)).toEqual([
      "string",
      "int64",
    ]);
    expect(comparison.dimensions).toEqual(["countryCode", "versionCode"]);
  });

  it("preserves precision far beyond JS floating point", () => {
    const value = firstValue(analyzeFixture("beyond-js-float-precision"));
    expect(value.absoluteDelta).toBe("0.000000000000000000000000000001");
    expect(value.relativeDeltaPercent).toBe("+8.1E-28");
    expect(value.direction).toBe("increased");
  });

  it("surfaces freshness facts without treating them as an error or an anomaly", () => {
    const lagging = analyzeFixture("freshness-lag");
    expect(lagging.sections[0]?.currentBeyondFreshness).toBe(true);
    expect(lagging.sections[0]?.baselineBeyondFreshness).toBe(false);
    expect(lagging.sections[0]?.freshness).toEqual([
      { aggregationPeriod: "DAILY", latestEndTimeUtc: "2026-09-24T07:00:00Z" },
    ]);
    // The comparison itself still succeeds.
    expect(lagging.comparedValueCount).toBe(1);

    const fresh = analyzeFixture("crash-increase");
    expect(fresh.sections[0]?.currentBeyondFreshness).toBe(false);
    expect(fresh.sections[0]?.baselineBeyondFreshness).toBe(false);
  });

  it("is deterministic for identical input", () => {
    const first = analyzeFixture("multiple-dimension-groups");
    const second = analyzeFixture("multiple-dimension-groups");
    expect(JSON.parse(JSON.stringify(second))).toEqual(JSON.parse(JSON.stringify(first)));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("does not mutate the caller's series", () => {
    const pair = fixture("anr-increase-multi-period");
    const snapshot = JSON.stringify({ current: pair.current, baseline: pair.baseline });
    analyzeHealthComparison({ current: [pair.current], baseline: [pair.baseline] });
    expect(JSON.stringify({ current: pair.current, baseline: pair.baseline })).toBe(snapshot);
  });

  it("carries no threshold, severity or alert policy", () => {
    const comparison = analyzeFixture("crash-increase");
    const value = firstValue(comparison);

    expect([...HEALTH_CHANGE_DIRECTIONS]).toEqual([
      "increased",
      "decreased",
      "unchanged",
      "incomparable",
    ]);
    expect([...HEALTH_COMPARISON_REASONS]).toEqual([
      "comparable",
      "baseline-zero",
      "current-unavailable",
      "baseline-unavailable",
      "both-unavailable",
    ]);
    expect(Object.keys(value).sort()).toEqual([
      "absoluteDelta",
      "baselineValue",
      "currentValue",
      "direction",
      "metric",
      "reason",
      "relativeDeltaPercent",
      "unit",
    ]);
    const serialized = JSON.stringify(comparison);
    for (const forbidden of ["threshold", "severity", "alert", "critical", "anomaly"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("requires equal-duration, same-shape windows", () => {
    expect(
      healthPeriodCount({
        startTimeUtc: "2026-09-23T07:00:00Z",
        endTimeUtc: "2026-09-24T07:00:00Z",
        granularity: "DAILY",
      }),
    ).toBe(1);
    expect(
      healthPeriodCount({
        startTimeUtc: "2026-09-23T07:00:00Z",
        endTimeUtc: "2026-09-25T07:00:00Z",
        granularity: "DAILY",
      }),
    ).toBe(2);
    expect(
      healthPeriodCount({
        startTimeUtc: "2026-09-23T00:00:00Z",
        endTimeUtc: "2026-09-23T03:00:00Z",
        granularity: "HOURLY",
      }),
    ).toBe(3);

    const base = fixture("crash-increase");

    // Unequal duration.
    expectIncompatible({
      baseline: seriesFor(
        "crash_rate",
        "DAILY",
        [],
        ["crashRate"],
        {
          startTime: "2026-09-22T07:00:00Z",
          endTime: "2026-09-24T07:00:00Z",
        },
        [
          {
            aggregationPeriod: "DAILY",
            startTime: { year: 2026, month: 9, day: 22, timeZone: { id: "America/Los_Angeles" } },
            dimensions: [],
            metrics: [{ metric: "crashRate", decimalValue: { value: "0.01" } }],
          },
        ],
      ),
    });

    // Mismatched granularity.
    expectIncompatible({
      baseline: seriesFor(
        "crash_rate",
        "HOURLY",
        [],
        ["crashRate"],
        {
          startTime: "2026-09-23T07:00:00Z",
          endTime: "2026-09-23T08:00:00Z",
        },
        [
          {
            aggregationPeriod: "HOURLY",
            startTime: { year: 2026, month: 9, day: 23, hours: 7, timeZone: { id: "UTC" } },
            dimensions: [],
            metrics: [{ metric: "crashRate", decimalValue: { value: "0.01" } }],
          },
        ],
      ),
    });

    // Mismatched metric names.
    expectIncompatible({
      baseline: seriesFor("crash_rate", "DAILY", [], ["crashRate", "distinctUsers"], DAY_23, [
        {
          aggregationPeriod: "DAILY",
          startTime: { year: 2026, month: 9, day: 23, timeZone: { id: "America/Los_Angeles" } },
          dimensions: [],
          metrics: [
            { metric: "crashRate", decimalValue: { value: "0.01" } },
            { metric: "distinctUsers", decimalValue: { value: "10" } },
          ],
        },
      ]),
    });

    // Mismatched dimension sets.
    expectIncompatible({
      baseline: seriesFor("crash_rate", "DAILY", ["countryCode"], ["crashRate"], DAY_23, [
        {
          aggregationPeriod: "DAILY",
          startTime: { year: 2026, month: 9, day: 23, timeZone: { id: "America/Los_Angeles" } },
          dimensions: [{ dimension: "countryCode", stringValue: "ID" }],
          metrics: [{ metric: "crashRate", decimalValue: { value: "0.01" } }],
        },
      ]),
    });

    // Different metric kinds cannot be paired at all.
    try {
      analyzeHealthComparison({
        current: [base.current],
        baseline: [
          seriesFor("anr_rate", "DAILY", [], ["anrRate"], DAY_23, [
            {
              aggregationPeriod: "DAILY",
              startTime: { year: 2026, month: 9, day: 23, timeZone: { id: "America/Los_Angeles" } },
              dimensions: [],
              metrics: [{ metric: "anrRate", decimalValue: { value: "0.01" } }],
            },
          ]),
        ],
      });
      expect.unreachable("expected INCOMPATIBLE_WINDOWS");
    } catch (error) {
      expect((error as HealthError).code).toBe("INCOMPATIBLE_WINDOWS");
    }

    // Missing baseline side entirely.
    expect(() => analyzeHealthComparison({ current: [base.current], baseline: [] })).toThrowError(
      HealthError,
    );
    expect(HEALTH_METRIC_SPECS.crash_rate.primaryMetric).toBe("crashRate");
    expect(DAY_24.startTime).toBe("2026-09-24T07:00:00Z");
  });

  it("rejects malformed decimal values and duplicate identities", () => {
    const base = fixture("crash-increase");
    const malformed = {
      ...base.current,
      points: [
        {
          startTimeUtc: "2026-09-24T07:00:00Z",
          aggregationPeriod: "DAILY" as const,
          dimensions: [],
          metrics: [{ metric: "crashRate" as const, value: "abc", unit: "percent" as const }],
        },
      ],
    };
    try {
      analyzeHealthComparison({ current: [malformed], baseline: [base.baseline] });
      expect.unreachable("expected INVALID_DECIMAL");
    } catch (error) {
      expect((error as HealthError).code).toBe("INVALID_DECIMAL");
    }

    const duplicated = (() => {
      const firstPoint = base.current.points[0];
      if (!firstPoint) throw new Error("fixture point missing");
      return { ...base.current, points: [firstPoint, firstPoint] };
    })();
    try {
      analyzeHealthComparison({ current: [duplicated], baseline: [base.baseline] });
      expect.unreachable("expected DUPLICATE_IDENTITY");
    } catch (error) {
      expect((error as HealthError).code).toBe("DUPLICATE_IDENTITY");
    }
  });

  it("rejects points that fall outside their own window", () => {
    const base = fixture("crash-increase");
    const outside = {
      ...base.current,
      points: [
        {
          startTimeUtc: "2026-09-30T07:00:00Z",
          aggregationPeriod: "DAILY" as const,
          dimensions: [],
          metrics: [{ metric: "crashRate" as const, value: "0.02", unit: "percent" as const }],
        },
      ],
    };
    try {
      analyzeHealthComparison({ current: [outside], baseline: [base.baseline] });
      expect.unreachable("expected REMOTE_DATA_INVALID");
    } catch (error) {
      expect((error as HealthError).code).toBe("REMOTE_DATA_INVALID");
    }
  });
});

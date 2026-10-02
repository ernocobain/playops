/**
 * Phase 5.1 — Reporting time-window and query validation tests.
 *
 * Pure validation only: no network, no Google client, no credentials.
 */
import { describe, expect, it } from "vitest";
import { HealthError } from "../src/health/errors.js";
import {
  HEALTH_DIMENSIONS,
  HEALTH_METRIC_SPECS,
  validateHealthMetricQuery,
  type HealthMetricQuery,
} from "../src/health/index.js";

/** 2026-09-01 00:00 America/Los_Angeles (PDT, UTC-7). */
const DAILY_WINDOW = {
  kind: "crash_rate",
  granularity: "DAILY",
  startTime: "2026-09-01T07:00:00Z",
  endTime: "2026-09-08T07:00:00Z",
} satisfies HealthMetricQuery;

function expectInvalid(code: string, input: HealthMetricQuery): HealthError {
  try {
    validateHealthMetricQuery(input);
  } catch (error) {
    expect(error).toBeInstanceOf(HealthError);
    expect((error as HealthError).code).toBe(code);
    return error as HealthError;
  }
  expect.unreachable("expected validation to fail");
}

describe("Phase 5.1 time-window validation", () => {
  it("accepts a DAILY window aligned to local midnight and freezes the normalized result", () => {
    const validated = validateHealthMetricQuery(DAILY_WINDOW);

    expect(validated.kind).toBe("crash_rate");
    expect(validated.window).toEqual({
      startTimeUtc: "2026-09-01T07:00:00Z",
      endTimeUtc: "2026-09-08T07:00:00Z",
      granularity: "DAILY",
    });
    // DAILY boundaries carry date fields only; the Google request deliberately omits
    // the timezone so the documented metric-set default (America/Los_Angeles) applies.
    expect(validated.timelineSpec.startTime).toEqual({ year: 2026, month: 9, day: 1 });
    expect(validated.timelineSpec.endTime).toEqual({ year: 2026, month: 9, day: 8 });
    expect(validated.timelineSpec.aggregationPeriod).toBe("DAILY");
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.window)).toBe(true);
    expect(Object.isFrozen(validated.dimensions)).toBe(true);
    expect(Object.isFrozen(validated.metrics)).toBe(true);
  });

  it("resolves the DAILY aggregation timezone correctly across a DST transition", () => {
    // 2026-11-01 09:00Z is the PDT→PST transition; 07:00Z is still PDT.
    const beforeChange = validateHealthMetricQuery({
      ...DAILY_WINDOW,
      startTime: "2026-11-01T07:00:00Z",
      endTime: "2026-11-02T08:00:00Z",
    });
    expect(beforeChange.timelineSpec.startTime).toEqual({ year: 2026, month: 11, day: 1 });
    expect(beforeChange.timelineSpec.endTime).toEqual({ year: 2026, month: 11, day: 2 });

    // Same instant one day later is PST (UTC-8): 08:00Z is local midnight.
    const afterChange = validateHealthMetricQuery({
      ...DAILY_WINDOW,
      startTime: "2026-11-02T08:00:00Z",
      endTime: "2026-11-03T08:00:00Z",
    });
    expect(afterChange.timelineSpec.startTime).toEqual({ year: 2026, month: 11, day: 2 });

    // 07:00Z on 2026-11-02 is 23:00 local on 2026-11-01 → not a local-midnight boundary.
    expectInvalid("INVALID_ARGUMENT", {
      ...DAILY_WINDOW,
      startTime: "2026-11-02T07:00:00Z",
      endTime: "2026-11-03T08:00:00Z",
    });
  });

  it("uses explicit UTC hour boundaries for HOURLY windows", () => {
    const validated = validateHealthMetricQuery({
      kind: "crash_rate",
      granularity: "HOURLY",
      startTime: "2026-09-01T00:00:00Z",
      endTime: "2026-09-01T06:00:00Z",
    });

    expect(validated.window.granularity).toBe("HOURLY");
    expect(validated.timelineSpec.startTime).toEqual({
      year: 2026,
      month: 9,
      day: 1,
      hours: 0,
      timeZoneId: "UTC",
    });
    expect(validated.timelineSpec.endTime).toEqual({
      year: 2026,
      month: 9,
      day: 1,
      hours: 6,
      timeZoneId: "UTC",
    });
  });

  it("rejects HOURLY windows that are not aligned to the start of an hour", () => {
    expectInvalid("INVALID_ARGUMENT", {
      kind: "anr_rate",
      granularity: "HOURLY",
      startTime: "2026-09-01T00:30:00Z",
      endTime: "2026-09-01T06:00:00Z",
    });
    expectInvalid("INVALID_ARGUMENT", {
      kind: "anr_rate",
      granularity: "HOURLY",
      startTime: "2026-09-01T00:00:00Z",
      endTime: "2026-09-01T06:10:00Z",
    });
  });

  it("rejects start == end and start > end", () => {
    expectInvalid("INVALID_ARGUMENT", {
      ...DAILY_WINDOW,
      startTime: "2026-09-01T07:00:00Z",
      endTime: "2026-09-01T07:00:00Z",
    });
    expectInvalid("INVALID_ARGUMENT", {
      ...DAILY_WINDOW,
      startTime: "2026-09-08T07:00:00Z",
      endTime: "2026-09-01T07:00:00Z",
    });
  });

  it("rejects malformed, non-UTC, or impossible timestamps", () => {
    for (const bad of [
      "",
      "  ",
      "2026-09-01",
      "2026-09-01T07:00:00",
      "2026-09-01T07:00:00+07:00",
      "2026-09-01T07:00:00.000Z",
      "2026-09-01 07:00:00Z",
      "2026-13-01T07:00:00Z",
      "2026-02-30T07:00:00Z",
      "not-a-date",
      "2026-09-01T25:00:00Z",
    ]) {
      expectInvalid("INVALID_ARGUMENT", { ...DAILY_WINDOW, startTime: bad });
      expectInvalid("INVALID_ARGUMENT", { ...DAILY_WINDOW, endTime: bad });
    }
  });

  it("rejects unsupported kind and granularity values", () => {
    expectInvalid("INVALID_ARGUMENT", {
      ...DAILY_WINDOW,
      kind: "memory_usage" as HealthMetricQuery["kind"],
    });
    for (const granularity of ["WEEKLY", "FULL_RANGE", "daily", ""]) {
      expectInvalid("INVALID_ARGUMENT", {
        ...DAILY_WINDOW,
        granularity: granularity as HealthMetricQuery["granularity"],
      });
    }
  });

  it("rejects granularity values the metric kind does not support", () => {
    // Excessive wakeups documents DAILY only (installed SDK + official reference).
    expect(HEALTH_METRIC_SPECS.excessive_wakeup_rate.granularities).toEqual(["DAILY"]);
    expectInvalid("INVALID_ARGUMENT", {
      kind: "excessive_wakeup_rate",
      granularity: "HOURLY",
      startTime: "2026-09-01T00:00:00Z",
      endTime: "2026-09-01T06:00:00Z",
    });
  });

  it("validates requested dimensions against the documented dimension set", () => {
    const validated = validateHealthMetricQuery({
      ...DAILY_WINDOW,
      dimensions: ["versionCode", "countryCode"],
    });
    expect(validated.dimensions).toEqual(["versionCode", "countryCode"]);
    expect(HEALTH_DIMENSIONS).toContain("deviceType");

    expectInvalid("INVALID_ARGUMENT", { ...DAILY_WINDOW, dimensions: ["platform"] });
    expectInvalid("INVALID_ARGUMENT", { ...DAILY_WINDOW, dimensions: [""] });
    expectInvalid("INVALID_ARGUMENT", {
      ...DAILY_WINDOW,
      dimensions: ["versionCode", "versionCode"],
    });
    expectInvalid("INVALID_ARGUMENT", {
      ...DAILY_WINDOW,
      dimensions: "versionCode" as unknown as string[],
    });
  });

  it("defaults requested metrics to the kind's primary metric", () => {
    expect(validateHealthMetricQuery(DAILY_WINDOW).metrics).toEqual(["crashRate"]);
    expect(validateHealthMetricQuery({ ...DAILY_WINDOW, kind: "anr_rate" }).metrics).toEqual([
      "anrRate",
    ]);
    expect(
      validateHealthMetricQuery({
        kind: "excessive_wakeup_rate",
        granularity: "DAILY",
        startTime: "2026-09-01T07:00:00Z",
        endTime: "2026-09-08T07:00:00Z",
      }).metrics,
    ).toEqual(["excessiveWakeupRate"]);
  });

  it("accepts only metric names the kind actually supports", () => {
    const validated = validateHealthMetricQuery({
      ...DAILY_WINDOW,
      metrics: ["crashRate", "userPerceivedCrashRate", "distinctUsers"],
    });
    expect(validated.metrics).toEqual(["crashRate", "userPerceivedCrashRate", "distinctUsers"]);

    expectInvalid("INVALID_ARGUMENT", { ...DAILY_WINDOW, metrics: ["anrRate"] });
    expectInvalid("INVALID_ARGUMENT", { ...DAILY_WINDOW, metrics: ["excessiveWakeupRate"] });
    expectInvalid("INVALID_ARGUMENT", { ...DAILY_WINDOW, metrics: ["crashRate", "crashRate"] });
    expectInvalid("INVALID_ARGUMENT", { ...DAILY_WINDOW, metrics: [""] });
    expectInvalid("INVALID_ARGUMENT", {
      ...DAILY_WINDOW,
      metrics: "crashRate" as unknown as string[],
    });
  });

  it("does not mutate caller input and is deterministic across calls", () => {
    const input: HealthMetricQuery = {
      ...DAILY_WINDOW,
      dimensions: ["versionCode"],
      metrics: ["crashRate"],
    };
    const snapshot = structuredClone(input);

    const first = validateHealthMetricQuery(input);
    const second = validateHealthMetricQuery(input);

    expect(input).toEqual(snapshot);
    expect(structuredClone(first)).toEqual(structuredClone(second));
  });

  it("imposes no invented maximum timeline range", () => {
    // The v1beta1 reference publishes no TimelineSpec range limit (checked 2026-10-02),
    // so PlayOps enforces alignment only and lets Google own any remote range rule.
    const long = validateHealthMetricQuery({
      ...DAILY_WINDOW,
      startTime: "2025-01-01T08:00:00Z",
      endTime: "2026-01-01T08:00:00Z",
    });
    expect(long.window.startTimeUtc).toBe("2025-01-01T08:00:00Z");
  });

  it("rejects non-object input", () => {
    for (const bad of [null, undefined, 42, "crash_rate", []]) {
      expectInvalid("INVALID_ARGUMENT", bad as unknown as HealthMetricQuery);
    }
  });
});

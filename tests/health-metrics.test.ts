/**
 * Phase 5.1 — health metric fetcher tests (crash rate, ANR rate, excessive wakeups).
 *
 * Fake gateway only: the Google boundary is never touched and no network call is made.
 */
import { describe, expect, it } from "vitest";
import { HealthError } from "../src/health/errors.js";
import { fetchHealthMetricSeries } from "../src/health/fetchers.js";
import type { HealthMetricGateway, HealthMetricQueryRequest } from "../src/health/gateway.js";
import {
  HEALTH_METRIC_KINDS,
  HEALTH_METRIC_SPECS,
  type HealthMetricKind,
  type HealthMetricQuery,
  type HealthMetricSeries,
} from "../src/health/index.js";

const PKG = "com.example.health";
const FAKE_TOKEN = "ya29.fake-health-token";
const SECRET_MARKER = "FAKE-PRIVATE-KEY-SHOULD-NOT-LEAK";

const DAILY_WINDOW = {
  kind: "crash_rate",
  granularity: "DAILY",
  startTime: "2026-09-01T07:00:00Z",
  endTime: "2026-09-08T07:00:00Z",
} satisfies HealthMetricQuery;

interface QueryCall {
  readonly kind: HealthMetricKind;
  readonly operation: "read" | "query";
  readonly request?: HealthMetricQueryRequest;
}

interface FakeState {
  readonly metricSet?: unknown;
  readonly pages?: readonly {
    readonly rows: readonly unknown[];
    readonly nextPageToken?: string;
  }[];
  readonly failOn?: "read" | "query";
  readonly failure?: unknown;
}

function metricSetFor(kind: HealthMetricKind): unknown {
  return {
    name: `apps/${PKG}/${HEALTH_METRIC_SPECS[kind].metricSetSuffix}`,
    freshnessInfo: {
      freshnesses: [
        {
          aggregationPeriod: "DAILY",
          latestEndTime: { year: 2026, month: 9, day: 8 },
        },
      ],
    },
  };
}

function fakeGateway(state: FakeState = {}): {
  readonly gateway: HealthMetricGateway;
  readonly calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  let pageIndex = 0;
  const gateway: HealthMetricGateway = {
    async readMetricSet(kind) {
      calls.push({ kind, operation: "read" });
      if (state.failOn === "read") throw state.failure;
      return state.metricSet ?? metricSetFor(kind);
    },
    async queryMetricSet(kind, request) {
      calls.push({ kind, operation: "query", request });
      if (state.failOn === "query") throw state.failure;
      const page = state.pages?.[pageIndex] ?? { rows: [] };
      pageIndex += 1;
      return page;
    },
  };
  return { gateway, calls };
}

function dailyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aggregationPeriod: "DAILY",
    startTime: { year: 2026, month: 9, day: 1, timeZone: { id: "America/Los_Angeles" } },
    dimensions: [
      { dimension: "versionCode", int64Value: "42" },
      { dimension: "countryCode", stringValue: "ID" },
    ],
    metrics: [{ metric: "crashRate", decimalValue: { value: "0.0123" } }],
    ...overrides,
  };
}

async function fetchWith(
  state: FakeState,
  input: HealthMetricQuery = DAILY_WINDOW,
): Promise<{ readonly series: HealthMetricSeries; readonly calls: QueryCall[] }> {
  const { gateway, calls } = fakeGateway(state);
  const series = await fetchHealthMetricSeries(gateway, input);
  return { series, calls };
}

async function expectRemoteInvalid(state: FakeState, input?: HealthMetricQuery): Promise<void> {
  try {
    await fetchWith(state, input);
  } catch (error) {
    expect(error).toBeInstanceOf(HealthError);
    expect((error as HealthError).code).toBe("REMOTE_DATA_INVALID");
    return;
  }
  expect.unreachable("expected REMOTE_DATA_INVALID");
}

describe("Phase 5.1 metric fetchers", () => {
  it("normalizes a crash-rate query and forwards one exact Reporting request", async () => {
    const { series, calls } = await fetchWith(
      {
        pages: [
          {
            rows: [
              dailyRow({
                metrics: [
                  {
                    metric: "crashRate",
                    decimalValue: { value: "0.0123" },
                    decimalValueConfidenceInterval: {
                      lowerBound: { value: "0.0100" },
                      upperBound: { value: "0.0150" },
                    },
                  },
                  { metric: "distinctUsers", decimalValue: { value: "123456" } },
                ],
              }),
            ],
          },
        ],
      },
      {
        ...DAILY_WINDOW,
        dimensions: ["versionCode", "countryCode"],
        metrics: ["crashRate", "distinctUsers"],
      },
    );

    expect(series.kind).toBe("crash_rate");
    expect(series.toolName).toBe("health.get_crash_rate");
    expect(series.window).toEqual({
      startTimeUtc: "2026-09-01T07:00:00Z",
      endTimeUtc: "2026-09-08T07:00:00Z",
      granularity: "DAILY",
    });
    expect(series.dimensions).toEqual(["versionCode", "countryCode"]);
    expect(series.metrics).toEqual(["crashRate", "distinctUsers"]);
    expect(series.freshness).toEqual([
      { aggregationPeriod: "DAILY", latestEndTimeUtc: "2026-09-08T07:00:00Z" },
    ]);
    expect(series.rowCount).toBe(1);
    expect(series.pageCount).toBe(1);
    expect(series.points).toEqual([
      {
        startTimeUtc: "2026-09-01T07:00:00Z",
        aggregationPeriod: "DAILY",
        dimensions: [
          { name: "versionCode", value: "42", valueType: "int64" },
          { name: "countryCode", value: "ID", valueType: "string" },
        ],
        metrics: [
          {
            metric: "crashRate",
            value: "0.0123",
            unit: "percent",
            confidenceInterval: { lowerBound: "0.0100", upperBound: "0.0150" },
          },
          { metric: "distinctUsers", value: "123456", unit: "count" },
        ],
      },
    ]);
    expect(Object.isFrozen(series)).toBe(true);
    expect(Object.isFrozen(series.points)).toBe(true);
    expect(Object.isFrozen(series.points[0])).toBe(true);

    expect(calls.map((call) => `${call.operation}:${call.kind}`)).toEqual([
      "read:crash_rate",
      "query:crash_rate",
    ]);
    expect(calls[1]?.request).toEqual({
      timelineSpec: {
        aggregationPeriod: "DAILY",
        startTime: { year: 2026, month: 9, day: 1 },
        endTime: { year: 2026, month: 9, day: 8 },
      },
      dimensions: ["versionCode", "countryCode"],
      metrics: ["crashRate", "distinctUsers"],
      pageSize: 1000,
    });
  });

  it("normalizes ANR rate with the same PlayOps-owned shape", async () => {
    const { series, calls } = await fetchWith(
      {
        pages: [
          {
            rows: [
              dailyRow({
                metrics: [
                  { metric: "anrRate", decimalValue: { value: "0.005" } },
                  { metric: "userPerceivedAnrRate", decimalValue: { value: "0.004" } },
                ],
              }),
            ],
          },
        ],
      },
      {
        kind: "anr_rate",
        granularity: "DAILY",
        startTime: "2026-09-01T07:00:00Z",
        endTime: "2026-09-08T07:00:00Z",
        dimensions: ["versionCode", "countryCode"],
        metrics: ["anrRate", "userPerceivedAnrRate"],
      },
    );

    expect(series.kind).toBe("anr_rate");
    expect(series.toolName).toBe("health.get_anr_rate");
    expect(series.points[0]?.metrics).toEqual([
      { metric: "anrRate", value: "0.005", unit: "percent" },
      { metric: "userPerceivedAnrRate", value: "0.004", unit: "percent" },
    ]);
    expect(calls[0]?.kind).toBe("anr_rate");
  });

  it("normalizes excessive wakeups through the installed excessiveWakeupRateMetricSet", async () => {
    const { series, calls } = await fetchWith(
      {
        metricSet: {
          name: `apps/${PKG}/excessiveWakeupRateMetricSet`,
          freshnessInfo: { freshnesses: [] },
        },
        pages: [
          {
            rows: [
              dailyRow({
                dimensions: [],
                metrics: [
                  { metric: "excessiveWakeupRate", decimalValue: { value: "0.02" } },
                  { metric: "excessiveWakeupRate7dUserWeighted", decimalValue: { value: "0.019" } },
                ],
              }),
            ],
          },
        ],
      },
      {
        kind: "excessive_wakeup_rate",
        granularity: "DAILY",
        startTime: "2026-09-01T07:00:00Z",
        endTime: "2026-09-08T07:00:00Z",
        metrics: ["excessiveWakeupRate", "excessiveWakeupRate7dUserWeighted"],
      },
    );

    expect(series.kind).toBe("excessive_wakeup_rate");
    expect(series.toolName).toBe("health.get_excessive_wakeups");
    expect(series.freshness).toEqual([]);
    expect(series.points[0]?.metrics).toEqual([
      { metric: "excessiveWakeupRate", value: "0.02", unit: "percent" },
      { metric: "excessiveWakeupRate7dUserWeighted", value: "0.019", unit: "percent" },
    ]);
    expect(calls.map((call) => `${call.operation}:${call.kind}`)).toEqual([
      "read:excessive_wakeup_rate",
      "query:excessive_wakeup_rate",
    ]);
  });

  it("preserves decimal and int64 precision exactly", async () => {
    const longDecimal = "0.123456789012345678901234567890";
    const hugeInt = "9223372036854775807";
    const { series } = await fetchWith(
      {
        pages: [
          {
            rows: [
              dailyRow({
                dimensions: [{ dimension: "versionCode", int64Value: hugeInt }],
                metrics: [
                  { metric: "crashRate", decimalValue: { value: longDecimal } },
                  { metric: "distinctUsers", decimalValue: { value: "1000000" } },
                ],
              }),
            ],
          },
        ],
      },
      {
        ...DAILY_WINDOW,
        dimensions: ["versionCode"],
        metrics: ["crashRate", "distinctUsers"],
      },
    );

    expect(series.points[0]?.metrics[0]?.value).toBe(longDecimal);
    expect(typeof series.points[0]?.metrics[0]?.value).toBe("string");
    expect(series.points[0]?.dimensions[0]?.value).toBe(hugeInt);
  });

  it("treats an empty result as valid data, never as an error or a zero", async () => {
    const { series } = await fetchWith({ pages: [{ rows: [] }] });

    expect(series.points).toEqual([]);
    expect(series.rowCount).toBe(0);
    expect(series.pageCount).toBe(1);
  });

  it("preserves the API row order across rows", async () => {
    const rows = [1, 2, 3].map((day) =>
      dailyRow({
        dimensions: [],
        startTime: { year: 2026, month: 9, day, timeZone: { id: "America/Los_Angeles" } },
      }),
    );
    const { series } = await fetchWith({ pages: [{ rows }] });

    expect(series.rowCount).toBe(3);
    expect(series.points.map((point) => point.startTimeUtc)).toEqual([
      "2026-09-01T07:00:00Z",
      "2026-09-02T07:00:00Z",
      "2026-09-03T07:00:00Z",
    ]);
  });

  it("rejects malformed rows instead of coercing them", async () => {
    const cases: Record<string, unknown>[] = [
      dailyRow({ startTime: undefined }),
      dailyRow({ startTime: { year: 2026, month: 9 } }),
      dailyRow({ startTime: { year: 2026, month: 9, day: 1, nanos: 500 } }),
      dailyRow({ startTime: { year: 2026, month: 9, day: 1, timeZone: { id: "Not/AZone" } } }),
      dailyRow({ aggregationPeriod: "HOURLY" }),
      dailyRow({ aggregationPeriod: "" }),
      dailyRow({ dimensions: [{ dimension: "platform", stringValue: "android" }] }),
      dailyRow({
        dimensions: [
          { dimension: "versionCode", stringValue: "1" },
          { dimension: "versionCode", int64Value: "2" },
        ],
      }),
      dailyRow({ dimensions: [{ dimension: "versionCode" }] }),
      dailyRow({ dimensions: [{ dimension: "versionCode", stringValue: "1", int64Value: "1" }] }),
      dailyRow({ dimensions: "nope" }),
      dailyRow({ metrics: [] }),
      dailyRow({ metrics: [{ metric: "anrRate", decimalValue: { value: "0.1" } }] }),
      dailyRow({ metrics: [{ metric: "crashRate" }] }),
      dailyRow({ metrics: [{ metric: "crashRate", decimalValue: { value: "abc" } }] }),
      dailyRow({ metrics: [{ metric: "crashRate", decimalValue: { value: "" } }] }),
      dailyRow({ metrics: [{ decimalValue: { value: "0.1" } }] }),
      dailyRow({ metrics: "nope" }),
    ];

    for (const row of cases) {
      await expectRemoteInvalid({
        pages: [
          {
            rows: [row],
          },
        ],
      });
    }

    await expectRemoteInvalid({ pages: [{ rows: ["not-an-object"] }] });
  });

  it("validates metric-set freshness shape", async () => {
    await expectRemoteInvalid({ metricSet: { freshnessInfo: "nope" } });
    await expectRemoteInvalid({ metricSet: { freshnessInfo: { freshnesses: "nope" } } });
    await expectRemoteInvalid({ metricSet: { freshnessInfo: { freshnesses: ["nope"] } } });
    await expectRemoteInvalid({
      metricSet: {
        freshnessInfo: {
          freshnesses: [{ aggregationPeriod: "", latestEndTime: { year: 2026, month: 9, day: 8 } }],
        },
      },
    });
    await expectRemoteInvalid({
      metricSet: {
        freshnessInfo: {
          freshnesses: [
            { aggregationPeriod: "DAILY", latestEndTime: { year: 2026, month: 9, day: 8 } },
            { aggregationPeriod: "DAILY", latestEndTime: { year: 2026, month: 9, day: 9 } },
          ],
        },
      },
    });
    await expectRemoteInvalid({
      metricSet: {
        freshnessInfo: { freshnesses: [{ aggregationPeriod: "DAILY", latestEndTime: "nope" }] },
      },
    });
    await expectRemoteInvalid({
      metricSet: {
        freshnessInfo: {
          freshnesses: [
            { aggregationPeriod: "FULL_RANGE", latestEndTime: { year: 2026, month: 9, day: 8 } },
          ],
        },
      },
    });
  });

  it("keeps freshness absent rather than inventing it, and normalizes multiple periods", async () => {
    const { series } = await fetchWith({ metricSet: { name: `apps/${PKG}/crashRateMetricSet` } });
    expect(series.freshness).toEqual([]);

    const multi = await fetchWith({
      metricSet: {
        freshnessInfo: {
          freshnesses: [
            { aggregationPeriod: "DAILY", latestEndTime: { year: 2026, month: 9, day: 8 } },
            {
              aggregationPeriod: "HOURLY",
              latestEndTime: { year: 2026, month: 9, day: 8, hours: 6 },
            },
          ],
        },
      },
    });
    expect(multi.series.freshness).toEqual([
      { aggregationPeriod: "DAILY", latestEndTimeUtc: "2026-09-08T07:00:00Z" },
      { aggregationPeriod: "HOURLY", latestEndTimeUtc: "2026-09-08T06:00:00Z" },
    ]);
  });

  it("wraps Reporting failures as SOURCE_FAILED without leaking secrets", async () => {
    const failure = Object.assign(new Error(`boom Authorization: ${FAKE_TOKEN}`), {
      code: 503,
      config: { headers: { Authorization: SECRET_MARKER } },
    });

    for (const failOn of ["read", "query"] as const) {
      try {
        await fetchWith({ failOn, failure });
        expect.unreachable();
      } catch (error) {
        const wrapped = error as HealthError;
        expect(wrapped.code).toBe("SOURCE_FAILED");
        expect(wrapped.cause).toBe(failure);
        expect(wrapped.message).not.toContain(FAKE_TOKEN);
        expect(wrapped.message).not.toContain(SECRET_MARKER);
        expect(JSON.stringify(wrapped)).not.toContain(SECRET_MARKER);
      }
    }
  });

  it("returns a compatible PlayOps shape for every supported metric kind", async () => {
    const windows: Record<HealthMetricKind, HealthMetricQuery> = {
      crash_rate: DAILY_WINDOW,
      anr_rate: { ...DAILY_WINDOW, kind: "anr_rate" },
      excessive_wakeup_rate: { ...DAILY_WINDOW, kind: "excessive_wakeup_rate" },
    };

    for (const kind of HEALTH_METRIC_KINDS) {
      const spec = HEALTH_METRIC_SPECS[kind];
      const { series } = await fetchWith(
        {
          pages: [
            {
              rows: [
                dailyRow({
                  dimensions: [],
                  metrics: [{ metric: spec.primaryMetric, decimalValue: { value: "0.01" } }],
                }),
              ],
            },
          ],
        },
        windows[kind],
      );

      expect(Object.keys(series).sort()).toEqual([
        "dimensions",
        "freshness",
        "kind",
        "metrics",
        "pageCount",
        "points",
        "rowCount",
        "toolName",
        "window",
      ]);
      expect(series.metrics).toEqual([spec.primaryMetric]);
      expect(Object.keys(series.points[0] ?? {}).sort()).toEqual([
        "aggregationPeriod",
        "dimensions",
        "metrics",
        "startTimeUtc",
      ]);
    }
  });
});

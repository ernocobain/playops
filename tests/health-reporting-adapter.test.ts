/**
 * Phase 5.1 — mock integration through the REAL Phase 1.3 Reporting boundary.
 *
 * PlayOps query → production Reporting wrapper → fake generated client
 * (VitalsResourceLike) → normalized PlayOps result. The generated client is faked;
 * PlayOps validation, normalization, retry-policy ownership and error mapping are
 * exercised for real. No network, no credentials, no live Google call.
 */
import { describe, expect, it } from "vitest";
import type { PlayReportingClient, VitalsResourceLike } from "../src/googleplay/reporting/index.js";
import { fetchHealthMetricSeries } from "../src/health/fetchers.js";
import type { HealthMetricQuery } from "../src/health/index.js";
import { createReportingHealthMetricGateway } from "../src/health/reporting.js";

const PKG = "com.example.adapter";
const RAW_MARKER = "RAW-GENERATED-PAYLOAD-MARKER";

interface Recorded {
  readonly kind: string;
  readonly params: Record<string, unknown>;
  readonly options: unknown;
}

interface FakeOptions {
  readonly metricSet?: Record<string, unknown>;
  readonly rows?: readonly unknown[];
  readonly nextPageToken?: string | null;
  readonly failQueryWith?: unknown;
}

function metricSetPayload(kindSuffix: string): Record<string, unknown> {
  return {
    name: `apps/${PKG}/${kindSuffix}`,
    freshnessInfo: {
      freshnesses: [
        { aggregationPeriod: "DAILY", latestEndTime: { year: 2026, month: 9, day: 8 } },
      ],
    },
    [RAW_MARKER]: RAW_MARKER,
  };
}

function vitalsFake(options: FakeOptions = {}): {
  readonly resource: VitalsResourceLike;
  readonly calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const makeGet =
    (kind: string) =>
    (params: Record<string, unknown>, opts?: unknown): Promise<{ data: unknown }> => {
      calls.push({ kind, params, options: opts });
      return Promise.resolve({ data: options.metricSet ?? ({} as unknown) });
    };
  const makeQuery =
    (kind: string) =>
    (params: Record<string, unknown>, opts?: unknown): Promise<{ data: unknown }> => {
      calls.push({ kind, params, options: opts });
      if (options.failQueryWith !== undefined) return Promise.reject(options.failQueryWith);
      return Promise.resolve({
        data: {
          rows: options.rows ?? [],
          nextPageToken: options.nextPageToken ?? null,
          [RAW_MARKER]: RAW_MARKER,
        } as unknown,
      });
    };

  const resource: VitalsResourceLike = {
    anrrate: {
      get: makeGet("anrrate.get") as VitalsResourceLike["anrrate"]["get"],
      query: makeQuery("anrrate.query") as VitalsResourceLike["anrrate"]["query"],
    },
    crashrate: {
      get: makeGet("crashrate.get") as VitalsResourceLike["crashrate"]["get"],
      query: makeQuery("crashrate.query") as VitalsResourceLike["crashrate"]["query"],
    },
    excessivewakeuprate: {
      get: makeGet("excessivewakeuprate.get") as VitalsResourceLike["excessivewakeuprate"]["get"],
      query: makeQuery(
        "excessivewakeuprate.query",
      ) as VitalsResourceLike["excessivewakeuprate"]["query"],
    },
  };
  return { resource, calls };
}

function reportingClient(resource: VitalsResourceLike): PlayReportingClient {
  return { version: "v1beta1", vitals: resource };
}

const CRASH_WINDOW = {
  kind: "crash_rate",
  granularity: "DAILY",
  startTime: "2026-09-01T07:00:00Z",
  endTime: "2026-09-08T07:00:00Z",
  dimensions: ["countryCode"],
  metrics: ["crashRate"],
} satisfies HealthMetricQuery;

const CRASH_ROW = {
  aggregationPeriod: "DAILY",
  startTime: { year: 2026, month: 9, day: 1, timeZone: { id: "America/Los_Angeles" } },
  dimensions: [{ dimension: "countryCode", stringValue: "ID" }],
  metrics: [{ metric: "crashRate", decimalValue: { value: "0.0123" } }],
};

describe("Phase 5.1 mock integration through the production Reporting boundary", () => {
  it("drives the generated crash-rate client and returns normalized PlayOps data", async () => {
    const { resource, calls } = vitalsFake({
      metricSet: metricSetPayload("crashRateMetricSet"),
      rows: [CRASH_ROW],
    });
    const gateway = createReportingHealthMetricGateway(reportingClient(resource), PKG);

    const series = await fetchHealthMetricSeries(gateway, CRASH_WINDOW);

    expect(calls.map((call) => call.kind)).toEqual(["crashrate.get", "crashrate.query"]);
    expect(calls[0]?.params).toEqual({ name: `apps/${PKG}/crashRateMetricSet` });
    expect(calls[0]?.options).toEqual({ retry: false });
    expect(calls[1]?.params).toEqual({
      name: `apps/${PKG}/crashRateMetricSet`,
      requestBody: {
        timelineSpec: {
          aggregationPeriod: "DAILY",
          startTime: { year: 2026, month: 9, day: 1 },
          endTime: { year: 2026, month: 9, day: 8 },
        },
        dimensions: ["countryCode"],
        metrics: ["crashRate"],
        pageSize: 1000,
      },
    });
    expect(calls[1]?.options).toEqual({ retry: false });

    expect(series.points).toEqual([
      {
        startTimeUtc: "2026-09-01T07:00:00Z",
        aggregationPeriod: "DAILY",
        dimensions: [{ name: "countryCode", value: "ID", valueType: "string" }],
        metrics: [{ metric: "crashRate", value: "0.0123", unit: "percent" }],
      },
    ]);
    expect(series.freshness).toEqual([
      { aggregationPeriod: "DAILY", latestEndTimeUtc: "2026-09-08T07:00:00Z" },
    ]);
    expect(series.rowCount).toBe(1);

    // Normalized output only: raw generated payload never escapes the Google boundary.
    expect(JSON.stringify(series)).not.toContain(RAW_MARKER);
  });

  it("routes excessive wakeups through the exact generated resource", async () => {
    const { resource, calls } = vitalsFake({
      metricSet: metricSetPayload("excessiveWakeupRateMetricSet"),
      rows: [
        {
          ...CRASH_ROW,
          dimensions: [],
          metrics: [{ metric: "excessiveWakeupRate", decimalValue: { value: "0.02" } }],
        },
      ],
    });
    const gateway = createReportingHealthMetricGateway(reportingClient(resource), PKG);

    const series = await fetchHealthMetricSeries(gateway, {
      kind: "excessive_wakeup_rate",
      granularity: "DAILY",
      startTime: "2026-09-01T07:00:00Z",
      endTime: "2026-09-08T07:00:00Z",
    });

    expect(calls.map((call) => call.kind)).toEqual([
      "excessivewakeuprate.get",
      "excessivewakeuprate.query",
    ]);
    expect(calls[1]?.params).toMatchObject({
      name: `apps/${PKG}/excessiveWakeupRateMetricSet`,
      requestBody: { metrics: ["excessiveWakeupRate"] },
    });
    expect(series.points[0]?.metrics[0]).toEqual({
      metric: "excessiveWakeupRate",
      value: "0.02",
      unit: "percent",
    });
  });

  it("follows the Phase 1.3 bounded read retry for transient failures and not for 400", async () => {
    const transient = vitalsFake({
      metricSet: metricSetPayload("crashRateMetricSet"),
      failQueryWith: { response: { status: 503 } },
    });
    const transientGateway = createReportingHealthMetricGateway(
      reportingClient(transient.resource),
      PKG,
      { retry: { sleep: () => Promise.resolve(), random: () => 0.5 } },
    );
    await expect(fetchHealthMetricSeries(transientGateway, CRASH_WINDOW)).rejects.toMatchObject({
      code: "SOURCE_FAILED",
    });
    // Existing Phase 1.5 read policy is reused unchanged: 3 total attempts.
    expect(transient.calls.filter((call) => call.kind === "crashrate.query")).toHaveLength(3);

    const client400 = vitalsFake({
      metricSet: metricSetPayload("crashRateMetricSet"),
      failQueryWith: Object.assign(new Error("bad request"), { code: 400 }),
    });
    const client400Gateway = createReportingHealthMetricGateway(
      reportingClient(client400.resource),
      PKG,
      { retry: { sleep: () => Promise.resolve(), random: () => 0.5 } },
    );
    await expect(fetchHealthMetricSeries(client400Gateway, CRASH_WINDOW)).rejects.toMatchObject({
      code: "SOURCE_FAILED",
    });
    expect(client400.calls.filter((call) => call.kind === "crashrate.query")).toHaveLength(1);
  });

  it("maps a malformed generated response through the existing Reporting error boundary", async () => {
    const { resource } = vitalsFake({ metricSet: metricSetPayload("crashRateMetricSet") });
    const malformed: VitalsResourceLike = {
      ...resource,
      crashrate: {
        ...resource.crashrate,
        query: (() =>
          Promise.resolve({
            data: { rows: "nope" },
          })) as unknown as VitalsResourceLike["crashrate"]["query"],
      },
    };
    const gateway = createReportingHealthMetricGateway(reportingClient(malformed), PKG);

    await expect(fetchHealthMetricSeries(gateway, CRASH_WINDOW)).rejects.toMatchObject({
      code: "SOURCE_FAILED",
    });
  });

  it("rejects a metric-set response that is not the requested resource", async () => {
    const wrongResource = vitalsFake({
      metricSet: {
        name: "apps/com.other.app/crashRateMetricSet",
        freshnessInfo: { freshnesses: [] },
      },
    });
    const wrongGateway = createReportingHealthMetricGateway(
      reportingClient(wrongResource.resource),
      PKG,
    );
    await expect(fetchHealthMetricSeries(wrongGateway, CRASH_WINDOW)).rejects.toMatchObject({
      code: "SOURCE_FAILED",
    });

    const malformedName = vitalsFake({
      metricSet: { name: 42 as unknown as string, freshnessInfo: { freshnesses: [] } },
    });
    const malformedGateway = createReportingHealthMetricGateway(
      reportingClient(malformedName.resource),
      PKG,
    );
    await expect(fetchHealthMetricSeries(malformedGateway, CRASH_WINDOW)).rejects.toMatchObject({
      code: "SOURCE_FAILED",
    });
  });

  it("binds the package name from composition and never from the model query", async () => {
    const bound = "com.example.bound";
    const { resource, calls } = vitalsFake({
      metricSet: {
        name: `apps/${bound}/crashRateMetricSet`,
        freshnessInfo: { freshnesses: [] },
      },
      rows: [],
    });
    const gateway = createReportingHealthMetricGateway(reportingClient(resource), bound);
    const series = await fetchHealthMetricSeries(gateway, CRASH_WINDOW);

    expect(calls.map((call) => call.params["name"])).toEqual([
      `apps/${bound}/crashRateMetricSet`,
      `apps/${bound}/crashRateMetricSet`,
    ]);
    // The query carries no package identity at all.
    expect(JSON.stringify(series)).not.toContain("com.example.bound");
  });
});

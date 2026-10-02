/**
 * Phase 5.1 — Reporting pagination tests (fake gateway only, no network).
 */
import { describe, expect, it } from "vitest";
import { HealthError } from "../src/health/errors.js";
import { fetchHealthMetricSeries } from "../src/health/fetchers.js";
import type { HealthMetricGateway, HealthMetricQueryRequest } from "../src/health/gateway.js";
import type { HealthMetricQuery } from "../src/health/index.js";

const PKG = "com.example.pagination";

const WINDOW = {
  kind: "anr_rate",
  granularity: "DAILY",
  startTime: "2026-09-01T07:00:00Z",
  endTime: "2026-09-08T07:00:00Z",
} satisfies HealthMetricQuery;

function row(day: number): Record<string, unknown> {
  return {
    aggregationPeriod: "DAILY",
    startTime: { year: 2026, month: 9, day, timeZone: { id: "America/Los_Angeles" } },
    dimensions: [],
    metrics: [{ metric: "anrRate", decimalValue: { value: "0.01" } }],
  };
}

function pagingGateway(
  pages: readonly { readonly rows: readonly unknown[]; readonly nextPageToken?: string }[],
): { readonly gateway: HealthMetricGateway; readonly requests: HealthMetricQueryRequest[] } {
  const requests: HealthMetricQueryRequest[] = [];
  const gateway: HealthMetricGateway = {
    async readMetricSet() {
      return { name: `apps/${PKG}/anrRateMetricSet`, freshnessInfo: { freshnesses: [] } };
    },
    async queryMetricSet(_kind, request) {
      requests.push(request);
      const page = pages[requests.length - 1] ?? { rows: [] };
      return page;
    },
  };
  return { gateway, requests };
}

describe("Phase 5.1 pagination", () => {
  it("follows nextPageToken until exhausted, preserving page and row order", async () => {
    const { gateway, requests } = pagingGateway([
      { rows: [row(1), row(2)], nextPageToken: "TOKEN-1" },
      { rows: [row(3)], nextPageToken: "TOKEN-2" },
      { rows: [row(4)] },
    ]);

    const series = await fetchHealthMetricSeries(gateway, WINDOW);

    expect(series.pageCount).toBe(3);
    expect(series.rowCount).toBe(4);
    expect(series.points.map((point) => point.startTimeUtc)).toEqual([
      "2026-09-01T07:00:00Z",
      "2026-09-02T07:00:00Z",
      "2026-09-03T07:00:00Z",
      "2026-09-04T07:00:00Z",
    ]);
    expect(requests.map((request) => request.pageToken)).toEqual([undefined, "TOKEN-1", "TOKEN-2"]);
    // Every non-token parameter must stay identical while paginating (Google requirement).
    for (const request of requests) {
      expect(request.timelineSpec).toEqual({
        aggregationPeriod: "DAILY",
        startTime: { year: 2026, month: 9, day: 1 },
        endTime: { year: 2026, month: 9, day: 8 },
      });
      expect(request.metrics).toEqual(["anrRate"]);
      expect(request.pageSize).toBe(1000);
    }
  });

  it("treats an empty nextPageToken as the end of the result", async () => {
    const { gateway, requests } = pagingGateway([{ rows: [row(1)], nextPageToken: "" }]);
    const series = await fetchHealthMetricSeries(gateway, WINDOW);

    expect(requests).toHaveLength(1);
    expect(series.pageCount).toBe(1);
  });

  it("detects a repeated page token instead of looping forever", async () => {
    const { gateway } = pagingGateway([
      { rows: [row(1)], nextPageToken: "LOOP" },
      { rows: [row(2)], nextPageToken: "LOOP" },
    ]);

    await expect(fetchHealthMetricSeries(gateway, WINDOW)).rejects.toMatchObject({
      name: "HealthError",
      code: "PAGINATION_LOOP",
    });
  });

  it("enforces a finite page guard without silently truncating", async () => {
    const { gateway, requests } = pagingGateway([
      { rows: [row(1)], nextPageToken: "T1" },
      { rows: [row(2)], nextPageToken: "T2" },
      { rows: [row(3)], nextPageToken: "T3" },
    ]);

    try {
      await fetchHealthMetricSeries(gateway, WINDOW, { maxPages: 2 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HealthError);
      expect((error as HealthError).code).toBe("MAX_PAGES_EXCEEDED");
    }
    expect(requests).toHaveLength(2);
  });

  it("rejects a malformed page token", async () => {
    const { gateway } = pagingGateway([{ rows: [row(1)], nextPageToken: 42 as unknown as string }]);
    await expect(fetchHealthMetricSeries(gateway, WINDOW)).rejects.toMatchObject({
      code: "REMOTE_DATA_INVALID",
    });
  });

  it("validates fetcher options and forwards an explicit page size", async () => {
    const { gateway, requests } = pagingGateway([{ rows: [] }]);
    await fetchHealthMetricSeries(gateway, WINDOW, { pageSize: 250, maxPages: 5 });
    expect(requests[0]?.pageSize).toBe(250);

    for (const options of [
      { pageSize: 0 },
      { pageSize: 100_001 },
      { maxPages: 0 },
      { maxPages: 1.5 },
    ]) {
      await expect(fetchHealthMetricSeries(gateway, WINDOW, options)).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }
  });
});

/** Synthetic normalized points only; no package identity, credentials or SDK types. */
import type { HealthConfig } from "../../../src/config/types.js";
import { DEFAULT_CONFIG } from "../../../src/config/types.js";
import {
  HEALTH_METRIC_SPECS,
  type HealthMetricKind,
  type HealthMetricPoint,
  type HealthMetricSeries,
} from "../../../src/health/index.js";

export const THRESHOLD_START = "2026-09-23T07:00:00Z";
export const THRESHOLD_NEXT = "2026-09-24T07:00:00Z";
export const THRESHOLD_END = "2026-09-25T07:00:00Z";
export const THRESHOLD_QUERY = Object.freeze({
  startTime: THRESHOLD_START,
  endTime: THRESHOLD_END,
  granularity: "DAILY" as const,
});

export function thresholdConfig(overrides: Partial<HealthConfig> = {}): HealthConfig {
  return { ...DEFAULT_CONFIG.health, ...overrides };
}

export function thresholdPoint(
  kind: HealthMetricKind,
  value: string | null,
  overrides: Partial<HealthMetricPoint> = {},
): HealthMetricPoint {
  return {
    startTimeUtc: THRESHOLD_START,
    aggregationPeriod: "DAILY",
    dimensions: [],
    metrics:
      value === null
        ? [{ metric: "distinctUsers", value: "123", unit: "count" }]
        : [{ metric: HEALTH_METRIC_SPECS[kind].primaryMetric, value, unit: "percent" }],
    ...overrides,
  };
}

export function thresholdSeries(
  kind: HealthMetricKind,
  points: readonly HealthMetricPoint[],
  overrides: Partial<HealthMetricSeries> = {},
): HealthMetricSeries {
  return {
    kind,
    toolName: HEALTH_METRIC_SPECS[kind].toolName,
    window: { startTimeUtc: THRESHOLD_START, endTimeUtc: THRESHOLD_END, granularity: "DAILY" },
    dimensions: [],
    metrics: HEALTH_METRIC_SPECS[kind].metrics,
    freshness: [],
    points,
    pageCount: 1,
    rowCount: points.length,
    ...overrides,
  };
}

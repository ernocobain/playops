/**
 * FAKE fixtures for Phase 5.2 App Health baseline comparison.
 *
 * Synthetic, package-neutral data only — no credentials, no live user or app
 * data. Rows are shaped exactly like Play Developer Reporting metric rows so the
 * tests can drive them through the REAL Phase 5.1 normalizers before comparing.
 *
 * Window convention: September/October 2026 is America/Los_Angeles PDT (UTC-7),
 * so a DAILY boundary is always `T07:00:00Z`. HOURLY boundaries are UTC.
 */
import type { HealthGranularity, HealthMetricKind } from "../../../src/health/index.js";

export const FAKE_MARKER = "FAKE-PHASE52-FIXTURE";

export interface FakeDimension {
  readonly name: string;
  readonly value: string;
  readonly int64?: boolean;
}

export interface FakeWindow {
  readonly startTime: string;
  readonly endTime: string;
  readonly rows: readonly Record<string, unknown>[];
  /** Optional metric-set payload comment; identity is composition-bound in production. */
  readonly metricSetSuffix?: string;
}

export interface ComparisonScenario {
  readonly name: string;
  readonly kind: HealthMetricKind;
  readonly granularity: HealthGranularity;
  readonly dimensions: readonly string[];
  readonly metrics: readonly string[];
  readonly current: FakeWindow;
  readonly baseline: FakeWindow;
}

/** Daily point in America/Los_Angeles (September/October 2026 → 07:00Z). */
export function dailyRow(
  day: number,
  metrics: Readonly<Record<string, string>>,
  dimensions: readonly FakeDimension[] = [],
): Record<string, unknown> {
  return {
    aggregationPeriod: "DAILY",
    startTime: { year: 2026, month: 9, day, timeZone: { id: "America/Los_Angeles" } },
    dimensions: dimensions.map((entry) => ({
      dimension: entry.name,
      ...(entry.int64 === true ? { int64Value: entry.value } : { stringValue: entry.value }),
    })),
    metrics: Object.entries(metrics).map(([metric, value]) => ({
      metric,
      decimalValue: { value },
    })),
    marker: FAKE_MARKER,
  };
}

/** Hourly point (UTC). */
export function hourlyRow(
  day: number,
  hour: number,
  metrics: Readonly<Record<string, string>>,
): Record<string, unknown> {
  return {
    aggregationPeriod: "HOURLY",
    startTime: { year: 2026, month: 9, day, hours: hour, timeZone: { id: "UTC" } },
    dimensions: [],
    metrics: Object.entries(metrics).map(([metric, value]) => ({
      metric,
      decimalValue: { value },
    })),
    marker: FAKE_MARKER,
  };
}

const day = (n: number): string => `2026-09-${String(n).padStart(2, "0")}T07:00:00Z`;

/** One-day current window and the immediately preceding one-day baseline. */
function singleDay(currentDay: number): { current: FakeWindow; baseline: FakeWindow } {
  return {
    current: {
      startTime: day(currentDay),
      endTime: day(currentDay + 1),
      rows: [],
    },
    baseline: {
      startTime: day(currentDay - 1),
      endTime: day(currentDay),
      rows: [],
    },
  };
}

export const COMPARISON_SCENARIOS: readonly ComparisonScenario[] = Object.freeze([
  {
    name: "crash-increase",
    kind: "crash_rate",
    granularity: "DAILY",
    dimensions: [],
    metrics: ["crashRate"],
    ...singleDay(24),
  },
  {
    name: "crash-decrease",
    kind: "crash_rate",
    granularity: "DAILY",
    dimensions: [],
    metrics: ["crashRate"],
    ...singleDay(24),
  },
  {
    name: "crash-unchanged",
    kind: "crash_rate",
    granularity: "DAILY",
    dimensions: [],
    metrics: ["crashRate"],
    ...singleDay(24),
  },
  {
    name: "anr-increase-multi-period",
    kind: "anr_rate",
    granularity: "DAILY",
    dimensions: [],
    metrics: ["anrRate"],
    current: { startTime: day(24), endTime: day(26), rows: [] },
    baseline: { startTime: day(22), endTime: day(24), rows: [] },
  },
  {
    name: "excessive-wakeups-change",
    kind: "excessive_wakeup_rate",
    granularity: "DAILY",
    dimensions: [],
    metrics: ["excessiveWakeupRate"],
    ...singleDay(24),
  },
  {
    name: "baseline-zero-current-zero",
    kind: "crash_rate",
    granularity: "DAILY",
    dimensions: [],
    metrics: ["crashRate"],
    ...singleDay(24),
  },
  {
    name: "baseline-zero-current-positive",
    kind: "crash_rate",
    granularity: "DAILY",
    dimensions: [],
    metrics: ["crashRate"],
    ...singleDay(24),
  },
  {
    name: "current-window-empty",
    kind: "crash_rate",
    granularity: "DAILY",
    dimensions: [],
    metrics: ["crashRate", "distinctUsers"],
    ...singleDay(24),
  },
  {
    name: "baseline-window-empty",
    kind: "crash_rate",
    granularity: "DAILY",
    dimensions: [],
    metrics: ["crashRate", "distinctUsers"],
    ...singleDay(24),
  },
  {
    name: "both-windows-empty",
    kind: "crash_rate",
    granularity: "DAILY",
    dimensions: [],
    metrics: ["crashRate"],
    ...singleDay(24),
  },
  {
    name: "current-only-dimension-group",
    kind: "crash_rate",
    granularity: "DAILY",
    dimensions: ["deviceModel"],
    metrics: ["crashRate"],
    ...singleDay(24),
  },
  {
    name: "baseline-only-dimension-group",
    kind: "crash_rate",
    granularity: "DAILY",
    dimensions: ["deviceModel"],
    metrics: ["crashRate"],
    ...singleDay(24),
  },
  {
    name: "multiple-dimension-groups",
    kind: "crash_rate",
    granularity: "DAILY",
    dimensions: ["countryCode", "versionCode"],
    metrics: ["crashRate"],
    current: { startTime: day(24), endTime: day(26), rows: [] },
    baseline: { startTime: day(22), endTime: day(24), rows: [] },
  },
  {
    name: "beyond-js-float-precision",
    kind: "crash_rate",
    granularity: "DAILY",
    dimensions: [],
    metrics: ["crashRate"],
    ...singleDay(24),
  },
  {
    name: "freshness-lag",
    kind: "crash_rate",
    granularity: "DAILY",
    dimensions: [],
    metrics: ["crashRate"],
    ...singleDay(24),
  },
  {
    name: "hourly-multi-period",
    kind: "anr_rate",
    granularity: "HOURLY",
    dimensions: [],
    metrics: ["anrRate"],
    current: {
      startTime: "2026-09-24T00:00:00Z",
      endTime: "2026-09-24T03:00:00Z",
      rows: [],
    },
    baseline: {
      startTime: "2026-09-23T21:00:00Z",
      endTime: "2026-09-24T00:00:00Z",
      rows: [],
    },
  },
]);

/** Raw rows per scenario, kept separate so each fixture stays readable. */
export const SCENARIO_ROWS: Readonly<
  Record<
    string,
    { current: readonly Record<string, unknown>[]; baseline: readonly Record<string, unknown>[] }
  >
> = Object.freeze({
  "crash-increase": {
    current: [dailyRow(24, { crashRate: "0.0155" })],
    baseline: [dailyRow(23, { crashRate: "0.0123" })],
  },
  "crash-decrease": {
    current: [dailyRow(24, { crashRate: "0.0088" })],
    baseline: [dailyRow(23, { crashRate: "0.0123" })],
  },
  "crash-unchanged": {
    current: [dailyRow(24, { crashRate: "0.0123" })],
    baseline: [dailyRow(23, { crashRate: "0.0123" })],
  },
  "anr-increase-multi-period": {
    current: [dailyRow(24, { anrRate: "0.0020" }), dailyRow(25, { anrRate: "0.0024" })],
    baseline: [dailyRow(22, { anrRate: "0.0018" }), dailyRow(23, { anrRate: "0.0020" })],
  },
  "excessive-wakeups-change": {
    current: [dailyRow(24, { excessiveWakeupRate: "0.02" })],
    baseline: [dailyRow(23, { excessiveWakeupRate: "0.05" })],
  },
  "baseline-zero-current-zero": {
    current: [dailyRow(24, { crashRate: "0" })],
    baseline: [dailyRow(23, { crashRate: "0.000" })],
  },
  "baseline-zero-current-positive": {
    current: [dailyRow(24, { crashRate: "0.0012" })],
    baseline: [dailyRow(23, { crashRate: "0" })],
  },
  "current-window-empty": {
    current: [],
    baseline: [dailyRow(23, { crashRate: "0.0123", distinctUsers: "12000" })],
  },
  "baseline-window-empty": {
    current: [dailyRow(24, { crashRate: "0.0155", distinctUsers: "15000" })],
    baseline: [],
  },
  "both-windows-empty": { current: [], baseline: [] },
  "current-only-dimension-group": {
    current: [
      dailyRow(24, { crashRate: "0.02" }, [{ name: "deviceModel", value: "google/coral" }]),
    ],
    baseline: [
      dailyRow(23, { crashRate: "0.01" }, [{ name: "deviceModel", value: "google/panther" }]),
    ],
  },
  "baseline-only-dimension-group": {
    current: [
      dailyRow(24, { crashRate: "0.02" }, [{ name: "deviceModel", value: "google/panther" }]),
    ],
    baseline: [
      dailyRow(23, { crashRate: "0.01" }, [{ name: "deviceModel", value: "google/coral" }]),
    ],
  },
  "multiple-dimension-groups": {
    current: [
      dailyRow(24, { crashRate: "0.03" }, [
        { name: "versionCode", value: "374", int64: true },
        { name: "countryCode", value: "ID" },
      ]),
      dailyRow(25, { crashRate: "0.04" }, [
        { name: "versionCode", value: "374", int64: true },
        { name: "countryCode", value: "ID" },
      ]),
      dailyRow(24, { crashRate: "0.01" }, [
        { name: "versionCode", value: "375", int64: true },
        { name: "countryCode", value: "US" },
      ]),
      dailyRow(25, { crashRate: "0.02" }, [
        { name: "versionCode", value: "375", int64: true },
        { name: "countryCode", value: "US" },
      ]),
    ],
    baseline: [
      dailyRow(22, { crashRate: "0.02" }, [
        { name: "countryCode", value: "ID" },
        { name: "versionCode", value: "374", int64: true },
      ]),
      dailyRow(23, { crashRate: "0.02" }, [
        { name: "countryCode", value: "ID" },
        { name: "versionCode", value: "374", int64: true },
      ]),
      dailyRow(22, { crashRate: "0.02" }, [
        { name: "versionCode", value: "375", int64: true },
        { name: "countryCode", value: "US" },
      ]),
      dailyRow(23, { crashRate: "0.02" }, [
        { name: "versionCode", value: "375", int64: true },
        { name: "countryCode", value: "US" },
      ]),
    ],
  },
  "beyond-js-float-precision": {
    current: [dailyRow(24, { crashRate: "0.123456789012345678901234567890" })],
    baseline: [dailyRow(23, { crashRate: "0.123456789012345678901234567889" })],
  },
  "freshness-lag": {
    current: [dailyRow(24, { crashRate: "0.0155" })],
    baseline: [dailyRow(23, { crashRate: "0.0123" })],
  },
  "hourly-multi-period": {
    current: [hourlyRow(24, 0, { anrRate: "0.0030" }), hourlyRow(24, 1, { anrRate: "0.0010" })],
    baseline: [hourlyRow(23, 21, { anrRate: "0.0020" }), hourlyRow(23, 22, { anrRate: "0.0020" })],
  },
});

/** Metric-set payloads used to prove freshness handling. */
export const SCENARIO_FRESHNESS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "freshness-lag": ["2026-09-24T07:00:00Z"],
  default: ["2026-10-01T07:00:00Z"],
});

export function scenarioByName(name: string): ComparisonScenario {
  const scenario = COMPARISON_SCENARIOS.find((entry) => entry.name === name);
  if (!scenario) throw new Error(`Unknown Phase 5.2 fixture: ${name}`);
  return scenario;
}

export function rowsFor(
  name: string,
  side: "current" | "baseline",
): readonly Record<string, unknown>[] {
  const rows = SCENARIO_ROWS[name];
  if (!rows) throw new Error(`Unknown Phase 5.2 fixture rows: ${name}`);
  return rows[side];
}

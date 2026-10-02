/**
 * Phase 5.1 — PlayOps App Health metric model (Reporting API vitals).
 *
 * Provider-neutral: no `@googleapis/*` type crosses this module. Everything here
 * is derived from the installed `@googleapis/playdeveloperreporting@15.0.1`
 * v1beta1 declarations and the official Play Developer Reporting reference
 * (consulted read-only on 2026-10-02) — never from guessing metric names.
 *
 * Phase 5.1 scope (conservative reading of the roadmap's "etc."): exactly three
 * App-Health-relevant, stability/performance metric sets —
 *   - `crashRateMetricSet`           → crash rate
 *   - `anrRateMetricSet`             → ANR rate
 *   - `excessiveWakeupRateMetricSet` → excessive wakeups
 * Every other available vitals metric set (memory usage, LMK, slow rendering,
 * slow start, stuck background wakelock, error counts/issues/reports, anomalies,
 * apps) is deliberately out of scope for 5.1.
 *
 * No anomaly interpretation, baseline comparison, severity, threshold evaluation
 * or reporting lives here — that is Phase 5.2–5.4.
 */
import { HealthError } from "./errors.js";
import {
  buildQueryBoundary,
  DAILY_AGGREGATION_TIME_ZONE,
  formatUtcInstant,
  HOURLY_AGGREGATION_TIME_ZONE,
  parseRemoteDateTime,
  parseUtcInstant,
  type HealthDateTime,
  type HealthGranularity,
} from "./time.js";

export { HealthError } from "./errors.js";
export type { HealthErrorCode } from "./errors.js";
export {
  DAILY_AGGREGATION_TIME_ZONE,
  HOURLY_AGGREGATION_TIME_ZONE,
  HEALTH_GRANULARITIES,
} from "./time.js";
export type { HealthDateTime, HealthGranularity } from "./time.js";

export const HEALTH_METRIC_KINDS = Object.freeze([
  "crash_rate",
  "anr_rate",
  "excessive_wakeup_rate",
] as const);
export type HealthMetricKind = (typeof HEALTH_METRIC_KINDS)[number];

/** Exact Reporting metric names, in the documented metric-set order. */
export const HEALTH_METRIC_NAMES = Object.freeze([
  "crashRate",
  "crashRate7dUserWeighted",
  "crashRate28dUserWeighted",
  "userPerceivedCrashRate",
  "userPerceivedCrashRate7dUserWeighted",
  "userPerceivedCrashRate28dUserWeighted",
  "anrRate",
  "anrRate7dUserWeighted",
  "anrRate28dUserWeighted",
  "userPerceivedAnrRate",
  "userPerceivedAnrRate7dUserWeighted",
  "userPerceivedAnrRate28dUserWeighted",
  "excessiveWakeupRate",
  "excessiveWakeupRate7dUserWeighted",
  "excessiveWakeupRate28dUserWeighted",
  "distinctUsers",
] as const);
export type HealthMetricName = (typeof HEALTH_METRIC_NAMES)[number];

/**
 * Documented supported dimensions. Identical for all three Phase 5.1 metric sets
 * (verified in the installed v1beta1 declarations); PlayOps refuses to invent
 * cross-metric dimension differences and refuses any dimension outside this set.
 */
export const HEALTH_DIMENSIONS = Object.freeze([
  "apiLevel",
  "versionCode",
  "deviceModel",
  "deviceBrand",
  "deviceType",
  "countryCode",
  "deviceRamBucket",
  "deviceSocMake",
  "deviceSocModel",
  "deviceCpuMake",
  "deviceCpuModel",
  "deviceGpuMake",
  "deviceGpuModel",
  "deviceGpuVersion",
  "deviceVulkanVersion",
  "deviceGlEsVersion",
  "deviceScreenSize",
  "deviceScreenDpi",
] as const);
export type HealthDimension = (typeof HEALTH_DIMENSIONS)[number];

/**
 * Unit metadata derived from the metric-set documentation wording ("Percentage of
 * distinct users …" vs "Count of distinct users …"). The Reporting API itself
 * returns no unit field and PlayOps never scales the value: the exact decimal
 * string from Google is preserved untouched.
 */
export type HealthMetricUnit = "percent" | "count";
export const HEALTH_METRIC_UNITS: Readonly<Record<HealthMetricName, HealthMetricUnit>> =
  Object.freeze(
    Object.fromEntries(
      HEALTH_METRIC_NAMES.map((name) => [name, name === "distinctUsers" ? "count" : "percent"]),
    ) as Record<HealthMetricName, HealthMetricUnit>,
  );

export interface HealthMetricKindSpec {
  readonly kind: HealthMetricKind;
  /** Stable Phase 5.1 runtime tool name. */
  readonly toolName: string;
  /** Reporting resource suffix: `apps/{packageName}/{metricSetSuffix}`. */
  readonly metricSetSuffix: string;
  readonly readOperation: string;
  readonly queryOperation: string;
  readonly granularities: readonly HealthGranularity[];
  readonly primaryMetric: HealthMetricName;
  readonly metrics: readonly HealthMetricName[];
}

export const HEALTH_METRIC_SPECS: Readonly<Record<HealthMetricKind, HealthMetricKindSpec>> =
  Object.freeze({
    crash_rate: Object.freeze({
      kind: "crash_rate",
      toolName: "health.get_crash_rate",
      metricSetSuffix: "crashRateMetricSet",
      readOperation: "vitals.crashrate.get",
      queryOperation: "vitals.crashrate.query",
      granularities: Object.freeze(["DAILY", "HOURLY"] as const),
      primaryMetric: "crashRate",
      metrics: Object.freeze([
        "crashRate",
        "crashRate7dUserWeighted",
        "crashRate28dUserWeighted",
        "userPerceivedCrashRate",
        "userPerceivedCrashRate7dUserWeighted",
        "userPerceivedCrashRate28dUserWeighted",
        "distinctUsers",
      ] as const),
    }),
    anr_rate: Object.freeze({
      kind: "anr_rate",
      toolName: "health.get_anr_rate",
      metricSetSuffix: "anrRateMetricSet",
      readOperation: "vitals.anrrate.get",
      queryOperation: "vitals.anrrate.query",
      granularities: Object.freeze(["DAILY", "HOURLY"] as const),
      primaryMetric: "anrRate",
      metrics: Object.freeze([
        "anrRate",
        "anrRate7dUserWeighted",
        "anrRate28dUserWeighted",
        "userPerceivedAnrRate",
        "userPerceivedAnrRate7dUserWeighted",
        "userPerceivedAnrRate28dUserWeighted",
        "distinctUsers",
      ] as const),
    }),
    excessive_wakeup_rate: Object.freeze({
      kind: "excessive_wakeup_rate",
      toolName: "health.get_excessive_wakeups",
      metricSetSuffix: "excessiveWakeupRateMetricSet",
      readOperation: "vitals.excessivewakeuprate.get",
      queryOperation: "vitals.excessivewakeuprate.query",
      // Installed SDK + official reference: excessive wakeups documents DAILY only.
      granularities: Object.freeze(["DAILY"] as const),
      primaryMetric: "excessiveWakeupRate",
      metrics: Object.freeze([
        "excessiveWakeupRate",
        "excessiveWakeupRate7dUserWeighted",
        "excessiveWakeupRate28dUserWeighted",
        "distinctUsers",
      ] as const),
    }),
  });

/** Google's documented query defaults: at most 1000 rows unless pageSize is set. */
export const HEALTH_DEFAULT_PAGE_SIZE = 1_000;
export const HEALTH_MAX_PAGE_SIZE = 100_000;
export const HEALTH_DEFAULT_MAX_PAGES = 50;
export const HEALTH_MAX_PAGES_LIMIT = 1_000;

export interface HealthMetricQuery {
  readonly kind: HealthMetricKind;
  /** Explicit UTC instant: `YYYY-MM-DDTHH:MM:SSZ`. */
  readonly startTime: string;
  /** Explicit UTC instant: exclusive end of the timeline. */
  readonly endTime: string;
  readonly granularity: HealthGranularity;
  readonly dimensions?: readonly string[];
  readonly metrics?: readonly string[];
}

export interface HealthWindow {
  readonly startTimeUtc: string;
  readonly endTimeUtc: string;
  readonly granularity: HealthGranularity;
}

export interface HealthTimelineSpec {
  readonly aggregationPeriod: HealthGranularity;
  readonly startTime: HealthDateTime;
  readonly endTime: HealthDateTime;
}

export interface ValidatedHealthMetricQuery {
  readonly kind: HealthMetricKind;
  readonly toolName: string;
  readonly window: HealthWindow;
  readonly dimensions: readonly HealthDimension[];
  readonly metrics: readonly HealthMetricName[];
  readonly timelineSpec: HealthTimelineSpec;
}

export interface HealthDimensionValue {
  readonly name: HealthDimension;
  readonly value: string;
  readonly valueType: "string" | "int64";
  readonly valueLabel?: string;
}

export interface HealthMetricValue {
  readonly metric: HealthMetricName;
  readonly value: string;
  readonly unit: HealthMetricUnit;
  readonly confidenceInterval?: {
    readonly lowerBound?: string;
    readonly upperBound?: string;
  };
}

export interface HealthMetricPoint {
  readonly startTimeUtc: string;
  readonly aggregationPeriod: HealthGranularity;
  readonly dimensions: readonly HealthDimensionValue[];
  readonly metrics: readonly HealthMetricValue[];
}

export interface HealthFreshnessEntry {
  readonly aggregationPeriod: string;
  readonly latestEndTimeUtc: string;
}

export interface HealthMetricSeries {
  readonly kind: HealthMetricKind;
  readonly toolName: string;
  readonly window: HealthWindow;
  readonly dimensions: readonly HealthDimension[];
  readonly metrics: readonly HealthMetricName[];
  readonly freshness: readonly HealthFreshnessEntry[];
  readonly points: readonly HealthMetricPoint[];
  readonly pageCount: number;
  readonly rowCount: number;
}

function invalidArgument(message: string): HealthError {
  return new HealthError(message, "INVALID_ARGUMENT");
}

function remoteInvalid(message: string): HealthError {
  return new HealthError(message, "REMOTE_DATA_INVALID");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isHealthMetricKind(value: unknown): value is HealthMetricKind {
  return typeof value === "string" && HEALTH_METRIC_KINDS.some((kind) => kind === value);
}

function isHealthDimension(value: unknown): value is HealthDimension {
  return typeof value === "string" && HEALTH_DIMENSIONS.some((name) => name === value);
}

function isHealthMetricName(value: unknown): value is HealthMetricName {
  return typeof value === "string" && HEALTH_METRIC_NAMES.some((name) => name === value);
}

function validateStringList(
  value: unknown,
  field: string,
  isValidEntry: (entry: unknown) => boolean,
  describe: string,
): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw invalidArgument(`${field} must be an array of ${describe}.`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (!isValidEntry(entry)) {
      throw invalidArgument(`${field} contains an unsupported entry: ${JSON.stringify(entry)}.`);
    }
    const name = entry as string;
    if (seen.has(name)) {
      throw invalidArgument(`${field} contains duplicate entry "${name}".`);
    }
    seen.add(name);
    out.push(name);
  }
  return Object.freeze(out);
}

/** Validate and freeze an operator/model-supplied health metric query. */
export function validateHealthMetricQuery(input: HealthMetricQuery): ValidatedHealthMetricQuery {
  if (!isRecord(input)) {
    throw invalidArgument("Health metric query must be an object.");
  }
  if (!isHealthMetricKind(input.kind)) {
    throw invalidArgument(
      `Unsupported health metric kind. Supported kinds: ${HEALTH_METRIC_KINDS.join(", ")}.`,
    );
  }
  const spec = HEALTH_METRIC_SPECS[input.kind];
  const granularity = input.granularity;
  if (
    typeof granularity !== "string" ||
    !spec.granularities.some((supported) => supported === granularity)
  ) {
    throw invalidArgument(
      `granularity must be one of ${spec.granularities.join(", ")} for ${input.kind}.`,
    );
  }

  const startMs = parseUtcInstant(input.startTime, "startTime");
  const endMs = parseUtcInstant(input.endTime, "endTime");
  if (startMs >= endMs) {
    throw invalidArgument("startTime must be strictly earlier than endTime.");
  }

  const dimensions = validateStringList(
    input.dimensions,
    "dimensions",
    isHealthDimension,
    `supported dimensions (${HEALTH_DIMENSIONS.join(", ")})`,
  ) as readonly HealthDimension[];
  const metrics =
    input.metrics === undefined
      ? Object.freeze([spec.primaryMetric])
      : (validateStringList(
          input.metrics,
          "metrics",
          isHealthMetricName,
          `supported metric names (${spec.metrics.join(", ")})`,
        ) as readonly HealthMetricName[]);
  for (const metric of metrics) {
    if (!spec.metrics.some((supported) => supported === metric)) {
      throw invalidArgument(`metric "${metric}" is not supported for ${input.kind}.`);
    }
  }

  return Object.freeze({
    kind: input.kind,
    toolName: spec.toolName,
    window: Object.freeze({
      startTimeUtc: formatUtcInstant(startMs),
      endTimeUtc: formatUtcInstant(endMs),
      granularity,
    }),
    dimensions,
    metrics,
    timelineSpec: Object.freeze({
      aggregationPeriod: granularity,
      startTime: buildQueryBoundary(startMs, granularity),
      endTime: buildQueryBoundary(endMs, granularity),
    }),
  });
}

/** Google `google.type.Decimal` values are exact decimal strings. */
const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** True when `value` is an exact decimal string (never parsed to a float). */
export function isHealthDecimalString(value: unknown): boolean {
  return typeof value === "string" && DECIMAL_PATTERN.test(value.trim());
}

function requireDecimalString(value: unknown, field: string): string {
  if (!isHealthDecimalString(value) || typeof value !== "string") {
    throw remoteInvalid(`Remote metric value "${field}" is not a valid decimal string.`);
  }
  return value;
}

function readDecimalField(value: unknown, field: string): string {
  if (!isRecord(value)) {
    throw remoteInvalid(`Remote decimal "${field}" is not an object.`);
  }
  return requireDecimalString(value.value, field);
}

function normalizeDimensionValue(
  value: unknown,
  requested: readonly HealthDimension[],
): HealthDimensionValue {
  if (!isRecord(value)) {
    throw remoteInvalid("Remote dimension entry is not an object.");
  }
  const name = value.dimension;
  if (!isHealthDimension(name) || !requested.some((entry) => entry === name)) {
    throw remoteInvalid("Remote row returned a dimension that was not requested.");
  }
  const hasString = value.stringValue !== undefined && value.stringValue !== null;
  const hasInt64 = value.int64Value !== undefined && value.int64Value !== null;
  if (hasString === hasInt64) {
    throw remoteInvalid(
      `Remote dimension "${name}" must carry exactly one of stringValue or int64Value.`,
    );
  }
  const rawValue = hasString ? value.stringValue : value.int64Value;
  if (typeof rawValue !== "string" || rawValue.trim() === "") {
    throw remoteInvalid(`Remote dimension "${name}" has an empty value.`);
  }
  if (hasInt64 && !/^-?\d+$/.test(rawValue)) {
    throw remoteInvalid(`Remote dimension "${name}" int64 value is not an integer string.`);
  }
  let valueLabel: string | undefined;
  if (value.valueLabel !== undefined && value.valueLabel !== null) {
    if (typeof value.valueLabel !== "string" || value.valueLabel.trim() === "") {
      throw remoteInvalid(`Remote dimension "${name}" has an invalid valueLabel.`);
    }
    valueLabel = value.valueLabel;
  }
  return Object.freeze({
    name,
    value: rawValue,
    valueType: hasString ? ("string" as const) : ("int64" as const),
    ...(valueLabel !== undefined ? { valueLabel } : {}),
  });
}

function normalizeMetricValue(
  value: unknown,
  allowed: readonly HealthMetricName[],
): HealthMetricValue {
  if (!isRecord(value)) {
    throw remoteInvalid("Remote metric entry is not an object.");
  }
  const metric = value.metric;
  if (!isHealthMetricName(metric) || !allowed.some((entry) => entry === metric)) {
    throw remoteInvalid("Remote row returned a metric that was not requested.");
  }
  const decimalValue = readDecimalField(value.decimalValue, metric);

  let confidenceInterval: HealthMetricValue["confidenceInterval"];
  const rawInterval = value.decimalValueConfidenceInterval;
  if (rawInterval !== undefined && rawInterval !== null) {
    if (!isRecord(rawInterval)) {
      throw remoteInvalid(`Remote confidence interval for "${metric}" is not an object.`);
    }
    const lowerBound =
      rawInterval.lowerBound === undefined || rawInterval.lowerBound === null
        ? undefined
        : readDecimalField(rawInterval.lowerBound, `${metric}.lowerBound`);
    const upperBound =
      rawInterval.upperBound === undefined || rawInterval.upperBound === null
        ? undefined
        : readDecimalField(rawInterval.upperBound, `${metric}.upperBound`);
    confidenceInterval = Object.freeze({
      ...(lowerBound !== undefined ? { lowerBound } : {}),
      ...(upperBound !== undefined ? { upperBound } : {}),
    });
  }

  return Object.freeze({
    metric,
    value: decimalValue,
    unit: HEALTH_METRIC_UNITS[metric],
    ...(confidenceInterval !== undefined ? { confidenceInterval } : {}),
  });
}

function normalizeRow(row: unknown, context: ValidatedHealthMetricQuery): HealthMetricPoint {
  if (!isRecord(row)) {
    throw remoteInvalid("Remote metrics row is not an object.");
  }

  const granularity = context.window.granularity;
  if (row.aggregationPeriod !== undefined && row.aggregationPeriod !== null) {
    if (row.aggregationPeriod !== granularity) {
      throw remoteInvalid("Remote row aggregationPeriod does not match the requested granularity.");
    }
  }

  const fallbackZone =
    granularity === "HOURLY" ? HOURLY_AGGREGATION_TIME_ZONE : DAILY_AGGREGATION_TIME_ZONE;
  const { epochMs } = parseRemoteDateTime(row.startTime, fallbackZone);

  let dimensionEntries: readonly unknown[] = [];
  const rawDimensions = row.dimensions;
  if (rawDimensions !== undefined && rawDimensions !== null) {
    if (!Array.isArray(rawDimensions)) {
      throw remoteInvalid('Remote row "dimensions" is not an array.');
    }
    dimensionEntries = rawDimensions;
  }
  const dimensions: HealthDimensionValue[] = [];
  const seenDimensions = new Set<string>();
  for (const entry of dimensionEntries) {
    const normalized = normalizeDimensionValue(entry, context.dimensions);
    if (seenDimensions.has(normalized.name)) {
      throw remoteInvalid(`Remote row repeats dimension "${normalized.name}".`);
    }
    seenDimensions.add(normalized.name);
    dimensions.push(normalized);
  }

  let metricEntries: readonly unknown[] = [];
  const rawMetrics = row.metrics;
  if (rawMetrics !== undefined && rawMetrics !== null) {
    if (!Array.isArray(rawMetrics)) {
      throw remoteInvalid('Remote row "metrics" is not an array.');
    }
    metricEntries = rawMetrics;
  }
  const metrics: HealthMetricValue[] = [];
  const seenMetrics = new Set<string>();
  for (const entry of metricEntries) {
    const normalized = normalizeMetricValue(entry, context.metrics);
    if (seenMetrics.has(normalized.metric)) {
      throw remoteInvalid(`Remote row repeats metric "${normalized.metric}".`);
    }
    seenMetrics.add(normalized.metric);
    metrics.push(normalized);
  }
  if (metrics.length === 0) {
    throw remoteInvalid("Remote row carries no metric values.");
  }

  return Object.freeze({
    startTimeUtc: formatUtcInstant(epochMs),
    aggregationPeriod: granularity,
    dimensions: Object.freeze(dimensions),
    metrics: Object.freeze(metrics),
  });
}

/** Normalize one page of untrusted rows. Row order is preserved exactly. */
export function normalizeHealthRows(
  rows: unknown,
  context: ValidatedHealthMetricQuery,
): readonly HealthMetricPoint[] {
  if (!Array.isArray(rows)) {
    throw remoteInvalid('Remote response "rows" is not an array.');
  }
  const points: HealthMetricPoint[] = [];
  for (const row of rows) {
    points.push(normalizeRow(row, context));
  }
  return Object.freeze(points);
}

/**
 * Normalize the metric-set resource's freshness summary (the only place the
 * Reporting API exposes data freshness). An absent summary is valid and yields
 * `[]`; a present but malformed summary fails closed.
 */
export function parseHealthFreshness(metricSet: unknown): readonly HealthFreshnessEntry[] {
  if (!isRecord(metricSet)) {
    throw remoteInvalid("Metric-set response is not an object.");
  }
  const info = metricSet.freshnessInfo;
  if (info === undefined || info === null) return Object.freeze([]);
  if (!isRecord(info)) {
    throw remoteInvalid('Metric-set "freshnessInfo" is not an object.');
  }
  const list = info.freshnesses;
  if (list === undefined || list === null) return Object.freeze([]);
  if (!Array.isArray(list)) {
    throw remoteInvalid('Metric-set "freshnesses" is not an array.');
  }
  const seen = new Set<string>();
  const out: HealthFreshnessEntry[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) {
      throw remoteInvalid("Metric-set freshness entry is not an object.");
    }
    const aggregationPeriod = entry.aggregationPeriod;
    if (typeof aggregationPeriod !== "string" || aggregationPeriod.trim() === "") {
      throw remoteInvalid("Metric-set freshness entry has no aggregation period.");
    }
    if (seen.has(aggregationPeriod)) {
      throw remoteInvalid(
        `Metric-set freshness repeats aggregation period "${aggregationPeriod}".`,
      );
    }
    seen.add(aggregationPeriod);
    const fallback =
      aggregationPeriod === "HOURLY"
        ? "UTC"
        : aggregationPeriod === "DAILY"
          ? "America/Los_Angeles"
          : undefined;
    const { epochMs } = parseRemoteDateTime(entry.latestEndTime, fallback);
    out.push(
      Object.freeze({
        aggregationPeriod,
        latestEndTimeUtc: formatUtcInstant(epochMs),
      }),
    );
  }
  return Object.freeze(out);
}

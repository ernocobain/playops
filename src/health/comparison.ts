/**
 * Phase 5.2 — deterministic App Health baseline comparison.
 *
 * The roadmap calls this the "Anomaly summary tool". PlayOps implements it as a
 * **factual baseline-deviation comparison**: it reports observed change
 * (increased / decreased / unchanged / incomparable) with exact numeric deltas.
 * It is explicitly NOT an alert decision — there is no threshold, no severity,
 * no config-driven policy and no alerting here; Phase 5.4 owns those.
 *
 * Comparison semantics (documented, deterministic):
 * - CURRENT and BASELINE are two explicit windows. Nothing is derived ("previous
 *   week" or similar) inside the core.
 * - Windows must be *comparable*: same metric kind, same granularity, identical
 *   requested metric names, identical requested dimension sets, equal duration
 *   measured in aggregation periods, and each window individually valid. Equal
 *   duration is required and enforced (`INCOMPATIBLE_WINDOWS` otherwise); a
 *   1-day window is never compared against a 28-day window.
 * - **No rate aggregation.** Reporting rate metrics are percentages of distinct
 *   users; a mean of daily points would be statistically misleading because the
 *   underlying user populations differ, and the API publishes no window-level
 *   aggregate for these metric sets. Phase 5.2 therefore performs no reduction:
 *   points are paired by *period position* within the window, which tolerates
 *   gaps without shifting alignment. No weighted aggregate is synthesized from
 *   insufficient information, and no value is ever rescaled.
 * - Rows are matched by a canonical, order-independent dimension key (sorted
 *   `name=value` pairs, exact string and int64 text preserved); a dimension group
 *   present on only one side is reported as unmatched, never compared, and a
 *   point from one platform is never compared against another because
 *   timestamps align.
 * - Only the same exact metric name is compared; similar names are not treated
 *   as equivalent.
 * - Missing data is never zero: an empty side yields an explicit
 *   unavailable/incomparable entry with the missing side named.
 */
import {
  formatHealthDecimal,
  parseHealthDecimal,
  isZeroHealthDecimal,
  relativeDeltaPercent,
  subtractHealthDecimals,
} from "./decimal.js";
import { HealthError } from "./errors.js";
import {
  HEALTH_METRIC_KINDS,
  HEALTH_METRIC_UNITS,
  type HealthDimension,
  type HealthDimensionValue,
  type HealthFreshnessEntry,
  type HealthGranularity,
  type HealthMetricKind,
  type HealthMetricName,
  type HealthMetricPoint,
  type HealthMetricSeries,
  type HealthMetricUnit,
  type HealthWindow,
} from "./index.js";
import { DAILY_AGGREGATION_TIME_ZONE, parseUtcInstant, zonedParts } from "./time.js";

/** Roadmap 5.2 identity: the one Phase 5.2 runtime tool. */
export const HEALTH_COMPARISON_TOOL_NAME = "health.compare_to_baseline";

export const HEALTH_CHANGE_DIRECTIONS = Object.freeze([
  "increased",
  "decreased",
  "unchanged",
  "incomparable",
] as const);
export type HealthChangeDirection = (typeof HEALTH_CHANGE_DIRECTIONS)[number];

export const HEALTH_COMPARISON_REASONS = Object.freeze([
  "comparable",
  "baseline-zero",
  "current-unavailable",
  "baseline-unavailable",
  "both-unavailable",
] as const);
export type HealthComparisonReason = (typeof HEALTH_COMPARISON_REASONS)[number];

/** Display labels for the deterministic renderer. */
export const HEALTH_KIND_LABELS: Readonly<Record<HealthMetricKind, string>> = Object.freeze({
  crash_rate: "Crash rate",
  anr_rate: "ANR rate",
  excessive_wakeup_rate: "Excessive wakeups",
});

export interface HealthComparisonValue {
  readonly metric: HealthMetricName;
  readonly unit: HealthMetricUnit;
  readonly currentValue?: string;
  readonly baselineValue?: string;
  /** Exact decimal string in the same scale as the reported values. */
  readonly absoluteDelta?: string;
  /** Signed percent, six significant digits; absent when the baseline is zero. */
  readonly relativeDeltaPercent?: string;
  readonly direction: HealthChangeDirection;
  readonly reason: HealthComparisonReason;
}

export interface HealthComparisonEntry {
  /** Canonical, order-independent dimension identity (`""` when none requested). */
  readonly dimensionKey: string;
  readonly dimensions: readonly HealthDimensionValue[];
  /** Position of the aggregation period inside the window; `null` when neither side had a point. */
  readonly periodIndex: number | null;
  readonly currentStartTimeUtc?: string;
  readonly baselineStartTimeUtc?: string;
  readonly values: readonly HealthComparisonValue[];
}

export interface HealthComparisonSection {
  readonly kind: HealthMetricKind;
  /** Phase 5.1 fetcher tool name for this metric kind. */
  readonly toolName: string;
  readonly metrics: readonly HealthMetricName[];
  readonly granularity: HealthGranularity;
  readonly current: HealthWindow;
  readonly baseline: HealthWindow;
  readonly freshness: readonly HealthFreshnessEntry[];
  readonly currentBeyondFreshness: boolean;
  readonly baselineBeyondFreshness: boolean;
  readonly currentRowCount: number;
  readonly baselineRowCount: number;
  readonly currentPageCount: number;
  readonly baselinePageCount: number;
  readonly entries: readonly HealthComparisonEntry[];
}

export interface HealthComparison {
  readonly toolName: string;
  readonly kinds: readonly HealthMetricKind[];
  readonly granularity: HealthGranularity;
  readonly dimensions: readonly HealthDimension[];
  readonly current: HealthWindow;
  readonly baseline: HealthWindow;
  readonly sections: readonly HealthComparisonSection[];
  readonly entryCount: number;
  /** Values with a defined comparison (including a zero-baseline comparison). */
  readonly comparedValueCount: number;
  readonly unavailableValueCount: number;
  readonly pageCount: number;
  readonly rowCount: number;
}

export interface HealthComparisonInput {
  /** One validated Phase 5.1 series per metric kind, for the current window. */
  readonly current: readonly HealthMetricSeries[];
  /** One validated Phase 5.1 series per metric kind, for the baseline window. */
  readonly baseline: readonly HealthMetricSeries[];
}

function incompatible(message: string): HealthError {
  return new HealthError(message, "INCOMPATIBLE_WINDOWS");
}

function duplicateIdentity(message: string): HealthError {
  return new HealthError(message, "DUPLICATE_IDENTITY");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localDayNumber(epochMs: number): number {
  const parts = zonedParts(epochMs, DAILY_AGGREGATION_TIME_ZONE);
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000);
}

/** Number of aggregation periods a window spans (HOURLY: hours, DAILY: local days). */
export function healthPeriodCount(window: HealthWindow): number {
  const start = parseUtcInstant(window.startTimeUtc, "startTime");
  const end = parseUtcInstant(window.endTimeUtc, "endTime");
  if (end <= start) throw incompatible("Comparison windows must be positive-length.");
  if (window.granularity === "HOURLY") {
    const hours = (end - start) / 3_600_000;
    if (!Number.isInteger(hours)) {
      throw incompatible("HOURLY comparison windows must span whole hours.");
    }
    return hours;
  }
  const days = localDayNumber(end) - localDayNumber(start);
  if (days < 1) throw incompatible("DAILY comparison windows must span whole local days.");
  return days;
}

/**
 * Position of a point inside its own window, counted in aggregation periods.
 * Returns `undefined` when the point cannot be positioned (it precedes the
 * window start or is not period-aligned).
 */
export function healthPeriodIndex(
  pointStartTimeUtc: string,
  window: HealthWindow,
): number | undefined {
  const start = parseUtcInstant(window.startTimeUtc, "startTime");
  const point = parseUtcInstant(pointStartTimeUtc, "pointStartTime");
  if (window.granularity === "HOURLY") {
    const difference = (point - start) / 3_600_000;
    if (!Number.isInteger(difference) || difference < 0) return undefined;
    return difference;
  }
  const difference = localDayNumber(point) - localDayNumber(start);
  return difference >= 0 ? difference : undefined;
}

/** Canonical, order-independent dimension identity. */
export function healthDimensionKey(dimensions: readonly HealthDimensionValue[]): string {
  const pairs: string[] = [];
  const seen = new Set<string>();
  for (const dimension of dimensions) {
    if (seen.has(dimension.name)) {
      throw duplicateIdentity(`Comparison row repeats dimension "${dimension.name}".`);
    }
    seen.add(dimension.name);
    pairs.push(`${dimension.name}=${dimension.value}`);
  }
  return pairs.sort().join("|");
}

function assertSeriesShape(series: unknown, side: string): HealthMetricSeries {
  if (!isRecord(series)) throw incompatible(`${side} comparison input must be a series object.`);
  const kind = series["kind"];
  if (typeof kind !== "string" || !HEALTH_METRIC_KINDS.some((entry) => entry === kind)) {
    throw incompatible(`${side} comparison input has an unsupported metric kind.`);
  }
  const window = series["window"];
  if (
    !isRecord(window) ||
    typeof window["startTimeUtc"] !== "string" ||
    typeof window["endTimeUtc"] !== "string"
  ) {
    throw incompatible(`${side} comparison input has an invalid window.`);
  }
  if (window["granularity"] !== "DAILY" && window["granularity"] !== "HOURLY") {
    throw incompatible(`${side} comparison input has an unsupported granularity.`);
  }
  if (!Array.isArray(series["points"])) {
    throw incompatible(`${side} comparison input has no points array.`);
  }
  if (!Array.isArray(series["metrics"]) || series["metrics"].length === 0) {
    throw incompatible(`${side} comparison input has no metrics.`);
  }
  if (!Array.isArray(series["dimensions"])) {
    throw incompatible(`${side} comparison input has no dimensions array.`);
  }
  return series as unknown as HealthMetricSeries;
}

function sameNameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((entry, index) => entry === rightSorted[index]);
}

function freshnessBeyond(
  window: HealthWindow,
  freshness: readonly HealthFreshnessEntry[],
): boolean {
  const entry = freshness.find((item) => item.aggregationPeriod === window.granularity);
  if (!entry) return false;
  let latest: number;
  try {
    latest = parseUtcInstant(entry.latestEndTimeUtc, "latestEndTime");
  } catch {
    throw new HealthError(
      "Comparison freshness metadata carries an invalid timestamp.",
      "REMOTE_DATA_INVALID",
    );
  }
  return parseUtcInstant(window.endTimeUtc, "endTime") > latest;
}

function metricValueIn(
  point: HealthMetricPoint | undefined,
  metric: HealthMetricName,
): string | undefined {
  if (!point) return undefined;
  const match = point.metrics.find((entry) => entry.metric === metric);
  return match?.value;
}

function compareValues(
  currentPoint: HealthMetricPoint | undefined,
  baselinePoint: HealthMetricPoint | undefined,
  metrics: readonly HealthMetricName[],
): readonly HealthComparisonValue[] {
  return Object.freeze(
    metrics.map((metric): HealthComparisonValue => {
      const unit = HEALTH_METRIC_UNITS[metric];
      const currentValue = metricValueIn(currentPoint, metric);
      const baselineValue = metricValueIn(baselinePoint, metric);

      if (currentValue === undefined && baselineValue === undefined) {
        return Object.freeze({
          metric,
          unit,
          direction: "incomparable",
          reason: "both-unavailable",
        });
      }
      if (currentValue === undefined) {
        return Object.freeze({
          metric,
          unit,
          baselineValue,
          direction: "incomparable",
          reason: "current-unavailable",
        });
      }
      if (baselineValue === undefined) {
        return Object.freeze({
          metric,
          unit,
          currentValue,
          direction: "incomparable",
          reason: "baseline-unavailable",
        });
      }

      // Both sides present: exact decimal arithmetic only.
      const currentDecimal = parseHealthDecimal(currentValue);
      const baselineDecimal = parseHealthDecimal(baselineValue);
      const delta = subtractHealthDecimals(currentDecimal, baselineDecimal);
      const direction: HealthChangeDirection = isZeroHealthDecimal(delta)
        ? "unchanged"
        : delta.negative
          ? "decreased"
          : "increased";
      const relative = relativeDeltaPercent(currentDecimal, baselineDecimal);
      return Object.freeze({
        metric,
        unit,
        currentValue,
        baselineValue,
        absoluteDelta: formatHealthDecimal(delta),
        ...(relative !== undefined ? { relativeDeltaPercent: relative } : {}),
        direction,
        reason: isZeroHealthDecimal(baselineDecimal) ? "baseline-zero" : "comparable",
      });
    }),
  );
}

interface IdentityBucket {
  readonly dimensionKey: string;
  readonly dimensions: readonly HealthDimensionValue[];
  readonly periodIndex: number;
  readonly point: HealthMetricPoint;
}

function indexPoints(
  series: HealthMetricSeries,
  side: string,
  periodCount: number,
): Map<string, IdentityBucket> {
  const buckets = new Map<string, IdentityBucket>();
  for (const point of series.points) {
    const dimensionKey = healthDimensionKey(point.dimensions);
    const periodIndex = healthPeriodIndex(point.startTimeUtc, series.window);
    if (periodIndex === undefined || periodIndex >= periodCount) {
      throw new HealthError(
        `${side} comparison input has a point outside its window.`,
        "REMOTE_DATA_INVALID",
      );
    }
    const identity = `${dimensionKey}#${periodIndex}`;
    if (buckets.has(identity)) {
      throw duplicateIdentity("Comparison input repeats the same dimension and period.");
    }
    const dimensions = Object.freeze(
      [...point.dimensions].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      ),
    );
    buckets.set(identity, { dimensionKey, dimensions, periodIndex, point });
  }
  return buckets;
}

function analyzeSection(
  current: HealthMetricSeries,
  baseline: HealthMetricSeries,
): HealthComparisonSection {
  if (current.kind !== baseline.kind) {
    throw incompatible("Comparison windows must use the same metric kind.");
  }
  if (current.window.granularity !== baseline.window.granularity) {
    throw incompatible("Comparison windows must use the same aggregation period.");
  }
  if (!sameNameSet(current.metrics, baseline.metrics)) {
    throw incompatible("Comparison windows must request the same metric names.");
  }
  if (!sameNameSet(current.dimensions, baseline.dimensions)) {
    throw incompatible("Comparison windows must request the same dimensions.");
  }
  const periodCount = healthPeriodCount(current.window);
  if (healthPeriodCount(baseline.window) !== periodCount) {
    throw incompatible(
      "Comparison windows must have equal duration measured in aggregation periods.",
    );
  }

  const metrics = Object.freeze([...current.metrics]);
  const currentBuckets = indexPoints(current, "current", periodCount);
  const baselineBuckets = indexPoints(baseline, "baseline", periodCount);

  const identities = [...new Set([...currentBuckets.keys(), ...baselineBuckets.keys()])];
  const ordered = identities
    .map((identity) => ({
      identity,
      bucket: currentBuckets.get(identity) ?? baselineBuckets.get(identity),
      periodIndex:
        (currentBuckets.get(identity) ?? baselineBuckets.get(identity))?.periodIndex ?? 0,
    }))
    .sort((left, right) => {
      const leftKey = left.bucket?.dimensionKey ?? "";
      const rightKey = right.bucket?.dimensionKey ?? "";
      if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
      return left.periodIndex - right.periodIndex;
    });

  const entries: HealthComparisonEntry[] = [];
  if (ordered.length === 0) {
    // Neither window observed any point: an explicit unavailable entry, never a zero.
    entries.push(
      Object.freeze({
        dimensionKey: "",
        dimensions: Object.freeze([]),
        periodIndex: null,
        values: compareValues(undefined, undefined, metrics),
      }),
    );
  } else {
    for (const item of ordered) {
      const currentPoint = currentBuckets.get(item.identity)?.point;
      const baselinePoint = baselineBuckets.get(item.identity)?.point;
      const dimensions = item.bucket?.dimensions ?? Object.freeze([]);
      entries.push(
        Object.freeze({
          dimensionKey: item.bucket?.dimensionKey ?? "",
          dimensions,
          periodIndex: item.periodIndex,
          ...(currentPoint !== undefined ? { currentStartTimeUtc: currentPoint.startTimeUtc } : {}),
          ...(baselinePoint !== undefined
            ? { baselineStartTimeUtc: baselinePoint.startTimeUtc }
            : {}),
          values: compareValues(currentPoint, baselinePoint, metrics),
        }),
      );
    }
  }

  const freshness = Object.freeze([...(current.freshness ?? [])]);
  return Object.freeze({
    kind: current.kind,
    toolName: current.toolName,
    metrics,
    granularity: current.window.granularity,
    current: current.window,
    baseline: baseline.window,
    freshness,
    currentBeyondFreshness: freshnessBeyond(current.window, freshness),
    baselineBeyondFreshness: freshnessBeyond(baseline.window, freshness),
    currentRowCount: current.rowCount,
    baselineRowCount: baseline.rowCount,
    currentPageCount: current.pageCount,
    baselinePageCount: baseline.pageCount,
    entries: Object.freeze(entries),
  });
}

/**
 * Compare two explicitly requested windows. Pure: it never mutates its input and
 * is deterministic for identical input.
 */
export function analyzeHealthComparison(input: HealthComparisonInput): HealthComparison {
  if (!isRecord(input) || !Array.isArray(input.current) || !Array.isArray(input.baseline)) {
    throw incompatible("Comparison requires current and baseline series collections.");
  }
  if (input.current.length === 0 || input.current.length !== input.baseline.length) {
    throw incompatible("Comparison requires the same metric kinds on both sides.");
  }

  const currentByKind = new Map<HealthMetricKind, HealthMetricSeries>();
  const baselineByKind = new Map<HealthMetricKind, HealthMetricSeries>();
  for (const series of input.current) {
    const validated = assertSeriesShape(series, "current");
    if (currentByKind.has(validated.kind)) {
      throw incompatible("Comparison input repeats a metric kind.");
    }
    currentByKind.set(validated.kind, validated);
  }
  for (const series of input.baseline) {
    const validated = assertSeriesShape(series, "baseline");
    if (baselineByKind.has(validated.kind)) {
      throw incompatible("Comparison input repeats a metric kind.");
    }
    baselineByKind.set(validated.kind, validated);
  }
  for (const kind of currentByKind.keys()) {
    if (!baselineByKind.has(kind)) {
      throw incompatible("Comparison requires the same metric kinds on both sides.");
    }
  }
  for (const kind of baselineByKind.keys()) {
    if (!currentByKind.has(kind)) {
      throw incompatible("Comparison requires the same metric kinds on both sides.");
    }
  }

  const kinds = Object.freeze(HEALTH_METRIC_KINDS.filter((kind) => currentByKind.has(kind)));
  const sections: HealthComparisonSection[] = [];
  for (const kind of kinds) {
    const current = currentByKind.get(kind);
    const baseline = baselineByKind.get(kind);
    if (!current || !baseline) throw incompatible("Comparison requires both windows per kind.");
    sections.push(analyzeSection(current, baseline));
  }

  const first = sections[0];
  if (!first) throw incompatible("Comparison requires at least one metric kind.");
  for (const section of sections) {
    if (section.granularity !== first.granularity) {
      throw incompatible("Comparison windows must share one aggregation period.");
    }
    if (
      section.current.startTimeUtc !== first.current.startTimeUtc ||
      section.current.endTimeUtc !== first.current.endTimeUtc ||
      section.baseline.startTimeUtc !== first.baseline.startTimeUtc ||
      section.baseline.endTimeUtc !== first.baseline.endTimeUtc
    ) {
      throw incompatible("Comparison requires identical windows for every metric kind.");
    }
  }

  let entryCount = 0;
  let comparedValueCount = 0;
  let unavailableValueCount = 0;
  let pageCount = 0;
  let rowCount = 0;
  for (const section of sections) {
    entryCount += section.entries.length;
    pageCount += section.currentPageCount + section.baselinePageCount;
    rowCount += section.currentRowCount + section.baselineRowCount;
    for (const entry of section.entries) {
      for (const value of entry.values) {
        if (value.reason === "comparable" || value.reason === "baseline-zero") {
          comparedValueCount += 1;
        } else {
          unavailableValueCount += 1;
        }
      }
    }
  }

  const currentKind = currentByKind.get(first.kind);
  const baselineKind = baselineByKind.get(first.kind);
  if (!currentKind || !baselineKind)
    throw incompatible("Comparison requires both windows per kind.");

  return Object.freeze({
    toolName: HEALTH_COMPARISON_TOOL_NAME,
    kinds,
    granularity: first.granularity,
    dimensions: Object.freeze([...currentKind.dimensions]),
    current: first.current,
    baseline: first.baseline,
    sections: Object.freeze(sections),
    entryCount,
    comparedValueCount,
    unavailableValueCount,
    pageCount,
    rowCount,
  });
}

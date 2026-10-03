/** Phase 5.4 — pure exact reported-scale rules and per-point evaluation.
 * No I/O, clock, LLM, aggregation, freshness policy, severity or rescaling.
 */
import { parseHealthThresholdConfig, parseReportedHealthThreshold } from "../config/health.js";
import type { HealthConfig } from "../config/types.js";
import { compareHealthDecimals, parseHealthDecimal } from "./decimal.js";
import {
  HealthError,
  HEALTH_METRIC_KINDS,
  HEALTH_METRIC_SPECS,
  HEALTH_METRIC_UNITS,
  isHealthDecimalString,
  validateHealthMetricQuery,
  type HealthDimensionValue,
  type HealthMetricKind,
  type HealthMetricPoint,
  type HealthMetricSeries,
  type HealthWindow,
} from "./index.js";

export const HEALTH_THRESHOLDS_TOOL_NAME = "health.check_thresholds";
export const HEALTH_THRESHOLD_BINDINGS = Object.freeze([
  Object.freeze({
    metricKind: "crash_rate",
    metricName: "crashRate",
    configField: "crashRateReportedThreshold",
  }),
  Object.freeze({
    metricKind: "anr_rate",
    metricName: "anrRate",
    configField: "anrRateReportedThreshold",
  }),
  Object.freeze({
    metricKind: "excessive_wakeup_rate",
    metricName: "excessiveWakeupRate",
    configField: "excessiveWakeupRateReportedThreshold",
  }),
] as const);

type PrimaryMetric = (typeof HEALTH_THRESHOLD_BINDINGS)[number]["metricName"];
export interface HealthThresholdRule {
  readonly metricKind: HealthMetricKind;
  readonly metricName: PrimaryMetric;
  readonly configField: keyof HealthConfig;
  readonly thresholdValue: string;
  readonly operator: ">";
}

export interface HealthThresholdEvaluation {
  readonly metricKind: HealthMetricKind;
  readonly metricName: PrimaryMetric;
  readonly observedValue: string | null;
  readonly thresholdValue: string;
  readonly operator: ">";
  readonly status: "BREACHED" | "NOT_BREACHED" | "NO_DATA";
  readonly window: HealthWindow | null;
  readonly startTimeUtc: string | null;
  readonly dimensions: readonly HealthDimensionValue[];
}
export type HealthThresholdBreach = HealthThresholdEvaluation & {
  readonly status: "BREACHED";
  readonly observedValue: string;
  readonly startTimeUtc: string;
  readonly window: HealthWindow;
};
export interface HealthThresholdResult {
  readonly status: "DISABLED" | "NO_DATA" | "EVALUATED";
  readonly enabledRuleCount: number;
  readonly evaluatedPointCount: number;
  readonly noDataCount: number;
  readonly evaluations: readonly HealthThresholdEvaluation[];
  readonly breaches: readonly HealthThresholdBreach[];
}

/** Snapshot validated operator settings; null never creates a rule. */
export function buildHealthThresholdRules(
  health: Readonly<HealthConfig>,
): readonly HealthThresholdRule[] {
  const config = parseHealthThresholdConfig(health);
  return Object.freeze(
    HEALTH_THRESHOLD_BINDINGS.flatMap((binding) => {
      const value = config[binding.configField];
      return value === null
        ? []
        : [Object.freeze({ ...binding, thresholdValue: value, operator: ">" as const })];
    }),
  );
}

function compareText(a: string, b: string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Boolean-only guard avoids narrowing readonly domain arrays to any[]. */
function isArray(value: unknown): boolean {
  return Array.isArray(value);
}

function invalidData(): never {
  throw new HealthError(
    "Health threshold source contains invalid normalized data.",
    "REMOTE_DATA_INVALID",
  );
}

function duplicateIdentity(): never {
  throw new HealthError(
    "Health threshold source contains a duplicate identity.",
    "DUPLICATE_IDENTITY",
  );
}

function orderedRules(rules: readonly HealthThresholdRule[]): readonly HealthThresholdRule[] {
  if (!isArray(rules))
    throw new HealthError("Threshold rules must be an array.", "INVALID_ARGUMENT");
  const seen = new Set<HealthMetricKind>();
  for (const rule of rules) {
    const binding = HEALTH_THRESHOLD_BINDINGS.find(
      (entry) => entry.metricKind === rule?.metricKind,
    );
    if (
      !binding ||
      rule.metricName !== binding.metricName ||
      rule.configField !== binding.configField ||
      rule.operator !== ">"
    ) {
      throw new HealthError(
        "Threshold rule must bind one supported primary metric with operator >.",
        "INVALID_ARGUMENT",
      );
    }
    if (seen.has(rule.metricKind)) duplicateIdentity();
    seen.add(rule.metricKind);
    try {
      parseReportedHealthThreshold(rule.thresholdValue, "Threshold rule", false);
    } catch {
      throw new HealthError("Threshold rule value is invalid.", "INVALID_ARGUMENT");
    }
  }
  return [...rules].sort(
    (a, b) => HEALTH_METRIC_KINDS.indexOf(a.metricKind) - HEALTH_METRIC_KINDS.indexOf(b.metricKind),
  );
}

function validateSeries(source: HealthMetricSeries): void {
  if (
    !source ||
    !HEALTH_METRIC_KINDS.includes(source.kind) ||
    !source.window ||
    !isArray(source.points) ||
    !isArray(source.dimensions) ||
    !isArray(source.metrics)
  )
    invalidData();
  if (source.toolName !== HEALTH_METRIC_SPECS[source.kind].toolName) invalidData();
  try {
    validateHealthMetricQuery({
      kind: source.kind,
      startTime: source.window.startTimeUtc,
      endTime: source.window.endTimeUtc,
      granularity: source.window.granularity,
      dimensions: source.dimensions,
      metrics: source.metrics,
    });
  } catch {
    invalidData();
  }
}

function safeDimensions(
  source: HealthMetricSeries,
  point: HealthMetricPoint,
): readonly HealthDimensionValue[] {
  if (
    !point ||
    point.aggregationPeriod !== source.window.granularity ||
    !isArray(point.dimensions) ||
    !isArray(point.metrics)
  )
    invalidData();
  try {
    validateHealthMetricQuery({
      kind: source.kind,
      startTime: point.startTimeUtc,
      endTime: source.window.endTimeUtc,
      granularity: source.window.granularity,
    });
  } catch {
    invalidData();
  }
  if (point.startTimeUtc < source.window.startTimeUtc) invalidData();
  const names = new Set<string>();
  const dimensions: HealthDimensionValue[] = [];
  for (const dimension of point.dimensions) {
    if (
      !dimension ||
      !source.dimensions.includes(dimension.name) ||
      names.has(dimension.name) ||
      typeof dimension.value !== "string" ||
      !dimension.value.trim() ||
      (dimension.valueType !== "string" && dimension.valueType !== "int64")
    )
      invalidData();
    if (dimension.valueType === "int64" && !/^[+-]?\d+$/.test(dimension.value)) invalidData();
    names.add(dimension.name);
    dimensions.push(
      Object.freeze({
        name: dimension.name,
        value: dimension.value,
        valueType: dimension.valueType,
      }),
    );
  }
  if (names.size !== source.dimensions.length) invalidData();
  const metrics = new Set<string>();
  for (const metric of point.metrics) {
    if (
      !metric ||
      !source.metrics.includes(metric.metric) ||
      !HEALTH_METRIC_SPECS[source.kind].metrics.includes(metric.metric) ||
      metrics.has(metric.metric) ||
      !isHealthDecimalString(metric.value) ||
      metric.unit !== HEALTH_METRIC_UNITS[metric.metric]
    )
      invalidData();
    parseHealthDecimal(metric.value);
    metrics.add(metric.metric);
  }
  return Object.freeze(dimensions.sort((a, b) => compareText(a.name, b.name)));
}

export function evaluateHealthThresholds(
  series: readonly HealthMetricSeries[],
  rules: readonly HealthThresholdRule[],
): HealthThresholdResult {
  const ordered = orderedRules(rules);
  if (!isArray(series)) invalidData();
  const sourceKinds = new Set<HealthMetricKind>();
  for (const source of series) {
    validateSeries(source);
    if (sourceKinds.has(source.kind)) duplicateIdentity();
    sourceKinds.add(source.kind);
  }
  const evaluations: HealthThresholdEvaluation[] = [];
  for (const rule of ordered) {
    const source = series.find((entry) => entry.kind === rule.metricKind);
    const window = source
      ? Object.freeze({
          startTimeUtc: source.window.startTimeUtc,
          endTimeUtc: source.window.endTimeUtc,
          granularity: source.window.granularity,
        })
      : null;
    if (!source || source.points.length === 0) {
      evaluations.push(
        Object.freeze({
          metricKind: rule.metricKind,
          metricName: rule.metricName,
          thresholdValue: rule.thresholdValue,
          operator: ">",
          status: "NO_DATA",
          observedValue: null,
          window,
          startTimeUtc: null,
          dimensions: Object.freeze([]),
        }),
      );
      continue;
    }
    const identities = new Set<string>();
    const points = source.points
      .map((point) => {
        const dimensions = safeDimensions(source, point);
        const identity = JSON.stringify([
          point.startTimeUtc,
          point.aggregationPeriod,
          dimensions.map((entry) => [entry.name, entry.valueType, entry.value]),
        ]);
        if (identities.has(identity)) duplicateIdentity();
        identities.add(identity);
        return { point, dimensions, identity };
      })
      .sort((a, b) => compareText(a.identity, b.identity));
    const threshold = parseHealthDecimal(rule.thresholdValue);
    for (const { point, dimensions } of points) {
      const metric = point.metrics.find((entry) => entry.metric === rule.metricName);
      const breached =
        metric !== undefined &&
        compareHealthDecimals(parseHealthDecimal(metric.value), threshold) > 0;
      evaluations.push(
        Object.freeze({
          metricKind: rule.metricKind,
          metricName: rule.metricName,
          thresholdValue: rule.thresholdValue,
          operator: ">",
          status: metric === undefined ? "NO_DATA" : breached ? "BREACHED" : "NOT_BREACHED",
          observedValue: metric?.value ?? null,
          window,
          startTimeUtc: point.startTimeUtc,
          dimensions,
        }),
      );
    }
  }
  const evaluatedPointCount = evaluations.filter((entry) => entry.status !== "NO_DATA").length;
  return Object.freeze({
    status: rules.length === 0 ? "DISABLED" : evaluatedPointCount === 0 ? "NO_DATA" : "EVALUATED",
    enabledRuleCount: rules.length,
    evaluatedPointCount,
    noDataCount: evaluations.filter((entry) => entry.status === "NO_DATA").length,
    evaluations: Object.freeze(evaluations),
    breaches: Object.freeze(
      evaluations.filter((entry) => entry.status === "BREACHED") as HealthThresholdBreach[],
    ),
  });
}

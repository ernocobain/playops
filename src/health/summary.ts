/**
 * Phase 5.4 WP2a-2 — read-only `health check` summary provider and status adapter.
 *
 * Reuses the shared `evaluateThresholdWindow` core without importing or calling
 * any audit writer. `recordedAlertCount` is always `0` because it counts durable
 * alerts written by this invocation, not a historical total or breach count.
 */
import type {
  HealthCheckInput,
  HealthCheckSummary,
  HealthCheckSummaryStatus,
} from "../cli/health-check.js";
import type { FetchHealthMetricOptions } from "./fetchers.js";
import type { HealthMetricGateway } from "./gateway.js";
import { HealthError, HEALTH_METRIC_SPECS, type HealthGranularity } from "./index.js";
import { UnsupportedThresholdGranularityError } from "./summary-errors.js";
import { evaluateThresholdWindow } from "./threshold-tool.js";
import type { HealthThresholdResult, HealthThresholdRule } from "./thresholds.js";

export interface HealthSummarySource {
  readSummary(input: HealthCheckInput): Promise<HealthCheckSummary>;
}

export interface HealthSummarySourceOptions {
  readonly rules: readonly HealthThresholdRule[];
  readonly gateway: HealthMetricGateway;
  readonly fetchOptions?: FetchHealthMetricOptions;
}

function inconsistent(): HealthError {
  return new HealthError("Health threshold result is inconsistent.", "INVALID_ARGUMENT");
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isArray(value: unknown): boolean {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertConsistentResult(result: HealthThresholdResult): void {
  if (!isRecord(result)) {
    throw inconsistent();
  }
  if (
    result.status !== "DISABLED" &&
    result.status !== "NO_DATA" &&
    result.status !== "EVALUATED"
  ) {
    throw inconsistent();
  }
  if (
    !isNonNegativeSafeInteger(result.enabledRuleCount) ||
    !isNonNegativeSafeInteger(result.evaluatedPointCount) ||
    !isNonNegativeSafeInteger(result.noDataCount)
  ) {
    throw inconsistent();
  }
  if (!isArray(result.evaluations) || !isArray(result.breaches)) {
    throw inconsistent();
  }
  if (result.breaches.length > result.evaluatedPointCount) {
    throw inconsistent();
  }
  if (result.evaluatedPointCount + result.noDataCount !== result.evaluations.length) {
    throw inconsistent();
  }
  if (result.status === "DISABLED" && result.enabledRuleCount !== 0) {
    throw inconsistent();
  }
  if (
    result.status === "NO_DATA" &&
    (result.enabledRuleCount <= 0 || result.evaluatedPointCount !== 0)
  ) {
    throw inconsistent();
  }
  if (result.status === "EVALUATED" && result.evaluatedPointCount <= 0) {
    throw inconsistent();
  }
  for (const breach of result.breaches as readonly unknown[]) {
    if (!isRecord(breach) || breach.status !== "BREACHED") {
      throw inconsistent();
    }
  }
}

function mapSummaryStatus(result: HealthThresholdResult): HealthCheckSummaryStatus {
  if (result.status === "DISABLED") {
    return "DISABLED";
  }
  if (result.status === "NO_DATA") {
    return "NO_DATA";
  }
  if (result.breaches.length > 0) {
    return "BREACH_DETECTED";
  }
  if (result.noDataCount > 0) {
    return "INCOMPLETE_DATA";
  }
  return "NO_BREACH_OBSERVED";
}

export function toHealthCheckSummary(result: HealthThresholdResult): HealthCheckSummary {
  assertConsistentResult(result);
  const status = mapSummaryStatus(result);
  const recordedAlertCount = 0;
  if (!isNonNegativeSafeInteger(recordedAlertCount)) {
    throw inconsistent();
  }
  return Object.freeze({
    status,
    enabledRuleCount: result.enabledRuleCount,
    evaluatedPointCount: result.evaluatedPointCount,
    noDataCount: result.noDataCount,
    breachedPointCount: result.breaches.length,
    recordedAlertCount,
  });
}

function assertGranularitySupported(
  rules: readonly HealthThresholdRule[],
  granularity: HealthGranularity,
): void {
  if (!isArray(rules) || rules.length === 0) {
    return;
  }
  const unsupportedKinds = rules
    .filter((rule) => !HEALTH_METRIC_SPECS[rule.metricKind]?.granularities.includes(granularity))
    .map((rule) => rule.metricKind);
  if (unsupportedKinds.length > 0) {
    throw new UnsupportedThresholdGranularityError(granularity, unsupportedKinds);
  }
}

export function createHealthSummarySource(
  options: HealthSummarySourceOptions,
): HealthSummarySource {
  const { rules, gateway, fetchOptions } = options;
  return Object.freeze({
    async readSummary(input: HealthCheckInput): Promise<HealthCheckSummary> {
      assertGranularitySupported(rules, input.granularity);
      const result = await evaluateThresholdWindow({ rules, gateway, fetchOptions }, input);
      return toHealthCheckSummary(result);
    },
  });
}

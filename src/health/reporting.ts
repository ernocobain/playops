/**
 * Phase 5.1 — production App Health gateway over the Phase 1.3 Reporting wrapper.
 *
 * Reuses the existing Reporting boundary: no second client, no raw REST, no
 * retry duplication, no new dependency. The existing Phase 1.5 bounded read
 * retry (3 total attempts, generated/Gaxios retry disabled) remains the only
 * retry budget, and mutating retry is never used because every call here is a
 * read.
 *
 * `packageName` and the metric-set resource name are composition-bound; the
 * model can never supply them. Raw generated payloads are handed to the domain
 * as untrusted values and never escape this boundary.
 */
import {
  getAnrRateMetricSet,
  getCrashRateMetricSet,
  getExcessiveWakeupRateMetricSet,
  queryAnrRate,
  queryCrashRate,
  queryExcessiveWakeupRate,
  ReportingError,
  type PlayReportingClient,
  type QueryVitalsInput,
  type QueryVitalsResult,
  type TimelineSpec,
} from "../googleplay/reporting/index.js";
import type { ReadRetryOptions } from "../googleplay/retry/index.js";
import { HealthError, HEALTH_METRIC_SPECS, type HealthMetricKind } from "./index.js";
import type {
  HealthMetricGateway,
  HealthMetricQueryPage,
  HealthMetricQueryRequest,
} from "./gateway.js";
import type { HealthDateTime } from "./time.js";

export interface ReportingHealthGatewayOptions {
  /** Injected retry controls for tests (sleep/clock/random/policy); never a new policy. */
  readonly retry?: ReadRetryOptions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The installed client expects a generated `DateTime`; PlayOps owns the shape. */
function toGoogleDateTime(dateTime: HealthDateTime): Record<string, unknown> {
  return {
    year: dateTime.year,
    month: dateTime.month,
    day: dateTime.day,
    ...(dateTime.hours !== undefined ? { hours: dateTime.hours } : {}),
    ...(dateTime.timeZoneId !== undefined ? { timeZone: { id: dateTime.timeZoneId } } : {}),
  };
}

function toQueryVitalsInput(
  packageName: string,
  request: HealthMetricQueryRequest,
): QueryVitalsInput {
  const timelineSpec = {
    aggregationPeriod: request.timelineSpec.aggregationPeriod,
    startTime: toGoogleDateTime(request.timelineSpec.startTime),
    endTime: toGoogleDateTime(request.timelineSpec.endTime),
  };
  return {
    packageName,
    timelineSpec: timelineSpec as unknown as TimelineSpec,
    dimensions: [...request.dimensions],
    metrics: [...request.metrics],
    pageSize: request.pageSize,
    ...(request.pageToken !== undefined ? { pageToken: request.pageToken } : {}),
  };
}

function readMetricSetFor(
  client: PlayReportingClient,
  packageName: string,
  kind: HealthMetricKind,
  retry: ReadRetryOptions | undefined,
): Promise<unknown> {
  switch (kind) {
    case "crash_rate":
      return getCrashRateMetricSet(client, packageName, retry);
    case "anr_rate":
      return getAnrRateMetricSet(client, packageName, retry);
    case "excessive_wakeup_rate":
      return getExcessiveWakeupRateMetricSet(client, packageName, retry);
    default:
      throw new HealthError(`Unsupported health metric kind.`, "INVALID_ARGUMENT");
  }
}

function queryMetricSetFor(
  client: PlayReportingClient,
  input: QueryVitalsInput,
  kind: HealthMetricKind,
  retry: ReadRetryOptions | undefined,
): Promise<QueryVitalsResult> {
  switch (kind) {
    case "crash_rate":
      return queryCrashRate(client, input, retry);
    case "anr_rate":
      return queryAnrRate(client, input, retry);
    case "excessive_wakeup_rate":
      return queryExcessiveWakeupRate(client, input, retry);
    default:
      throw new HealthError(`Unsupported health metric kind.`, "INVALID_ARGUMENT");
  }
}

/**
 * Confirm the returned metric set is the exact resource PlayOps asked for.
 * A mismatch — or a malformed identity — is a boundary response failure, never
 * something the domain should reinterpret.
 */
function assertMetricSetIdentity(payload: unknown, expectedName: string, operation: string): void {
  if (!isRecord(payload)) {
    throw new ReportingError(`${operation}: response payload is not an object`, "INVALID_RESPONSE");
  }
  const name = payload.name;
  if (name === undefined || name === null) return;
  if (typeof name !== "string" || name !== expectedName) {
    throw new ReportingError(
      `${operation}: response did not match the requested metric-set resource`,
      "INVALID_RESPONSE",
    );
  }
}

/** Build the composition-bound production gateway for the three Phase 5.1 kinds. */
export function createReportingHealthMetricGateway(
  client: PlayReportingClient,
  packageName: string,
  options: ReportingHealthGatewayOptions = {},
): HealthMetricGateway {
  if (typeof packageName !== "string" || packageName.trim() === "") {
    throw new HealthError("Reporting health gateway requires a package name.", "INVALID_ARGUMENT");
  }
  if (!client || typeof client.vitals !== "object" || client.vitals === null) {
    throw new HealthError(
      "Reporting health gateway requires a reporting client.",
      "INVALID_ARGUMENT",
    );
  }
  const retry = options.retry;

  return Object.freeze({
    async readMetricSet(kind: HealthMetricKind): Promise<unknown> {
      const spec = HEALTH_METRIC_SPECS[kind];
      const expectedName = `apps/${packageName}/${spec.metricSetSuffix}`;
      const payload = await readMetricSetFor(client, packageName, kind, retry);
      assertMetricSetIdentity(payload, expectedName, spec.readOperation);
      return payload;
    },

    async queryMetricSet(
      kind: HealthMetricKind,
      request: HealthMetricQueryRequest,
    ): Promise<HealthMetricQueryPage> {
      const input = toQueryVitalsInput(packageName, request);
      const result = await queryMetricSetFor(client, input, kind, retry);
      // Generated rows are handed to the domain as untrusted records; Phase 5.1
      // re-validates every field it uses.
      return {
        rows: result.rows as unknown as readonly unknown[],
        ...(result.nextPageToken !== undefined ? { nextPageToken: result.nextPageToken } : {}),
      };
    },
  });
}

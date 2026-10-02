/**
 * Play Developer Reporting API boundary for PlayOps (Phase 1.3).
 *
 * Owns a small, stable interface over the official
 * @googleapis/playdeveloperreporting v1beta1 client. Consumes the
 * authenticated client from Phase 1.1; never reads credential files, config,
 * or env, and never performs token acquisition or scope management.
 *
 * Phase 1.3 scope: vitals.anrrate.{get,query} and vitals.crashrate.{get,query}
 * ONLY. No error issues/reports, no other vitals metric sets, no anomalies,
 * no health analysis — that belongs to Phase 5.
 *
 * Pagination: one PlayOps query call = one Google API page; nextPageToken is
 * exposed explicitly (no automatic fetch-everything loop).
 */
import {
  playdeveloperreporting,
  type playdeveloperreporting_v1beta1,
} from "@googleapis/playdeveloperreporting";
import type { GoogleAuthClient } from "../auth/index.js";
import { executeWithRetry, type ReadRetryOptions } from "../retry/index.js";

export type ReportingErrorCode = "INVALID_ARGUMENT" | "API_REQUEST_FAILED" | "INVALID_RESPONSE";

/**
 * Typed reporting error. Safe diagnostics only: operation, packageName,
 * HTTP status/code when available. Never auth headers, tokens, private keys,
 * credential objects, or raw Gaxios request config.
 */
export class ReportingError extends Error {
  override readonly name = "ReportingError";

  constructor(
    message: string,
    readonly code: ReportingErrorCode,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Official generated types reused inside the boundary. */
export type TimelineSpec =
  playdeveloperreporting_v1beta1.Schema$GooglePlayDeveloperReportingV1beta1TimelineSpec;
export type MetricsRow =
  playdeveloperreporting_v1beta1.Schema$GooglePlayDeveloperReportingV1beta1MetricsRow;
export type AnrRateMetricSet =
  playdeveloperreporting_v1beta1.Schema$GooglePlayDeveloperReportingV1beta1AnrRateMetricSet;
export type CrashRateMetricSet =
  playdeveloperreporting_v1beta1.Schema$GooglePlayDeveloperReportingV1beta1CrashRateMetricSet;

type AnrQueryRequest =
  playdeveloperreporting_v1beta1.Schema$GooglePlayDeveloperReportingV1beta1QueryAnrRateMetricSetRequest;
type CrashQueryRequest =
  playdeveloperreporting_v1beta1.Schema$GooglePlayDeveloperReportingV1beta1QueryCrashRateMetricSetRequest;

export interface QueryVitalsInput {
  packageName: string;
  timelineSpec?: TimelineSpec;
  dimensions?: string[];
  metrics?: string[];
  filter?: string;
  /** Integer in (0, 100000]; Google coerces larger values to 100000. */
  pageSize?: number;
  pageToken?: string;
  userCohort?: string;
}

export interface QueryVitalsResult {
  rows: MetricsRow[];
  nextPageToken?: string;
}

/** Narrow structural view of the generated vitals surface PlayOps uses. */
export interface VitalsResourceLike {
  anrrate: {
    get(params: { name: string }, options?: { retry: false }): Promise<{ data: AnrRateMetricSet }>;
    query(
      params: {
        name: string;
        requestBody: AnrQueryRequest;
      },
      options?: { retry: false },
    ): Promise<{ data: { rows?: MetricsRow[]; nextPageToken?: string | null } }>;
  };
  crashrate: {
    get(
      params: { name: string },
      options?: { retry: false },
    ): Promise<{ data: CrashRateMetricSet }>;
    query(
      params: {
        name: string;
        requestBody: CrashQueryRequest;
      },
      options?: { retry: false },
    ): Promise<{ data: { rows?: MetricsRow[]; nextPageToken?: string | null } }>;
  };
}

export interface PlayReportingClient {
  readonly version: "v1beta1";
  readonly vitals: VitalsResourceLike;
}

/** Factory for the official generated client (injectable for tests). */
export type ReportingClientFactory = (options: {
  version: "v1beta1";
  auth: GoogleAuthClient;
  retry: false;
}) => PlayReportingClient;

const defaultFactory: ReportingClientFactory = (options) =>
  playdeveloperreporting({
    version: options.version,
    // The official Options type expects concrete google-auth-library classes;
    // the Phase 1.1 JWT boundary satisfies it at runtime. Adapted structurally.
    auth: options.auth as never,
    retry: options.retry,
  }) as unknown as PlayReportingClient;

/** Create the PlayOps Reporting client around the Phase 1.1 auth client. */
export function createPlayReportingClient(
  auth: GoogleAuthClient,
  factory: ReportingClientFactory = defaultFactory,
): PlayReportingClient {
  // Disable googleapis-common's default Gaxios retries for all API methods.
  return factory({ version: "v1beta1", auth, retry: false });
}

const ANR_RATE_METRIC_SET_SUFFIX = "anrRateMetricSet";
const CRASH_RATE_METRIC_SET_SUFFIX = "crashRateMetricSet";

function requirePackageName(value: string, operation: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReportingError(
      `${operation}: packageName must be a non-empty string`,
      "INVALID_ARGUMENT",
    );
  }
  return value;
}

function optionalNonBlank(
  value: string | undefined,
  field: string,
  operation: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReportingError(`${operation}: ${field} must be non-empty`, "INVALID_ARGUMENT");
  }
  return value;
}

function optionalNonBlankList(
  values: string[] | undefined,
  field: string,
  operation: string,
): string[] | undefined {
  if (values === undefined) return undefined;
  for (const entry of values) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new ReportingError(
        `${operation}: ${field} entries must be non-empty strings`,
        "INVALID_ARGUMENT",
      );
    }
  }
  return values;
}

function metricSetName(packageName: string, suffix: string): string {
  return `apps/${packageName}/${suffix}`;
}

function safeStatus(cause: unknown): number | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const error = cause as { response?: { status?: unknown }; status?: unknown; code?: unknown };
  const raw = error.response?.status ?? error.status ?? error.code;
  const status = typeof raw === "string" && /^\d{3}$/.test(raw) ? Number(raw) : raw;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : undefined;
}

function wrapApiError(operation: string, context: string, cause: unknown): ReportingError {
  const status = safeStatus(cause);
  const statusText = status === undefined ? "" : ` (status ${status})`;
  return new ReportingError(
    `${operation} failed for ${context}${statusText}: Google API request failed`,
    "API_REQUEST_FAILED",
    { cause },
  );
}

function requireObjectPayload(
  data: unknown,
  operation: string,
): asserts data is Record<string, unknown> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ReportingError(`${operation}: response payload is not an object`, "INVALID_RESPONSE");
  }
}

/** Get the ANR rate metric set for an app. Returns metric-set data only. */
export async function getAnrRateMetricSet(
  client: PlayReportingClient,
  packageName: string,
  retryOptions?: ReadRetryOptions,
): Promise<AnrRateMetricSet> {
  const operation = "vitals.anrrate.get";
  const name = metricSetName(
    requirePackageName(packageName, operation),
    ANR_RATE_METRIC_SET_SUFFIX,
  );
  try {
    const response = await executeWithRetry(
      () => client.vitals.anrrate.get({ name }, { retry: false }),
      { ...retryOptions, safety: "read" },
    );
    requireObjectPayload(response.data, operation);
    return response.data;
  } catch (cause) {
    if (cause instanceof ReportingError) throw cause;
    throw wrapApiError(operation, name, cause);
  }
}

/** Get the crash rate metric set for an app. Returns metric-set data only. */
export async function getCrashRateMetricSet(
  client: PlayReportingClient,
  packageName: string,
  retryOptions?: ReadRetryOptions,
): Promise<CrashRateMetricSet> {
  const operation = "vitals.crashrate.get";
  const name = metricSetName(
    requirePackageName(packageName, operation),
    CRASH_RATE_METRIC_SET_SUFFIX,
  );
  try {
    const response = await executeWithRetry(
      () => client.vitals.crashrate.get({ name }, { retry: false }),
      { ...retryOptions, safety: "read" },
    );
    requireObjectPayload(response.data, operation);
    return response.data;
  } catch (cause) {
    if (cause instanceof ReportingError) throw cause;
    throw wrapApiError(operation, name, cause);
  }
}

function validateQueryInput(input: QueryVitalsInput, operation: string): QueryVitalsInput {
  const packageName = requirePackageName(input.packageName, operation);
  const pageToken = optionalNonBlank(input.pageToken, "pageToken", operation);
  const filter = optionalNonBlank(input.filter, "filter", operation);
  const userCohort = optionalNonBlank(input.userCohort, "userCohort", operation);
  const dimensions = optionalNonBlankList(input.dimensions, "dimensions", operation);
  const metrics = optionalNonBlankList(input.metrics, "metrics", operation);
  if (
    input.pageSize !== undefined &&
    (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100_000)
  ) {
    throw new ReportingError(
      `${operation}: pageSize must be an integer in (0, 100000]`,
      "INVALID_ARGUMENT",
    );
  }
  return {
    packageName,
    ...(input.timelineSpec !== undefined ? { timelineSpec: input.timelineSpec } : {}),
    ...(dimensions !== undefined ? { dimensions } : {}),
    ...(metrics !== undefined ? { metrics } : {}),
    ...(filter !== undefined ? { filter } : {}),
    ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
    ...(pageToken !== undefined ? { pageToken } : {}),
    ...(userCohort !== undefined ? { userCohort } : {}),
  };
}

function normalizeQueryResponse(
  data: { rows?: MetricsRow[]; nextPageToken?: string | null },
  operation: string,
): QueryVitalsResult {
  requireObjectPayload(data, operation);
  const rows = data.rows ?? [];
  if (!Array.isArray(rows)) {
    throw new ReportingError(
      `${operation}: response "rows" field is not an array`,
      "INVALID_RESPONSE",
    );
  }
  const nextPageToken = data.nextPageToken ?? undefined;
  return {
    rows,
    ...(typeof nextPageToken === "string" && nextPageToken !== "" ? { nextPageToken } : {}),
  };
}

/** Query the ANR rate metric set. One call = one page. */
export async function queryAnrRate(
  client: PlayReportingClient,
  input: QueryVitalsInput,
  retryOptions?: ReadRetryOptions,
): Promise<QueryVitalsResult> {
  const operation = "vitals.anrrate.query";
  const validated = validateQueryInput(input, operation);
  const name = metricSetName(validated.packageName, ANR_RATE_METRIC_SET_SUFFIX);
  const { packageName: _packageName, ...requestBody } = validated;
  try {
    const response = await executeWithRetry(
      () =>
        client.vitals.anrrate.query(
          {
            name,
            requestBody: requestBody as AnrQueryRequest,
          },
          { retry: false },
        ),
      { ...retryOptions, safety: "read" },
    );
    return normalizeQueryResponse(response.data, operation);
  } catch (cause) {
    if (cause instanceof ReportingError) throw cause;
    throw wrapApiError(operation, name, cause);
  }
}

/** Query the crash rate metric set. One call = one page. */
export async function queryCrashRate(
  client: PlayReportingClient,
  input: QueryVitalsInput,
  retryOptions?: ReadRetryOptions,
): Promise<QueryVitalsResult> {
  const operation = "vitals.crashrate.query";
  const validated = validateQueryInput(input, operation);
  const name = metricSetName(validated.packageName, CRASH_RATE_METRIC_SET_SUFFIX);
  const { packageName: _packageName, ...requestBody } = validated;
  try {
    const response = await executeWithRetry(
      () =>
        client.vitals.crashrate.query(
          {
            name,
            requestBody: requestBody as CrashQueryRequest,
          },
          { retry: false },
        ),
      { ...retryOptions, safety: "read" },
    );
    return normalizeQueryResponse(response.data, operation);
  } catch (cause) {
    if (cause instanceof ReportingError) throw cause;
    throw wrapApiError(operation, name, cause);
  }
}

/**
 * Phase 5.1 — metric fetcher: validated query → paginated Reporting reads →
 * normalized, frozen PlayOps series.
 *
 * Pagination follows `nextPageToken` until absent/empty (one API call per page,
 * every other parameter unchanged, exactly as Google requires). A repeated token
 * is a `PAGINATION_LOOP`; exceeding the page guard is `MAX_PAGES_EXCEEDED` —
 * PlayOps never silently truncates a result. An empty result is valid data
 * (`points: []`), never an error and never synthesized as zero.
 *
 * No LLM involvement, no anomaly judgment, no thresholds: fetchers only.
 */
import type { HealthMetricGateway, HealthMetricQueryRequest } from "./gateway.js";
import {
  HealthError,
  HEALTH_DEFAULT_MAX_PAGES,
  HEALTH_DEFAULT_PAGE_SIZE,
  HEALTH_MAX_PAGES_LIMIT,
  HEALTH_MAX_PAGE_SIZE,
  normalizeHealthRows,
  parseHealthFreshness,
  validateHealthMetricQuery,
  type HealthMetricPoint,
  type HealthMetricQuery,
  type HealthMetricSeries,
} from "./index.js";

export interface FetchHealthMetricOptions {
  /** Rows per page; Google's default is 1000 and the maximum is 100000. */
  readonly pageSize?: number;
  /** Finite page guard for one fetch. */
  readonly maxPages?: number;
}

function invalidArgument(message: string): HealthError {
  return new HealthError(message, "INVALID_ARGUMENT");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvePageSize(value: unknown): number {
  if (value === undefined) return HEALTH_DEFAULT_PAGE_SIZE;
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > HEALTH_MAX_PAGE_SIZE
  ) {
    throw invalidArgument(`pageSize must be an integer in (0, ${HEALTH_MAX_PAGE_SIZE}].`);
  }
  return value as number;
}

function resolveMaxPages(value: unknown): number {
  if (value === undefined) return HEALTH_DEFAULT_MAX_PAGES;
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > HEALTH_MAX_PAGES_LIMIT
  ) {
    throw invalidArgument(`maxPages must be an integer in (0, ${HEALTH_MAX_PAGES_LIMIT}].`);
  }
  return value as number;
}

/** Wrap only gateway failures; domain validation errors keep their own codes. */
async function callGateway<T>(action: () => Promise<T>, operation: string): Promise<T> {
  try {
    return await action();
  } catch (cause) {
    if (cause instanceof HealthError) throw cause;
    throw new HealthError(
      `${operation} failed: the Play Developer Reporting request did not complete.`,
      "SOURCE_FAILED",
      { cause },
    );
  }
}

function readPage(page: unknown): { readonly rows: unknown; readonly nextPageToken: unknown } {
  if (!isRecord(page)) {
    throw new HealthError("Reporting page is not an object.", "REMOTE_DATA_INVALID");
  }
  return { rows: page.rows ?? [], nextPageToken: page.nextPageToken };
}

/** Fetch one normalized health metric series for an explicit, trusted time window. */
export async function fetchHealthMetricSeries(
  gateway: HealthMetricGateway,
  input: HealthMetricQuery,
  options: FetchHealthMetricOptions = {},
): Promise<HealthMetricSeries> {
  if (
    !gateway ||
    typeof gateway.readMetricSet !== "function" ||
    typeof gateway.queryMetricSet !== "function"
  ) {
    throw invalidArgument("A health metric gateway with read/query support is required.");
  }
  const query = validateHealthMetricQuery(input);
  const pageSize = resolvePageSize(options?.pageSize);
  const maxPages = resolveMaxPages(options?.maxPages);

  const metricSet = await callGateway(() => gateway.readMetricSet(query.kind), query.toolName);
  const freshness = parseHealthFreshness(metricSet);

  const points: HealthMetricPoint[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  let pageCount = 0;

  for (;;) {
    const request: HealthMetricQueryRequest = {
      timelineSpec: query.timelineSpec,
      dimensions: query.dimensions,
      metrics: query.metrics,
      pageSize,
      ...(pageToken !== undefined ? { pageToken } : {}),
    };
    const page = await callGateway(
      () => gateway.queryMetricSet(query.kind, request),
      query.toolName,
    );
    pageCount += 1;

    const { rows, nextPageToken } = readPage(page);
    for (const point of normalizeHealthRows(rows, query)) {
      points.push(point);
    }

    if (nextPageToken === undefined || nextPageToken === null || nextPageToken === "") {
      break;
    }
    if (typeof nextPageToken !== "string" || nextPageToken.trim() === "") {
      throw new HealthError("Reporting nextPageToken is invalid.", "REMOTE_DATA_INVALID");
    }
    if (seenTokens.has(nextPageToken)) {
      throw new HealthError(
        "Reporting pagination repeated a page token; the result is incomplete.",
        "PAGINATION_LOOP",
      );
    }
    seenTokens.add(nextPageToken);
    if (pageCount >= maxPages) {
      throw new HealthError(
        `Reporting pagination exceeded the ${maxPages}-page guard; no partial result is returned.`,
        "MAX_PAGES_EXCEEDED",
      );
    }
    pageToken = nextPageToken;
  }

  return Object.freeze({
    kind: query.kind,
    toolName: query.toolName,
    window: query.window,
    dimensions: query.dimensions,
    metrics: query.metrics,
    freshness,
    points: Object.freeze(points),
    pageCount,
    rowCount: points.length,
  });
}

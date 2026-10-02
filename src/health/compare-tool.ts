/**
 * Phase 5.2 — `health.compare_to_baseline` read-only tool for the Phase 2 runtime.
 *
 * One narrow tool (roadmap: "Anomaly summary tool"): it compares an explicit
 * CURRENT window against an explicit BASELINE window and returns the structured
 * comparison plus its deterministic rendered summary. Permission is exactly
 * `read`, there is no approval path, no mutation, no verifier (Phase 2.4 records
 * `VERIFICATION_SKIPPED`) and no threshold/alert behaviour.
 *
 * The tool orchestrates the Phase 5.1 fetchers — one bounded fetch sequence per
 * window per metric kind — so there is no second data-access path to Google:
 * `health.compare_to_baseline` → Phase 5.1 fetcher → existing Reporting adapter.
 *
 * The model may choose only the metric kinds, the two windows, the granularity
 * and (within the documented sets) the dimensions and metric names. Package
 * identity, credentials, page sizes and pagination stay composition-bound.
 */
import type { AgentToolBinding } from "../runtime/agent/index.js";
import type { ToolDefinition, ToolSchema } from "../runtime/tools/index.js";
import type { VerificationResult } from "../runtime/verification/index.js";
import {
  analyzeHealthComparison,
  healthPeriodCount,
  HEALTH_CHANGE_DIRECTIONS,
  HEALTH_COMPARISON_REASONS,
  HEALTH_COMPARISON_TOOL_NAME,
  type HealthComparison,
  type HealthComparisonEntry,
  type HealthComparisonValue,
} from "./comparison.js";
import { HealthError } from "./errors.js";
import { fetchHealthMetricSeries, type FetchHealthMetricOptions } from "./fetchers.js";
import type { HealthMetricGateway } from "./gateway.js";
import {
  HEALTH_DIMENSIONS,
  HEALTH_GRANULARITIES,
  HEALTH_METRIC_KINDS,
  HEALTH_METRIC_NAMES,
  HEALTH_METRIC_SPECS,
  HEALTH_METRIC_UNITS,
  isHealthDecimalString,
  validateHealthMetricQuery,
  type HealthGranularity,
  type HealthMetricKind,
  type HealthMetricName,
  type HealthMetricSeries,
  type ValidatedHealthMetricQuery,
} from "./index.js";
import { renderHealthComparison } from "./render.js";
import { parseUtcInstant } from "./time.js";

export interface HealthComparisonWindowInput {
  readonly startTime: string;
  readonly endTime: string;
}

export interface HealthComparisonToolInput {
  /** Defaults to every supported metric kind, in `HEALTH_METRIC_KINDS` order. */
  readonly kinds?: readonly HealthMetricKind[];
  readonly current: HealthComparisonWindowInput;
  readonly baseline: HealthComparisonWindowInput;
  readonly granularity: HealthGranularity;
  readonly dimensions?: readonly string[];
  readonly metrics?: readonly string[];
}

export interface HealthComparisonResult {
  readonly comparison: HealthComparison;
  readonly summary: string;
}

export interface HealthComparisonToolOptions {
  readonly gateway: HealthMetricGateway;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export interface HealthComparisonTool {
  readonly tool: ToolDefinition<HealthComparisonToolInput, HealthComparisonResult>;
  readonly binding: AgentToolBinding;
}

const INPUT_KEYS = Object.freeze([
  "kinds",
  "current",
  "baseline",
  "granularity",
  "dimensions",
  "metrics",
]);
const WINDOW_KEYS = Object.freeze(["startTime", "endTime"]);
const RESULT_KEYS = Object.freeze(["comparison", "summary"]);
const COMPARISON_KEYS = Object.freeze([
  "baseline",
  "comparedValueCount",
  "current",
  "dimensions",
  "entryCount",
  "granularity",
  "kinds",
  "pageCount",
  "rowCount",
  "sections",
  "toolName",
  "unavailableValueCount",
]);
const SECTION_KEYS = Object.freeze([
  "baseline",
  "baselineBeyondFreshness",
  "baselinePageCount",
  "baselineRowCount",
  "current",
  "currentBeyondFreshness",
  "currentPageCount",
  "currentRowCount",
  "entries",
  "freshness",
  "granularity",
  "kind",
  "metrics",
  "toolName",
]);
const ENTRY_KEYS = Object.freeze([
  "baselineStartTimeUtc",
  "currentStartTimeUtc",
  "dimensionKey",
  "dimensions",
  "periodIndex",
  "values",
]);
const VALUE_KEYS = Object.freeze([
  "absoluteDelta",
  "baselineValue",
  "currentValue",
  "direction",
  "metric",
  "reason",
  "relativeDeltaPercent",
  "unit",
]);

function invalid(message: string): HealthError {
  return new HealthError(message, "INVALID_ARGUMENT");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.some((entry) => entry === key));
}

function readStringList(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalid(`${field} must be an array of strings.`);
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") throw invalid(`${field} must be an array of strings.`);
    out.push(entry);
  }
  return Object.freeze(out);
}

function isHealthMetricKindName(value: unknown): value is HealthMetricKind {
  return typeof value === "string" && HEALTH_METRIC_KINDS.some((entry) => entry === value);
}

function isHealthMetricNameValue(value: unknown): value is HealthMetricName {
  return typeof value === "string" && HEALTH_METRIC_NAMES.some((entry) => entry === value);
}

function isHealthGranularityValue(value: unknown): value is HealthGranularity {
  return typeof value === "string" && HEALTH_GRANULARITIES.some((entry) => entry === value);
}

function readKindList(value: unknown): readonly HealthMetricKind[] {
  if (value === undefined) return Object.freeze([...HEALTH_METRIC_KINDS]);
  if (!Array.isArray(value)) throw invalid("kinds must be an array of metric kinds.");
  if (value.length === 0) throw invalid("kinds must not be empty.");
  const kinds: HealthMetricKind[] = [];
  for (const entry of value) {
    if (!isHealthMetricKindName(entry))
      throw invalid(`Unsupported health metric kind: ${String(entry)}.`);
    if (kinds.some((kind) => kind === entry)) throw invalid(`Duplicate metric kind: ${entry}.`);
    kinds.push(entry);
  }
  return Object.freeze(kinds);
}

function readWindow(value: unknown, field: string): HealthComparisonWindowInput {
  if (!isRecord(value) || !hasExactKeys(value, WINDOW_KEYS)) {
    throw invalid(`${field} must be an object with startTime and endTime.`);
  }
  const startTime = value["startTime"];
  const endTime = value["endTime"];
  if (typeof startTime !== "string" || typeof endTime !== "string") {
    throw invalid(`${field} startTime and endTime must be UTC instant strings.`);
  }
  return Object.freeze({ startTime, endTime });
}

interface PlannedQuery {
  readonly kind: HealthMetricKind;
  readonly raw: {
    readonly kind: HealthMetricKind;
    readonly granularity: HealthGranularity;
    readonly startTime: string;
    readonly endTime: string;
    readonly dimensions?: readonly string[];
    readonly metrics?: readonly string[];
  };
  readonly validated: ValidatedHealthMetricQuery;
}

function planQueries(
  input: HealthComparisonToolInput,
  dimensions: readonly string[] | undefined,
  metrics: readonly string[] | undefined,
): readonly PlannedQuery[] {
  return Object.freeze(
    input.kinds?.map((kind) => {
      const raw = {
        kind,
        granularity: input.granularity,
        startTime: input.current.startTime,
        endTime: input.current.endTime,
        ...(dimensions !== undefined ? { dimensions } : {}),
        ...(metrics !== undefined ? { metrics } : {}),
      };
      return { kind, raw, validated: validateHealthMetricQuery(raw) };
    }) ?? [],
  );
}

function createInputSchema(): ToolSchema<HealthComparisonToolInput> {
  return {
    parse(value: unknown): HealthComparisonToolInput {
      if (!isRecord(value) || !hasExactKeys(value, INPUT_KEYS)) {
        throw invalid("Comparison input must be an object with supported fields only.");
      }
      const current = readWindow(value["current"], "current");
      const baseline = readWindow(value["baseline"], "baseline");
      const granularity = value["granularity"];
      if (!isHealthGranularityValue(granularity)) {
        throw invalid(`granularity must be one of ${HEALTH_GRANULARITIES.join(", ")}.`);
      }
      const requestedKinds = readKindList(value["kinds"]);
      const kinds: HealthMetricKind[] = [...requestedKinds];
      const dimensions = readStringList(value["dimensions"], "dimensions");
      const metrics = readStringList(value["metrics"], "metrics");

      const parsed: HealthComparisonToolInput = {
        kinds,
        current,
        baseline,
        granularity,
        ...(dimensions !== undefined ? { dimensions } : {}),
        ...(metrics !== undefined ? { metrics } : {}),
      };

      // Pre-fetch validation: both windows must be valid and comparable before
      // any Reporting call, so the Google query count stays deterministic.
      const currentQueries = planQueries(parsed, dimensions, metrics);
      const baselineQueries = planQueries(
        {
          ...parsed,
          current: baseline,
        },
        dimensions,
        metrics,
      );
      for (let index = 0; index < currentQueries.length; index += 1) {
        const currentQuery = currentQueries[index];
        const baselineQuery = baselineQueries[index];
        if (!currentQuery || !baselineQuery) throw invalid("Comparison plan is invalid.");
        if (
          healthPeriodCount(currentQuery.validated.window) !==
          healthPeriodCount(baselineQuery.validated.window)
        ) {
          throw new HealthError(
            "Current and baseline windows must have equal duration measured in aggregation periods.",
            "INCOMPATIBLE_WINDOWS",
          );
        }
      }
      return Object.freeze(parsed);
    },
  };
}

function checkWindow(value: unknown): boolean {
  if (!isRecord(value)) return false;
  try {
    parseUtcInstant(value["startTimeUtc"], "startTimeUtc");
    parseUtcInstant(value["endTimeUtc"], "endTimeUtc");
    return value["granularity"] === "DAILY" || value["granularity"] === "HOURLY";
  } catch {
    return false;
  }
}

function checkOptionalInstant(value: unknown): boolean {
  if (value === undefined) return true;
  try {
    parseUtcInstant(value, "instant");
    return true;
  } catch {
    return false;
  }
}

function checkValue(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, VALUE_KEYS)) return false;
  const metric = value["metric"];
  if (!isHealthMetricNameValue(metric)) return false;
  if (value["unit"] !== HEALTH_METRIC_UNITS[metric]) return false;
  if (!HEALTH_CHANGE_DIRECTIONS.some((entry) => entry === value["direction"])) return false;
  if (!HEALTH_COMPARISON_REASONS.some((entry) => entry === value["reason"])) return false;
  for (const field of ["currentValue", "baselineValue", "absoluteDelta"]) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && !isHealthDecimalString(fieldValue)) return false;
  }
  const relative = value["relativeDeltaPercent"];
  if (relative !== undefined && typeof relative !== "string") return false;
  if (value["reason"] === "baseline-zero" && relative !== undefined) return false;
  if (value["reason"] === "current-unavailable" && value["currentValue"] !== undefined)
    return false;
  if (value["reason"] === "baseline-unavailable" && value["baselineValue"] !== undefined) {
    return false;
  }
  if (value["direction"] === "incomparable") {
    return value["absoluteDelta"] === undefined && relative === undefined;
  }
  return (
    typeof value["currentValue"] === "string" &&
    typeof value["baselineValue"] === "string" &&
    typeof value["absoluteDelta"] === "string"
  );
}

function checkEntry(value: unknown): value is HealthComparisonEntry {
  if (!isRecord(value) || !hasExactKeys(value, ENTRY_KEYS)) return false;
  if (typeof value["dimensionKey"] !== "string") return false;
  const periodIndex = value["periodIndex"];
  if (periodIndex !== null && (!Number.isInteger(periodIndex) || (periodIndex as number) < 0)) {
    return false;
  }
  if (!checkOptionalInstant(value["currentStartTimeUtc"])) return false;
  if (!checkOptionalInstant(value["baselineStartTimeUtc"])) return false;
  if (!Array.isArray(value["dimensions"])) return false;
  for (const dimension of value["dimensions"]) {
    if (!isRecord(dimension)) return false;
    if (typeof dimension["name"] !== "string") return false;
    if (!HEALTH_DIMENSIONS.some((entry) => entry === dimension["name"])) return false;
    if (typeof dimension["value"] !== "string" || dimension["value"].trim() === "") return false;
    if (dimension["valueType"] !== "string" && dimension["valueType"] !== "int64") return false;
  }
  const values = value["values"];
  if (!Array.isArray(values) || values.length === 0) return false;
  return values.every(checkValue);
}

function checkSection(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, SECTION_KEYS)) return false;
  const kind = value["kind"];
  if (!isHealthMetricKindName(kind)) return false;
  if (value["toolName"] !== HEALTH_METRIC_SPECS[kind].toolName) return false;
  if (!checkWindow(value["current"]) || !checkWindow(value["baseline"])) return false;
  if (
    (value["current"] as { granularity?: unknown }).granularity !== value["granularity"] ||
    value["granularity"] !== (value["baseline"] as { granularity?: unknown }).granularity
  ) {
    return false;
  }
  if (
    (value["current"] as { startTimeUtc?: unknown }).startTimeUtc ===
    (value["current"] as { endTimeUtc?: unknown }).endTimeUtc
  ) {
    return false;
  }
  const metrics = value["metrics"];
  if (!Array.isArray(metrics) || metrics.length === 0) return false;
  for (const metric of metrics) {
    if (
      typeof metric !== "string" ||
      !HEALTH_METRIC_SPECS[kind].metrics.some((entry) => entry === metric)
    ) {
      return false;
    }
  }
  const freshness = value["freshness"];
  if (!Array.isArray(freshness)) return false;
  for (const item of freshness) {
    if (!isRecord(item)) return false;
    if (typeof item["aggregationPeriod"] !== "string" || item["aggregationPeriod"].trim() === "") {
      return false;
    }
    if (!checkOptionalInstant(item["latestEndTimeUtc"])) return false;
  }
  for (const field of ["currentBeyondFreshness", "baselineBeyondFreshness"]) {
    if (typeof value[field] !== "boolean") return false;
  }
  for (const field of [
    "currentRowCount",
    "baselineRowCount",
    "currentPageCount",
    "baselinePageCount",
  ]) {
    if (!Number.isInteger(value[field]) || (value[field] as number) < 0) return false;
  }
  const entries = value["entries"];
  if (!Array.isArray(entries) || !entries.every(checkEntry)) return false;
  const currentPageCount = value["currentPageCount"] as number;
  return currentPageCount >= 1;
}

function createOutputSchema(): ToolSchema<HealthComparisonResult> {
  const invalidOutput = (): HealthError =>
    new HealthError(
      `${HEALTH_COMPARISON_TOOL_NAME} produced an invalid result.`,
      "INVALID_ARGUMENT",
    );

  return {
    parse(value: unknown): HealthComparisonResult {
      if (!isRecord(value) || !hasExactKeys(value, RESULT_KEYS)) throw invalidOutput();
      const comparison = value["comparison"];
      if (!isRecord(comparison) || !hasExactKeys(comparison, COMPARISON_KEYS))
        throw invalidOutput();
      if (comparison["toolName"] !== HEALTH_COMPARISON_TOOL_NAME) throw invalidOutput();
      if (!checkWindow(comparison["current"]) || !checkWindow(comparison["baseline"])) {
        throw invalidOutput();
      }
      const kinds = comparison["kinds"];
      if (!Array.isArray(kinds) || kinds.length === 0) throw invalidOutput();
      for (const kind of kinds) {
        if (!HEALTH_METRIC_KINDS.some((entry) => entry === kind)) throw invalidOutput();
      }
      const dimensions = comparison["dimensions"];
      if (!Array.isArray(dimensions)) throw invalidOutput();
      for (const dimension of dimensions) {
        if (!HEALTH_DIMENSIONS.some((entry) => entry === dimension)) throw invalidOutput();
      }
      const sections = comparison["sections"];
      if (!Array.isArray(sections) || sections.length !== kinds.length) throw invalidOutput();
      if (!sections.every(checkSection)) throw invalidOutput();

      let entryCount = 0;
      let compared = 0;
      let unavailable = 0;
      let pageCount = 0;
      let rowCount = 0;
      for (const section of sections as readonly Record<string, unknown>[]) {
        const entries = section["entries"] as readonly HealthComparisonEntry[];
        entryCount += entries.length;
        pageCount +=
          (section["currentPageCount"] as number) + (section["baselinePageCount"] as number);
        rowCount +=
          (section["currentRowCount"] as number) + (section["baselineRowCount"] as number);
        for (const entry of entries) {
          for (const entryValue of entry.values) {
            if (entryValue.reason === "comparable" || entryValue.reason === "baseline-zero") {
              compared += 1;
            } else {
              unavailable += 1;
            }
          }
        }
      }
      if (comparison["entryCount"] !== entryCount) throw invalidOutput();
      if (comparison["comparedValueCount"] !== compared) throw invalidOutput();
      if (comparison["unavailableValueCount"] !== unavailable) throw invalidOutput();
      if (comparison["pageCount"] !== pageCount) throw invalidOutput();
      if (comparison["rowCount"] !== rowCount) throw invalidOutput();

      const summary = value["summary"];
      if (typeof summary !== "string" || summary.trim() === "") throw invalidOutput();
      // Anti-drift: the rendered text must be exactly the derivation of the structure.
      if (summary !== renderHealthComparison(comparison as unknown as HealthComparison)) {
        throw invalidOutput();
      }
      return value as unknown as HealthComparisonResult;
    },
  };
}

/** Create the Phase 5.2 read-only comparison tool. */
export function createHealthComparisonTool(
  options: HealthComparisonToolOptions,
): HealthComparisonTool {
  const gateway = options?.gateway;
  if (
    !gateway ||
    typeof gateway.readMetricSet !== "function" ||
    typeof gateway.queryMetricSet !== "function"
  ) {
    throw invalid("A health metric gateway with read/query support is required.");
  }
  const fetchOptions: FetchHealthMetricOptions = {
    ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
  };

  const description =
    "Compare Google Play App Health metrics between an explicit current window and an explicit " +
    "baseline window (crash rate, ANR rate and excessive wakeups) and return the structured " +
    "comparison plus a deterministic human-readable summary. Factual baseline deviation only: " +
    "read-only, no thresholds, no severity and no alerts.";

  const inputSchema = createInputSchema();
  const outputSchema = createOutputSchema();

  const tool: ToolDefinition<HealthComparisonToolInput, HealthComparisonResult> = {
    name: HEALTH_COMPARISON_TOOL_NAME,
    description,
    permission: "read",
    inputSchema,
    outputSchema,
    async execute(input) {
      const parsed = inputSchema.parse(input);
      const kinds = Object.freeze([...(parsed.kinds ?? HEALTH_METRIC_KINDS)]);
      const dimensions: readonly string[] | undefined = parsed.dimensions;
      const metrics: readonly string[] | undefined = parsed.metrics;

      const buildQuery = (
        kind: HealthMetricKind,
        window: HealthComparisonWindowInput,
      ): {
        readonly kind: HealthMetricKind;
        readonly granularity: HealthGranularity;
        readonly startTime: string;
        readonly endTime: string;
        readonly dimensions?: readonly string[];
        readonly metrics?: readonly string[];
      } => ({
        kind,
        granularity: parsed.granularity,
        startTime: window.startTime,
        endTime: window.endTime,
        ...(dimensions !== undefined ? { dimensions } : {}),
        ...(metrics !== undefined ? { metrics } : {}),
      });

      const currentSeries: HealthMetricSeries[] = [];
      const baselineSeries: HealthMetricSeries[] = [];
      for (const kind of kinds) {
        // One bounded Phase 5.1 fetch sequence per window per kind. No repeated
        // fetch of the same window and no polling.
        currentSeries.push(
          await fetchHealthMetricSeries(gateway, buildQuery(kind, parsed.current), fetchOptions),
        );
        baselineSeries.push(
          await fetchHealthMetricSeries(gateway, buildQuery(kind, parsed.baseline), fetchOptions),
        );
      }

      const comparison = analyzeHealthComparison({
        current: Object.freeze(currentSeries),
        baseline: Object.freeze(baselineSeries),
      });
      return Object.freeze({
        comparison,
        summary: renderHealthComparison(comparison),
      });
    },
    // No verifier on purpose: read-only tool; verification is legitimately SKIPPED.
  };

  const binding: AgentToolBinding = {
    toolName: HEALTH_COMPARISON_TOOL_NAME,
    llm: {
      name: HEALTH_COMPARISON_TOOL_NAME,
      description,
      inputSchema: {
        type: "object",
        properties: {
          kinds: {
            type: "array",
            items: { type: "string", enum: [...HEALTH_METRIC_KINDS] },
            description: "Metric kinds to compare; defaults to all supported kinds.",
          },
          current: {
            type: "object",
            properties: {
              startTime: {
                type: "string",
                description:
                  "Current window start, explicit UTC instant, e.g. 2026-09-24T07:00:00Z.",
              },
              endTime: {
                type: "string",
                description: "Current window end (exclusive), explicit UTC instant.",
              },
            },
            required: ["startTime", "endTime"],
            additionalProperties: false,
          },
          baseline: {
            type: "object",
            properties: {
              startTime: {
                type: "string",
                description: "Baseline window start, explicit UTC instant.",
              },
              endTime: {
                type: "string",
                description: "Baseline window end (exclusive), explicit UTC instant.",
              },
            },
            required: ["startTime", "endTime"],
            additionalProperties: false,
          },
          granularity: {
            type: "string",
            enum: [...HEALTH_GRANULARITIES],
            description: "Aggregation period; both windows must use the same one.",
          },
          dimensions: {
            type: "array",
            items: { type: "string", enum: [...HEALTH_DIMENSIONS] },
            description: "Optional supported breakdown dimensions.",
          },
          metrics: {
            type: "array",
            items: { type: "string", enum: [...HEALTH_METRIC_NAMES] },
            description:
              "Optional metric names; must be supported by every requested kind (default: each kind's primary metric).",
          },
        },
        required: ["current", "baseline", "granularity"],
        additionalProperties: false,
      },
    },
    serializeResult(output: unknown, verification: VerificationResult): string {
      const result = outputSchema.parse(output);
      if (
        !verification ||
        verification.toolName !== HEALTH_COMPARISON_TOOL_NAME ||
        verification.permission !== "read" ||
        verification.required !== false ||
        verification.status !== "skipped" ||
        verification.code !== "VERIFICATION_SKIPPED" ||
        verification.verified !== false
      ) {
        throw invalid(
          `${HEALTH_COMPARISON_TOOL_NAME} requires a skipped read verification result.`,
        );
      }
      // Structured comparison plus its deterministic summary. No credentials,
      // tokens, package identity, raw Google payloads, thresholds or severity.
      return JSON.stringify({
        comparison: result.comparison,
        summary: result.summary,
      });
    },
  };

  return Object.freeze({ tool, binding });
}

/** Re-exported for callers that need the raw comparison value shape. */
export type { HealthComparison, HealthComparisonValue };

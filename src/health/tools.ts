/**
 * Phase 5.1 — read-only App Health metric tools for the real Phase 2 runtime.
 *
 * One tool per metric kind (`health.get_crash_rate`, `health.get_anr_rate`,
 * `health.get_excessive_wakeups`), all permission `read`, no approval, no
 * verifier (Phase 2.4 therefore records `VERIFICATION_SKIPPED`).
 *
 * The authoritative input schema is the trust boundary: the model may supply
 * only a time window, a granularity, and — within the kind's documented sets —
 * dimensions and metric names. Package identity, metric-set resource names,
 * credentials, filters, cohorts, page sizes and pagination are composition-bound
 * or internal, and any unknown field is rejected. There is deliberately no
 * generic "run an arbitrary Reporting query" tool.
 */
import type { AgentToolBinding } from "../runtime/agent/index.js";
import type { ToolDefinition, ToolSchema } from "../runtime/tools/index.js";
import type { VerificationResult } from "../runtime/verification/index.js";
import { fetchHealthMetricSeries, type FetchHealthMetricOptions } from "./fetchers.js";
import type { HealthMetricGateway } from "./gateway.js";
import {
  HealthError,
  HEALTH_DIMENSIONS,
  HEALTH_METRIC_SPECS,
  isHealthDecimalString,
  validateHealthMetricQuery,
  type HealthGranularity,
  type HealthMetricKind,
  type HealthMetricPoint,
  type HealthMetricQuery,
  type HealthMetricSeries,
} from "./index.js";
import { parseUtcInstant } from "./time.js";

export interface HealthMetricToolInput {
  /** Explicit UTC instant: `YYYY-MM-DDTHH:MM:SSZ` (inclusive start). */
  readonly startTime: string;
  /** Explicit UTC instant: exclusive end of the timeline. */
  readonly endTime: string;
  readonly granularity: HealthGranularity;
  readonly dimensions?: readonly string[];
  readonly metrics?: readonly string[];
}

export interface HealthMetricToolOptions {
  readonly metricKind: HealthMetricKind;
  readonly gateway: HealthMetricGateway;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export interface HealthMetricTool {
  readonly tool: ToolDefinition<HealthMetricToolInput, HealthMetricSeries>;
  readonly binding: AgentToolBinding;
}

const INPUT_KEYS = Object.freeze(["startTime", "endTime", "granularity", "dimensions", "metrics"]);
const OUTPUT_KEYS = Object.freeze([
  "dimensions",
  "freshness",
  "kind",
  "metrics",
  "pageCount",
  "points",
  "rowCount",
  "toolName",
  "window",
]);

function invalid(message: string): HealthError {
  return new HealthError(message, "INVALID_ARGUMENT");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalStringList(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw invalid(`${field} must be an array of strings.`);
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw invalid(`${field} must be an array of strings.`);
    }
    out.push(entry);
  }
  return Object.freeze(out);
}

function toQuery(kind: HealthMetricKind, parsed: HealthMetricToolInput): HealthMetricQuery {
  return {
    kind,
    startTime: parsed.startTime,
    endTime: parsed.endTime,
    granularity: parsed.granularity,
    ...(parsed.dimensions !== undefined ? { dimensions: parsed.dimensions } : {}),
    ...(parsed.metrics !== undefined ? { metrics: parsed.metrics } : {}),
  };
}

function createInputSchema(kind: HealthMetricKind): ToolSchema<HealthMetricToolInput> {
  return {
    parse(value: unknown): HealthMetricToolInput {
      if (!isRecord(value)) throw invalid("Health metric tool input must be an object.");
      for (const key of Object.keys(value)) {
        if (!INPUT_KEYS.some((allowed) => allowed === key)) {
          throw invalid(`Health metric tool input has unsupported field "${key}".`);
        }
      }
      const dimensions = readOptionalStringList(value.dimensions, "dimensions");
      const metrics = readOptionalStringList(value.metrics, "metrics");
      const parsed: HealthMetricToolInput = {
        startTime: value.startTime as string,
        endTime: value.endTime as string,
        granularity: value.granularity as HealthGranularity,
        ...(dimensions !== undefined ? { dimensions } : {}),
        ...(metrics !== undefined ? { metrics } : {}),
      };
      // Authoritative window/dimension/metric validation; throws
      // HealthError INVALID_ARGUMENT so a bad window never reaches Google.
      validateHealthMetricQuery(toQuery(kind, parsed));
      return Object.freeze(parsed);
    },
  };
}

function createOutputSchema(kind: HealthMetricKind): ToolSchema<HealthMetricSeries> {
  const spec = HEALTH_METRIC_SPECS[kind];
  const invalidOutput = (): HealthError =>
    new HealthError(`${spec.toolName} produced an invalid result.`, "INVALID_ARGUMENT");

  const checkInstant = (value: unknown): boolean => {
    try {
      parseUtcInstant(value, "instant");
      return true;
    } catch {
      return false;
    }
  };

  const checkDimensionValue = (value: unknown): boolean => {
    if (!isRecord(value)) return false;
    const name = value.name;
    if (typeof name !== "string" || !HEALTH_DIMENSIONS.some((entry) => entry === name))
      return false;
    if (typeof value.value !== "string" || value.value.trim() === "") return false;
    if (value.valueType !== "string" && value.valueType !== "int64") return false;
    if (
      value.valueLabel !== undefined &&
      (typeof value.valueLabel !== "string" || value.valueLabel.trim() === "")
    ) {
      return false;
    }
    return true;
  };

  const checkMetricValue = (value: unknown): boolean => {
    if (!isRecord(value)) return false;
    const metric = value.metric;
    if (typeof metric !== "string" || !spec.metrics.some((entry) => entry === metric)) return false;
    if (!isHealthDecimalString(value.value)) return false;
    if (value.unit !== "percent" && value.unit !== "count") return false;
    const interval = value.confidenceInterval;
    if (interval !== undefined) {
      if (!isRecord(interval)) return false;
      for (const bound of [interval.lowerBound, interval.upperBound]) {
        if (bound !== undefined && !isHealthDecimalString(bound)) return false;
      }
    }
    return true;
  };

  const checkPoint = (value: unknown): value is HealthMetricPoint => {
    if (!isRecord(value)) return false;
    if (!checkInstant(value.startTimeUtc)) return false;
    if (!spec.granularities.some((entry) => entry === value.aggregationPeriod)) return false;
    if (!Array.isArray(value.dimensions) || !value.dimensions.every(checkDimensionValue)) {
      return false;
    }
    if (!Array.isArray(value.metrics) || value.metrics.length === 0) return false;
    return value.metrics.every(checkMetricValue);
  };

  return {
    parse(value: unknown): HealthMetricSeries {
      if (!isRecord(value)) throw invalidOutput();
      const keys = Object.keys(value).sort();
      if (
        keys.length !== OUTPUT_KEYS.length ||
        keys.some((key, index) => key !== OUTPUT_KEYS[index])
      ) {
        throw invalidOutput();
      }
      if (value.kind !== kind || value.toolName !== spec.toolName) throw invalidOutput();

      const window = value.window;
      if (
        !isRecord(window) ||
        !checkInstant(window.startTimeUtc) ||
        !checkInstant(window.endTimeUtc) ||
        !spec.granularities.some((entry) => entry === window.granularity)
      ) {
        throw invalidOutput();
      }

      const dimensions = value.dimensions;
      if (
        !Array.isArray(dimensions) ||
        !dimensions.every((entry) => HEALTH_DIMENSIONS.some((name) => name === entry))
      ) {
        throw invalidOutput();
      }

      const metrics = value.metrics;
      if (
        !Array.isArray(metrics) ||
        !metrics.every((entry) => spec.metrics.some((name) => name === entry))
      ) {
        throw invalidOutput();
      }

      const freshness = value.freshness;
      if (
        !Array.isArray(freshness) ||
        !freshness.every(
          (entry) =>
            isRecord(entry) &&
            typeof entry.aggregationPeriod === "string" &&
            entry.aggregationPeriod.trim() !== "" &&
            checkInstant(entry.latestEndTimeUtc),
        )
      ) {
        throw invalidOutput();
      }

      const points = value.points;
      if (!Array.isArray(points) || !points.every(checkPoint)) throw invalidOutput();
      if (!Number.isInteger(value.pageCount) || (value.pageCount as number) < 1) {
        throw invalidOutput();
      }
      if (!Number.isInteger(value.rowCount) || value.rowCount !== points.length) {
        throw invalidOutput();
      }
      return value as unknown as HealthMetricSeries;
    },
  };
}

/** Create one read-only App Health metric tool bound to a metric kind. */
export function createHealthMetricTool(options: HealthMetricToolOptions): HealthMetricTool {
  const kind = options?.metricKind;
  if (typeof kind !== "string" || !Object.hasOwn(HEALTH_METRIC_SPECS, kind)) {
    throw invalid("A supported health metric kind is required.");
  }
  const gateway = options?.gateway;
  if (
    !gateway ||
    typeof gateway.readMetricSet !== "function" ||
    typeof gateway.queryMetricSet !== "function"
  ) {
    throw invalid("A health metric gateway with read/query support is required.");
  }
  const spec = HEALTH_METRIC_SPECS[kind];
  const fetchOptions: FetchHealthMetricOptions = {
    ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
  };

  const description =
    `Read ${spec.kind.replace(/_/gu, " ")} metrics for the configured Google Play app from the ` +
    `Play Developer Reporting API over an explicit UTC time window (${spec.granularities.join("/")} ` +
    `aggregation). Read-only: it returns normalized metric points and data freshness and never ` +
    `mutates anything, never guesses a window, and never summarizes or judges the numbers.`;

  const inputSchema = createInputSchema(kind);
  const outputSchema = createOutputSchema(kind);

  const tool: ToolDefinition<HealthMetricToolInput, HealthMetricSeries> = {
    name: spec.toolName,
    description,
    permission: "read",
    inputSchema,
    outputSchema,
    async execute(input) {
      const parsed = inputSchema.parse(input);
      return fetchHealthMetricSeries(gateway, toQuery(kind, parsed), fetchOptions);
    },
    // No verifier on purpose: read-only tool; verification is legitimately SKIPPED.
  };

  const binding: AgentToolBinding = {
    toolName: spec.toolName,
    llm: {
      name: spec.toolName,
      description,
      inputSchema: {
        type: "object",
        properties: {
          startTime: {
            type: "string",
            description:
              "Inclusive window start as an explicit UTC instant, e.g. 2026-09-01T07:00:00Z.",
          },
          endTime: {
            type: "string",
            description:
              "Exclusive window end as an explicit UTC instant, e.g. 2026-09-08T07:00:00Z.",
          },
          granularity: {
            type: "string",
            enum: [...spec.granularities],
            description: "Aggregation period of the returned timeline.",
          },
          dimensions: {
            type: "array",
            items: { type: "string", enum: [...HEALTH_DIMENSIONS] },
            description: "Optional supported breakdown dimensions.",
          },
          metrics: {
            type: "array",
            items: { type: "string", enum: [...spec.metrics] },
            description: `Optional metric names supported by this tool (default: ${spec.primaryMetric}).`,
          },
        },
        required: ["startTime", "endTime", "granularity"],
        additionalProperties: false,
      },
    },
    serializeResult(output: unknown, verification: VerificationResult): string {
      const result = outputSchema.parse(output);
      if (
        !verification ||
        verification.toolName !== spec.toolName ||
        verification.permission !== "read" ||
        verification.required !== false ||
        verification.status !== "skipped" ||
        verification.code !== "VERIFICATION_SKIPPED" ||
        verification.verified !== false
      ) {
        throw invalid(`${spec.toolName} requires a skipped read verification result.`);
      }
      // Normalized health data only: no credentials, tokens, package identity,
      // raw Google objects, internal request objects or transport diagnostics.
      return JSON.stringify({
        kind: result.kind,
        toolName: result.toolName,
        window: result.window,
        dimensions: result.dimensions,
        metrics: result.metrics,
        freshness: result.freshness,
        points: result.points,
        pageCount: result.pageCount,
        rowCount: result.rowCount,
      });
    },
  };

  return Object.freeze({ tool, binding });
}

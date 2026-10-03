/** Phase 5.4 — read-only primary metric fetches and breach-only internal audit.
 * Thresholds/package/credentials are never caller input. All fetches and pure
 * evaluation finish before the first alert append. Appends are ordered but not
 * transactional; a failure never reports success and is never retried here.
 */
import { appendAuditEntry } from "../audit/log.js";
import type { NewAuditEntry } from "../audit/types.js";
import type { HealthConfig } from "../config/types.js";
import type { AgentToolBinding } from "../runtime/agent/index.js";
import type { ToolDefinition, ToolSchema } from "../runtime/tools/index.js";
import type { VerificationResult } from "../runtime/verification/index.js";
import { fetchHealthMetricSeries, type FetchHealthMetricOptions } from "./fetchers.js";
import type { HealthMetricGateway } from "./gateway.js";
import {
  HealthError,
  HEALTH_DIMENSIONS,
  isHealthDecimalString,
  validateHealthMetricQuery,
  type HealthGranularity,
  type HealthMetricSeries,
} from "./index.js";
import { parseHealthDecimal } from "./decimal.js";
import {
  buildHealthThresholdRules,
  evaluateHealthThresholds,
  HEALTH_THRESHOLDS_TOOL_NAME,
  type HealthThresholdEvaluation,
  type HealthThresholdResult,
} from "./thresholds.js";

export const HEALTH_THRESHOLD_ALERT_EVENT = "health.threshold.alert";
export interface HealthThresholdToolInput {
  readonly startTime: string;
  readonly endTime: string;
  readonly granularity: HealthGranularity;
  readonly dimensions?: readonly string[];
}
export interface HealthThresholdCheckResult extends HealthThresholdResult {
  readonly recordedAlertCount: number;
}
export interface HealthThresholdTool {
  readonly tool: ToolDefinition<HealthThresholdToolInput, HealthThresholdCheckResult>;
  readonly binding: AgentToolBinding;
}
export interface HealthThresholdToolOptions extends FetchHealthMetricOptions {
  readonly health: Readonly<HealthConfig>;
  readonly gateway: HealthMetricGateway;
  readonly auditLogPath: string;
  /** Trusted audit fault-injection seam only, never part of the runtime tool input. */
  readonly appendAlert?: (entry: NewAuditEntry) => void | Promise<void>;
}

function invalid(): HealthError {
  return new HealthError("Health threshold tool input or output is invalid.", "INVALID_ARGUMENT");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createHealthThresholdTool(
  options: HealthThresholdToolOptions,
): HealthThresholdTool {
  const rules = buildHealthThresholdRules(options?.health);
  const gateway = options.gateway;
  const auditLogPath = options.auditLogPath;
  if (
    !gateway ||
    typeof gateway.readMetricSet !== "function" ||
    typeof gateway.queryMetricSet !== "function" ||
    typeof auditLogPath !== "string" ||
    !auditLogPath.trim() ||
    (options.appendAlert !== undefined && typeof options.appendAlert !== "function")
  )
    throw invalid();
  const appendAlert =
    options.appendAlert ??
    ((entry: NewAuditEntry): void => {
      appendAuditEntry(auditLogPath, entry, { durable: true });
    });
  const fetchOptions: FetchHealthMetricOptions = {
    ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
  };
  const inputKeys = ["startTime", "endTime", "granularity", "dimensions"];
  const inputSchema: ToolSchema<HealthThresholdToolInput> = {
    parse(value) {
      if (!isRecord(value) || Object.keys(value).some((key) => !inputKeys.includes(key)))
        throw invalid();
      const query = {
        startTime: value.startTime as string,
        endTime: value.endTime as string,
        granularity: value.granularity as HealthGranularity,
        ...(value.dimensions !== undefined
          ? { dimensions: value.dimensions as readonly string[] }
          : {}),
      };
      // Basic validation also applies with zero enabled rules. Then preflight ALL
      // enabled kinds, including DAILY-only wakeups, before any source access.
      const validated = validateHealthMetricQuery({ ...query, kind: "crash_rate" });
      for (const rule of rules)
        validateHealthMetricQuery({ ...query, kind: rule.metricKind, metrics: [rule.metricName] });
      return Object.freeze({
        startTime: validated.window.startTimeUtc,
        endTime: validated.window.endTimeUtc,
        granularity: validated.window.granularity,
        dimensions: validated.dimensions,
      });
    },
  };
  const outputKeys = [
    "status",
    "enabledRuleCount",
    "evaluatedPointCount",
    "noDataCount",
    "evaluations",
    "breaches",
    "recordedAlertCount",
  ];
  const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key));
  const evaluationKeys = [
    "metricKind",
    "metricName",
    "observedValue",
    "thresholdValue",
    "operator",
    "status",
    "window",
    "startTimeUtc",
    "dimensions",
  ];
  const parseEvaluation = (value: unknown): HealthThresholdEvaluation => {
    if (!isRecord(value) || !exactKeys(value, evaluationKeys)) throw invalid();
    const rule = rules.find((entry) => entry.metricKind === value.metricKind);
    if (
      !rule ||
      value.metricName !== rule.metricName ||
      value.thresholdValue !== rule.thresholdValue ||
      value.operator !== ">" ||
      !["BREACHED", "NOT_BREACHED", "NO_DATA"].includes(value.status as string) ||
      !Array.isArray(value.dimensions)
    )
      throw invalid();
    if (value.status === "NO_DATA") {
      if (value.observedValue !== null) throw invalid();
    } else {
      if (!isHealthDecimalString(value.observedValue)) throw invalid();
      parseHealthDecimal(value.observedValue);
    }
    const names: string[] = [];
    for (const dimension of value.dimensions as unknown[]) {
      if (
        !isRecord(dimension) ||
        !exactKeys(dimension, ["name", "value", "valueType"]) ||
        typeof dimension.name !== "string" ||
        !HEALTH_DIMENSIONS.some((name) => name === dimension.name) ||
        names.includes(dimension.name) ||
        typeof dimension.value !== "string" ||
        !dimension.value.trim() ||
        (dimension.valueType !== "int64" && dimension.valueType !== "string")
      )
        throw invalid();
      if (dimension.valueType === "int64" && !/^[+-]?\d+$/.test(dimension.value)) throw invalid();
      names.push(dimension.name);
    }
    if (value.window === null) {
      if (value.status !== "NO_DATA" || value.startTimeUtc !== null || names.length !== 0)
        throw invalid();
    } else {
      if (
        !isRecord(value.window) ||
        !exactKeys(value.window, ["startTimeUtc", "endTimeUtc", "granularity"])
      )
        throw invalid();
      const query = {
        kind: rule.metricKind,
        startTime: value.window.startTimeUtc as string,
        endTime: value.window.endTimeUtc as string,
        granularity: value.window.granularity as HealthGranularity,
        dimensions: names,
        metrics: [rule.metricName],
      };
      validateHealthMetricQuery(query);
      if (value.startTimeUtc === null) {
        if (value.status !== "NO_DATA" || names.length !== 0) throw invalid();
      } else {
        if (typeof value.startTimeUtc !== "string" || value.startTimeUtc < query.startTime)
          throw invalid();
        validateHealthMetricQuery({ ...query, startTime: value.startTimeUtc });
      }
    }
    return value as unknown as HealthThresholdEvaluation;
  };
  const outputSchema: ToolSchema<HealthThresholdCheckResult> = {
    parse(value) {
      if (
        !isRecord(value) ||
        Object.keys(value).length !== outputKeys.length ||
        Object.keys(value).some((key) => !outputKeys.includes(key))
      )
        throw invalid();
      if (
        !["DISABLED", "NO_DATA", "EVALUATED"].includes(value.status as string) ||
        !Array.isArray(value.evaluations) ||
        !Array.isArray(value.breaches)
      )
        throw invalid();
      for (const count of [
        value.enabledRuleCount,
        value.evaluatedPointCount,
        value.noDataCount,
        value.recordedAlertCount,
      ]) {
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw invalid();
      }
      const evaluations = (value.evaluations as unknown[]).map(parseEvaluation);
      const expectedStatus =
        rules.length === 0
          ? "DISABLED"
          : evaluations.some((entry) => entry.status !== "NO_DATA")
            ? "EVALUATED"
            : "NO_DATA";
      if (
        value.status !== expectedStatus ||
        new Set(evaluations.map((entry) => entry.metricKind)).size !== rules.length ||
        JSON.stringify(value.breaches) !==
          JSON.stringify(evaluations.filter((entry) => entry.status === "BREACHED"))
      )
        throw invalid();
      if (
        value.enabledRuleCount !== rules.length ||
        value.recordedAlertCount !== value.breaches.length ||
        value.evaluatedPointCount !==
          value.evaluations.filter(
            (entry: unknown) => isRecord(entry) && entry.status !== "NO_DATA",
          ).length ||
        value.noDataCount !==
          value.evaluations.filter(
            (entry: unknown) => isRecord(entry) && entry.status === "NO_DATA",
          ).length
      )
        throw invalid();
      return value as unknown as HealthThresholdCheckResult;
    },
  };
  const description =
    "Check configured App Health primary metric thresholds over an explicit UTC window. Exact reported-scale operator thresholds only; no rescaling or aggregation. Reads Google only; real breaches append internal audit alerts, not human notifications.";
  const tool: ToolDefinition<HealthThresholdToolInput, HealthThresholdCheckResult> = {
    name: HEALTH_THRESHOLDS_TOOL_NAME,
    description,
    permission: "read",
    inputSchema,
    outputSchema,
    async execute(input) {
      const parsed = inputSchema.parse(input);
      const series: HealthMetricSeries[] = [];
      for (const rule of rules)
        series.push(
          await fetchHealthMetricSeries(
            gateway,
            { ...parsed, kind: rule.metricKind, metrics: [rule.metricName] },
            fetchOptions,
          ),
        );
      const result = evaluateHealthThresholds(series, rules);
      let recordedAlertCount = 0;
      for (const breach of result.breaches) {
        try {
          await appendAlert({
            type: HEALTH_THRESHOLD_ALERT_EVENT,
            actor: "system",
            action: HEALTH_THRESHOLDS_TOOL_NAME,
            status: "success",
            metadata: {
              metricKind: breach.metricKind,
              metricName: breach.metricName,
              observedValue: breach.observedValue,
              thresholdValue: breach.thresholdValue,
              operator: breach.operator,
              result: "BREACHED",
              startTimeUtc: breach.startTimeUtc,
              aggregationPeriod: breach.window.granularity,
              window: breach.window,
              dimensions: breach.dimensions,
            },
          });
          recordedAlertCount += 1;
        } catch (cause) {
          throw new HealthError(
            "Health threshold alert could not be durably appended to the audit log.",
            "ALERT_AUDIT_FAILED",
            { cause },
          );
        }
      }
      return Object.freeze({ ...result, recordedAlertCount });
    },
    // Internal audit persistence does not change Phase 2's read-only Google
    // classification: no approval metadata or external mutation verifier.
  };
  const binding: AgentToolBinding = {
    toolName: HEALTH_THRESHOLDS_TOOL_NAME,
    llm: {
      name: HEALTH_THRESHOLDS_TOOL_NAME,
      description,
      inputSchema: {
        type: "object",
        properties: {
          startTime: { type: "string", description: "Inclusive explicit UTC window start." },
          endTime: { type: "string", description: "Exclusive explicit UTC window end." },
          granularity: { type: "string", enum: ["DAILY", "HOURLY"] },
          dimensions: { type: "array", items: { type: "string", enum: [...HEALTH_DIMENSIONS] } },
        },
        required: ["startTime", "endTime", "granularity"],
        additionalProperties: false,
      },
    },
    serializeResult(output: unknown, verification: VerificationResult): string {
      const result = outputSchema.parse(output);
      if (
        !verification ||
        verification.toolName !== HEALTH_THRESHOLDS_TOOL_NAME ||
        verification.permission !== "read" ||
        verification.required !== false ||
        verification.status !== "skipped" ||
        verification.code !== "VERIFICATION_SKIPPED" ||
        verification.verified !== false
      )
        throw invalid();
      // Model-facing summary only; source payloads, config, paths and audit entries
      // never reach the LLM. Exact breach facts are in the operator's audit log.
      return JSON.stringify({
        status: result.status,
        enabledRuleCount: result.enabledRuleCount,
        evaluatedPointCount: result.evaluatedPointCount,
        noDataCount: result.noDataCount,
        breachedPointCount: result.breaches.length,
        recordedAlertCount: result.recordedAlertCount,
      });
    },
  };
  return Object.freeze({ tool, binding });
}

/**
 * Phase 5 health composition root.
 *
 * Registers the three read-only App Health metric tools in the real Phase 2
 * runtime over one Phase 1.1 auth client and one existing Phase 1.3 Reporting
 * client — no second Google auth or client path. The Phase 5.2 comparison and
 * Phase 5.4 threshold capability reuse that gateway; the descriptive report
 * still invokes only comparison. Threshold alerts are internal audit entries.
 *
 * Only composition knows the package identity, the Reporting client and the
 * audit ledger; the evaluator consumes validated rules/normalized data without
 * environment, credential files or streams.
 */
import { loadConfig, loadServiceAccountCredentials, type PlayOpsConfig } from "../config/index.js";
import { parseHealthThresholdConfig } from "../config/health.js";
import {
  createGoogleAuthClient,
  PLAY_DEVELOPER_REPORTING_SCOPE,
} from "../googleplay/auth/index.js";
import {
  createPlayReportingClient,
  type PlayReportingClient,
} from "../googleplay/reporting/index.js";
import { createFileAgentLedger, type AgentToolBinding } from "../runtime/agent/index.js";
import { ToolRegistry } from "../runtime/tools/index.js";
import { createHealthComparisonTool, type HealthComparisonTool } from "./compare-tool.js";
import { HEALTH_COMPARISON_TOOL_NAME } from "./comparison.js";
import { HEALTH_METRIC_KINDS, HEALTH_METRIC_SPECS, HealthError } from "./index.js";
import type { HealthMetricGateway } from "./gateway.js";
import { createReportingHealthMetricGateway } from "./reporting.js";
import { createHealthMetricTool, type HealthMetricTool } from "./tools.js";
import { createHealthThresholdTool, type HealthThresholdTool } from "./threshold-tool.js";
import { HEALTH_THRESHOLDS_TOOL_NAME } from "./thresholds.js";

/** Fixed-message configuration failure; raw values, paths and keys are never echoed. */
export class HealthCompositionError extends Error {
  override readonly name = "HealthCompositionError";
  readonly code = "CONFIG_INVALID";
}

/** Validate the configuration the health composition actually needs. */
export function validateHealthConfig(config: PlayOpsConfig): void {
  const invalid = (key: string): never => {
    throw new HealthCompositionError(`Health metrics require valid ${key}.`);
  };
  if (
    !config ||
    !config.googlePlay ||
    typeof config.googlePlay.packageName !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(config.googlePlay.packageName)
  ) {
    invalid("google_play.package_name");
  }
  if (
    typeof config.googlePlay.serviceAccountJson !== "string" ||
    !config.googlePlay.serviceAccountJson.trim()
  ) {
    invalid("google_play.service_account_json");
  }
  if (!config.audit || typeof config.audit.logPath !== "string" || !config.audit.logPath.trim()) {
    invalid("audit.log_path");
  }
  // Embedded/typed configs are as strict as YAML/env; before credential reads.
  parseHealthThresholdConfig(config.health);
}

export interface HealthComposition {
  readonly packageName: string;
  readonly gateway: HealthMetricGateway;
  readonly registry: ToolRegistry;
  readonly bindings: readonly AgentToolBinding[];
  readonly ledger: ReturnType<typeof createFileAgentLedger>;
  readonly tools: readonly HealthMetricTool[];
  /** Phase 5.2 baseline-comparison tool. */
  readonly comparisonTool: HealthComparisonTool;
  /** Separate Phase 5.4 capability; never executed by health report. */
  readonly thresholdTool: HealthThresholdTool;
}

/** Shared construction for production and fake-only tests; one Reporting client. */
export function createHealthComposition(
  config: PlayOpsConfig,
  deps: {
    readonly reporting: PlayReportingClient;
    /** Test/embedding seam; defaults to the same production gateway as the fetchers. */
    readonly comparisonGateway?: HealthMetricGateway;
  },
): HealthComposition {
  validateHealthConfig(config);
  if (
    !deps?.reporting ||
    typeof deps.reporting.vitals !== "object" ||
    deps.reporting.vitals === null
  ) {
    throw new HealthError("Health composition requires a Reporting client.", "INVALID_ARGUMENT");
  }
  const packageName = config.googlePlay.packageName;
  const gateway = createReportingHealthMetricGateway(deps.reporting, packageName);
  const tools = Object.freeze(
    HEALTH_METRIC_KINDS.map((kind) => createHealthMetricTool({ metricKind: kind, gateway })),
  );
  const comparisonTool = createHealthComparisonTool({
    gateway: deps.comparisonGateway ?? gateway,
  });
  const thresholdTool = createHealthThresholdTool({
    health: config.health,
    gateway,
    auditLogPath: config.audit.logPath,
  });
  const registry = new ToolRegistry();
  for (const entry of tools) {
    registry.register(entry.tool);
  }
  registry.register(comparisonTool.tool);
  registry.register(thresholdTool.tool);
  return Object.freeze({
    packageName,
    gateway,
    registry,
    bindings: Object.freeze([
      ...tools.map((entry) => entry.binding),
      comparisonTool.binding,
      thresholdTool.binding,
    ]),
    ledger: createFileAgentLedger(config.audit.logPath),
    tools,
    comparisonTool,
    thresholdTool,
  });
}

/** Only composition knows the concrete credential loaders and Google clients. */
export interface LiveHealthFactories {
  readonly loadConfig?: typeof loadConfig;
  readonly loadCredentials?: typeof loadServiceAccountCredentials;
  readonly authenticate?: typeof createGoogleAuthClient;
  readonly createReporting?: typeof createPlayReportingClient;
}

export async function createLiveHealthComposition(
  factories: LiveHealthFactories = {},
): Promise<HealthComposition> {
  const config = (factories.loadConfig ?? loadConfig)();
  validateHealthConfig(config); // before credentials, auth or client creation
  const credentials = (factories.loadCredentials ?? loadServiceAccountCredentials)(config);
  const auth = (factories.authenticate ?? createGoogleAuthClient)(credentials, [
    PLAY_DEVELOPER_REPORTING_SCOPE,
  ]);
  const reporting = (factories.createReporting ?? createPlayReportingClient)(auth);
  return createHealthComposition(config, { reporting });
}

/** Registered Phase 5.1 tool names, in registration order (Phase 5.2 tool excluded). */
export const HEALTH_METRIC_TOOL_NAMES: readonly string[] = Object.freeze(
  HEALTH_METRIC_KINDS.map((kind) => HEALTH_METRIC_SPECS[kind].toolName),
);

/** Every health tool registered by the health composition, in registration order. */
export const HEALTH_TOOL_NAMES: readonly string[] = Object.freeze([
  ...HEALTH_METRIC_TOOL_NAMES,
  HEALTH_COMPARISON_TOOL_NAME,
  HEALTH_THRESHOLDS_TOOL_NAME,
]);

/**
 * PlayOps configuration loader (through Phase 6.2 diagnostic logging).
 *
 * Precedence (highest wins): environment variables > config file > defaults.
 *
 * - Default path: config/playops.yaml (relative to cwd).
 * - Missing default file → defaults (not an error).
 * - Explicitly supplied path that is missing → ConfigError (CONFIG_NOT_FOUND).
 * - No credential-file existence checks here (that is Phase 0.7).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigError } from "./errors.js";
import { isLogLevel, type LogLevel } from "../logging/levels.js";
import {
  HEALTH_THRESHOLD_FIELDS,
  healthThresholdEnvOverrides,
  parseHealthThresholdConfig,
} from "./health.js";
import { DEFAULT_CONFIG, type PartialPlayOpsConfig, type PlayOpsConfig } from "./types.js";

export const DEFAULT_CONFIG_PATH = "config/playops.yaml";

/** Environment variable names that override config values. */
export const ENV_VARS = {
  packageName: "PLAYOPS_GOOGLE_PLAY_PACKAGE_NAME",
  serviceAccountJson: "PLAYOPS_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON",
  maxSteps: "PLAYOPS_AGENT_MAX_STEPS",
  approvalTimeoutSeconds: "PLAYOPS_AGENT_APPROVAL_TIMEOUT_SECONDS",
  crashRateReportedThreshold: HEALTH_THRESHOLD_FIELDS.crashRateReportedThreshold.env,
  anrRateReportedThreshold: HEALTH_THRESHOLD_FIELDS.anrRateReportedThreshold.env,
  excessiveWakeupRateReportedThreshold:
    HEALTH_THRESHOLD_FIELDS.excessiveWakeupRateReportedThreshold.env,
  logPath: "PLAYOPS_AUDIT_LOG_PATH",
  loggingLevel: "PLAYOPS_LOGGING_LEVEL",
  reviewCheckpointPath: "PLAYOPS_REVIEW_CHECKPOINT_PATH",
  releaseEditSessionPath: "PLAYOPS_RELEASE_EDIT_SESSION_PATH",
  releaseEditCleanupJournalPath: "PLAYOPS_RELEASE_EDIT_CLEANUP_JOURNAL_PATH",
  llm9RouterBaseUrl: "PLAYOPS_LLM_9ROUTER_BASE_URL",
  llm9RouterModel: "PLAYOPS_LLM_9ROUTER_MODEL",
  llm9RouterApiKey: "PLAYOPS_LLM_9ROUTER_API_KEY",
} as const;

export interface LoadConfigOptions {
  /** Explicit config file path. When omitted, DEFAULT_CONFIG_PATH is used. */
  configPath?: string;
  /** Environment source (defaults to process.env). Injectable for tests. */
  env?: Record<string, string | undefined>;
}

type RawConfig = Record<string, unknown>;

function readLoggingLevel(value: unknown): LogLevel {
  if (!isLogLevel(value)) {
    throw new ConfigError(
      "logging.level must be debug, info, warn or error.",
      "CONFIG_INVALID_VALUE",
    );
  }
  return value;
}

function isPlainObject(value: unknown): value is RawConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(raw: RawConfig, key: string, path: string): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ConfigError(
      `${path}.${key} must be a string, got ${typeof value}`,
      "CONFIG_INVALID_TYPE",
    );
  }
  return value;
}

function readNumber(raw: RawConfig, key: string, path: string): number | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ConfigError(
      `${path}.${key} must be a number, got ${typeof value}`,
      "CONFIG_INVALID_TYPE",
    );
  }
  return value;
}

function section(raw: RawConfig, key: string): RawConfig {
  const value = raw[key];
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    throw new ConfigError(`${key} must be a mapping, got ${typeof value}`, "CONFIG_INVALID_TYPE");
  }
  return value;
}

/** Parse raw YAML text into a partial typed config (defaults not yet applied). */
export function parseConfigYaml(yamlText: string): PartialPlayOpsConfig {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch {
    // Generic message; YAML raw content is never echoed (secrets may be in it).
    throw new ConfigError("Malformed YAML configuration.", "CONFIG_MALFORMED_YAML");
  }
  if (doc === null || doc === undefined) return {};
  if (!isPlainObject(doc)) {
    throw new ConfigError("Config root must be a mapping", "CONFIG_INVALID_TYPE");
  }

  const gp = section(doc, "google_play");
  const agent = section(doc, "agent");
  const health = section(doc, "health");
  const audit = section(doc, "audit");
  const logging = section(doc, "logging");
  const review = section(doc, "review");
  const release = section(doc, "release");
  const llmRoot = section(doc, "llm");
  const nineRouter = section(llmRoot, "nine_router");

  const result: PartialPlayOpsConfig = {};

  const packageName = readString(gp, "package_name", "google_play");
  const serviceAccountJson = readString(gp, "service_account_json", "google_play");
  if (packageName !== undefined || serviceAccountJson !== undefined) {
    const googlePlay: Partial<PlayOpsConfig["googlePlay"]> = {};
    if (packageName !== undefined) googlePlay.packageName = packageName;
    if (serviceAccountJson !== undefined) googlePlay.serviceAccountJson = serviceAccountJson;
    result.googlePlay = googlePlay;
  }

  const maxSteps = readNumber(agent, "max_steps", "agent");
  const approvalTimeoutSeconds = readNumber(agent, "approval_timeout_seconds", "agent");
  if (maxSteps !== undefined || approvalTimeoutSeconds !== undefined) {
    const agentSection: Partial<PlayOpsConfig["agent"]> = {};
    if (maxSteps !== undefined) {
      if (!Number.isInteger(maxSteps) || maxSteps < 1) {
        throw new ConfigError("agent.max_steps must be an integer >= 1", "CONFIG_INVALID_VALUE");
      }
      agentSection.maxSteps = maxSteps;
    }
    if (approvalTimeoutSeconds !== undefined) {
      if (approvalTimeoutSeconds < 0) {
        throw new ConfigError(
          "agent.approval_timeout_seconds must be >= 0",
          "CONFIG_INVALID_VALUE",
        );
      }
      agentSection.approvalTimeoutSeconds = approvalTimeoutSeconds;
    }
    result.agent = agentSection;
  }

  if (doc.health !== undefined) result.health = parseHealthThresholdConfig(health, "yaml");

  const loggingLevel = readString(logging, "level", "logging");
  if (loggingLevel !== undefined) result.logging = { level: readLoggingLevel(loggingLevel) };

  const logPath = readString(audit, "log_path", "audit");
  if (logPath !== undefined) {
    result.audit = { logPath };
  }

  const checkpointPath = readString(review, "checkpoint_path", "review");
  if (checkpointPath !== undefined) {
    result.review = { checkpointPath };
  }

  const editSessionPath = readString(release, "edit_session_path", "release");
  const editCleanupJournalPath = readString(release, "edit_cleanup_journal_path", "release");
  if (editSessionPath !== undefined || editCleanupJournalPath !== undefined) {
    result.release = {
      ...(editSessionPath !== undefined ? { editSessionPath } : {}),
      ...(editCleanupJournalPath !== undefined ? { editCleanupJournalPath } : {}),
    };
  }
  const nrBaseUrl = readString(nineRouter, "base_url", "llm.nine_router");
  const nrModel = readString(nineRouter, "model", "llm.nine_router");
  const nrApiKey = readString(nineRouter, "api_key", "llm.nine_router");
  if (nrBaseUrl !== undefined || nrModel !== undefined || nrApiKey !== undefined) {
    const nr: Partial<PlayOpsConfig["llm"]["nineRouter"]> = {};
    if (nrBaseUrl !== undefined) nr.baseUrl = nrBaseUrl;
    if (nrModel !== undefined) nr.model = nrModel;
    if (nrApiKey !== undefined) nr.apiKey = nrApiKey;
    result.llm = { nineRouter: nr };
  }

  return result;
}

function parseEnvNumber(name: string, raw: string): number {
  const value = Number(raw);
  if (Number.isNaN(value)) {
    throw new ConfigError(
      `Environment variable ${name} must be a number, got "${raw}"`,
      "CONFIG_INVALID_VALUE",
    );
  }
  return value;
}

/** Extract env-var overrides into a partial config. */
export function envOverrides(env: Record<string, string | undefined>): PartialPlayOpsConfig {
  const result: PartialPlayOpsConfig = {};
  const healthOverrides = healthThresholdEnvOverrides(env);
  if (Object.keys(healthOverrides).length > 0) result.health = healthOverrides;

  const loggingLevel = env[ENV_VARS.loggingLevel];
  if (loggingLevel !== undefined) result.logging = { level: readLoggingLevel(loggingLevel) };

  const packageName = env[ENV_VARS.packageName];
  const serviceAccountJson = env[ENV_VARS.serviceAccountJson];
  if (packageName !== undefined || serviceAccountJson !== undefined) {
    const googlePlay: Partial<PlayOpsConfig["googlePlay"]> = {};
    if (packageName !== undefined) googlePlay.packageName = packageName;
    if (serviceAccountJson !== undefined) googlePlay.serviceAccountJson = serviceAccountJson;
    result.googlePlay = googlePlay;
  }

  const maxSteps = env[ENV_VARS.maxSteps];
  const approvalTimeout = env[ENV_VARS.approvalTimeoutSeconds];
  if (maxSteps !== undefined || approvalTimeout !== undefined) {
    const agentSection: Partial<PlayOpsConfig["agent"]> = {};
    if (maxSteps !== undefined) agentSection.maxSteps = parseEnvNumber(ENV_VARS.maxSteps, maxSteps);
    if (approvalTimeout !== undefined)
      agentSection.approvalTimeoutSeconds = parseEnvNumber(
        ENV_VARS.approvalTimeoutSeconds,
        approvalTimeout,
      );
    result.agent = agentSection;
  }

  const logPath = env[ENV_VARS.logPath];
  if (logPath !== undefined) {
    result.audit = { logPath };
  }

  const checkpointPath = env[ENV_VARS.reviewCheckpointPath];
  if (checkpointPath !== undefined) {
    result.review = { checkpointPath };
  }

  const editSessionPath = env[ENV_VARS.releaseEditSessionPath];
  const editCleanupJournalPath = env[ENV_VARS.releaseEditCleanupJournalPath];
  if (editSessionPath !== undefined || editCleanupJournalPath !== undefined) {
    result.release = {
      ...(editSessionPath !== undefined ? { editSessionPath } : {}),
      ...(editCleanupJournalPath !== undefined ? { editCleanupJournalPath } : {}),
    };
  }

  const nrBaseUrl = env[ENV_VARS.llm9RouterBaseUrl];
  const nrModel = env[ENV_VARS.llm9RouterModel];
  const nrApiKey = env[ENV_VARS.llm9RouterApiKey];
  if (nrBaseUrl !== undefined || nrModel !== undefined || nrApiKey !== undefined) {
    const nr: Partial<PlayOpsConfig["llm"]["nineRouter"]> = {};
    if (nrBaseUrl !== undefined) nr.baseUrl = nrBaseUrl;
    if (nrModel !== undefined) nr.model = nrModel;
    if (nrApiKey !== undefined) nr.apiKey = nrApiKey;
    result.llm = { nineRouter: nr };
  }

  return result;
}

function merge(base: PlayOpsConfig, override: PartialPlayOpsConfig): PlayOpsConfig {
  return {
    googlePlay: { ...base.googlePlay, ...override.googlePlay },
    agent: { ...base.agent, ...override.agent },
    health: { ...base.health, ...override.health },
    audit: { ...base.audit, ...override.audit },
    logging: { ...base.logging, ...override.logging },
    review: { ...base.review, ...override.review },
    release: { ...base.release, ...override.release },
    llm: {
      nineRouter: { ...base.llm.nineRouter, ...override.llm?.nineRouter },
    },
  };
}

/**
 * Load PlayOps configuration.
 *
 * Resolution order (later wins): DEFAULT_CONFIG < config file < environment.
 *
 * Missing default config file is fine (defaults apply). An explicitly supplied
 * config path that does not exist raises ConfigError(CONFIG_NOT_FOUND) — a
 * missing explicit path is treated as operator error, not guessed around.
 */
export function loadConfig(options: LoadConfigOptions = {}): PlayOpsConfig {
  const explicit = options.configPath !== undefined;
  const path = resolve(options.configPath ?? DEFAULT_CONFIG_PATH);

  let fromFile: PartialPlayOpsConfig = {};
  let text: string | undefined;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    const missing = (cause as NodeJS.ErrnoException).code === "ENOENT";
    if (!missing) throw cause;
    if (explicit) {
      throw new ConfigError(`Config file not found: ${path}`, "CONFIG_NOT_FOUND");
    }
    // Default config file absent → defaults only (plus env overrides below).
  }
  if (text !== undefined) {
    fromFile = parseConfigYaml(text);
  }

  const fromEnv = envOverrides(options.env ?? process.env);
  return merge(merge(DEFAULT_CONFIG, fromFile), fromEnv);
}

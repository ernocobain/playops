/** Phase 5.4 — one health threshold model, migrated to exact reported scale. */
import { parseHealthDecimal } from "../health/decimal.js";
import { ConfigError } from "./errors.js";
import type { HealthConfig } from "./types.js";

export const HEALTH_THRESHOLD_FIELDS = Object.freeze({
  crashRateReportedThreshold: Object.freeze({
    yaml: "crash_rate_reported_threshold",
    env: "PLAYOPS_HEALTH_CRASH_RATE_REPORTED_THRESHOLD",
  }),
  anrRateReportedThreshold: Object.freeze({
    yaml: "anr_rate_reported_threshold",
    env: "PLAYOPS_HEALTH_ANR_RATE_REPORTED_THRESHOLD",
  }),
  excessiveWakeupRateReportedThreshold: Object.freeze({
    yaml: "excessive_wakeup_rate_reported_threshold",
    env: "PLAYOPS_HEALTH_EXCESSIVE_WAKEUP_RATE_REPORTED_THRESHOLD",
  }),
});

const RETIRED_FIELDS = Object.freeze({
  crashRateThreshold: "crashRateReportedThreshold",
  crash_rate_threshold: "crashRateReportedThreshold",
  anrRateThreshold: "anrRateReportedThreshold",
  anr_rate_threshold: "anrRateReportedThreshold",
} as const);
const RETIRED_ENV = Object.freeze({
  PLAYOPS_HEALTH_CRASH_RATE_THRESHOLD: HEALTH_THRESHOLD_FIELDS.crashRateReportedThreshold.env,
  PLAYOPS_HEALTH_ANR_RATE_THRESHOLD: HEALTH_THRESHOLD_FIELDS.anrRateReportedThreshold.env,
});

/** Never echo operator-supplied values; never coerce the Decimal to a number. */
export function parseReportedHealthThreshold(
  value: unknown,
  field: string,
  allowDisabled = true,
): string | null {
  if (value === null && allowDisabled) return null;
  if (typeof value !== "string") {
    throw new ConfigError(
      `${field} must be an exact decimal string${allowDisabled ? " or null" : ""}; quote decimal values in YAML.`,
      "CONFIG_INVALID_TYPE",
    );
  }
  const invalid = (): never => {
    throw new ConfigError(
      `${field} must be a non-negative exact decimal string without surrounding whitespace.`,
      "CONFIG_INVALID_VALUE",
    );
  };
  if (!value || value !== value.trim()) invalid();
  try {
    if (parseHealthDecimal(value).negative) invalid();
  } catch {
    invalid();
  }
  return value;
}

/** Strict health subsection only; other sections keep their established policy. */
export function parseHealthThresholdConfig(
  input: unknown,
  syntax: "typed" | "yaml" = "typed",
): HealthConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ConfigError("health must be a mapping.", "CONFIG_INVALID_TYPE");
  }
  const raw = input as Record<string, unknown>;
  for (const [retired, replacement] of Object.entries(RETIRED_FIELDS)) {
    if (Object.hasOwn(raw, retired)) {
      const field = syntax === "yaml" ? HEALTH_THRESHOLD_FIELDS[replacement].yaml : replacement;
      throw new ConfigError(
        `health.${retired} is retired; use health.${field} as an exact reported-scale decimal string or null. No automatic migration is supported.`,
        "CONFIG_MIGRATION_REQUIRED",
      );
    }
  }
  const keys = Object.keys(HEALTH_THRESHOLD_FIELDS) as (keyof HealthConfig)[];
  const allowed = keys.map((key) => (syntax === "yaml" ? HEALTH_THRESHOLD_FIELDS[key].yaml : key));
  if (Object.keys(raw).some((key) => !allowed.includes(key as (typeof allowed)[number]))) {
    throw new ConfigError(
      "health contains an unsupported field; only the three reported-scale threshold fields are accepted.",
      "CONFIG_INVALID_VALUE",
    );
  }
  const result = {} as HealthConfig;
  for (const key of keys) {
    const inputKey = syntax === "yaml" ? HEALTH_THRESHOLD_FIELDS[key].yaml : key;
    result[key] = Object.hasOwn(raw, inputKey)
      ? parseReportedHealthThreshold(raw[inputKey], `health.${inputKey}`)
      : null;
  }
  return Object.freeze(result);
}

/** Retired env names fail even when blank; absence (undefined) is not an override. */
export function healthThresholdEnvOverrides(
  env: Record<string, string | undefined>,
): Partial<HealthConfig> {
  for (const [retired, replacement] of Object.entries(RETIRED_ENV)) {
    if (env[retired] !== undefined) {
      throw new ConfigError(
        `Environment variable ${retired} is retired; use ${replacement} with an exact reported-scale decimal string. No automatic migration is supported.`,
        "CONFIG_MIGRATION_REQUIRED",
      );
    }
  }
  const result: Partial<HealthConfig> = {};
  for (const key of Object.keys(HEALTH_THRESHOLD_FIELDS) as (keyof HealthConfig)[]) {
    const name = HEALTH_THRESHOLD_FIELDS[key].env;
    if (env[name] !== undefined) {
      result[key] = parseReportedHealthThreshold(env[name], `Environment variable ${name}`, false);
    }
  }
  return result;
}

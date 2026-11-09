/** Phase 5.4 WP1a — pure argument and runtime summary validation for `playops health check`. */
import {
  validateHealthMetricQuery,
  type HealthDimension,
  type HealthGranularity,
} from "../health/index.js";
import { UnsupportedThresholdGranularityError } from "../health/summary-errors.js";
import { parseUtcInstant } from "../health/time.js";

export class HealthCheckCliError extends Error {
  override readonly name = "HealthCheckCliError";
  readonly code = "CLI_ARGUMENT_INVALID";
}

export type HealthCheckSummaryStatus =
  "NO_BREACH_OBSERVED" | "BREACH_DETECTED" | "INCOMPLETE_DATA" | "NO_DATA" | "DISABLED";

export interface HealthCheckSummary {
  readonly status: HealthCheckSummaryStatus;
  readonly enabledRuleCount: number;
  readonly evaluatedPointCount: number;
  readonly noDataCount: number;
  readonly breachedPointCount: number;
  readonly recordedAlertCount: number;
}

export interface HealthCheckInput {
  readonly startTime: string;
  readonly endTime: string;
  readonly granularity: HealthGranularity;
  readonly dimensions: readonly HealthDimension[];
}

export type HealthCheckCommand =
  | { readonly kind: "help" }
  | { readonly kind: "check"; readonly input: HealthCheckInput; readonly json: boolean };

const SUMMARY_STATUSES: readonly HealthCheckSummaryStatus[] = Object.freeze([
  "NO_BREACH_OBSERVED",
  "BREACH_DETECTED",
  "INCOMPLETE_DATA",
  "NO_DATA",
  "DISABLED",
]);

const VALUE_FLAGS: readonly string[] = Object.freeze([
  "--start",
  "--end",
  "--granularity",
  "--dimensions",
]);

const SUMMARY_KEYS: readonly string[] = Object.freeze([
  "status",
  "enabledRuleCount",
  "evaluatedPointCount",
  "noDataCount",
  "breachedPointCount",
  "recordedAlertCount",
]);

function sanitizeOneLine(text: string): string {
  // eslint-disable-next-line no-control-regex -- untrusted CLI text must not carry terminal controls or NUL
  return text.replace(/[\x00-\x1f\x7f-\x9f]+/gu, " ").trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isHealthCheckSummaryStatus(value: unknown): value is HealthCheckSummaryStatus {
  return typeof value === "string" && SUMMARY_STATUSES.some((status) => status === value);
}

/** Parse tokens after `playops health check`. Both `--flag VALUE` and `--flag=VALUE` are accepted. */
export function parseHealthCheckCommand(args: readonly string[]): HealthCheckCommand {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    return Object.freeze({ kind: "help" });
  }

  const values = new Map<string, string>();
  let json = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    const equals = arg.indexOf("=");
    const flag = equals < 0 ? arg : arg.slice(0, equals);

    if (flag === "--help") {
      throw new HealthCheckCliError('Unexpected "--help"; it may only be passed alone.');
    }

    if (flag === "--json") {
      if (equals >= 0) {
        throw new HealthCheckCliError('Flag "--json" does not take a value.');
      }
      if (json) {
        throw new HealthCheckCliError('Duplicate flag "--json".');
      }
      json = true;
      continue;
    }

    if (!VALUE_FLAGS.includes(flag)) {
      throw new HealthCheckCliError(`Unexpected argument "${sanitizeOneLine(arg)}".`);
    }

    if (values.has(flag)) {
      throw new HealthCheckCliError(`Duplicate flag "${flag}".`);
    }

    let value: string | undefined;
    if (equals < 0) {
      i += 1;
      value = args[i];
    } else {
      value = arg.slice(equals + 1);
    }

    if (value === undefined) {
      throw new HealthCheckCliError(`Missing value for "${flag}".`);
    }
    if (value === "" || value !== value.trim() || value.startsWith("--")) {
      const suffix = value.startsWith("--") ? ` (unexpected "${sanitizeOneLine(value)}")` : "";
      throw new HealthCheckCliError(`Invalid value for "${flag}"${suffix}.`);
    }

    values.set(flag, value);
  }

  const startTime = values.get("--start");
  if (startTime === undefined) {
    throw new HealthCheckCliError('Missing required flag "--start".');
  }
  const endTime = values.get("--end");
  if (endTime === undefined) {
    throw new HealthCheckCliError('Missing required flag "--end".');
  }
  const granularity = values.get("--granularity");
  if (granularity === undefined) {
    throw new HealthCheckCliError('Missing required flag "--granularity".');
  }

  try {
    parseUtcInstant(startTime, "--start");
    parseUtcInstant(endTime, "--end");
  } catch (cause) {
    const message =
      cause instanceof Error ? sanitizeOneLine(cause.message) : "Invalid --start or --end value.";
    throw new HealthCheckCliError(message, { cause });
  }

  if (granularity !== "DAILY" && granularity !== "HOURLY") {
    throw new HealthCheckCliError('Flag "--granularity" must be DAILY or HOURLY.');
  }

  const dimensionsRaw = values.get("--dimensions");
  let dimensions: readonly string[] | undefined;
  if (dimensionsRaw !== undefined) {
    const entries = dimensionsRaw.split(",");
    if (entries.some((entry) => entry === "" || entry !== entry.trim())) {
      throw new HealthCheckCliError(
        'Flag "--dimensions" must be a comma-separated list of non-empty trimmed names.',
      );
    }
    dimensions = entries;
  }

  try {
    const validated = validateHealthMetricQuery({
      kind: "crash_rate",
      startTime,
      endTime,
      granularity,
      ...(dimensions !== undefined ? { dimensions } : {}),
    });
    return Object.freeze({
      kind: "check",
      input: Object.freeze({
        startTime: validated.window.startTimeUtc,
        endTime: validated.window.endTimeUtc,
        granularity: validated.window.granularity,
        dimensions: validated.dimensions,
      }),
      json,
    });
  } catch (cause) {
    const detail = cause instanceof Error ? sanitizeOneLine(cause.message) : "Invalid query.";
    const blamed = detail.includes("dimensions") ? "--dimensions" : "--start/--end";
    throw new HealthCheckCliError(`Invalid ${blamed}: ${detail}`, { cause });
  }
}

function parseSummaryCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new HealthCheckCliError(
      `Health check summary field "${field}" must be a non-negative safe integer.`,
    );
  }
  return value;
}

/** Validate the six-field runtime summary payload without cross-field arithmetic assumptions. */
export function parseHealthCheckSummary(value: unknown): HealthCheckSummary {
  if (!isPlainObject(value)) {
    throw new HealthCheckCliError("Health check summary must be a plain object.");
  }

  for (const requiredKey of SUMMARY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, requiredKey)) {
      throw new HealthCheckCliError(
        `Health check summary is missing required field "${requiredKey}".`,
      );
    }
  }

  for (const key of Object.keys(value)) {
    if (!SUMMARY_KEYS.includes(key)) {
      throw new HealthCheckCliError(
        `Health check summary contains unexpected field "${sanitizeOneLine(key)}".`,
      );
    }
  }

  const status = value.status;
  if (!isHealthCheckSummaryStatus(status)) {
    throw new HealthCheckCliError('Health check summary field "status" is invalid.');
  }

  const enabledRuleCount = parseSummaryCount(value.enabledRuleCount, "enabledRuleCount");
  const evaluatedPointCount = parseSummaryCount(value.evaluatedPointCount, "evaluatedPointCount");
  const noDataCount = parseSummaryCount(value.noDataCount, "noDataCount");
  const breachedPointCount = parseSummaryCount(value.breachedPointCount, "breachedPointCount");
  const recordedAlertCount = parseSummaryCount(value.recordedAlertCount, "recordedAlertCount");

  return Object.freeze({
    status,
    enabledRuleCount,
    evaluatedPointCount,
    noDataCount,
    breachedPointCount,
    recordedAlertCount,
  });
}

export const HEALTH_CHECK_HELP: string = [
  "Usage: playops health check --start UTC --end UTC --granularity DAILY|HOURLY",
  "  [--dimensions NAME[,NAME...]] [--json]",
  "",
  "Checks the operator-configured App Health primary-metric thresholds over an explicit UTC window.",
  "--start and --end are strict UTC instants (YYYY-MM-DDTHH:MM:SSZ); start inclusive, end exclusive.",
  "--granularity is DAILY or HOURLY, case-sensitive; DAILY windows align to America/Los_Angeles midnight.",
  "--dimensions narrows the check to the named dimensions; duplicates and unknown names are rejected.",
  "--json prints one machine-readable object instead of the human summary.",
  "",
  "Exit codes: 0 no breach observed, 2 breach detected, 1 incomplete data, no data, disabled thresholds or invalid arguments.",
].join("\n");

export function renderHealthCheckSummary(summary: HealthCheckSummary, json: boolean): string {
  if (json) {
    return JSON.stringify({
      status: summary.status,
      enabledRuleCount: summary.enabledRuleCount,
      evaluatedPointCount: summary.evaluatedPointCount,
      noDataCount: summary.noDataCount,
      breachedPointCount: summary.breachedPointCount,
      recordedAlertCount: summary.recordedAlertCount,
    });
  }
  return [
    "App Health threshold check",
    `Status: ${summary.status}`,
    `Rules: ${summary.enabledRuleCount} enabled`,
    `Points: ${summary.evaluatedPointCount} evaluated, ${summary.noDataCount} no data, ${summary.breachedPointCount} breached`,
    `Alerts: ${summary.recordedAlertCount} recorded`,
  ].join("\n");
}

export function healthCheckExitCode(summary: HealthCheckSummary): 0 | 1 | 2 {
  switch (summary.status) {
    case "NO_BREACH_OBSERVED":
      return 0;
    case "BREACH_DETECTED":
      return 2;
    case "INCOMPLETE_DATA":
    case "NO_DATA":
    case "DISABLED":
      return 1;
  }
}

export interface HealthCheckCliIo {
  write(text: string): void | Promise<void>;
  writeError(text: string): void;
}

export interface HealthCheckCliDeps {
  /** Caller-injected summary provider receiving the already-validated parsed input. */
  readonly readSummary?: (input: HealthCheckInput) => unknown | Promise<unknown>;
}

export async function runHealthCheckCli(
  args: readonly string[],
  io: HealthCheckCliIo,
  deps: HealthCheckCliDeps = {},
): Promise<0 | 1 | 2> {
  let command: HealthCheckCommand;
  try {
    command = parseHealthCheckCommand(args);
  } catch (error) {
    const message =
      error instanceof Error ? sanitizeOneLine(error.message) : "Invalid health check arguments.";
    io.writeError(`${message}\n`);
    return 1;
  }

  if (command.kind === "help") {
    try {
      await io.write(`${HEALTH_CHECK_HELP}\n`);
      return 0;
    } catch {
      io.writeError("Health check help could not be written to stdout.\n");
      return 1;
    }
  }

  if (typeof deps.readSummary !== "function") {
    io.writeError("Health check could not read the runtime summary.\n");
    return 1;
  }

  let rawSummary: unknown;
  try {
    rawSummary = await deps.readSummary(command.input);
  } catch (error) {
    if (error instanceof UnsupportedThresholdGranularityError) {
      io.writeError(`${sanitizeOneLine(error.message)}\n`);
      return 1;
    }
    io.writeError("Health check runtime summary could not be produced.\n");
    return 1;
  }

  let summary: HealthCheckSummary;
  try {
    summary = parseHealthCheckSummary(rawSummary);
  } catch (error) {
    const message =
      error instanceof Error ? sanitizeOneLine(error.message) : "Invalid health check summary.";
    io.writeError(`${message}\n`);
    return 1;
  }

  const rendered = renderHealthCheckSummary(summary, command.json);
  try {
    await io.write(`${rendered}\n`);
  } catch {
    io.writeError("Health check output could not be written to stdout.\n");
    return 1;
  }

  return healthCheckExitCode(summary);
}

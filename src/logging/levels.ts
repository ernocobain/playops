/** Ordered minimum severities, not an audit event taxonomy. */
export const LOG_LEVELS = Object.freeze(["debug", "info", "warn", "error"] as const);
export type LogLevel = (typeof LOG_LEVELS)[number];
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

export function isLogLevel(value: unknown): value is LogLevel {
  return LOG_LEVELS.some((level) => level === value);
}

/** Diagnostic JSONL only; never an audit writer or authoritative operation evidence. */
import { DEFAULT_LOG_LEVEL, isLogLevel, LOG_LEVELS, type LogLevel } from "./levels.js";
import { sanitizeLogContext } from "./context.js";
export { DEFAULT_LOG_LEVEL, isLogLevel, LOG_LEVELS, type LogLevel } from "./levels.js";

/** One sanitized newline-terminated record; rejection is diagnostic failure only. */
export type LogSink = (line: string) => void | Promise<void>;
export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly sink: LogSink;
  readonly now?: () => Date;
}
export interface Logger {
  debug(message: string, context?: unknown): void;
  info(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  error(message: string, context?: unknown): void;
}

/**
 * Messages must be static/safe strings, and context must be explicitly selected
 * metadata, never entire config/env/HTTP payloads. Key redaction is defense in
 * depth, not universal scanning of free-form text. No raw Error message/stack.
 * Sink/clock/serialization failure drops diagnostics without retry or fallback;
 * this policy is NOT used by audit, approval, verification or alert writes.
 */
export function createLogger(options: LoggerOptions): Logger {
  const level = options.level === undefined ? DEFAULT_LOG_LEVEL : options.level;
  if (!isLogLevel(level)) throw new Error("Invalid logging level.");
  const minimum = LOG_LEVELS.indexOf(level);
  const now = options.now ?? (() => new Date());
  const sink = options.sink;
  const emit = (severity: LogLevel, message: string, context?: unknown): void => {
    if (
      LOG_LEVELS.indexOf(severity) < minimum ||
      typeof message !== "string" ||
      message.length > 2048
    )
      return;
    try {
      const timestamp = Date.prototype.toISOString.call(now());
      const line = `${JSON.stringify({
        timestamp,
        level: severity,
        message,
        ...(context !== undefined ? { context: sanitizeLogContext(context) } : {}),
      })}\n`;
      const pending = sink(line);
      if (pending !== undefined)
        void Promise.resolve(pending).catch(() => {
          // Best-effort diagnostics: never log a sink failure through another sink.
        });
    } catch {
      // Broken diagnostics must not change a command result or weaken audit.
    }
  };
  return Object.freeze({
    debug: (message: string, context?: unknown) => emit("debug", message, context),
    info: (message: string, context?: unknown) => emit("info", message, context),
    warn: (message: string, context?: unknown) => emit("warn", message, context),
    error: (message: string, context?: unknown) => emit("error", message, context),
  });
}

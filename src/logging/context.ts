/**
 * Bounded, getter-free safe copies for diagnostic context, not audit storage.
 * String values must already be safe: this is key redaction, not secret scanning.
 */
import { types } from "node:util";
import { isSensitiveKey, REDACTED } from "../shared/redaction.js";

export type LogValue = null | string | boolean | number | LogValue[] | { [key: string]: LogValue };
const UNSUPPORTED = "[UNSUPPORTED]";
const TRUNCATED = "[TRUNCATED]";
const MAX_DEPTH = 12;
const MAX_ENTRIES = 100;
const MAX_NODES = 1000;
const MAX_STRING_LENGTH = 2048;
const MAX_KEY_LENGTH = 128;

function sensitiveLogKey(key: string): boolean {
  // Retain every audit rule; diagnostics additionally recognize all separator
  // forms and API keys. Audit's exact legacy matching is deliberately unchanged.
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return isSensitiveKey(normalized) || normalized.endsWith("apikey");
}

/** Read own data only, never inherited fields or accessors (including stack). */
function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function safeError(value: object): LogValue {
  const output: Record<string, LogValue> = Object.create(null) as Record<string, LogValue>;
  const uncertainty = ownData(value, "externalStateUncertain");
  if (typeof uncertainty === "boolean") output.externalStateUncertain = uncertainty;
  // Raw names/codes can themselves be secrets; do not copy them or attempt a
  // regex-based proof of safety. Phase 6.3 owns broader error taxonomy.
  output.name = "Error";
  const status = ownData(value, "status");
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599)
    output.status = status;
  return output;
}

export function sanitizeLogContext(value: unknown): LogValue {
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): LogValue => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) return TRUNCATED;
    if (item === null || item === undefined) return null;
    if (typeof item === "string") return item.length > MAX_STRING_LENGTH ? TRUNCATED : item;
    if (typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : null;
    if (typeof item === "bigint") {
      const text = item.toString();
      return text.length > MAX_STRING_LENGTH ? TRUNCATED : text;
    }
    if (typeof item !== "object" || types.isProxy(item)) return UNSUPPORTED;
    if (types.isNativeError(item)) return safeError(item);
    if (ancestors.has(item)) return "[CIRCULAR]";
    const array = Array.isArray(item);
    const prototype: unknown = Object.getPrototypeOf(item);
    if (!array && prototype !== Object.prototype && prototype !== null) return UNSUPPORTED;
    ancestors.add(item);
    try {
      if (array) {
        const length = ownData(item, "length");
        if (typeof length !== "number" || length > MAX_ENTRIES) return TRUNCATED;
        const output: LogValue[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          output.push(
            descriptor !== undefined && !("value" in descriptor)
              ? UNSUPPORTED
              : visit(ownData(item, String(index)), depth + 1),
          );
        }
        return output;
      }
      const keys = Object.keys(item).sort();
      if (keys.length > MAX_ENTRIES || keys.some((key) => key.length > MAX_KEY_LENGTH))
        return TRUNCATED;
      const output: Record<string, LogValue> = Object.create(null) as Record<string, LogValue>;
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        output[key] = sensitiveLogKey(key)
          ? REDACTED
          : descriptor === undefined || !("value" in descriptor)
            ? UNSUPPORTED
            : visit(ownData(item, key), depth + 1);
      }
      return output;
    } finally {
      ancestors.delete(item);
    }
  };
  try {
    return visit(value, 0);
  } catch {
    // No raw fallback or secondary error logging: even a broken diagnostic
    // value must not leak an error message or escape into the command runtime.
    return UNSUPPORTED;
  }
}

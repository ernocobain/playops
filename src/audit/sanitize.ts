/**
 * Metadata sanitization for the audit log (Phase 0.6).
 *
 * Redacts values whose keys match sensitive concepts (case-insensitive,
 * separator-tolerant: matches "access_token", "accessToken", "ACCESS-TOKEN",
 * "clientSecret", …). Works recursively on nested plain objects and arrays.
 *
 * This is intentionally minimal — a protection layer for the audit log,
 * not a general security framework.
 */

export const REDACTED = "[REDACTED]";

/** Sensitive key fragments; normalized (lowercase, separators stripped) before matching. */
const SENSITIVE_KEYS = [
  "authorization",
  "token",
  "accesstoken",
  "refreshtoken",
  "password",
  "secret",
  "privatekey",
  "clientsecret",
] as const;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEYS.some((s) => normalized === s || normalized.endsWith(s));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Return a sanitized deep copy of `metadata`. Sensitive values become REDACTED;
 * everything else is structurally unchanged. The input is never mutated.
 */
export function sanitizeAuditMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue(metadata) as Record<string, unknown>;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? REDACTED : sanitizeValue(inner);
    }
    return out;
  }
  return value;
}

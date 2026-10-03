/** Pure, provider-neutral legacy secret-key policy shared without any I/O. */
export const REDACTED = "[REDACTED]";
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

/** Audit's exact Phase 0.6 case/separator/suffix semantics; do not broaden here. */
export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  return SENSITIVE_KEYS.some((s) => normalized === s || normalized.endsWith(s));
}

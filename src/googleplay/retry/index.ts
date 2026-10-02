import { setTimeout } from "node:timers/promises";

export type OperationSafety = "read" | "mutation";

export interface RetryPolicy {
  /** Total calls, including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
});

export interface RetryOptions {
  safety: OperationSafety;
  policy?: RetryPolicy;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  /** A future mutation must explicitly document why its retry is safe. */
  mutationRetry?: { idempotencyReason: string };
}

export type ReadRetryOptions = Pick<RetryOptions, "policy" | "sleep" | "now" | "random">;

const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"]);

function validatePolicy(policy: RetryPolicy): void {
  if (
    !Number.isInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1 ||
    policy.maxAttempts > 10 ||
    !Number.isInteger(policy.baseDelayMs) ||
    policy.baseDelayMs < 1 ||
    !Number.isInteger(policy.maxDelayMs) ||
    policy.maxDelayMs < policy.baseDelayMs ||
    policy.maxDelayMs > 60_000
  ) {
    throw new RangeError("Invalid retry policy: attempts must be 1–10 and delays 1–60000 ms");
  }
}

/** Consult only structured HTTP status, never an error message or request config. */
export function isRetryableError(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const error = cause as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  const rawStatus = error.response?.status ?? error.status ?? error.code;
  const status =
    typeof rawStatus === "string" && /^\d{3}$/.test(rawStatus) ? Number(rawStatus) : rawStatus;
  if (typeof status === "number") return RETRYABLE_HTTP.has(status);
  return typeof status === "string" && RETRYABLE_NETWORK.has(status);
}

/** `failedAttempt` starts at 1; half-to-full jitter limits synchronized clients. */
export function calculateRetryDelay(
  failedAttempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  validatePolicy(policy);
  if (
    !Number.isInteger(failedAttempt) ||
    failedAttempt < 1 ||
    failedAttempt >= policy.maxAttempts
  ) {
    throw new RangeError("Invalid retry attempt");
  }
  const jitter = random();
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    throw new RangeError("Invalid retry jitter");
  }
  const capped = Math.min(policy.baseDelayMs * 2 ** (failedAttempt - 1), policy.maxDelayMs);
  return Math.round(capped * (0.5 + jitter / 2));
}

/** Accept only non-negative integer seconds or a canonical HTTP-date. */
function retryAfterDelay(cause: unknown, now: () => number): number | undefined {
  if (typeof cause !== "object" || cause === null || !("response" in cause)) return undefined;
  const response = cause.response;
  if (typeof response !== "object" || response === null || !("headers" in response)) {
    return undefined;
  }
  const headers = response.headers;
  let hint: unknown;
  if (headers instanceof Headers) {
    hint = headers.get("retry-after");
  } else if (typeof headers === "object" && headers !== null) {
    hint = Object.entries(headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
  }
  if (typeof hint !== "string") return undefined;
  const value = hint.trim();
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? seconds * 1_000 : undefined;
  }
  if (
    !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)
  ) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== value) return undefined;
  const delay = timestamp - now();
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

/** Run one operation; transient retries are introduced only for safe operations. */
export async function executeWithRetry<T>(
  action: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  validatePolicy(policy);
  if (
    options.mutationRetry !== undefined &&
    (typeof options.mutationRetry.idempotencyReason !== "string" ||
      options.mutationRetry.idempotencyReason.trim() === "")
  ) {
    throw new TypeError("mutationRetry.idempotencyReason must document idempotency");
  }
  const sleep = options.sleep ?? ((ms: number) => setTimeout(ms));
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (cause) {
      const safeToRetry =
        options.safety === "read" ||
        (options.safety === "mutation" && options.mutationRetry !== undefined);
      if (!safeToRetry || !isRetryableError(cause) || attempt >= policy.maxAttempts) {
        throw cause;
      }
      const hint = retryAfterDelay(cause, options.now ?? Date.now);
      await sleep(
        hint === undefined
          ? calculateRetryDelay(attempt, policy, options.random)
          : Math.min(hint, policy.maxDelayMs),
      );
    }
  }
}

/**
 * Phase 3.1 — PlayOps-owned review domain errors and Google Timestamp handling.
 * No Google client import; timestamps are compared as (BigInt seconds, integer nanos).
 */

export type ReviewIngestionErrorCode =
  | "INVALID_ARGUMENT"
  | "REMOTE_DATA_INVALID"
  | "PAGINATION_LOOP"
  | "MAX_PAGES_EXCEEDED"
  | "CHECKPOINT_INVALID"
  | "CHECKPOINT_PACKAGE_MISMATCH"
  | "CHECKPOINT_READ_FAILED"
  | "CHECKPOINT_WRITE_FAILED"
  | "SOURCE_FAILED";

/** Safe messages only; causes preserved programmatically, never serialized into messages. */
export class ReviewIngestionError extends Error {
  override readonly name = "ReviewIngestionError";
  constructor(
    readonly code: ReviewIngestionErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
  }
}

/** Google `Timestamp` as PlayOps stores it: seconds as a decimal string (lossless), nanos 0..999_999_999. */
export interface ReviewTimestamp {
  readonly seconds: string;
  readonly nanos: number;
}

const SECONDS_PATTERN = /^-?\d{1,19}$/;

/** Accepts the generated shape `{ seconds?: string|null, nanos?: number|null }`; missing nanos → 0; missing seconds → invalid. */
export function parseReviewTimestamp(value: unknown): ReviewTimestamp | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { seconds, nanos } = value as { seconds?: unknown; nanos?: unknown };
  let secondsText: string;
  if (typeof seconds === "string" && SECONDS_PATTERN.test(seconds.trim())) {
    secondsText = BigInt(seconds.trim()).toString();
  } else if (typeof seconds === "number" && Number.isSafeInteger(seconds)) {
    secondsText = String(seconds);
  } else {
    return undefined;
  }
  let nanosValue = 0;
  if (nanos !== undefined && nanos !== null) {
    if (typeof nanos !== "number" || !Number.isInteger(nanos) || nanos < 0 || nanos > 999_999_999) {
      return undefined;
    }
    nanosValue = nanos;
  }
  return Object.freeze({ seconds: secondsText, nanos: nanosValue });
}

/** Deterministic total order: -1, 0, 1. */
export function compareReviewTimestamps(a: ReviewTimestamp, b: ReviewTimestamp): -1 | 0 | 1 {
  const sa = BigInt(a.seconds);
  const sb = BigInt(b.seconds);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  if (a.nanos < b.nanos) return -1;
  if (a.nanos > b.nanos) return 1;
  return 0;
}

export function maxReviewTimestamp(a: ReviewTimestamp, b: ReviewTimestamp): ReviewTimestamp {
  return compareReviewTimestamps(a, b) >= 0 ? a : b;
}

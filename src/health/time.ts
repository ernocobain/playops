/**
 * Phase 5.1 — time-window primitives for Play Developer Reporting queries.
 *
 * Timezone policy (verified against the installed
 * `@googleapis/playdeveloperreporting@15.0.1` v1beta1 declarations and the
 * official Play Developer Reporting reference on 2026-10-02):
 *
 * - DAILY aggregation: "Due to historical constraints, the default and only
 *   supported timezone is `America/Los_Angeles`." A DAILY window boundary must
 *   therefore be exactly local midnight in that zone. PlayOps omits the explicit
 *   timezone from the request so Google applies that documented metric-set
 *   default; the window itself is still validated against it locally.
 * - HOURLY aggregation: "The default and only supported timezone is `UTC`."
 *   PlayOps sets `timeZone: { id: "UTC" }` explicitly (documented as valid) and
 *   requires hour-aligned boundaries.
 *
 * Operator-facing windows are always explicit UTC instants (`YYYY-MM-DDTHH:MM:SSZ`).
 * PlayOps never guesses a local time and never silently rounds a boundary: a
 * non-aligned instant is rejected. Conversions use only Node's built-in `Intl`
 * (no date library, no new dependency).
 */
import { HealthError } from "./errors.js";

export const HEALTH_GRANULARITIES = Object.freeze(["DAILY", "HOURLY"] as const);
export type HealthGranularity = (typeof HEALTH_GRANULARITIES)[number];

export const DAILY_AGGREGATION_TIME_ZONE = "America/Los_Angeles";
export const HOURLY_AGGREGATION_TIME_ZONE = "UTC";

/** PlayOps-owned projection of a Google `DateTime` used as a query boundary. */
export interface HealthDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  /** Present only for granularities whose boundary carries a time of day. */
  readonly hours?: number;
  /** Present only when PlayOps sets the timezone explicitly (HOURLY → UTC). */
  readonly timeZoneId?: string;
}

interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
}

const UTC_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const MIN_YEAR = 1970;
const MAX_YEAR = 9999;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function invalidArgument(message: string): HealthError {
  return new HealthError(message, "INVALID_ARGUMENT");
}

function remoteInvalid(message: string): HealthError {
  return new HealthError(message, "REMOTE_DATA_INVALID");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `id` is an IANA timezone the running Node/ICU build can resolve. */
export function isSupportedTimeZone(id: string): boolean {
  if (typeof id !== "string" || id.trim() === "") return false;
  try {
    formatterFor(id);
    return true;
  } catch {
    return false;
  }
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatterCache.set(timeZone, created);
  return created;
}

/** Calendar fields of an instant in a named IANA timezone. */
export function zonedParts(epochMs: number, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs));
  const read = (type: string): number => {
    const match = parts.find((part) => part.type === type);
    return match ? Number(match.value) : Number.NaN;
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hours: read("hour"),
    minutes: read("minute"),
    seconds: read("second"),
  };
}

function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const parts = zonedParts(epochMs, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hours,
    parts.minutes,
    parts.seconds,
  );
  return asUtc - Math.trunc(epochMs / 1_000) * 1_000;
}

/** Epoch milliseconds of a wall-clock time in a named IANA timezone (DST-correct). */
export function utcInstantFromZonedParts(
  parts: {
    readonly year: number;
    readonly month: number;
    readonly day: number;
    readonly hours?: number;
    readonly minutes?: number;
    readonly seconds?: number;
  },
  timeZone: string,
): number {
  const hours = parts.hours ?? 0;
  const minutes = parts.minutes ?? 0;
  const seconds = parts.seconds ?? 0;
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, hours, minutes, seconds);
  const firstOffset = zoneOffsetMs(guess, timeZone);
  const candidate = guess - firstOffset;
  const secondOffset = zoneOffsetMs(candidate, timeZone);
  return secondOffset === firstOffset ? candidate : guess - secondOffset;
}

/** Parse a strict UTC ISO-8601 second-precision instant (`YYYY-MM-DDTHH:MM:SSZ`). */
export function parseUtcInstant(value: unknown, field: string): number {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidArgument(
      `${field} must be a UTC ISO-8601 timestamp such as "2026-09-01T00:00:00Z".`,
    );
  }
  const match = UTC_INSTANT_PATTERN.exec(value);
  if (!match) {
    throw invalidArgument(
      `${field} must be an explicit UTC instant like "2026-09-01T00:00:00Z" (no offset, no fractional seconds).`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = Number(match[6]);
  if (year < MIN_YEAR || year > MAX_YEAR || hours > 23 || minutes > 59 || seconds > 59) {
    throw invalidArgument(`${field} is outside the supported timestamp range.`);
  }
  const epochMs = Date.UTC(year, month - 1, day, hours, minutes, seconds);
  const roundTrip = new Date(epochMs);
  if (
    !Number.isFinite(epochMs) ||
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    throw invalidArgument(`${field} is not a valid calendar timestamp.`);
  }
  return epochMs;
}

/** Canonical UTC instant string: `YYYY-MM-DDTHH:MM:SSZ`. */
export function formatUtcInstant(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 19)}Z`;
}

/** Documented metric-set default timezone for an aggregation period, when known. */
export function defaultTimeZoneForAggregationPeriod(aggregationPeriod: string): string | undefined {
  if (aggregationPeriod === "HOURLY") return HOURLY_AGGREGATION_TIME_ZONE;
  if (aggregationPeriod === "DAILY") return DAILY_AGGREGATION_TIME_ZONE;
  return undefined;
}

/**
 * Build the query boundary for an aligned window instant.
 * Rejects (never rounds) an instant that is not an aggregation-period boundary.
 */
export function buildQueryBoundary(
  epochMs: number,
  granularity: HealthGranularity,
): HealthDateTime {
  if (granularity === "HOURLY") {
    const parts = zonedParts(epochMs, HOURLY_AGGREGATION_TIME_ZONE);
    if (parts.minutes !== 0 || parts.seconds !== 0) {
      throw invalidArgument(
        `HOURLY window boundaries must be aligned to the start of an hour in UTC; received ${formatUtcInstant(epochMs)}.`,
      );
    }
    return Object.freeze({
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hours: parts.hours,
      timeZoneId: HOURLY_AGGREGATION_TIME_ZONE,
    });
  }
  const parts = zonedParts(epochMs, DAILY_AGGREGATION_TIME_ZONE);
  if (parts.hours !== 0 || parts.minutes !== 0 || parts.seconds !== 0) {
    throw invalidArgument(
      `DAILY window boundaries must be exactly local midnight in ${DAILY_AGGREGATION_TIME_ZONE}; received ${formatUtcInstant(epochMs)}.`,
    );
  }
  return Object.freeze({ year: parts.year, month: parts.month, day: parts.day });
}

function requireIntegerField(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw remoteInvalid(`Remote datetime field "${field}" is missing or out of range.`);
  }
  return value;
}

function optionalIntegerField(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || value === null) return fallback;
  return requireIntegerField(value, field, min, max);
}

function parseUtcOffsetSeconds(value: unknown): number {
  // protobuf Duration JSON is a string of seconds, optionally suffixed with "s"
  // (e.g. "-14400" or "-14400s"); fractional offsets are not accepted.
  if (typeof value !== "string" || !/^[+-]?\d{1,6}s?$/.test(value)) {
    throw remoteInvalid('Remote datetime field "utcOffset" is not a whole-second offset.');
  }
  const seconds = Number(value.replace(/s$/, ""));
  if (!Number.isInteger(seconds) || Math.abs(seconds) > 64_800) {
    throw remoteInvalid('Remote datetime field "utcOffset" is outside ±18 hours.');
  }
  return seconds;
}

/**
 * Normalize a remote Google `DateTime` into an unambiguous UTC instant.
 *
 * Fail-closed rules: year/month/day are required and must form a real calendar
 * date; sub-second precision (`nanos` other than 0) is rejected rather than
 * truncated; an unresolvable timezone is rejected rather than guessed.
 */
export function parseRemoteDateTime(
  value: unknown,
  fallbackTimeZone?: string,
): { readonly epochMs: number; readonly timeZoneId?: string } {
  if (!isRecord(value)) {
    throw remoteInvalid("Remote datetime value is not an object.");
  }
  const year = requireIntegerField(value.year, "year", 1, 9999);
  const month = requireIntegerField(value.month, "month", 1, 12);
  const day = requireIntegerField(value.day, "day", 1, 31);
  const hours = optionalIntegerField(value.hours, "hours", 0, 23, 0);
  const minutes = optionalIntegerField(value.minutes, "minutes", 0, 59, 0);
  const seconds = optionalIntegerField(value.seconds, "seconds", 0, 59, 0);

  if (value.nanos !== undefined && value.nanos !== null && value.nanos !== 0) {
    throw remoteInvalid(
      "Remote datetime carries sub-second precision, which PlayOps does not support.",
    );
  }

  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw remoteInvalid("Remote datetime is not a valid calendar date.");
  }

  let zoneId: string | undefined;
  if (value.timeZone !== undefined && value.timeZone !== null) {
    if (!isRecord(value.timeZone) || typeof value.timeZone.id !== "string") {
      throw remoteInvalid('Remote datetime field "timeZone" is invalid.');
    }
    if (!isSupportedTimeZone(value.timeZone.id)) {
      throw remoteInvalid('Remote datetime field "timeZone.id" is not a supported IANA timezone.');
    }
    zoneId = value.timeZone.id;
  }

  const fields = { year, month, day, hours, minutes, seconds };
  if (zoneId !== undefined) {
    return { epochMs: utcInstantFromZonedParts(fields, zoneId), timeZoneId: zoneId };
  }
  if (value.utcOffset !== undefined && value.utcOffset !== null) {
    const offsetSeconds = parseUtcOffsetSeconds(value.utcOffset);
    return {
      epochMs: Date.UTC(year, month - 1, day, hours, minutes, seconds) - offsetSeconds * 1_000,
    };
  }
  if (fallbackTimeZone === undefined) {
    throw remoteInvalid(
      "Remote datetime carries neither a timezone nor a UTC offset, and no default timezone applies.",
    );
  }
  return {
    epochMs: utcInstantFromZonedParts(fields, fallbackTimeZone),
    timeZoneId: fallbackTimeZone,
  };
}

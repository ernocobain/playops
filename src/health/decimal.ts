/**
 * Phase 5.2 — exact decimal arithmetic for Play Developer Reporting values.
 *
 * Phase 5.1 deliberately preserves `google.type.Decimal` values as strings.
 * Phase 5.2 must not undo that: this module never uses `Number()`, `parseFloat`,
 * `parseInt` or floating-point arithmetic on metric values. Values are held as
 * `sign × coefficient × 10^exponent` with a `bigint` coefficient, so subtraction
 * and comparison are exact for any magnitude the API can return.
 *
 * No dependency is added (no `decimal.js`, `big.js`, statistics or date library).
 *
 * Formatting rules (documented, deterministic):
 * - `formatHealthDecimal` emits a canonical plain decimal string (no exponent,
 *   no trailing zeros, no `-0`).
 * - `relativeDeltaPercent` divides exactly where possible and otherwise rounds
 *   to a controlled **six significant digits**, half away from zero. Because a
 *   relative change can be far smaller than one decimal place, a non-zero ratio
 *   is never collapsed to "0": magnitudes below `1e-6` (or at/above `1e15`) are
 *   rendered in scientific notation such as `8.10001E-28`. `Infinity`/`NaN` are
 *   never produced; a zero baseline yields `undefined` instead of a fake number.
 */
import { HealthError } from "./errors.js";

export interface HealthDecimal {
  readonly negative: boolean;
  /** Always non-negative and free of trailing zeros. */
  readonly coefficient: bigint;
  /** value = sign × coefficient × 10^exponent */
  readonly exponent: number;
}

/** Parsing/arithmetic guard: keeps shifts finite and bounded. */
const MAX_EXPONENT = 10_000;
const MAX_SHIFT = 30_000;
const RELATIVE_SIGNIFICANT_DIGITS = 6;
const SCIENTIFIC_LOWER_BOUND = -6;
const SCIENTIFIC_UPPER_BOUND = 15;

const DECIMAL_INPUT = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

const POW10: bigint[] = [1n];

function pow10(exponent: number): bigint {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > MAX_SHIFT) {
    throw new HealthError("Decimal exponent is out of range.", "INVALID_DECIMAL");
  }
  while (POW10.length <= exponent) {
    const last = POW10[POW10.length - 1] ?? 1n;
    POW10.push(last * 10n);
  }
  const cached = POW10[exponent];
  if (cached === undefined) {
    throw new HealthError("Decimal exponent is out of range.", "INVALID_DECIMAL");
  }
  return cached;
}

function invalidDecimal(message: string): HealthError {
  return new HealthError(message, "INVALID_DECIMAL");
}

function normalize(negative: boolean, coefficient: bigint, exponent: number): HealthDecimal {
  let sign = negative;
  let value = coefficient;
  let scale = exponent;
  if (value < 0n) {
    value = -value;
    sign = !sign;
  }
  if (value === 0n) return Object.freeze({ negative: false, coefficient: 0n, exponent: 0 });
  while (value % 10n === 0n) {
    value /= 10n;
    scale += 1;
  }
  if (scale > MAX_EXPONENT || scale < -MAX_EXPONENT) {
    throw invalidDecimal("Decimal exponent is out of scale.");
  }
  return Object.freeze({ negative: sign, coefficient: value, exponent: scale });
}

/** Parse an exact decimal string (the only accepted representation). */
export function parseHealthDecimal(value: unknown): HealthDecimal {
  if (typeof value !== "string") {
    throw invalidDecimal("Decimal value must be a string.");
  }
  const trimmed = value.trim();
  if (trimmed === "") throw invalidDecimal("Decimal value must not be empty.");
  const match = DECIMAL_INPUT.exec(trimmed);
  if (!match) throw invalidDecimal("Decimal value is not a valid decimal string.");
  const sign = match[1] ?? "";
  const integerPart = match[2] ?? "";
  const fractionPart = match[3] ?? "";
  const exponentPart = match[4];
  if (integerPart === "" && fractionPart === "") {
    throw invalidDecimal("Decimal value must contain at least one digit.");
  }
  let explicitExponent = 0;
  if (exponentPart !== undefined) {
    explicitExponent = Number(exponentPart);
    if (!Number.isSafeInteger(explicitExponent) || Math.abs(explicitExponent) > MAX_EXPONENT) {
      throw invalidDecimal("Decimal exponent is out of scale.");
    }
  }
  const digits = `${integerPart}${fractionPart}`;
  const coefficient = BigInt(digits);
  const exponent = explicitExponent - fractionPart.length;
  return normalize(sign === "-", coefficient, exponent);
}

/** Canonical plain decimal string: no exponent, no trailing zeros, no `-0`. */
export function formatHealthDecimal(value: HealthDecimal): string {
  if (value.coefficient === 0n) return "0";
  const digits = value.coefficient.toString();
  const sign = value.negative ? "-" : "";
  if (value.exponent >= 0) {
    return `${sign}${digits}${"0".repeat(value.exponent)}`;
  }
  const pointPosition = digits.length + value.exponent;
  if (pointPosition > 0) {
    return `${sign}${digits.slice(0, pointPosition)}.${digits.slice(pointPosition)}`;
  }
  return `${sign}0.${"0".repeat(-pointPosition)}${digits}`;
}

function compareMagnitude(a: HealthDecimal, b: HealthDecimal): number {
  const exponent = Math.min(a.exponent, b.exponent);
  const left = a.coefficient * pow10(a.exponent - exponent);
  const right = b.coefficient * pow10(b.exponent - exponent);
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/** Exact three-way comparison. */
export function compareHealthDecimals(a: HealthDecimal, b: HealthDecimal): -1 | 0 | 1 {
  const leftZero = a.coefficient === 0n;
  const rightZero = b.coefficient === 0n;
  if (leftZero && rightZero) return 0;
  if (leftZero) return b.negative ? 1 : -1;
  if (rightZero) return a.negative ? -1 : 1;
  if (a.negative !== b.negative) return a.negative ? -1 : 1;
  const magnitude = compareMagnitude(a, b);
  return (a.negative ? -magnitude : magnitude) as -1 | 0 | 1;
}

/** Exact subtraction (`a - b`). */
export function subtractHealthDecimals(a: HealthDecimal, b: HealthDecimal): HealthDecimal {
  const exponent = Math.min(a.exponent, b.exponent);
  const signA = a.negative ? -1n : 1n;
  const signB = b.negative ? -1n : 1n;
  const left = signA * a.coefficient * pow10(a.exponent - exponent);
  const right = signB * b.coefficient * pow10(b.exponent - exponent);
  return normalize(false, left - right, exponent);
}

export function isZeroHealthDecimal(value: HealthDecimal): boolean {
  return value.coefficient === 0n;
}

/** Compare `numerator/denominator` (denominator > 0) with `10^exponent`. */
function compareRatioToPowerOfTen(
  numerator: bigint,
  denominator: bigint,
  shift: number,
  exponent: number,
): number {
  const difference = shift - exponent;
  const left = difference >= 0 ? numerator * pow10(difference) : numerator;
  const right = difference >= 0 ? denominator : denominator * pow10(-difference);
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function scientificMantissa(coefficient: bigint): string {
  const digits = coefficient.toString().padStart(RELATIVE_SIGNIFICANT_DIGITS, "0");
  const head = digits.slice(0, 1);
  const tail = digits.slice(1).replace(/0+$/u, "");
  return tail === "" ? head : `${head}.${tail}`;
}

/**
 * Relative change in percent: `(current - baseline) / |baseline| × 100`.
 * Returns `undefined` when the baseline is zero (the ratio is not defined) and
 * `"0"` when the values are equal. The result is a signed string; positive
 * values carry an explicit `+`.
 */
export function relativeDeltaPercent(
  current: HealthDecimal,
  baseline: HealthDecimal,
): string | undefined {
  if (baseline.coefficient === 0n) return undefined;
  const delta = subtractHealthDecimals(current, baseline);
  if (delta.coefficient === 0n) return "0";

  // ratio = delta/|baseline| × 100 = numerator/denominator × 10^shift
  const numerator = delta.coefficient;
  const denominator = baseline.coefficient;
  const shift = delta.exponent - baseline.exponent + 2;

  const digitSpan = numerator.toString().length - denominator.toString().length;
  let exponent = digitSpan + 1 + shift;
  while (compareRatioToPowerOfTen(numerator, denominator, shift, exponent - 1) < 0) {
    exponent -= 1;
  }
  while (compareRatioToPowerOfTen(numerator, denominator, shift, exponent) >= 0) {
    exponent += 1;
  }

  const mantissaShift = shift + RELATIVE_SIGNIFICANT_DIGITS - exponent;
  const scaledNumerator = mantissaShift >= 0 ? numerator * pow10(mantissaShift) : numerator;
  const scaledDenominator = mantissaShift >= 0 ? denominator : denominator * pow10(-mantissaShift);
  let mantissa = scaledNumerator / scaledDenominator;
  const remainder = scaledNumerator % scaledDenominator;
  if (2n * remainder >= scaledDenominator) mantissa += 1n;
  if (mantissa >= pow10(RELATIVE_SIGNIFICANT_DIGITS)) {
    mantissa /= 10n;
    exponent += 1;
  }

  const sign = delta.negative ? "-" : "+";
  const order = exponent - 1;
  if (order < SCIENTIFIC_LOWER_BOUND || order > SCIENTIFIC_UPPER_BOUND) {
    return `${sign}${scientificMantissa(mantissa)}E${order}`;
  }
  return `${sign}${formatHealthDecimal(
    normalize(false, mantissa, exponent - RELATIVE_SIGNIFICANT_DIGITS),
  )}`;
}

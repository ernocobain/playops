/**
 * Phase 5.2 — exact decimal arithmetic tests (no floating point, no dependency).
 */
import { describe, expect, it } from "vitest";
import {
  compareHealthDecimals,
  formatHealthDecimal,
  isZeroHealthDecimal,
  parseHealthDecimal,
  relativeDeltaPercent,
  subtractHealthDecimals,
} from "../src/health/decimal.js";
import { HealthError } from "../src/health/errors.js";

function parse(value: string): ReturnType<typeof parseHealthDecimal> {
  return parseHealthDecimal(value);
}

describe("Phase 5.2 exact decimal arithmetic", () => {
  it("parses and canonicalizes documented decimal-string forms", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["0.0123", "0.0123"],
      ["5.0", "5"],
      ["0.500", "0.5"],
      ["+1.5", "1.5"],
      ["-4", "-4"],
      ["-0", "0"],
      [".5", "0.5"],
      ["1e-3", "0.001"],
      ["1E+3", "1000"],
      ["00012", "12"],
      ["0.000", "0"],
      ["123456789012345678901234567890", "123456789012345678901234567890"],
    ];
    for (const [input, expected] of cases) {
      expect(formatHealthDecimal(parse(input))).toBe(expected);
    }
  });

  it("compares exactly, including values far beyond JS safe floats", () => {
    expect(compareHealthDecimals(parse("0.0123"), parse("0.0155"))).toBe(-1);
    expect(compareHealthDecimals(parse("0.0155"), parse("0.0123"))).toBe(1);
    expect(compareHealthDecimals(parse("1.50"), parse("1.5"))).toBe(0);
    expect(compareHealthDecimals(parse("-2"), parse("1"))).toBe(-1);
    expect(compareHealthDecimals(parse("9007199254740993"), parse("9007199254740992"))).toBe(1);
    expect(
      compareHealthDecimals(
        parse("0.123456789012345678901234567890"),
        parse("0.123456789012345678901234567889"),
      ),
    ).toBe(1);
  });

  it("subtracts exactly without binary floating point error", () => {
    expect(formatHealthDecimal(subtractHealthDecimals(parse("0.0155"), parse("0.0123")))).toBe(
      "0.0032",
    );
    expect(formatHealthDecimal(subtractHealthDecimals(parse("0.1"), parse("0.2")))).toBe("-0.1");
    expect(
      formatHealthDecimal(
        subtractHealthDecimals(
          parse("0.123456789012345678901234567890"),
          parse("0.123456789012345678901234567889"),
        ),
      ),
    ).toBe("0.000000000000000000000000000001");
    expect(formatHealthDecimal(subtractHealthDecimals(parse("1e30"), parse("1")))).toBe(
      "999999999999999999999999999999",
    );
    expect(formatHealthDecimal(subtractHealthDecimals(parse("12"), parse("12")))).toBe("0");
  });

  it("treats any zero representation as zero", () => {
    for (const zero of ["0", "0.000", "-0", "0e5", ".0"]) {
      expect(isZeroHealthDecimal(parse(zero))).toBe(true);
    }
    expect(isZeroHealthDecimal(parse("0.0000001"))).toBe(false);
    expect(isZeroHealthDecimal(parse("-1"))).toBe(false);
  });

  it("computes relative deltas with a controlled six-significant-digit scale", () => {
    expect(relativeDeltaPercent(parse("0.0155"), parse("0.0123"))).toBe("+26.0163");
    expect(relativeDeltaPercent(parse("0.0088"), parse("0.0123"))).toBe("-28.4553");
    expect(relativeDeltaPercent(parse("1"), parse("3"))).toBe("-66.6667");
    expect(relativeDeltaPercent(parse("4"), parse("3"))).toBe("+33.3333");
    expect(relativeDeltaPercent(parse("2"), parse("1"))).toBe("+100");
    // The denominator is the baseline magnitude, so a negative baseline is not inverted.
    expect(relativeDeltaPercent(parse("-1"), parse("-2"))).toBe("+50");
    expect(relativeDeltaPercent(parse("-3"), parse("-2"))).toBe("-50");
    expect(relativeDeltaPercent(parse("0.0123"), parse("0.0123"))).toBe("0");
  });

  it("never collapses a non-zero ratio to zero, falling back to scientific notation", () => {
    // The exact ratio is 8.1000000729e-28; six significant digits must not become "0".
    expect(
      relativeDeltaPercent(
        parse("0.123456789012345678901234567890"),
        parse("0.123456789012345678901234567889"),
      ),
    ).toBe("+8.1E-28");
  });

  it("leaves the relative delta undefined for a zero baseline instead of inventing one", () => {
    expect(relativeDeltaPercent(parse("0"), parse("0"))).toBeUndefined();
    expect(relativeDeltaPercent(parse("0.0012"), parse("0"))).toBeUndefined();
    expect(relativeDeltaPercent(parse("0"), parse("0.0012"))).toBe("-100");
  });

  it("never produces NaN or Infinity text", () => {
    const outputs = [
      relativeDeltaPercent(parse("1"), parse("7")) ?? "",
      relativeDeltaPercent(parse("0"), parse("0")) ?? "",
      formatHealthDecimal(subtractHealthDecimals(parse("1e-30"), parse("1e-30"))),
      formatHealthDecimal(parse("1e-30")),
    ];
    for (const output of outputs) {
      expect(output).not.toContain("Infinity");
      expect(output).not.toContain("NaN");
    }
    expect(outputs[0]).toMatch(/^[+-]?\d/);
  });

  it("rejects malformed decimal strings with INVALID_DECIMAL", () => {
    const malformed: readonly unknown[] = [
      "",
      "   ",
      "abc",
      "1.2.3",
      "NaN",
      "Infinity",
      "-",
      "+",
      "1e",
      "0x10",
      "1 2",
      "1,5",
      null,
      undefined,
      42,
      {},
      [],
    ];
    for (const value of malformed) {
      try {
        parseHealthDecimal(value);
        expect.unreachable(`expected INVALID_DECIMAL for ${JSON.stringify(value)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(HealthError);
        expect((error as HealthError).code).toBe("INVALID_DECIMAL");
      }
    }
  });

  it("is deterministic and does not mutate its inputs", () => {
    const current = parse("0.0155");
    const baseline = parse("0.0123");
    const snapshot = (): string =>
      JSON.stringify({ current, baseline }, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      );
    const before = snapshot();
    const first = relativeDeltaPercent(current, baseline);
    const second = relativeDeltaPercent(current, baseline);
    expect(first).toBe(second);
    expect(snapshot()).toBe(before);
  });
});

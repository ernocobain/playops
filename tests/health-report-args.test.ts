import { describe, expect, it } from "vitest";
import { parseHealthCommand } from "../src/cli/health.js";

const REPORT_ARGS = [
  "report",
  "--current-start",
  "2026-09-24T07:00:00Z",
  "--current-end",
  "2026-09-25T07:00:00Z",
  "--baseline-start",
  "2026-09-23T07:00:00Z",
  "--baseline-end",
  "2026-09-24T07:00:00Z",
  "--granularity",
  "DAILY",
  "--output-dir",
  "./reports",
];

describe("Phase 5.3 operator argument parser", () => {
  it("binds explicit windows and default kinds to the existing 5.2 input", () => {
    const before = JSON.stringify(REPORT_ARGS);
    expect(parseHealthCommand(REPORT_ARGS)).toEqual({
      kind: "report",
      outputDir: "./reports",
      input: {
        kinds: ["crash_rate", "anr_rate", "excessive_wakeup_rate"],
        current: { startTime: "2026-09-24T07:00:00Z", endTime: "2026-09-25T07:00:00Z" },
        baseline: { startTime: "2026-09-23T07:00:00Z", endTime: "2026-09-24T07:00:00Z" },
        granularity: "DAILY",
      },
    });
    expect(JSON.stringify(REPORT_ARGS)).toBe(before);
  });

  it.each([[], ["--help"], ["report", "--help"]])("supports help without I/O: %j", (...args) => {
    expect(parseHealthCommand(args)).toEqual({ kind: "help" });
  });

  it("accepts equals syntax and only safely supported optional selections", () => {
    const args = REPORT_ARGS.map((arg) => arg);
    const outputIndex = args.indexOf("--output-dir");
    args.splice(outputIndex, 2, "--output-dir=./reports");
    const command = parseHealthCommand([
      ...args,
      "--kinds=anr_rate,crash_rate",
      "--dimensions=countryCode,versionCode",
      "--metrics=distinctUsers",
    ]);
    expect(command).toMatchObject({
      kind: "report",
      input: {
        kinds: ["anr_rate", "crash_rate"],
        dimensions: ["countryCode", "versionCode"],
        metrics: ["distinctUsers"],
      },
    });
  });

  it.each([
    "--current-start",
    "--current-end",
    "--baseline-start",
    "--baseline-end",
    "--granularity",
    "--output-dir",
  ])("rejects a missing required %s", (flag) => {
    const args = [...REPORT_ARGS];
    args.splice(args.indexOf(flag), 2);
    expect(() => parseHealthCommand(args)).toThrowError(
      expect.objectContaining({ code: "CLI_ARGUMENT_INVALID" }),
    );
  });

  it.each([
    ["--current-start", "yesterday"],
    ["--current-start", "2026-09-24"],
    ["--current-start", "2026-09-24T07:00:00.000Z"],
    ["--current-start", "2026-09-24T00:00:00-07:00"],
    ["--current-start", "2026-09-24T00:00:00Z"],
    ["--current-end", "2026-09-24T07:00:00Z"],
    ["--baseline-start", "2026-09-22T07:00:00Z"],
    ["--baseline-start", "2026-02-30T07:00:00Z"],
    ["--granularity", "WEEKLY"],
    ["--granularity", "HOURLY"], // default wakeup kind is DAILY only
    ["--output-dir", ""],
    ["--output-dir", "\u0000reports"],
    ["--output-dir", "reports\nother"],
  ])("rejects invalid explicit option %s=%s", (flag, value) => {
    const args = [...REPORT_ARGS];
    args[args.indexOf(flag) + 1] = value;
    expect(() => parseHealthCommand(args)).toThrowError(
      expect.objectContaining({ code: "CLI_ARGUMENT_INVALID" }),
    );
  });

  it.each([
    ["--kinds", "unknown"],
    ["--kinds", "crash_rate,crash_rate"],
    ["--kinds", "crash_rate,"],
    ["--kinds", " crash_rate"],
    ["--metrics", "crashRate"], // not supported by all default kinds
    ["--metrics", "unknown"],
    ["--metrics", "distinctUsers,distinctUsers"],
    ["--dimensions", "unknown"],
    ["--dimensions", "countryCode,countryCode"],
    ["--package-name", "com.prohibited.app"],
    ["--packageName", "com.prohibited.app"],
    ["--credentials", "FAKE-SECRET-PATH"],
    ["--service-account-json", "FAKE-SECRET-PATH"],
    ["--approve", "FAKE-SECRET"],
    ["--json"],
    ["--force"],
    ["--threshold", "1"],
    ["--current-start=2026-09-24T07:00:00Z"], // duplicate mixed spelling
    ["--output-dir", "./elsewhere"],
    ["--metrics"],
    ["extra-positional"],
  ])("rejects unknown/duplicate/unsafe options: %j", (...extra) => {
    try {
      parseHealthCommand([...REPORT_ARGS, ...extra]);
      expect.unreachable("Expected refusal");
    } catch (error) {
      expect(error).toMatchObject({ code: "CLI_ARGUMENT_INVALID" });
      expect(String(error)).not.toContain("FAKE-SECRET");
    }
  });
});

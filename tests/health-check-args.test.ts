import { describe, expect, it } from "vitest";
import {
  HealthCheckCliError,
  isHealthCheckSummaryStatus,
  parseHealthCheckCommand,
  parseHealthCheckSummary,
  type HealthCheckSummary,
  type HealthCheckSummaryStatus,
} from "../src/cli/health-check.js";

const DAILY_ARGS = [
  "--start",
  "2026-09-24T07:00:00Z",
  "--end",
  "2026-09-25T07:00:00Z",
  "--granularity",
  "DAILY",
];

function expectCliRejection(fn: () => unknown, expectedToken?: string): void {
  try {
    fn();
    expect.unreachable("Expected HealthCheckCliError");
  } catch (error) {
    expect(error).toBeInstanceOf(HealthCheckCliError);
    expect(error).toMatchObject({
      name: "HealthCheckCliError",
      code: "CLI_ARGUMENT_INVALID",
    });
    const message = error instanceof Error ? error.message : "";
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain("\n");
    if (expectedToken !== undefined) {
      expect(message).toContain(expectedToken);
    }
  }
}

function acceptStatus(status: HealthCheckSummaryStatus): HealthCheckSummaryStatus {
  return status;
}

describe("Phase 5.4 WP1a health check CLI argument parser", () => {
  it.each([[], ["--help"]])("supports help without I/O: %j", (...args) => {
    expect(parseHealthCheckCommand(args)).toEqual({ kind: "help" });
  });

  it("binds canonical input with json:false by default and json:true with --json", () => {
    const before = JSON.stringify(DAILY_ARGS);
    const defaultCommand = parseHealthCheckCommand(DAILY_ARGS);
    expect(defaultCommand).toEqual({
      kind: "check",
      json: false,
      input: {
        startTime: "2026-09-24T07:00:00Z",
        endTime: "2026-09-25T07:00:00Z",
        granularity: "DAILY",
        dimensions: [],
      },
    });
    expect(JSON.stringify(DAILY_ARGS)).toBe(before);

    const jsonCommand = parseHealthCheckCommand([...DAILY_ARGS, "--json"]);
    expect(jsonCommand).toEqual({
      kind: "check",
      json: true,
      input: {
        startTime: "2026-09-24T07:00:00Z",
        endTime: "2026-09-25T07:00:00Z",
        granularity: "DAILY",
        dimensions: [],
      },
    });
  });

  it("produces the same command for equals syntax and space syntax", () => {
    const spaceCommand = parseHealthCheckCommand([
      "--start",
      "2026-09-24T07:00:00Z",
      "--end",
      "2026-09-25T07:00:00Z",
      "--granularity",
      "DAILY",
      "--dimensions",
      "countryCode,versionCode",
      "--json",
    ]);
    const equalsCommand = parseHealthCheckCommand([
      "--start=2026-09-24T07:00:00Z",
      "--end=2026-09-25T07:00:00Z",
      "--granularity=DAILY",
      "--dimensions=countryCode,versionCode",
      "--json",
    ]);
    expect(equalsCommand).toEqual(spaceCommand);
  });

  it.each(["yesterday", "2026-09-24", "2026-09-24T07:00:00.000Z", "2026-09-24T00:00:00-07:00"])(
    "AC1.1: rejects invalid --start timestamp %s naming --start",
    (badValue) => {
      const args = [...DAILY_ARGS];
      args[args.indexOf("--start") + 1] = badValue;
      expectCliRejection(() => parseHealthCheckCommand(args), "--start");
    },
  );

  it.each(["yesterday", "2026-09-24", "2026-09-24T07:00:00.000Z", "2026-09-24T00:00:00-07:00"])(
    "AC1.1: rejects invalid --end timestamp %s naming --end",
    (badValue) => {
      const args = [...DAILY_ARGS];
      args[args.indexOf("--end") + 1] = badValue;
      expectCliRejection(() => parseHealthCheckCommand(args), "--end");
    },
  );

  it("AC1.2: accepts DAILY and HOURLY with aligned windows", () => {
    expect(
      parseHealthCheckCommand([
        "--start",
        "2026-09-24T07:00:00Z",
        "--end",
        "2026-09-25T07:00:00Z",
        "--granularity",
        "DAILY",
      ]),
    ).toMatchObject({
      kind: "check",
      input: {
        startTime: "2026-09-24T07:00:00Z",
        endTime: "2026-09-25T07:00:00Z",
        granularity: "DAILY",
      },
    });

    expect(
      parseHealthCheckCommand([
        "--start",
        "2026-09-24T07:00:00Z",
        "--end",
        "2026-09-24T09:00:00Z",
        "--granularity",
        "HOURLY",
      ]),
    ).toMatchObject({
      kind: "check",
      input: {
        startTime: "2026-09-24T07:00:00Z",
        endTime: "2026-09-24T09:00:00Z",
        granularity: "HOURLY",
      },
    });
  });

  it.each(["daily", "WEEKLY", ""])(
    "AC1.2: rejects invalid --granularity %j naming --granularity",
    (badGranularity) => {
      const args = [...DAILY_ARGS];
      args[args.indexOf("--granularity") + 1] = badGranularity;
      expectCliRejection(() => parseHealthCheckCommand(args), "--granularity");
    },
  );

  it("AC1.3: accepts --dimensions=countryCode,versionCode", () => {
    const command = parseHealthCheckCommand([
      ...DAILY_ARGS,
      "--dimensions=countryCode,versionCode",
    ]);
    expect(command).toMatchObject({
      kind: "check",
      input: {
        dimensions: ["countryCode", "versionCode"],
      },
    });
  });

  it.each([
    "countryCode,",
    "countryCode,,versionCode",
    " countryCode",
    "unknown",
    "countryCode,countryCode",
  ])("AC1.3: rejects invalid --dimensions %j naming --dimensions", (badDimensions) => {
    expectCliRejection(
      () => parseHealthCheckCommand([...DAILY_ARGS, "--dimensions", badDimensions]),
      "--dimensions",
    );
  });

  it.each(["--start", "--end", "--granularity"])(
    "rejects missing required flag %s naming that flag",
    (flag) => {
      const args = [...DAILY_ARGS];
      args.splice(args.indexOf(flag), 2);
      expectCliRejection(() => parseHealthCheckCommand(args), flag);
    },
  );

  it("rejects start not earlier than end naming --start", () => {
    expectCliRejection(
      () =>
        parseHealthCheckCommand([
          "--start",
          "2026-09-25T07:00:00Z",
          "--end",
          "2026-09-24T07:00:00Z",
          "--granularity",
          "DAILY",
        ]),
      "--start",
    );
  });

  it.each([
    { extra: ["--start=2026-09-24T07:00:00Z"], token: "--start" },
    { extra: ["--end", "2026-09-25T07:00:00Z"], token: "--end" },
    { extra: ["--granularity=DAILY"], token: "--granularity" },
    {
      extra: ["--dimensions", "countryCode", "--dimensions=versionCode"],
      token: "--dimensions",
    },
    { extra: ["--json", "--json"], token: "--json" },
    { extra: ["--json=true"], token: "--json" },
    { extra: ["--help"], token: "--help" },
    { extra: ["--unknown-flag"], token: "--unknown-flag" },
    { extra: ["positional-token"], token: "positional-token" },
  ])("rejects duplicate, unknown, positional or malformed options: $token", ({ extra, token }) => {
    expectCliRejection(() => parseHealthCheckCommand([...DAILY_ARGS, ...extra]), token);
  });

  it.each([
    {
      label: "ESC CSI",
      args: [...DAILY_ARGS, "--bad\u001b[2Jtoken"],
      expected: "--bad [2Jtoken",
    },
    {
      label: "NUL",
      args: [...DAILY_ARGS, "--bad\u0000token"],
      expected: "--bad token",
    },
    {
      label: "BEL",
      args: [...DAILY_ARGS, "--bad\u0007token"],
      expected: "--bad token",
    },
    {
      label: "DEL",
      args: [...DAILY_ARGS, "--bad\u007ftoken"],
      expected: "--bad token",
    },
    {
      label: "C1 CSI",
      args: [...DAILY_ARGS, "--bad\u009btoken"],
      expected: "--bad token",
    },
    {
      label: "embedded CR/LF in flag-like value",
      args: [
        "--start",
        "--bad\r\nvalue",
        "--end",
        "2026-09-25T07:00:00Z",
        "--granularity",
        "DAILY",
      ],
      expected: "--bad value",
    },
    {
      label: "embedded CR/LF in timestamp value",
      args: [
        "--start",
        "2026-09-24\r\nT07:00:00Z",
        "--end",
        "2026-09-25T07:00:00Z",
        "--granularity",
        "DAILY",
      ],
      expected: "--start",
    },
  ])("strips control characters from rejected CLI arguments ($label)", ({ args, expected }) => {
    expectCliRejection(() => parseHealthCheckCommand(args), expected);
    try {
      parseHealthCheckCommand(args);
      expect.unreachable("Expected HealthCheckCliError");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("\r");
      expect(message).not.toContain("\n");
      // eslint-disable-next-line no-control-regex -- explicitly asserting absence of C0, DEL and C1 controls
      expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
      expect(message).toContain(expected);
    }
  });
});

describe("Phase 5.4 WP1a runtime summary validator", () => {
  const VALID_SUMMARY: HealthCheckSummary = {
    status: "NO_BREACH_OBSERVED",
    enabledRuleCount: 3,
    evaluatedPointCount: 10,
    noDataCount: 0,
    breachedPointCount: 0,
    recordedAlertCount: 0,
  };

  it.each([
    "NO_BREACH_OBSERVED",
    "BREACH_DETECTED",
    "INCOMPLETE_DATA",
    "NO_DATA",
    "DISABLED",
  ] as const)("AC1.5/AC1.7: accepts valid summary with status %s and narrows type", (status) => {
    const unknownStatus: unknown = status;
    expect(isHealthCheckSummaryStatus(unknownStatus)).toBe(true);
    if (isHealthCheckSummaryStatus(unknownStatus)) {
      expect(acceptStatus(unknownStatus)).toBe(status);
    }

    const summary = parseHealthCheckSummary({ ...VALID_SUMMARY, status });
    expect(summary).toEqual({ ...VALID_SUMMARY, status });
    expect(Object.isFrozen(summary)).toBe(true);
  });

  it("rejects non-object summary inputs", () => {
    expectCliRejection(() => parseHealthCheckSummary(null));
    expectCliRejection(() => parseHealthCheckSummary([]));
    expectCliRejection(() => parseHealthCheckSummary("NO_DATA"));
  });

  it.each([
    "status",
    "enabledRuleCount",
    "evaluatedPointCount",
    "noDataCount",
    "breachedPointCount",
    "recordedAlertCount",
  ] as const)("rejects missing key %s naming that field", (missingKey) => {
    const record: Record<string, unknown> = { ...VALID_SUMMARY };
    Reflect.deleteProperty(record, missingKey);
    expectCliRejection(() => parseHealthCheckSummary(record), missingKey);
  });

  it("rejects extra key naming the extra field", () => {
    expectCliRejection(
      () => parseHealthCheckSummary({ ...VALID_SUMMARY, extraField: 1 }),
      "extraField",
    );
  });

  it("rejects unknown status naming status", () => {
    expect(isHealthCheckSummaryStatus("EVALUATED")).toBe(false);
    expectCliRejection(
      () => parseHealthCheckSummary({ ...VALID_SUMMARY, status: "EVALUATED" }),
      "status",
    );
  });

  it.each([
    { field: "enabledRuleCount", badValue: "3" },
    { field: "evaluatedPointCount", badValue: -1 },
    { field: "noDataCount", badValue: 1.5 },
    { field: "breachedPointCount", badValue: Number.NaN },
    { field: "recordedAlertCount", badValue: Number.POSITIVE_INFINITY },
    { field: "enabledRuleCount", badValue: null },
  ])("rejects invalid count on $field ($badValue) naming $field", ({ field, badValue }) => {
    expectCliRejection(
      () => parseHealthCheckSummary({ ...VALID_SUMMARY, [field]: badValue }),
      field,
    );
  });
});

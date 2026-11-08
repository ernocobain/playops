import { describe, expect, it } from "vitest";
import {
  HEALTH_CHECK_HELP,
  HealthCheckCliError,
  healthCheckExitCode,
  isHealthCheckSummaryStatus,
  parseHealthCheckCommand,
  parseHealthCheckSummary,
  renderHealthCheckSummary,
  runHealthCheckCli,
  type HealthCheckCliIo,
  type HealthCheckSummary,
} from "../src/cli/health-check.js";

const DAILY_ARGS = [
  "--start",
  "2026-09-24T07:00:00Z",
  "--end",
  "2026-09-25T07:00:00Z",
  "--granularity",
  "DAILY",
];

const SAMPLE_SUMMARY: HealthCheckSummary = {
  status: "BREACH_DETECTED",
  enabledRuleCount: 3,
  evaluatedPointCount: 12,
  noDataCount: 1,
  breachedPointCount: 2,
  recordedAlertCount: 4,
};

interface CapturedIo {
  readonly io: HealthCheckCliIo;
  readonly writes: string[];
  readonly errors: string[];
}

function createCapturedIo(writeImpl?: (text: string) => void | Promise<void>): CapturedIo {
  const writes: string[] = [];
  const errors: string[] = [];
  return {
    writes,
    errors,
    io: {
      write(text: string): void | Promise<void> {
        if (writeImpl !== undefined) {
          return writeImpl(text);
        }
        writes.push(text);
      },
      writeError(text: string): void {
        errors.push(text);
      },
    },
  };
}

function expectSingleLineError(errors: readonly string[], expectedSubstring: string): void {
  expect(errors).toHaveLength(1);
  const entry = errors[0] ?? "";
  expect(entry.endsWith("\n")).toBe(true);
  const withoutTrailingLf = entry.slice(0, -1);
  expect(withoutTrailingLf.length).toBeGreaterThan(0);
  expect(withoutTrailingLf).not.toContain("\n");
  expect(withoutTrailingLf).not.toContain("\r");
  expect(withoutTrailingLf).toContain(expectedSubstring);
}

describe("Phase 5.4 WP1b health check summary renderer and exit codes", () => {
  it("AC1.4: renders exact five-line human text and one-line JSON in key order", () => {
    const human = renderHealthCheckSummary(SAMPLE_SUMMARY, false);
    expect(human).toBe(
      [
        "App Health threshold check",
        "Status: BREACH_DETECTED",
        "Rules: 3 enabled",
        "Points: 12 evaluated, 1 no data, 2 breached",
        "Alerts: 4 recorded",
      ].join("\n"),
    );
    expect(human.endsWith("\n")).toBe(false);
    expect(human.split("\n")).toHaveLength(5);

    const json = renderHealthCheckSummary(SAMPLE_SUMMARY, true);
    expect(json).not.toContain("\n");
    expect(json).toBe(
      '{"status":"BREACH_DETECTED","enabledRuleCount":3,"evaluatedPointCount":12,"noDataCount":1,"breachedPointCount":2,"recordedAlertCount":4}',
    );

    const parsed: unknown = JSON.parse(json);
    expect(parsed).toEqual(SAMPLE_SUMMARY);
    expect(Object.keys(parsed as Record<string, unknown>)).toEqual([
      "status",
      "enabledRuleCount",
      "evaluatedPointCount",
      "noDataCount",
      "breachedPointCount",
      "recordedAlertCount",
    ]);

    for (const token of ["BREACH_DETECTED", "3", "12", "1", "2", "4"]) {
      expect(human).toContain(token);
      expect(json).toContain(token);
    }
  });

  it.each([
    { status: "NO_BREACH_OBSERVED", expected: 0 },
    { status: "BREACH_DETECTED", expected: 2 },
    { status: "INCOMPLETE_DATA", expected: 1 },
    { status: "NO_DATA", expected: 1 },
    { status: "DISABLED", expected: 1 },
  ] as const)("AC1.6: maps status $status to exit code $expected", async ({ status, expected }) => {
    const summary: HealthCheckSummary = { ...SAMPLE_SUMMARY, status };
    expect(healthCheckExitCode(summary)).toBe(expected);

    const captured = createCapturedIo();
    const code = await runHealthCheckCli(DAILY_ARGS, captured.io, {
      readSummary: () => summary,
    });
    expect(code).toBe(expected);
    expect(captured.errors).toEqual([]);
    expect(captured.writes).toEqual([`${renderHealthCheckSummary(summary, false)}\n`]);
  });

  it("AC1.6: maps invalid CLI arguments to exit code 1 (never 2)", async () => {
    const captured = createCapturedIo();
    const code = await runHealthCheckCli(["--start", "bad-timestamp"], captured.io, {
      readSummary: () => SAMPLE_SUMMARY,
    });
    expect(code).toBe(1);
    expect(captured.writes).toEqual([]);
    expectSingleLineError(captured.errors, "--end");
  });
});

describe("Phase 5.4 WP1b runHealthCheckCli entry point", () => {
  it.each([[], ["--help"]])(
    "AC1.8: prints HEALTH_CHECK_HELP with trailing newline and returns 0 for %j",
    async (...args) => {
      expect(HEALTH_CHECK_HELP.endsWith("\n")).toBe(false);
      expect(HEALTH_CHECK_HELP.split("\n")).toHaveLength(10);

      const captured = createCapturedIo();
      const code = await runHealthCheckCli(args, captured.io);
      expect(code).toBe(0);
      expect(captured.errors).toEqual([]);
      expect(captured.writes).toEqual([`${HEALTH_CHECK_HELP}\n`]);
    },
  );

  it("writes human and --json summaries with trailing newline on the success path", async () => {
    const okSummary: HealthCheckSummary = {
      status: "NO_BREACH_OBSERVED",
      enabledRuleCount: 2,
      evaluatedPointCount: 8,
      noDataCount: 0,
      breachedPointCount: 0,
      recordedAlertCount: 0,
    };

    const humanIo = createCapturedIo();
    const humanCode = await runHealthCheckCli(DAILY_ARGS, humanIo.io, {
      readSummary: () => Promise.resolve(okSummary),
    });
    expect(humanCode).toBe(0);
    expect(humanIo.errors).toEqual([]);
    expect(humanIo.writes).toEqual([`${renderHealthCheckSummary(okSummary, false)}\n`]);

    const jsonIo = createCapturedIo();
    const jsonCode = await runHealthCheckCli([...DAILY_ARGS, "--json"], jsonIo.io, {
      readSummary: () => SAMPLE_SUMMARY,
    });
    expect(jsonCode).toBe(2);
    expect(jsonIo.errors).toEqual([]);
    expect(jsonIo.writes).toEqual([`${renderHealthCheckSummary(SAMPLE_SUMMARY, true)}\n`]);
  });

  it("fails with exit code 1 when readSummary dependency is missing", async () => {
    const captured = createCapturedIo();
    const code = await runHealthCheckCli(DAILY_ARGS, captured.io);
    expect(code).toBe(1);
    expect(captured.writes).toEqual([]);
    expect(captured.errors).toEqual(["Health check could not read the runtime summary.\n"]);
  });

  it("fails with exit code 1 when readSummary rejects without leaking details", async () => {
    const captured = createCapturedIo();
    const code = await runHealthCheckCli(DAILY_ARGS, captured.io, {
      readSummary: () => Promise.reject(new Error("internal secret stack\ndetail")),
    });
    expect(code).toBe(1);
    expect(captured.writes).toEqual([]);
    expect(captured.errors).toEqual(["Health check runtime summary could not be produced.\n"]);
  });

  it.each([
    {
      label: "missing required key",
      payload: {
        status: "NO_BREACH_OBSERVED",
        enabledRuleCount: 1,
        evaluatedPointCount: 1,
        noDataCount: 0,
        breachedPointCount: 0,
      },
      token: "recordedAlertCount",
    },
    {
      label: "bad count type",
      payload: {
        ...SAMPLE_SUMMARY,
        evaluatedPointCount: "12",
      },
      token: "evaluatedPointCount",
    },
  ])(
    "fails with exit code 1 and names the offending field on invalid summary ($label)",
    async ({ payload, token }) => {
      const captured = createCapturedIo();
      const code = await runHealthCheckCli(DAILY_ARGS, captured.io, {
        readSummary: () => payload,
      });
      expect(code).toBe(1);
      expect(captured.writes).toEqual([]);
      expectSingleLineError(captured.errors, token);
    },
  );

  it("fails with exit code 1 when io.write throws on help or check output", async () => {
    const helpIo = createCapturedIo(() => {
      throw new Error("EPIPE");
    });
    const helpCode = await runHealthCheckCli(["--help"], helpIo.io);
    expect(helpCode).toBe(1);
    expect(helpIo.writes).toEqual([]);
    expect(helpIo.errors).toEqual(["Health check help could not be written to stdout.\n"]);

    const checkIo = createCapturedIo(() => {
      throw new Error("EPIPE");
    });
    const checkCode = await runHealthCheckCli(DAILY_ARGS, checkIo.io, {
      readSummary: () => SAMPLE_SUMMARY,
    });
    expect(checkCode).toBe(1);
    expect(checkIo.writes).toEqual([]);
    expect(checkIo.errors).toEqual(["Health check output could not be written to stdout.\n"]);
  });

  it("regression guard: preserves WP1a parser and summary validator behavior", () => {
    expect(isHealthCheckSummaryStatus("NO_BREACH_OBSERVED")).toBe(true);
    expect(isHealthCheckSummaryStatus("UNKNOWN")).toBe(false);

    expect(parseHealthCheckCommand([...DAILY_ARGS, "--dimensions=countryCode", "--json"])).toEqual({
      kind: "check",
      json: true,
      input: {
        startTime: "2026-09-24T07:00:00Z",
        endTime: "2026-09-25T07:00:00Z",
        granularity: "DAILY",
        dimensions: ["countryCode"],
      },
    });
    expect(() => parseHealthCheckCommand(["--unknown"])).toThrow(HealthCheckCliError);

    expect(parseHealthCheckSummary({ ...SAMPLE_SUMMARY })).toEqual(SAMPLE_SUMMARY);
    expect(() => parseHealthCheckSummary({ ...SAMPLE_SUMMARY, noDataCount: -1 })).toThrow(
      HealthCheckCliError,
    );
  });
});

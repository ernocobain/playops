import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HEALTH_CHECK_HELP,
  renderHealthCheckSummary,
  type HealthCheckInput,
  type HealthCheckSummary,
} from "../src/cli/health-check.js";
import type { HealthCliDeps } from "../src/cli/health.js";
import { runCli, type CliOutput } from "../src/cli/main.js";
import type { DoctorDeps } from "../src/doctor/doctor.js";
import type { HealthComposition } from "../src/health/composition.js";
import { UnsupportedThresholdGranularityError } from "../src/health/summary-errors.js";
import {
  fakeReportComposition,
  healthReportArgs,
  RAW_REPORT_MARKER,
  REPORT_FILE,
  REPORT_TIME,
} from "./fixtures/health/report.fake.js";

const DAILY_CHECK_ARGS = [
  "health",
  "check",
  "--start",
  "2026-09-24T07:00:00Z",
  "--end",
  "2026-09-25T07:00:00Z",
  "--granularity",
  "DAILY",
] as const;

const NO_BREACH_SUMMARY: HealthCheckSummary = {
  status: "NO_BREACH_OBSERVED",
  enabledRuleCount: 1,
  evaluatedPointCount: 1,
  noDataCount: 0,
  breachedPointCount: 0,
  recordedAlertCount: 0,
};

const SENTINEL_SECRET = "SENTINEL-SECRET-CREDENTIAL-MUST-NOT-LEAK";

const STATUS_EXIT_CASES: readonly {
  readonly summary: HealthCheckSummary;
  readonly expectedExit: 0 | 1 | 2;
}[] = [
  {
    summary: {
      status: "NO_BREACH_OBSERVED",
      enabledRuleCount: 1,
      evaluatedPointCount: 1,
      noDataCount: 0,
      breachedPointCount: 0,
      recordedAlertCount: 0,
    },
    expectedExit: 0,
  },
  {
    summary: {
      status: "BREACH_DETECTED",
      enabledRuleCount: 1,
      evaluatedPointCount: 1,
      noDataCount: 0,
      breachedPointCount: 1,
      recordedAlertCount: 0,
    },
    expectedExit: 2,
  },
  {
    summary: {
      status: "INCOMPLETE_DATA",
      enabledRuleCount: 1,
      evaluatedPointCount: 1,
      noDataCount: 1,
      breachedPointCount: 0,
      recordedAlertCount: 0,
    },
    expectedExit: 1,
  },
  {
    summary: {
      status: "NO_DATA",
      enabledRuleCount: 1,
      evaluatedPointCount: 0,
      noDataCount: 1,
      breachedPointCount: 0,
      recordedAlertCount: 0,
    },
    expectedExit: 1,
  },
  {
    summary: {
      status: "DISABLED",
      enabledRuleCount: 0,
      evaluatedPointCount: 0,
      noDataCount: 0,
      breachedPointCount: 0,
      recordedAlertCount: 0,
    },
    expectedExit: 1,
  },
];

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function setup(initialSummary: unknown = NO_BREACH_SUMMARY) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const readSummary = vi.fn<(input: HealthCheckInput) => Promise<unknown>>(
    async () => initialSummary,
  );
  const composition = {
    summarySource: { readSummary },
  } as unknown as HealthComposition;
  const compositionFactory = vi.fn(async (): Promise<HealthComposition> => composition);
  const now = vi.fn(() => new Date(REPORT_TIME));
  const output: CliOutput = {
    log: (text: string) => {
      stdout.push(text);
    },
    error: (text: string) => {
      stderr.push(text);
    },
  };
  const healthDeps: HealthCliDeps = {
    io: {
      write: (text: string) => {
        stdout.push(text);
      },
      writeError: (text: string) => {
        stderr.push(text);
      },
    },
    compositionFactory,
    now,
  };
  const run = (args: readonly string[]) =>
    runCli(args, {} as DoctorDeps, output, undefined, undefined, healthDeps);
  return { stdout, stderr, readSummary, compositionFactory, now, output, healthDeps, run };
}

describe("Phase 5.4 WP2b health check CLI wiring", () => {
  it("routes health check with valid DAILY args to the WP1 runner", async () => {
    const s = setup(NO_BREACH_SUMMARY);
    const code = await s.run(DAILY_CHECK_ARGS);
    expect(code).toBe(0);
    expect(s.compositionFactory).toHaveBeenCalledTimes(1);
    expect(s.readSummary).toHaveBeenCalledTimes(1);
    expect(s.now).not.toHaveBeenCalled();
    expect(s.stderr).toEqual([]);
    expect(s.stdout).toEqual([`${renderHealthCheckSummary(NO_BREACH_SUMMARY, false)}\n`]);
  });

  it("prints HEALTH_CHECK_HELP on health check --help without calling composition", async () => {
    const s = setup();
    const code = await s.run(["health", "check", "--help"]);
    expect(code).toBe(0);
    expect(s.stdout).toEqual([`${HEALTH_CHECK_HELP}\n`]);
    expect(s.stderr).toEqual([]);
    expect(s.compositionFactory).not.toHaveBeenCalled();
    expect(s.readSummary).not.toHaveBeenCalled();
  });

  it("forwards valid options to the WP1 parser and passes canonical HealthCheckInput", async () => {
    const s = setup();
    const code = await s.run([
      "health",
      "check",
      "--start=2026-09-24T07:00:00Z",
      "--end",
      "2026-09-25T07:00:00Z",
      "--granularity=DAILY",
      "--dimensions=countryCode,versionCode",
    ]);
    expect(code).toBe(0);
    expect(s.readSummary).toHaveBeenCalledTimes(1);
    const expectedInput: HealthCheckInput = {
      startTime: "2026-09-24T07:00:00Z",
      endTime: "2026-09-25T07:00:00Z",
      granularity: "DAILY",
      dimensions: ["countryCode", "versionCode"],
    };
    expect(s.readSummary.mock.calls[0]?.[0]).toEqual(expectedInput);
  });

  it("rejects invalid --start before compositionFactory or readSummary is called", async () => {
    const s = setup();
    const code = await s.run([
      "health",
      "check",
      "--start",
      "invalid-timestamp",
      "--end",
      "2026-09-25T07:00:00Z",
      "--granularity",
      "DAILY",
    ]);
    expect(code).toBe(1);
    expect(s.stdout).toEqual([]);
    expect(s.stderr).toHaveLength(1);
    const err = s.stderr[0] ?? "";
    expect(err.endsWith("\n")).toBe(true);
    expect(err.slice(0, -1)).not.toContain("\n");
    expect(err).toContain("--start");
    expect(s.compositionFactory).not.toHaveBeenCalled();
    expect(s.readSummary).not.toHaveBeenCalled();
  });

  it("renders exact human output with trailing newline and empty stderr", async () => {
    const summary: HealthCheckSummary = {
      status: "NO_BREACH_OBSERVED",
      enabledRuleCount: 2,
      evaluatedPointCount: 6,
      noDataCount: 0,
      breachedPointCount: 0,
      recordedAlertCount: 0,
    };
    const s = setup(summary);
    const code = await s.run(DAILY_CHECK_ARGS);
    expect(code).toBe(0);
    expect(s.stdout).toEqual([`${renderHealthCheckSummary(summary, false)}\n`]);
    expect(s.stderr).toEqual([]);
  });

  it("renders exact single-line JSON output in canonical key order with --json", async () => {
    const summary: HealthCheckSummary = {
      status: "BREACH_DETECTED",
      enabledRuleCount: 3,
      evaluatedPointCount: 9,
      noDataCount: 1,
      breachedPointCount: 2,
      recordedAlertCount: 0,
    };
    const s = setup(summary);
    const code = await s.run([...DAILY_CHECK_ARGS, "--json"]);
    expect(code).toBe(2);
    expect(s.stderr).toEqual([]);
    expect(s.stdout).toHaveLength(1);
    const raw = s.stdout[0] ?? "";
    expect(raw.endsWith("\n")).toBe(true);
    const singleLine = raw.slice(0, -1);
    expect(singleLine).not.toContain("\n");
    const parsed: unknown = JSON.parse(singleLine);
    expect(parsed).toEqual(summary);
    expect(Object.keys(parsed as Record<string, unknown>)).toEqual([
      "status",
      "enabledRuleCount",
      "evaluatedPointCount",
      "noDataCount",
      "breachedPointCount",
      "recordedAlertCount",
    ]);
  });

  it.each(STATUS_EXIT_CASES)(
    "maps status $summary.status to exit code $expectedExit through runCli",
    async ({ summary, expectedExit }) => {
      const s = setup(summary);
      const code = await s.run(DAILY_CHECK_ARGS);
      expect(code).toBe(expectedExit);
      expect(s.stderr).toEqual([]);
      expect(s.stdout).toEqual([`${renderHealthCheckSummary(summary, false)}\n`]);
    },
  );

  it("handles provider errors safely without leaking sentinel secrets", async () => {
    const root = mkdtempSync(join(tmpdir(), "playops-hc-sentinel-"));
    dirs.push(root);
    const outputDir = join(root, "reports");
    mkdirSync(outputDir);
    const fake = fakeReportComposition(join(root, "audit.jsonl"), "normal");
    const reportOut: string[] = [];
    const reportErr: string[] = [];
    const reportCode = await runCli(
      healthReportArgs(outputDir),
      {} as DoctorDeps,
      {
        log: (text: string) => {
          reportOut.push(text);
        },
        error: (text: string) => {
          reportErr.push(text);
        },
      },
      undefined,
      undefined,
      {
        io: {
          write: (text: string) => {
            reportOut.push(text);
          },
          writeError: (text: string) => {
            reportErr.push(text);
          },
        },
        compositionFactory: async () => fake.composition,
        now: () => new Date(REPORT_TIME),
      },
    );
    expect(reportCode).toBe(0);
    const reportOutput = readFileSync(join(outputDir, REPORT_FILE), "utf8");

    const s = setup();
    s.readSummary.mockRejectedValueOnce(new Error(`Credential failure: ${SENTINEL_SECRET}`));
    const code = await s.run(DAILY_CHECK_ARGS);
    expect(code).toBe(1);
    expect(s.stdout).toEqual([]);
    expect(s.stderr).toEqual(["Health check runtime summary could not be produced.\n"]);
    expect(s.stdout.join("")).not.toContain(SENTINEL_SECRET);
    expect(s.stderr.join("")).not.toContain(SENTINEL_SECRET);
    expect(reportOutput).not.toContain(SENTINEL_SECRET);
    expect(reportOut.join("")).not.toContain(SENTINEL_SECRET);
    expect(reportErr.join("")).not.toContain(SENTINEL_SECRET);
  });

  it("writes no audit file and leaves temporary directory empty after health check", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "playops-hc-audit-"));
    dirs.push(tempDir);
    const auditPath = join(tempDir, "audit.jsonl");
    const s = setup(NO_BREACH_SUMMARY);
    const code = await s.run(DAILY_CHECK_ARGS);
    expect(code).toBe(0);
    expect(existsSync(auditPath)).toBe(false);
    expect(readdirSync(tempDir)).toEqual([]);
  });

  it("preserves health report behavior and does not leak secrets in report output", async () => {
    const root = mkdtempSync(join(tmpdir(), "playops-hc-report-"));
    dirs.push(root);
    const outputDir = join(root, "reports");
    mkdirSync(outputDir);
    const auditPath = join(root, "audit.jsonl");
    const fake = fakeReportComposition(auditPath, "normal");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const output: CliOutput = {
      log: (text: string) => {
        stdout.push(text);
      },
      error: (text: string) => {
        stderr.push(text);
      },
    };
    const code = await runCli(
      healthReportArgs(outputDir),
      {} as DoctorDeps,
      output,
      undefined,
      undefined,
      {
        io: { write: output.log, writeError: output.error },
        compositionFactory: async () => fake.composition,
        now: () => new Date(REPORT_TIME),
      },
    );
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    expect(readdirSync(outputDir)).toEqual([REPORT_FILE]);
    const reportText = readFileSync(join(outputDir, REPORT_FILE), "utf8");
    expect(reportText).toBe(stdout[0]);
    expect(reportText).not.toContain(SENTINEL_SECRET);
    expect(reportText).not.toContain(RAW_REPORT_MARKER);
  });

  it("exposes top-level, health, and health check help without calling composition", async () => {
    const top = setup();
    expect(await top.run(["--help"])).toBe(0);
    expect(top.stderr).toEqual([]);
    const topLines = (top.stdout[0] ?? "").split("\n");
    expect(topLines).toContain(
      "  health    Produce a dated health comparison report (stdout + saved file)",
    );
    expect(topLines).toContain(
      "  health check  Check configured App Health thresholds (read-only)",
    );
    expect(top.compositionFactory).not.toHaveBeenCalled();
    expect(top.readSummary).not.toHaveBeenCalled();

    const healthHelp = setup();
    expect(await healthHelp.run(["health", "--help"])).toBe(0);
    expect(healthHelp.stderr).toEqual([]);
    expect(healthHelp.stdout.join("")).toContain("Usage: playops health report");
    expect(healthHelp.compositionFactory).not.toHaveBeenCalled();
    expect(healthHelp.readSummary).not.toHaveBeenCalled();

    const checkHelp = setup();
    expect(await checkHelp.run(["health", "check", "--help"])).toBe(0);
    expect(checkHelp.stderr).toEqual([]);
    expect(checkHelp.stdout).toEqual([`${HEALTH_CHECK_HELP}\n`]);
    expect(checkHelp.compositionFactory).not.toHaveBeenCalled();
    expect(checkHelp.readSummary).not.toHaveBeenCalled();
  });

  it("prints the G2 message on UnsupportedThresholdGranularityError", async () => {
    const s = setup();
    s.readSummary.mockRejectedValueOnce(
      new UnsupportedThresholdGranularityError("HOURLY", ["excessive_wakeup_rate"]),
    );
    const code = await s.run([
      "health",
      "check",
      "--start",
      "2026-09-24T07:00:00Z",
      "--end",
      "2026-09-25T07:00:00Z",
      "--granularity",
      "HOURLY",
    ]);
    expect(code).toBe(1);
    expect(s.stdout).toEqual([]);
    const expectedG2 = [
      "Health check granularity HOURLY is not supported by",
      "enabled threshold metric kind(s): excessive_wakeup_rate.\n",
    ].join(" ");
    expect(s.stderr).toEqual([expectedG2]);
  });
});

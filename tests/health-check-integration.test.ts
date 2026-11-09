import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HEALTH_CHECK_HELP,
  renderHealthCheckSummary,
  type HealthCheckSummary,
} from "../src/cli/health-check.js";
import type { HealthCliDeps } from "../src/cli/health.js";
import { runCli, type CliOutput } from "../src/cli/main.js";
import type { DoctorDeps } from "../src/doctor/doctor.js";
import type { HealthComposition } from "../src/health/composition.js";
import type { HealthMetricGateway, HealthMetricQueryRequest } from "../src/health/gateway.js";
import { HEALTH_METRIC_SPECS, type HealthMetricKind } from "../src/health/index.js";
import { createHealthSummarySource, type HealthSummarySource } from "../src/health/summary.js";
import { buildHealthThresholdRules, type HealthThresholdRule } from "../src/health/thresholds.js";
import { thresholdConfig } from "./fixtures/health/thresholds.fake.js";

const CLI_PATH = join(process.cwd(), "dist", "cli", "index.js");

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

const HOURLY_CHECK_ARGS = [
  "health",
  "check",
  "--start",
  "2026-09-24T07:00:00Z",
  "--end",
  "2026-09-24T08:00:00Z",
  "--granularity",
  "HOURLY",
] as const;

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function runBinary(args: readonly string[]): SpawnSyncReturns<string> {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`Built CLI entrypoint not found at ${CLI_PATH}; run "npm run build" first.`);
  }
  const tempDir = createTempDir("playops-hc-bin-");
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    timeout: 20000,
    cwd: tempDir,
    env: { ...process.env, HOME: tempDir },
  });
}

function rawRow(kind: HealthMetricKind, request: HealthMetricQueryRequest, value: string) {
  return {
    aggregationPeriod: request.timelineSpec.aggregationPeriod,
    startTime: {
      ...request.timelineSpec.startTime,
      timeZone: { id: request.timelineSpec.startTime.timeZoneId ?? "America/Los_Angeles" },
    },
    dimensions: [],
    metrics: [{ metric: HEALTH_METRIC_SPECS[kind].primaryMetric, decimalValue: { value } }],
  };
}

function createFakeGateway(
  valuesByKind: Partial<Record<HealthMetricKind, string | null>> | string,
) {
  const readMetricSet = vi.fn<HealthMetricGateway["readMetricSet"]>(async () => ({}));
  const queryMetricSet = vi.fn<HealthMetricGateway["queryMetricSet"]>(async (kind, request) => {
    const value = typeof valuesByKind === "string" ? valuesByKind : valuesByKind[kind];
    if (value === undefined || value === null) {
      return { rows: [] };
    }
    return { rows: [rawRow(kind, request, value)] };
  });
  const gateway: HealthMetricGateway = { readMetricSet, queryMetricSet };
  return {
    gateway,
    readMetricSet,
    queryMetricSet,
    callCount: () => readMetricSet.mock.calls.length + queryMetricSet.mock.calls.length,
  };
}

function createInjectedHarness(options: {
  readonly rules?: readonly HealthThresholdRule[];
  readonly valuesByKind?: Partial<Record<HealthMetricKind, string | null>> | string;
  readonly summarySource?: HealthSummarySource;
}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fakeGw = createFakeGateway(options.valuesByKind ?? {});
  const rules = options.rules ?? [];
  const summarySource =
    options.summarySource ?? createHealthSummarySource({ rules, gateway: fakeGw.gateway });
  const composition = { summarySource } as unknown as HealthComposition;
  const compositionFactory = vi.fn(async (): Promise<HealthComposition> => composition);
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
  };
  const run = (args: readonly string[]) =>
    runCli(args, {} as DoctorDeps, output, undefined, undefined, healthDeps);
  return { stdout, stderr, fakeGw, compositionFactory, run };
}

// ============================================================================
// Real executable section (true built binary via child_process.spawnSync)
// ============================================================================
describe("Phase 5.4 WP2c real built CLI executable (dist/cli/index.js)", () => {
  it("1. --help exits 0 and lists health check without config or credentials", () => {
    const res = runBinary(["--help"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toContain("Usage: playops <command>");
    expect(res.stdout.split("\n")).toContain(
      "  health check  Check configured App Health thresholds (read-only)",
    );
  });

  it("2. health --help exits 0 and prints health report usage", () => {
    const res = runBinary(["health", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toContain("Usage: playops health report");
  });

  it("3. health check --help exits 0 and prints exact HEALTH_CHECK_HELP", () => {
    const res = runBinary(["health", "check", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toBe(`${HEALTH_CHECK_HELP}\n`);
  });

  it("4. health check with bad --start exits 1 without stack or config errors", () => {
    const res = runBinary([
      "health",
      "check",
      "--start",
      "bad",
      "--end",
      "2026-09-25T07:00:00Z",
      "--granularity",
      "DAILY",
    ]);
    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("--start");
    expect(res.stderr).not.toContain("    at ");
    expect(res.stderr).not.toContain("Error:");
    expect(res.stderr).not.toMatch(/config|credential|serviceAccount/iu);
  });

  it("5. health report --help exits 0 and prints health report usage", () => {
    const res = runBinary(["health", "report", "--help"]);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toContain("Usage: playops health report");
  });

  it("6. health report with no arguments exits 1 without stack trace", () => {
    const res = runBinary(["health", "report"]);
    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("Invalid health command");
    expect(res.stderr).not.toContain("    at ");
    expect(res.stderr).not.toContain("Error:");
  });
});

// ============================================================================
// Injected-dependency section (not the executable; runCli + real summarySource)
// ============================================================================
describe("Phase 5.4 WP2c injected-dependency CLI integration", () => {
  it("7. human NO_BREACH_OBSERVED exits 0 with exact rendered summary", async () => {
    const rules = buildHealthThresholdRules(
      thresholdConfig({ crashRateReportedThreshold: "1.00" }),
    );
    const h = createInjectedHarness({ rules, valuesByKind: { crash_rate: "0.50" } });
    const summary: HealthCheckSummary = {
      status: "NO_BREACH_OBSERVED",
      enabledRuleCount: 1,
      evaluatedPointCount: 1,
      noDataCount: 0,
      breachedPointCount: 0,
      recordedAlertCount: 0,
    };

    const code = await h.run(DAILY_CHECK_ARGS);
    expect(code).toBe(0);
    expect(h.stderr).toEqual([]);
    expect(h.stdout).toEqual([`${renderHealthCheckSummary(summary, false)}\n`]);
  });

  it("8. JSON BREACH_DETECTED exits 2 with canonical single-line JSON", async () => {
    const rules = buildHealthThresholdRules(
      thresholdConfig({ crashRateReportedThreshold: "1.00" }),
    );
    const h = createInjectedHarness({ rules, valuesByKind: { crash_rate: "1.50" } });
    const summary: HealthCheckSummary = {
      status: "BREACH_DETECTED",
      enabledRuleCount: 1,
      evaluatedPointCount: 1,
      noDataCount: 0,
      breachedPointCount: 1,
      recordedAlertCount: 0,
    };

    const code = await h.run([...DAILY_CHECK_ARGS, "--json"]);
    expect(code).toBe(2);
    expect(h.stderr).toEqual([]);
    expect(h.stdout).toHaveLength(1);
    const raw = h.stdout[0] ?? "";
    expect(raw).toBe(`${renderHealthCheckSummary(summary, true)}\n`);
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

  it("9. INCOMPLETE_DATA with one evaluated and one missing point exits 1", async () => {
    const rules = buildHealthThresholdRules(
      thresholdConfig({
        crashRateReportedThreshold: "1.00",
        anrRateReportedThreshold: "0.50",
      }),
    );
    const h = createInjectedHarness({
      rules,
      valuesByKind: { crash_rate: "0.50", anr_rate: null },
    });
    const summary: HealthCheckSummary = {
      status: "INCOMPLETE_DATA",
      enabledRuleCount: 2,
      evaluatedPointCount: 1,
      noDataCount: 1,
      breachedPointCount: 0,
      recordedAlertCount: 0,
    };

    const code = await h.run(DAILY_CHECK_ARGS);
    expect(code).toBe(1);
    expect(h.stderr).toEqual([]);
    expect(h.stdout).toEqual([`${renderHealthCheckSummary(summary, false)}\n`]);
    expect(h.stdout[0]).toContain("Status: INCOMPLETE_DATA");
  });

  it("10. NO_DATA with one rule and empty rows exits 1", async () => {
    const rules = buildHealthThresholdRules(
      thresholdConfig({ crashRateReportedThreshold: "1.00" }),
    );
    const h = createInjectedHarness({ rules, valuesByKind: { crash_rate: null } });
    const summary: HealthCheckSummary = {
      status: "NO_DATA",
      enabledRuleCount: 1,
      evaluatedPointCount: 0,
      noDataCount: 1,
      breachedPointCount: 0,
      recordedAlertCount: 0,
    };

    const code = await h.run(DAILY_CHECK_ARGS);
    expect(code).toBe(1);
    expect(h.stderr).toEqual([]);
    expect(h.stdout).toEqual([`${renderHealthCheckSummary(summary, false)}\n`]);
    expect(h.stdout[0]).toContain("Status: NO_DATA");
  });

  it("11. DISABLED with zero rules exits 1 with gateway call count 0", async () => {
    const rules = buildHealthThresholdRules(thresholdConfig());
    const h = createInjectedHarness({ rules, valuesByKind: "1.50" });
    const summary: HealthCheckSummary = {
      status: "DISABLED",
      enabledRuleCount: 0,
      evaluatedPointCount: 0,
      noDataCount: 0,
      breachedPointCount: 0,
      recordedAlertCount: 0,
    };

    const code = await h.run(DAILY_CHECK_ARGS);
    expect(code).toBe(1);
    expect(h.stderr).toEqual([]);
    expect(h.stdout).toEqual([`${renderHealthCheckSummary(summary, false)}\n`]);
    expect(h.stdout[0]).toContain("Status: DISABLED");
    expect(h.fakeGw.callCount()).toBe(0);
  });

  it("12. G2 HOURLY rejection exits 1 with G2 message and 0 gateway calls", async () => {
    const rules = buildHealthThresholdRules(
      thresholdConfig({ excessiveWakeupRateReportedThreshold: "2.00" }),
    );
    const h = createInjectedHarness({ rules, valuesByKind: "1.00" });
    const expectedG2 = [
      "Health check granularity HOURLY is not supported by",
      "enabled threshold metric kind(s): excessive_wakeup_rate.\n",
    ].join(" ");

    const code = await h.run(HOURLY_CHECK_ARGS);
    expect(code).toBe(1);
    expect(h.stdout).toEqual([]);
    expect(h.stderr).toEqual([expectedG2]);
    expect(h.fakeGw.callCount()).toBe(0);
  });

  it("13. generic provider error exits 1 without leaking sentinel", async () => {
    const sentinel = "SENTINEL-SECRET-CREDENTIAL-DO-NOT-LEAK";
    const summarySource: HealthSummarySource = {
      readSummary: async () => {
        throw new Error(`Provider failure: ${sentinel}`);
      },
    };
    const h = createInjectedHarness({ summarySource });

    const code = await h.run(DAILY_CHECK_ARGS);
    expect(code).toBe(1);
    expect(h.stdout.join("")).toBe("");
    expect(h.stderr).toEqual(["Health check runtime summary could not be produced.\n"]);
    expect(h.stdout.join("")).not.toContain(sentinel);
    expect(h.stderr.join("")).not.toContain(sentinel);
  });

  it("14. invalid --start exits 1 without calling compositionFactory", async () => {
    const rules = buildHealthThresholdRules(
      thresholdConfig({ crashRateReportedThreshold: "1.00" }),
    );
    const h = createInjectedHarness({ rules, valuesByKind: "0.50" });

    const code = await h.run([
      "health",
      "check",
      "--start",
      "bad",
      "--end",
      "2026-09-25T07:00:00Z",
      "--granularity",
      "DAILY",
    ]);
    expect(code).toBe(1);
    expect(h.stdout).toEqual([]);
    expect(h.stderr.join("")).toContain("--start");
    expect(h.compositionFactory).not.toHaveBeenCalled();
    expect(h.fakeGw.callCount()).toBe(0);
  });

  it("15. breaching check writes no audit file in temp directory", async () => {
    const tempDir = createTempDir("playops-hc-no-audit-");
    const auditPath = join(tempDir, "audit.jsonl");
    const rules = buildHealthThresholdRules(
      thresholdConfig({ crashRateReportedThreshold: "1.00" }),
    );
    const h = createInjectedHarness({ rules, valuesByKind: { crash_rate: "2.00" } });

    const code = await h.run(DAILY_CHECK_ARGS);
    expect(code).toBe(2);
    expect(existsSync(auditPath)).toBe(false);
    expect(readdirSync(tempDir)).toEqual([]);
  });
});

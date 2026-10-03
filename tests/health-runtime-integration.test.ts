/**
 * Phase 5.1 — real Phase 2 runtime integration for the health metric tools.
 *
 * Real ToolRegistry + runAgent + permission engine + audit, scripted fake LLM,
 * and a fake generated Reporting client (no network, no credentials).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAuditEntries } from "../src/audit/index.js";
import { DEFAULT_CONFIG, type PlayOpsConfig } from "../src/config/index.js";
import type { PlayReportingClient, VitalsResourceLike } from "../src/googleplay/reporting/index.js";
import { createHealthComposition, type HealthComposition } from "../src/health/composition.js";
import { HEALTH_METRIC_SPECS, type HealthMetricSeries } from "../src/health/index.js";
import { runAgent, type AgentRunResult } from "../src/runtime/agent/index.js";
import type { LlmAdapter } from "../src/runtime/llm/index.js";

const PKG = "com.example.healthruntime";
const RAW_MARKER = "RAW-GENERATED-MARKER-PHASE51";
const FAKE_KEY_MARKER = "FAKE-KEY-MUST-NOT-LEAK";
let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs = [];
  vi.restoreAllMocks();
});

function makeDir(): string {
  const dir = mkdtempSync(
    join(process.env.TMPDIR ?? process.cwd(), "playops-phase51-integration-"),
  );
  tempDirs.push(dir);
  return dir;
}

function configFor(dir: string): PlayOpsConfig {
  return {
    ...DEFAULT_CONFIG,
    googlePlay: { packageName: PKG, serviceAccountJson: "FAKE-CREDENTIAL-PATH" },
    audit: { logPath: join(dir, "audit.jsonl") },
  };
}

const PRIMARY_ROW = {
  aggregationPeriod: "DAILY",
  startTime: { year: 2026, month: 9, day: 1, timeZone: { id: "America/Los_Angeles" } },
  dimensions: [{ dimension: "countryCode", stringValue: "ID" }],
  metrics: [{ metric: "crashRate", decimalValue: { value: "0.0123" } }],
};

function fakeReportingClient(): { readonly client: PlayReportingClient; readonly calls: string[] } {
  const calls: string[] = [];
  const makeGet = (operation: string, suffix: string) => (): Promise<{ data: unknown }> => {
    calls.push(operation);
    return Promise.resolve({
      data: {
        name: `apps/${PKG}/${suffix}`,
        freshnessInfo: {
          freshnesses: [
            { aggregationPeriod: "DAILY", latestEndTime: { year: 2026, month: 9, day: 8 } },
          ],
        },
        [RAW_MARKER]: RAW_MARKER,
      } as unknown,
    });
  };
  const makeQuery = (operation: string, metric: string) => (): Promise<{ data: unknown }> => {
    calls.push(operation);
    return Promise.resolve({
      data: {
        rows: [{ ...PRIMARY_ROW, metrics: [{ metric, decimalValue: { value: "0.0123" } }] }],
        nextPageToken: null,
        [RAW_MARKER]: RAW_MARKER,
        privateKey: FAKE_KEY_MARKER,
      } as unknown,
    });
  };

  const resource: VitalsResourceLike = {
    anrrate: {
      get: makeGet(
        "vitals.anrrate.get",
        "anrRateMetricSet",
      ) as VitalsResourceLike["anrrate"]["get"],
      query: makeQuery("vitals.anrrate.query", "anrRate") as VitalsResourceLike["anrrate"]["query"],
    },
    crashrate: {
      get: makeGet(
        "vitals.crashrate.get",
        "crashRateMetricSet",
      ) as VitalsResourceLike["crashrate"]["get"],
      query: makeQuery(
        "vitals.crashrate.query",
        "crashRate",
      ) as VitalsResourceLike["crashrate"]["query"],
    },
    excessivewakeuprate: {
      get: makeGet(
        "vitals.excessivewakeuprate.get",
        "excessiveWakeupRateMetricSet",
      ) as VitalsResourceLike["excessivewakeuprate"]["get"],
      query: makeQuery(
        "vitals.excessivewakeuprate.query",
        "excessiveWakeupRate",
      ) as VitalsResourceLike["excessivewakeuprate"]["query"],
    },
  };
  return { client: { version: "v1beta1", vitals: resource }, calls };
}

function llmCalling(toolName: string, args: Record<string, unknown>): LlmAdapter {
  let turn = 0;
  return {
    provider: "fake-phase51-runtime",
    async complete() {
      turn += 1;
      if (turn === 1) {
        return {
          toolCalls: [{ id: "health-call", name: toolName, arguments: args }],
          usage: { totalTokens: 1 },
        };
      }
      return { content: "Health metrics fetched.", toolCalls: [], usage: { totalTokens: 1 } };
    },
  };
}

interface Harness {
  readonly result: AgentRunResult;
  readonly composition: HealthComposition;
  readonly calls: string[];
  readonly dir: string;
}

async function runHealth(toolName: string, args: Record<string, unknown>): Promise<Harness> {
  const dir = makeDir();
  const fake = fakeReportingClient();
  const composition = createHealthComposition(configFor(dir), { reporting: fake.client });
  const result = await runAgent({
    llm: llmCalling(toolName, args),
    registry: composition.registry,
    bindings: composition.bindings,
    messages: [{ role: "user", content: "Fetch health metrics for the app." }],
    limits: { maxSteps: 3, maxToolCalls: 1, maxTotalTokens: 10 },
    ledger: composition.ledger,
    runId: () => "phase51-health-run",
  });
  return { result, composition, calls: fake.calls, dir };
}

const VALID_ARGS = {
  startTime: "2026-09-01T07:00:00Z",
  endTime: "2026-09-08T07:00:00Z",
  granularity: "DAILY",
  dimensions: ["countryCode"],
};

describe("Phase 5.1 health metric tools through the real Phase 2 runtime", () => {
  it("registers exactly the three read-only health tools with no verifier", () => {
    const composition = createHealthComposition(configFor(makeDir()), {
      reporting: fakeReportingClient().client,
    });

    expect(composition.registry.list().map((tool) => tool.name)).toEqual([
      "health.get_crash_rate",
      "health.get_anr_rate",
      "health.get_excessive_wakeups",
      "health.compare_to_baseline",
      "health.check_thresholds",
    ]);
    for (const tool of composition.registry.list()) {
      expect(tool.permission).toBe("read");
      expect(tool.verify).toBeUndefined();
    }
    expect(composition.tools).toHaveLength(3);
  });

  it("executes health.get_crash_rate with skipped verification, safe audit and zero network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { result, calls, dir } = await runHealth("health.get_crash_rate", {
      ...VALID_ARGS,
      metrics: ["crashRate"],
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, code: "COMPLETED", externalStateUncertain: false });
    expect(result.finalContent).toBe("Health metrics fetched.");
    expect(calls).toEqual(["vitals.crashrate.get", "vitals.crashrate.query"]);

    const toolMessage = result.conversation.find((message) => message.role === "tool");
    const payload = JSON.parse(toolMessage?.content ?? "null") as HealthMetricSeries;
    expect(payload.toolName).toBe("health.get_crash_rate");
    expect(payload.metrics).toEqual(["crashRate"]);
    expect(payload.points[0]?.metrics[0]).toEqual({
      metric: "crashRate",
      value: "0.0123",
      unit: "percent",
    });
    expect(payload.freshness).toEqual([
      { aggregationPeriod: "DAILY", latestEndTimeUtc: "2026-09-08T07:00:00Z" },
    ]);
    expect(toolMessage?.content ?? "").not.toContain(RAW_MARKER);
    expect(toolMessage?.content ?? "").not.toContain(FAKE_KEY_MARKER);

    const audit = readAuditEntries(join(dir, "audit.jsonl"));
    expect(audit.some((entry) => entry.type.startsWith("approval."))).toBe(false);
    expect(audit).toContainEqual(
      expect.objectContaining({
        type: "verification.completed",
        status: "success",
        metadata: expect.objectContaining({
          toolName: "health.get_crash_rate",
          permission: "read",
          required: false,
          code: "VERIFICATION_SKIPPED",
        }),
      }),
    );
    expect(JSON.stringify(audit)).not.toContain(RAW_MARKER);
    expect(JSON.stringify(audit)).not.toContain(FAKE_KEY_MARKER);
    expect(JSON.stringify(audit)).not.toContain("0.0123");
  });

  it("runs every supported metric kind through the runtime and the Reporting reads only", async () => {
    const cases = [
      { tool: "health.get_crash_rate", kind: "crash_rate", metric: "crashRate" },
      { tool: "health.get_anr_rate", kind: "anr_rate", metric: "anrRate" },
      {
        tool: "health.get_excessive_wakeups",
        kind: "excessive_wakeup_rate",
        metric: "excessiveWakeupRate",
      },
    ] as const;

    for (const testCase of cases) {
      const { result, calls } = await runHealth(testCase.tool, {
        ...VALID_ARGS,
        metrics: [testCase.metric],
      });

      expect(result.ok).toBe(true);
      const spec = HEALTH_METRIC_SPECS[testCase.kind];
      expect(calls).toEqual([spec.readOperation, spec.queryOperation]);
      const toolMessage = result.conversation.find((message) => message.role === "tool");
      const payload = JSON.parse(toolMessage?.content ?? "null") as HealthMetricSeries;
      expect(payload.kind).toBe(testCase.kind);
      expect(payload.toolName).toBe(spec.toolName);
      expect(payload.metrics).toEqual([spec.primaryMetric]);
    }
  });

  it("refuses an invalid window, a wrong metric, an extra field and a bad shape", async () => {
    const cases: Record<string, unknown>[] = [
      { ...VALID_ARGS, startTime: "2026-09-01T00:00:00Z" }, // not a local-midnight DAILY boundary
      { ...VALID_ARGS, metrics: ["anrRate"] }, // not a crash-rate metric
      { ...VALID_ARGS, packageName: "com.attacker.app" }, // model may not bind identity
      { ...VALID_ARGS, granularity: "HOURLY" }, // fine for crash rate, keep valid below
      { ...VALID_ARGS, dimensions: "countryCode" },
    ];

    for (const args of cases.slice(0, 3).concat(cases.slice(4))) {
      const { result, calls } = await runHealth("health.get_crash_rate", args);
      expect(result).toMatchObject({ ok: false, code: "INPUT_INVALID" });
      expect(calls).toEqual([]);
    }
  });

  it("has no mutation or approval path in the health registry", async () => {
    const { composition } = await runHealth("health.get_crash_rate", VALID_ARGS);

    expect(composition.registry.list()).toHaveLength(5);
    expect(composition.registry.list().every((tool) => tool.permission === "read")).toBe(true);
    expect(composition.bindings.map((binding) => binding.toolName).sort()).toEqual([
      "health.check_thresholds",
      "health.compare_to_baseline",
      "health.get_anr_rate",
      "health.get_crash_rate",
      "health.get_excessive_wakeups",
    ]);
  });
});

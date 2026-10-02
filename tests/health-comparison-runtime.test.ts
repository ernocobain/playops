/**
 * Phase 5.2 — real Phase 2 runtime integration for `health.compare_to_baseline`.
 *
 * Two flavors:
 *  A. fake Phase 5.1 gateway (deterministic Reporting query counts)
 *  B. real Phase 5.1 fetcher → real production Reporting adapter → fake generated
 *     Reporting client, proving 5.2 is composed over 5.1 rather than a parallel
 *     fake-only architecture.
 *
 * Real ToolRegistry, runAgent, permission engine, verification and audit;
 * scripted fake LLM; no network, no credentials, no live Google call.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAuditEntries } from "../src/audit/index.js";
import { DEFAULT_CONFIG, type PlayOpsConfig } from "../src/config/index.js";
import type { PlayReportingClient, VitalsResourceLike } from "../src/googleplay/reporting/index.js";
import { HEALTH_COMPARISON_TOOL_NAME } from "../src/health/comparison.js";
import { createHealthComposition, type HealthComposition } from "../src/health/composition.js";
import type { HealthMetricGateway, HealthMetricQueryRequest } from "../src/health/gateway.js";
import type { HealthMetricKind } from "../src/health/index.js";
import { runAgent, type AgentRunResult } from "../src/runtime/agent/index.js";
import type { LlmAdapter } from "../src/runtime/llm/index.js";

const PKG = "com.example.phase52";
const RAW_MARKER = "RAW-PHASE52-MARKER";
const SECRET_MARKER = "FAKE-KEY-PHASE52-MUST-NOT-LEAK";
const CURRENT = { startTime: "2026-09-24T07:00:00Z", endTime: "2026-09-25T07:00:00Z" };
const BASELINE = { startTime: "2026-09-23T07:00:00Z", endTime: "2026-09-24T07:00:00Z" };

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs = [];
  vi.restoreAllMocks();
});

function makeDir(): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-phase52-"));
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

function isCurrent(request: HealthMetricQueryRequest): boolean {
  return request.timelineSpec.startTime.day === 24;
}

function pointFor(
  kind: HealthMetricKind,
  request: HealthMetricQueryRequest,
): Record<string, unknown> {
  const current = isCurrent(request);
  const metrics = request.metrics.map((metric) => ({
    metric,
    decimalValue: {
      value:
        metric === "distinctUsers" ? (current ? "15000" : "12000") : current ? "0.0155" : "0.0123",
    },
  }));
  return {
    aggregationPeriod: request.timelineSpec.aggregationPeriod,
    startTime: {
      ...request.timelineSpec.startTime,
      ...(request.timelineSpec.startTime.timeZoneId !== undefined
        ? { timeZone: { id: request.timelineSpec.startTime.timeZoneId } }
        : { timeZone: { id: "America/Los_Angeles" } }),
    },
    dimensions: [],
    metrics,
    rawKind: kind,
    [RAW_MARKER]: RAW_MARKER,
  };
}

function fakeGateway(options: { readonly failBaselineQuery?: boolean } = {}): {
  readonly gateway: HealthMetricGateway;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const gateway: HealthMetricGateway = {
    async readMetricSet(kind) {
      calls.push(`${kind}:read`);
      return {
        name: `apps/${PKG}/x`,
        freshnessInfo: {
          freshnesses: [
            { aggregationPeriod: "DAILY", latestEndTime: { year: 2026, month: 10, day: 1 } },
          ],
        },
        [RAW_MARKER]: RAW_MARKER,
        privateKey: SECRET_MARKER,
      };
    },
    async queryMetricSet(kind, request) {
      const side = isCurrent(request) ? "current" : "baseline";
      calls.push(`${kind}:query:${side}`);
      if (options.failBaselineQuery === true && side === "baseline") {
        throw Object.assign(new Error(`boom ${SECRET_MARKER}`), { code: 503 });
      }
      return { rows: [pointFor(kind, request)], nextPageToken: undefined };
    },
  };
  return { gateway, calls };
}

function llmFor(args: Record<string, unknown>): LlmAdapter {
  let turn = 0;
  return {
    provider: "fake-phase52-runtime",
    async complete() {
      turn += 1;
      if (turn === 1) {
        return {
          toolCalls: [{ id: "compare-call", name: HEALTH_COMPARISON_TOOL_NAME, arguments: args }],
          usage: { totalTokens: 1 },
        };
      }
      return { content: "Comparison ready.", toolCalls: [], usage: { totalTokens: 1 } };
    },
  };
}

const VALID_ARGS = {
  current: { ...CURRENT },
  baseline: { ...BASELINE },
  granularity: "DAILY",
};

async function runComparison(
  gateway: HealthMetricGateway,
  args: Record<string, unknown> = VALID_ARGS,
): Promise<{
  readonly result: AgentRunResult;
  readonly composition: HealthComposition;
  readonly dir: string;
}> {
  const dir = makeDir();
  const composition = createHealthComposition(configFor(dir), {
    reporting: {
      version: "v1beta1",
      vitals: {} as VitalsResourceLike,
    } as unknown as PlayReportingClient,
    comparisonGateway: gateway,
  });
  const result = await runAgent({
    llm: llmFor(args),
    registry: composition.registry,
    bindings: composition.bindings,
    messages: [{ role: "user", content: "Compare health metrics to the baseline." }],
    limits: { maxSteps: 3, maxToolCalls: 1, maxTotalTokens: 10 },
    ledger: composition.ledger,
    runId: () => "phase52-run",
  });
  return { result, composition, dir };
}

function toolPayload(result: AgentRunResult): {
  readonly comparison: {
    readonly kinds: readonly string[];
    readonly entryCount: number;
    readonly sections: readonly {
      readonly entries: readonly {
        readonly values: readonly { readonly direction: string; readonly absoluteDelta?: string }[];
      }[];
    }[];
  };
  readonly summary: string;
} {
  const message = result.conversation.find((entry) => entry.role === "tool");
  return JSON.parse(message?.content ?? "null");
}

describe("Phase 5.2 through the real Phase 2 runtime (fake 5.1 gateway)", () => {
  it("registers the comparison tool as a read-only tool with no approval or verifier", () => {
    const gateway = fakeGateway().gateway;
    const composition = createHealthComposition(configFor(makeDir()), {
      reporting: {
        version: "v1beta1",
        vitals: {} as VitalsResourceLike,
      } as unknown as PlayReportingClient,
      comparisonGateway: gateway,
    });

    expect(composition.registry.list().map((tool) => tool.name)).toEqual([
      "health.get_crash_rate",
      "health.get_anr_rate",
      "health.get_excessive_wakeups",
      HEALTH_COMPARISON_TOOL_NAME,
    ]);
    const tool = composition.registry.get(HEALTH_COMPARISON_TOOL_NAME);
    expect(tool.permission).toBe("read");
    expect(tool.verify).toBeUndefined();
    expect(composition.comparisonTool?.binding.toolName).toBe(HEALTH_COMPARISON_TOOL_NAME);
  });

  it("fetches both windows once per kind, renders a deterministic summary and audits safely", async () => {
    const fake = fakeGateway();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { result, dir } = await runComparison(fake.gateway);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, code: "COMPLETED", externalStateUncertain: false });
    expect(result.finalContent).toBe("Comparison ready.");

    // Deterministic Reporting cost: two bounded 5.1 fetch sequences per kind
    // (current + baseline), each with its own metric-set read → 6 reads + 6 queries.
    expect(fake.calls.filter((call) => call.endsWith(":read"))).toHaveLength(6);
    expect(fake.calls.filter((call) => call.endsWith(":query:current"))).toHaveLength(3);
    expect(fake.calls.filter((call) => call.endsWith(":query:baseline"))).toHaveLength(3);

    const payload = toolPayload(result);
    expect(payload.comparison.kinds).toEqual(["crash_rate", "anr_rate", "excessive_wakeup_rate"]);
    expect(payload.comparison.sections).toHaveLength(3);
    expect(payload.summary).toContain("App Health baseline comparison (DAILY)");
    expect(payload.summary).toContain("baseline 0.0123 → current 0.0155");
    expect(payload.summary).toContain("Crash rate — crashRate");
    expect(payload.summary).toContain("ANR rate — anrRate");
    expect(payload.summary).toContain("Excessive wakeups — excessiveWakeupRate");
    expect(payload.summary).not.toContain(RAW_MARKER);
    expect(payload.summary).not.toContain(SECRET_MARKER);

    // Running the same comparison again yields byte-identical output.
    const replay = await runComparison(fakeGateway().gateway);
    expect(toolPayload(replay.result).summary).toBe(payload.summary);

    const audit = readAuditEntries(join(dir, "audit.jsonl"));
    expect(audit.some((entry) => entry.type.startsWith("approval."))).toBe(false);
    expect(audit).toContainEqual(
      expect.objectContaining({
        type: "verification.completed",
        status: "success",
        metadata: expect.objectContaining({
          toolName: HEALTH_COMPARISON_TOOL_NAME,
          permission: "read",
          required: false,
          code: "VERIFICATION_SKIPPED",
        }),
      }),
    );
    expect(JSON.stringify(audit)).not.toContain(RAW_MARKER);
    expect(JSON.stringify(audit)).not.toContain(SECRET_MARKER);
    expect(JSON.stringify(audit)).not.toContain("0.0155");
  });

  it("compares one explicitly requested kind when asked", async () => {
    const fake = fakeGateway();
    const { result } = await runComparison(fake.gateway, { ...VALID_ARGS, kinds: ["crash_rate"] });

    const payload = toolPayload(result);
    expect(payload.comparison.kinds).toEqual(["crash_rate"]);
    expect(fake.calls.filter((call) => call.endsWith(":query:baseline"))).toHaveLength(1);
  });

  it("fails closed with no partial summary when one window's source fails", async () => {
    const fake = fakeGateway({ failBaselineQuery: true });
    const { result, dir } = await runComparison(fake.gateway);

    expect(result).toMatchObject({ ok: false, code: "EXECUTION_FAILED" });
    expect(result.cause).toMatchObject({ code: "SOURCE_FAILED" });
    expect(result.conversation.some((entry) => entry.role === "tool")).toBe(false);
    const auditJson = JSON.stringify(readAuditEntries(join(dir, "audit.jsonl")));
    expect(auditJson).not.toContain(SECRET_MARKER);
    expect(auditJson).not.toContain("summary");
  });

  it("rejects incompatible or malformed input before any Reporting call", async () => {
    const cases: Record<string, unknown>[] = [
      {
        ...VALID_ARGS,
        baseline: { startTime: "2026-09-22T07:00:00Z", endTime: "2026-09-24T07:00:00Z" },
      },
      {
        ...VALID_ARGS,
        current: { startTime: "2026-09-24T00:00:00Z", endTime: "2026-09-25T07:00:00Z" },
      },
      { ...VALID_ARGS, kinds: ["not_a_kind"] },
      { ...VALID_ARGS, kinds: [] },
      { ...VALID_ARGS, metrics: ["anrRate"] },
      {
        ...VALID_ARGS,
        current: { startTime: "2026-09-24T07:00:00Z", endTime: "2026-09-24T07:00:00Z" },
      },
      { ...VALID_ARGS, packageName: "com.attacker.app" },
      { ...VALID_ARGS, current: { startTime: "2026-09-24T07:00:00Z" } },
    ];

    for (const args of cases) {
      const fake = fakeGateway();
      const { result } = await runComparison(fake.gateway, args);
      expect(result).toMatchObject({ ok: false, code: "INPUT_INVALID" });
      expect(fake.calls).toEqual([]);
    }
  });
});

describe("Phase 5.2 through the real Phase 5.1 fetcher and production Reporting adapter", () => {
  function fakeReportingClient(): {
    readonly client: PlayReportingClient;
    readonly calls: string[];
  } {
    const calls: string[] = [];
    const makeGet = (operation: string, suffix: string) => (): Promise<{ data: unknown }> => {
      calls.push(operation);
      return Promise.resolve({
        data: {
          name: `apps/${PKG}/${suffix}`,
          freshnessInfo: {
            freshnesses: [
              { aggregationPeriod: "DAILY", latestEndTime: { year: 2026, month: 10, day: 1 } },
            ],
          },
          [RAW_MARKER]: RAW_MARKER,
        } as unknown,
      });
    };
    const makeQuery =
      (operation: string) =>
      (params: unknown): Promise<{ data: unknown }> => {
        calls.push(operation);
        const requestBody = (
          params as {
            requestBody?: { timelineSpec?: { startTime?: { day?: number } }; metrics?: string[] };
          }
        ).requestBody;
        const current = requestBody?.timelineSpec?.startTime?.day === 24;
        const metrics = requestBody?.metrics ?? [];
        return Promise.resolve({
          data: {
            rows: [
              {
                aggregationPeriod: "DAILY",
                startTime: {
                  year: 2026,
                  month: 9,
                  day: current ? 24 : 23,
                  timeZone: { id: "America/Los_Angeles" },
                },
                dimensions: [],
                metrics: metrics.map((metric) => ({
                  metric,
                  decimalValue: {
                    value:
                      metric === "distinctUsers"
                        ? current
                          ? "15000"
                          : "12000"
                        : current
                          ? "0.0155"
                          : "0.0123",
                  },
                })),
                [RAW_MARKER]: RAW_MARKER,
                privateKey: SECRET_MARKER,
              },
            ],
            nextPageToken: null,
          } as unknown,
        });
      };

    const resource: VitalsResourceLike = {
      anrrate: {
        get: makeGet(
          "vitals.anrrate.get",
          "anrRateMetricSet",
        ) as VitalsResourceLike["anrrate"]["get"],
        query: makeQuery("vitals.anrrate.query") as VitalsResourceLike["anrrate"]["query"],
      },
      crashrate: {
        get: makeGet(
          "vitals.crashrate.get",
          "crashRateMetricSet",
        ) as VitalsResourceLike["crashrate"]["get"],
        query: makeQuery("vitals.crashrate.query") as VitalsResourceLike["crashrate"]["query"],
      },
      excessivewakeuprate: {
        get: makeGet(
          "vitals.excessivewakeuprate.get",
          "excessiveWakeupRateMetricSet",
        ) as VitalsResourceLike["excessivewakeuprate"]["get"],
        query: makeQuery(
          "vitals.excessivewakeuprate.query",
        ) as VitalsResourceLike["excessivewakeuprate"]["query"],
      },
    };
    return { client: { version: "v1beta1", vitals: resource }, calls };
  }

  it("compares current and baseline through the production adapter for every kind", async () => {
    const fake = fakeReportingClient();
    const dir = makeDir();
    const composition = createHealthComposition(configFor(dir), { reporting: fake.client });
    const result = await runAgent({
      llm: llmFor({ ...VALID_ARGS }),
      registry: composition.registry,
      bindings: composition.bindings,
      messages: [{ role: "user", content: "Compare health metrics to the baseline." }],
      limits: { maxSteps: 3, maxToolCalls: 1, maxTotalTokens: 10 },
      ledger: composition.ledger,
      runId: () => "phase52-adapter-run",
    });

    expect(result).toMatchObject({ ok: true, code: "COMPLETED" });
    const payload = toolPayload(result);
    expect(payload.comparison.kinds).toHaveLength(3);
    expect(payload.summary).toContain("baseline 0.0123 → current 0.0155");
    expect(payload.summary).not.toContain(RAW_MARKER);
    expect(payload.summary).not.toContain(SECRET_MARKER);

    // Both windows hit the real 5.1 wrapper for each kind: 3 gets + 6 queries.
    expect(fake.calls.filter((call) => call.endsWith(".get"))).toHaveLength(6);
    expect(fake.calls.filter((call) => call.endsWith(".query"))).toHaveLength(6);

    const audit = readAuditEntries(join(dir, "audit.jsonl"));
    expect(JSON.stringify(audit)).not.toContain(RAW_MARKER);
    expect(JSON.stringify(audit)).not.toContain(SECRET_MARKER);
  });
});

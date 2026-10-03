/** Real Phase 2 permission/run/audit + real Reporting adapter over a fake generated client. */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAuditEntries } from "../src/audit/log.js";
import { createHealthThresholdTool } from "../src/health/threshold-tool.js";
import { ToolRegistry } from "../src/runtime/tools/index.js";
import { DEFAULT_CONFIG, type PlayOpsConfig } from "../src/config/index.js";
import { createHealthComposition, createLiveHealthComposition } from "../src/health/composition.js";
import {
  HEALTH_METRIC_KINDS,
  HEALTH_METRIC_SPECS,
  type HealthMetricKind,
} from "../src/health/index.js";
import { HEALTH_THRESHOLDS_TOOL_NAME } from "../src/health/thresholds.js";
import type {
  MetricsRow,
  PlayReportingClient,
  VitalsResourceLike,
} from "../src/googleplay/reporting/index.js";
import { evaluateToolPermission } from "../src/runtime/permissions/index.js";
import { runAgent } from "../src/runtime/agent/index.js";
import type { LlmAdapter } from "../src/runtime/llm/index.js";
import { THRESHOLD_QUERY, thresholdConfig } from "./fixtures/health/thresholds.fake.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function configFor(
  health = thresholdConfig({
    crashRateReportedThreshold: "0.010000000000000000001",
    anrRateReportedThreshold: "0.010000000000000000001",
    excessiveWakeupRateReportedThreshold: "0.010000000000000000001",
  }),
): PlayOpsConfig {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-phase54-runtime-"));
  dirs.push(dir);
  return {
    ...DEFAULT_CONFIG,
    googlePlay: {
      packageName: "com.example.phase54",
      serviceAccountJson: "FAKE-UNREAD-CREDENTIAL-PATH",
    },
    audit: { logPath: join(dir, "audit.jsonl") },
    health,
  };
}
function fakeClient(values: Partial<Record<HealthMetricKind, string>> = {}) {
  const calls: string[] = [];
  function resource(kind: HealthMetricKind) {
    return {
      get: vi.fn(async (params: { name: string }) => {
        calls.push(`${kind}.get`);
        return { data: { name: params.name } };
      }),
      query: vi.fn(async (params: Parameters<VitalsResourceLike["crashrate"]["query"]>[0]) => {
        calls.push(`${kind}.query`);
        const timeline = params.requestBody.timelineSpec;
        if (!timeline?.startTime) throw new Error("Fake requires a real adapter timeline");
        const row: MetricsRow = {
          aggregationPeriod: timeline.aggregationPeriod,
          startTime: {
            ...timeline.startTime,
            timeZone: timeline.startTime.timeZone ?? { id: "America/Los_Angeles" },
          },
          dimensions: [],
          metrics: [
            {
              metric: HEALTH_METRIC_SPECS[kind].primaryMetric,
              decimalValue: { value: values[kind] ?? "0.010000000000000000002" },
            },
          ],
        };
        return { data: { rows: [row] } };
      }),
    };
  }
  const vitals = {
    crashrate: resource("crash_rate"),
    anrrate: resource("anr_rate"),
    excessivewakeuprate: resource("excessive_wakeup_rate"),
  };
  const reporting: PlayReportingClient = { version: "v1beta1", vitals };
  return { reporting, calls, vitals };
}
function llmFor(args: unknown = THRESHOLD_QUERY): LlmAdapter {
  let step = 0;
  return {
    provider: "scripted-fake",
    async complete() {
      step += 1;
      return step === 1
        ? {
            toolCalls: [
              { id: "threshold-call", name: HEALTH_THRESHOLDS_TOOL_NAME, arguments: args },
            ],
            usage: { totalTokens: 1 },
          }
        : { toolCalls: [], content: "Threshold check finished.", usage: { totalTokens: 1 } };
    },
  };
}
async function execute(
  config: PlayOpsConfig,
  fake: ReturnType<typeof fakeClient>,
  args: unknown = THRESHOLD_QUERY,
) {
  const composition = createHealthComposition(config, { reporting: fake.reporting });
  const approve = vi.fn();
  const result = await runAgent({
    llm: llmFor(args),
    registry: composition.registry,
    bindings: composition.bindings,
    messages: [{ role: "user", content: "Check configured health thresholds." }],
    limits: { maxSteps: 3, maxToolCalls: 1, maxTotalTokens: 10 },
    ledger: composition.ledger,
    approvalResolver: { resolve: approve },
    runId: () => "phase54-fake-run",
  });
  return { composition, result, approve, audit: readAuditEntries(config.audit.logPath) };
}

describe("Phase 5.4 production adapter mock and Phase 2 integration", () => {
  it("registers one separate read capability without approval or verifier", () => {
    const composition = createHealthComposition(configFor(), { reporting: fakeClient().reporting });
    expect(composition.registry.has(HEALTH_THRESHOLDS_TOOL_NAME)).toBe(true);
    expect(composition.registry.list()).toHaveLength(5);
    const tool = composition.registry.get(HEALTH_THRESHOLDS_TOOL_NAME);
    expect(evaluateToolPermission(tool)).toMatchObject({
      allowed: true,
      permission: "read",
      requiresApproval: false,
    });
    expect(tool.verify).toBeUndefined();
    expect(
      composition.bindings.find((entry) => entry.toolName === HEALTH_THRESHOLDS_TOOL_NAME)
        ?.approval,
    ).toBeUndefined();
  });

  it("real runtime fetches once per enabled kind and records three exact ordered alerts", async () => {
    const config = configFor();
    const fake = fakeClient();
    const network = vi.spyOn(globalThis, "fetch");
    const { result, approve, audit } = await execute(config, fake);
    expect(result).toMatchObject({ ok: true, code: "COMPLETED", externalStateUncertain: false });
    expect(approve).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(fake.calls).toEqual(
      HEALTH_METRIC_KINDS.flatMap((kind) => [`${kind}.get`, `${kind}.query`]),
    );
    for (const kind of HEALTH_METRIC_KINDS) {
      const resource =
        kind === "crash_rate"
          ? fake.vitals.crashrate
          : kind === "anr_rate"
            ? fake.vitals.anrrate
            : fake.vitals.excessivewakeuprate;
      expect(resource.query).toHaveBeenCalledWith(
        expect.objectContaining({
          name: `apps/com.example.phase54/${HEALTH_METRIC_SPECS[kind].metricSetSuffix}`,
          requestBody: expect.objectContaining({
            metrics: [HEALTH_METRIC_SPECS[kind].primaryMetric],
          }),
        }),
        { retry: false },
      );
    }
    const alerts = audit.filter((entry) => entry.type === "health.threshold.alert");
    expect(alerts.map((entry) => entry.metadata?.metricKind)).toEqual(HEALTH_METRIC_KINDS);
    expect(alerts).toHaveLength(3);
    expect(alerts[0]?.metadata).toMatchObject({
      observedValue: "0.010000000000000000002",
      thresholdValue: "0.010000000000000000001",
      result: "BREACHED",
    });
    expect(audit.some((entry) => entry.type.startsWith("approval."))).toBe(false);
    expect(audit).toContainEqual(
      expect.objectContaining({
        type: "verification.completed",
        metadata: expect.objectContaining({
          code: "VERIFICATION_SKIPPED",
          permission: "read",
          required: false,
        }),
      }),
    );
    expect(audit).toContainEqual(
      expect.objectContaining({ type: "agent.tool.execution.completed", status: "success" }),
    );
    const payload = JSON.parse(
      result.conversation.find((entry) => entry.role === "tool")?.content ?? "null",
    );
    expect(payload).toMatchObject({
      status: "EVALUATED",
      evaluatedPointCount: 3,
      breachedPointCount: 3,
      recordedAlertCount: 3,
    });
    expect(JSON.stringify(payload)).not.toContain("0.010000000000000000001");
    expect(JSON.stringify(audit)).not.toContain("FAKE-UNREAD-CREDENTIAL-PATH");
  });

  it("startup rejects typed legacy health fields before credentials/auth/client creation", async () => {
    const config = configFor();
    const loadCredentials = vi.fn();
    const authenticate = vi.fn();
    const createReporting = vi.fn();
    config.health = { crashRateThreshold: 0.01 } as unknown as PlayOpsConfig["health"];
    await expect(
      createLiveHealthComposition({
        loadConfig: () => config,
        loadCredentials,
        authenticate,
        createReporting,
      }),
    ).rejects.toMatchObject({ code: "CONFIG_MIGRATION_REQUIRED" });
    expect(loadCredentials).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
    expect(createReporting).not.toHaveBeenCalled();
  });

  it("equal/below results create no alert while normal read execution audit remains", async () => {
    const config = configFor();
    const fake = fakeClient({
      crash_rate: "0.010000000000000000001",
      anr_rate: "0",
      excessive_wakeup_rate: "0.009999999999999999999",
    });
    const { result, audit } = await execute(config, fake);
    expect(result).toMatchObject({ ok: true, code: "COMPLETED", externalStateUncertain: false });
    expect(audit.filter((entry) => entry.type === "health.threshold.alert")).toHaveLength(0);
    expect(audit.some((entry) => entry.type === "agent.tool.execution.completed")).toBe(true);
    expect(
      JSON.parse(result.conversation.find((entry) => entry.role === "tool")?.content ?? "null"),
    ).toMatchObject({ evaluatedPointCount: 3, recordedAlertCount: 0 });
  });

  it("disabled defaults produce no Reporting access but retain normal runtime audit", async () => {
    const config = configFor(thresholdConfig());
    const fake = fakeClient();
    const { result, audit } = await execute(config, fake);
    expect(result).toMatchObject({ ok: true, code: "COMPLETED" });
    expect(fake.calls).toEqual([]);
    expect(audit.filter((entry) => entry.type === "health.threshold.alert")).toEqual([]);
    expect(
      JSON.parse(result.conversation.find((entry) => entry.role === "tool")?.content ?? "null"),
    ).toMatchObject({ status: "DISABLED", enabledRuleCount: 0, recordedAlertCount: 0 });
  });

  it("fetches only the enabled ANR rule and never implicitly enables crash/wakeups", async () => {
    const config = configFor(thresholdConfig({ anrRateReportedThreshold: "0.01" }));
    const fake = fakeClient();
    const { result, audit } = await execute(config, fake);
    expect(result.ok).toBe(true);
    expect(fake.calls).toEqual(["anr_rate.get", "anr_rate.query"]);
    expect(
      audit
        .filter((entry) => entry.type === "health.threshold.alert")
        .map((entry) => entry.metadata?.metricName),
    ).toEqual(["anrRate"]);
  });

  it("empty adapter data remains a successful NO_DATA check without alerts", async () => {
    const config = configFor(thresholdConfig({ crashRateReportedThreshold: "0" }));
    const fake = fakeClient();
    fake.vitals.crashrate.query.mockResolvedValue({ data: { rows: [] } });
    const { result, audit } = await execute(config, fake);
    expect(result.ok).toBe(true);
    expect(audit.filter((entry) => entry.type === "health.threshold.alert")).toEqual([]);
    expect(
      JSON.parse(result.conversation.find((entry) => entry.role === "tool")?.content ?? "null"),
    ).toMatchObject({ status: "NO_DATA", evaluatedPointCount: 0, recordedAlertCount: 0 });
  });

  it("source failure after an earlier breached kind records only safe failure audit", async () => {
    const config = configFor();
    const fake = fakeClient();
    fake.vitals.anrrate.query.mockRejectedValue(new Error("RAW-REPORTING-ERROR-MARKER"));
    const { result, audit } = await execute(config, fake);
    expect(result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: false,
    });
    expect(result.cause).toMatchObject({ code: "SOURCE_FAILED" });
    expect(result.conversation.some((entry) => entry.role === "tool")).toBe(false);
    expect(audit.filter((entry) => entry.type === "health.threshold.alert")).toEqual([]);
    expect(audit.some((entry) => entry.type === "agent.tool.execution.failed")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("RAW-REPORTING-ERROR-MARKER");
  });

  it.each(["thresholds", "metrics", "packageName", "credentials"])(
    "real runtime denies caller %s before Reporting",
    async (field) => {
      const config = configFor();
      const fake = fakeClient();
      const { result, audit } = await execute(config, fake, {
        ...THRESHOLD_QUERY,
        [field]: "RAW-CALLER-MARKER",
      });
      expect(result).toMatchObject({ ok: false, code: "INPUT_INVALID" });
      expect(fake.calls).toEqual([]);
      expect(audit.filter((entry) => entry.type === "health.threshold.alert")).toEqual([]);
      expect(JSON.stringify(audit)).not.toContain("RAW-CALLER-MARKER");
    },
  );

  it("invalid new threshold also fails startup before credential access", async () => {
    const config = configFor(thresholdConfig({ crashRateReportedThreshold: "-1" }));
    const loadCredentials = vi.fn();
    await expect(
      createLiveHealthComposition({ loadConfig: () => config, loadCredentials }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID_VALUE" });
    expect(loadCredentials).not.toHaveBeenCalled();
  });

  it("evaluator duplicate failure through the production adapter records zero alerts", async () => {
    const config = configFor();
    const fake = fakeClient();
    const row: MetricsRow = {
      aggregationPeriod: "DAILY",
      startTime: { year: 2026, month: 9, day: 23, timeZone: { id: "America/Los_Angeles" } },
      dimensions: [],
      metrics: [{ metric: "crashRate", decimalValue: { value: "2" } }],
    };
    fake.vitals.crashrate.query.mockResolvedValue({ data: { rows: [row, structuredClone(row)] } });
    const { result, audit } = await execute(config, fake);
    expect(result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: false,
    });
    expect(result.cause).toMatchObject({ code: "DUPLICATE_IDENTITY" });
    expect(audit.filter((entry) => entry.type === "health.threshold.alert")).toEqual([]);
    expect(audit.some((entry) => entry.type === "agent.tool.execution.failed")).toBe(true);
  });

  it("required alert append failure fails the real runtime with safe ordinary failure audit", async () => {
    const config = configFor();
    const ledger = createHealthComposition(config, { reporting: fakeClient().reporting }).ledger;
    const append = vi.fn(() => {
      throw new Error("RAW-ALERT-AUDIT-ERROR");
    });
    const capability = createHealthThresholdTool({
      health: config.health,
      auditLogPath: config.audit.logPath,
      appendAlert: append,
      gateway: {
        readMetricSet: async () => ({}),
        queryMetricSet: async (kind, request) => ({
          rows: [
            {
              aggregationPeriod: "DAILY",
              startTime: {
                ...request.timelineSpec.startTime,
                timeZone: { id: "America/Los_Angeles" },
              },
              dimensions: [],
              metrics: [
                { metric: HEALTH_METRIC_SPECS[kind].primaryMetric, decimalValue: { value: "2" } },
              ],
            },
          ],
        }),
      },
    });
    const registry = new ToolRegistry();
    registry.register(capability.tool);
    const result = await runAgent({
      llm: llmFor(),
      registry,
      bindings: [capability.binding],
      messages: [{ role: "user", content: "Synthetic audit failure check." }],
      limits: { maxSteps: 3, maxToolCalls: 1, maxTotalTokens: 10 },
      ledger,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: false,
    });
    expect(result.cause).toMatchObject({ code: "ALERT_AUDIT_FAILED" });
    expect(append).toHaveBeenCalledTimes(1);
    const audit = readAuditEntries(config.audit.logPath);
    expect(audit.filter((entry) => entry.type === "health.threshold.alert")).toEqual([]);
    expect(audit.some((entry) => entry.type === "agent.tool.execution.completed")).toBe(false);
    expect(JSON.stringify(audit)).not.toContain("RAW-ALERT-AUDIT-ERROR");
  });
});

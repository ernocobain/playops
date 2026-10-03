import { describe, expect, it } from "vitest";
import { buildHealthThresholdRules, evaluateHealthThresholds } from "../src/health/thresholds.js";
import type { HealthThresholdRule } from "../src/health/thresholds.js";
import {
  HealthError,
  HEALTH_METRIC_KINDS,
  HEALTH_METRIC_SPECS,
  type HealthMetricPoint,
} from "../src/health/index.js";
import {
  THRESHOLD_START,
  THRESHOLD_NEXT,
  THRESHOLD_END,
  thresholdConfig,
  thresholdPoint,
  thresholdSeries,
} from "./fixtures/health/thresholds.fake.js";

describe("pure reported-scale threshold evaluator", () => {
  it("breaches only when the exact primary value is greater", () => {
    const rules = buildHealthThresholdRules(
      thresholdConfig({ crashRateReportedThreshold: "0.010000000000000000001" }),
    );
    const point = thresholdPoint("crash_rate", "0.010000000000000000002");
    const result = evaluateHealthThresholds([thresholdSeries("crash_rate", [point])], rules);
    expect(result.status).toBe("EVALUATED");
    expect(result.evaluatedPointCount).toBe(1);
    expect(result.breaches).toHaveLength(1);
    expect(result.breaches[0]).toMatchObject({
      metricKind: "crash_rate",
      metricName: "crashRate",
      observedValue: "0.010000000000000000002",
      thresholdValue: "0.010000000000000000001",
      operator: ">",
      status: "BREACHED",
    });
  });

  it.each([
    ["0.009999999999999999999", "NOT_BREACHED"],
    ["0.010000000000000000001", "NOT_BREACHED"],
    ["0.010000000000000000002", "BREACHED"],
    ["0", "NOT_BREACHED"],
  ] as const)("observed %s gives %s with a high-precision boundary", (value, status) => {
    const rules = buildHealthThresholdRules(
      thresholdConfig({ crashRateReportedThreshold: "0.010000000000000000001" }),
    );
    const result = evaluateHealthThresholds(
      [thresholdSeries("crash_rate", [thresholdPoint("crash_rate", value)])],
      rules,
    );
    expect(result.evaluations[0]?.status).toBe(status);
    expect(result.breaches).toHaveLength(status === "BREACHED" ? 1 : 0);
  });

  it.each([
    ["1e-500", "1E-500", "NOT_BREACHED"],
    ["1e-500", "2e-500", "BREACHED"],
    ["9007199254740993.000000000000001", "9007199254740993.000000000000002", "BREACHED"],
    ["0", "0.000000000000000000000000000001", "BREACHED"],
    ["1", "0.01", "NOT_BREACHED"],
    ["0.01", "1", "BREACHED"],
  ] as const)(
    "exact reported-scale %s vs observed %s gives %s without scaling",
    (threshold, observed, status) => {
      const result = evaluateHealthThresholds(
        [thresholdSeries("crash_rate", [thresholdPoint("crash_rate", observed)])],
        buildHealthThresholdRules(thresholdConfig({ crashRateReportedThreshold: threshold })),
      );
      expect(result.evaluations[0]).toMatchObject({
        observedValue: observed,
        thresholdValue: threshold,
        status,
      });
      expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
    },
  );

  it("binds exactly three primary metrics in configuration order", () => {
    const rules = buildHealthThresholdRules(
      thresholdConfig({
        crashRateReportedThreshold: "1",
        anrRateReportedThreshold: "2",
        excessiveWakeupRateReportedThreshold: "3",
      }),
    );
    expect(rules).toEqual([
      {
        metricKind: "crash_rate",
        metricName: "crashRate",
        configField: "crashRateReportedThreshold",
        thresholdValue: "1",
        operator: ">",
      },
      {
        metricKind: "anr_rate",
        metricName: "anrRate",
        configField: "anrRateReportedThreshold",
        thresholdValue: "2",
        operator: ">",
      },
      {
        metricKind: "excessive_wakeup_rate",
        metricName: "excessiveWakeupRate",
        configField: "excessiveWakeupRateReportedThreshold",
        thresholdValue: "3",
        operator: ">",
      },
    ]);
  });

  it.each(HEALTH_METRIC_KINDS)("can breach %s independently", (kind) => {
    const rules = buildHealthThresholdRules(
      thresholdConfig({
        crashRateReportedThreshold: "1",
        anrRateReportedThreshold: "1",
        excessiveWakeupRateReportedThreshold: "1",
      }),
    );
    const result = evaluateHealthThresholds(
      [thresholdSeries(kind, [thresholdPoint(kind, "1.000000000000001")])],
      rules,
    );
    expect(result.breaches).toHaveLength(1);
    expect(result.breaches[0]?.metricName).toBe(HEALTH_METRIC_SPECS[kind].primaryMetric);
  });

  it("all three breach and order does not depend on input series/rule traversal", () => {
    const rules = buildHealthThresholdRules(
      thresholdConfig({
        crashRateReportedThreshold: "1",
        anrRateReportedThreshold: "1",
        excessiveWakeupRateReportedThreshold: "1",
      }),
    );
    const data = HEALTH_METRIC_KINDS.map((kind) =>
      thresholdSeries(kind, [thresholdPoint(kind, "2")]),
    );
    const normal = evaluateHealthThresholds(data, rules);
    const reversed = evaluateHealthThresholds([...data].reverse(), [...rules].reverse());
    expect(normal.breaches.map((entry) => entry.metricKind)).toEqual(HEALTH_METRIC_KINDS);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(normal));
  });

  it("no rules means DISABLED, not no-data or breach", () => {
    expect(buildHealthThresholdRules(thresholdConfig())).toEqual([]);
    expect(evaluateHealthThresholds([], [])).toEqual({
      status: "DISABLED",
      enabledRuleCount: 0,
      evaluatedPointCount: 0,
      noDataCount: 0,
      evaluations: [],
      breaches: [],
    });
  });

  it("empty or missing kind data is explicit NO_DATA, never zero", () => {
    const rules = buildHealthThresholdRules(thresholdConfig({ crashRateReportedThreshold: "0" }));
    for (const data of [[], [thresholdSeries("crash_rate", [])]]) {
      const result = evaluateHealthThresholds(data, rules);
      expect(result.status).toBe("NO_DATA");
      expect(result.evaluatedPointCount).toBe(0);
      expect(result.breaches).toEqual([]);
      expect(result.evaluations[0]).toMatchObject({
        status: "NO_DATA",
        observedValue: null,
        startTimeUtc: null,
      });
    }
  });

  it.each([
    "distinctUsers",
    "crashRate7dUserWeighted",
    "crashRate28dUserWeighted",
    "userPerceivedCrashRate",
    "userPerceivedCrashRate7dUserWeighted",
    "userPerceivedCrashRate28dUserWeighted",
  ] as const)("never applies a crash threshold to %s", (metric) => {
    const point = thresholdPoint("crash_rate", null, {
      metrics: [
        {
          metric,
          value: "9999999999999999",
          unit: metric === "distinctUsers" ? "count" : "percent",
        },
      ],
    });
    const result = evaluateHealthThresholds(
      [thresholdSeries("crash_rate", [point])],
      buildHealthThresholdRules(thresholdConfig({ crashRateReportedThreshold: "0" })),
    );
    expect(result.status).toBe("NO_DATA");
    expect(result.breaches).toEqual([]);
    expect(result.evaluations[0]?.observedValue).toBeNull();
  });

  it("evaluates each period independently and never averages", () => {
    const points = [
      thresholdPoint("crash_rate", "0", { startTimeUtc: THRESHOLD_NEXT }),
      thresholdPoint("crash_rate", "10"),
    ];
    const result = evaluateHealthThresholds(
      [thresholdSeries("crash_rate", points)],
      buildHealthThresholdRules(thresholdConfig({ crashRateReportedThreshold: "6" })),
    );
    expect(
      result.evaluations.map((entry) => [entry.startTimeUtc, entry.observedValue, entry.status]),
    ).toEqual([
      [THRESHOLD_START, "10", "BREACHED"],
      [THRESHOLD_NEXT, "0", "NOT_BREACHED"],
    ]);
  });

  it("sorts normalized dimension identities canonically and preserves int64 text", () => {
    const dimensions = (country: string) => [
      { name: "versionCode" as const, value: "900719925474099312345", valueType: "int64" as const },
      { name: "countryCode" as const, value: country, valueType: "string" as const },
    ];
    const a = thresholdPoint("crash_rate", "2", { dimensions: dimensions("US") });
    const b = thresholdPoint("crash_rate", "3", { dimensions: [...dimensions("CA")].reverse() });
    const rules = buildHealthThresholdRules(thresholdConfig({ crashRateReportedThreshold: "1" }));
    const first = evaluateHealthThresholds(
      [thresholdSeries("crash_rate", [a, b], { dimensions: ["versionCode", "countryCode"] })],
      rules,
    );
    const second = evaluateHealthThresholds(
      [thresholdSeries("crash_rate", [b, a], { dimensions: ["countryCode", "versionCode"] })],
      rules,
    );
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.breaches).toHaveLength(2);
    expect(first.breaches[0]?.dimensions.map((entry) => entry.name)).toEqual([
      "countryCode",
      "versionCode",
    ]);
    expect(first.breaches[0]?.dimensions[1]?.value).toBe("900719925474099312345");
  });

  it("rejects identical duplicate point identity before returning any breach", () => {
    const point = thresholdPoint("crash_rate", "2");
    const rules = buildHealthThresholdRules(thresholdConfig({ crashRateReportedThreshold: "1" }));
    expect(() =>
      evaluateHealthThresholds(
        [thresholdSeries("crash_rate", [point, structuredClone(point)])],
        rules,
      ),
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_IDENTITY" }));
  });

  it("conflicting values at the same point identity are also rejected", () => {
    const points = [thresholdPoint("crash_rate", "2"), thresholdPoint("crash_rate", "0")];
    expect(() =>
      evaluateHealthThresholds(
        [thresholdSeries("crash_rate", points)],
        buildHealthThresholdRules(thresholdConfig({ crashRateReportedThreshold: "1" })),
      ),
    ).toThrowError(HealthError);
  });

  it("duplicate metric-kind series and duplicate rules fail closed", () => {
    const source = thresholdSeries("crash_rate", [thresholdPoint("crash_rate", "2")]);
    const rules = buildHealthThresholdRules(thresholdConfig({ crashRateReportedThreshold: "1" }));
    expect(() => evaluateHealthThresholds([source, source], rules)).toThrowError(HealthError);
    expect(() => evaluateHealthThresholds([source], [...rules, ...rules])).toThrowError(
      HealthError,
    );
  });

  it.each(["NaN", "Infinity", "-Infinity", "bad", "", "1e-10001", 0.02])(
    "malformed primary %s fails safely",
    (value) => {
      const point = thresholdPoint("crash_rate", value as string);
      expect(() =>
        evaluateHealthThresholds(
          [thresholdSeries("crash_rate", [point])],
          buildHealthThresholdRules(thresholdConfig({ crashRateReportedThreshold: "0" })),
        ),
      ).toThrowError(HealthError);
    },
  );

  it.each([
    { startTimeUtc: THRESHOLD_END },
    { startTimeUtc: "2026-09-22T07:00:00Z" },
    { startTimeUtc: "not-time" },
    { aggregationPeriod: "HOURLY" },
    { dimensions: [{ name: "countryCode", value: "US", valueType: "string" }] },
    { metrics: [{ metric: "anrRate", value: "99", unit: "percent" }] },
    {
      metrics: [
        { metric: "crashRate", value: "2", unit: "percent" },
        { metric: "crashRate", value: "3", unit: "percent" },
      ],
    },
  ])("rejects malformed normalized point %j", (changes) => {
    const point = thresholdPoint("crash_rate", "2", changes as Partial<HealthMetricPoint>);
    expect(() =>
      evaluateHealthThresholds(
        [thresholdSeries("crash_rate", [point])],
        buildHealthThresholdRules(thresholdConfig({ crashRateReportedThreshold: "1" })),
      ),
    ).toThrowError(HealthError);
  });

  it("rejects a forged weighted-metric rule and >= operator", () => {
    const rules = buildHealthThresholdRules(thresholdConfig({ crashRateReportedThreshold: "1" }));
    const source = thresholdSeries("crash_rate", [thresholdPoint("crash_rate", "2")]);
    expect(() =>
      evaluateHealthThresholds(
        [source],
        [{ ...rules[0], metricName: "crashRate7dUserWeighted" } as unknown as HealthThresholdRule],
      ),
    ).toThrowError(HealthError);
    expect(() =>
      evaluateHealthThresholds(
        [source],
        [{ ...rules[0], operator: ">=" } as unknown as HealthThresholdRule],
      ),
    ).toThrowError(HealthError);
  });

  it("does not turn stale freshness into an alert", () => {
    const source = thresholdSeries("crash_rate", [thresholdPoint("crash_rate", "0")], {
      freshness: [{ aggregationPeriod: "DAILY", latestEndTimeUtc: "2020-01-01T08:00:00Z" }],
    });
    expect(
      evaluateHealthThresholds(
        [source],
        buildHealthThresholdRules(thresholdConfig({ crashRateReportedThreshold: "1" })),
      ).breaches,
    ).toEqual([]);
  });

  it("does not mutate inputs and exposes only whitelisted, frozen normalized facts", () => {
    const config = thresholdConfig({ crashRateReportedThreshold: "1" });
    const point = thresholdPoint("crash_rate", "2", {
      dimensions: [
        { name: "countryCode", value: "US", valueType: "string", valueLabel: "RAW-PAYLOAD-MARKER" },
      ],
    });
    const source = thresholdSeries("crash_rate", [point], { dimensions: ["countryCode"] });
    const data = [source];
    const before = JSON.stringify({ config, data });
    const result = evaluateHealthThresholds(data, buildHealthThresholdRules(config));
    expect(JSON.stringify({ config, data })).toBe(before);
    expect(JSON.stringify(result)).not.toContain("RAW-PAYLOAD-MARKER");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.breaches[0]?.dimensions)).toBe(true);
    expect(Object.isFrozen(result.breaches[0]?.window)).toBe(true);
  });

  it.each(HEALTH_METRIC_KINDS)(
    "all secondary metrics of %s are excluded, including weighted/count/user-perceived",
    (kind) => {
      const spec = HEALTH_METRIC_SPECS[kind];
      const metrics = spec.metrics
        .filter((metric) => metric !== spec.primaryMetric)
        .map((metric) => ({
          metric,
          value: "99999999999999",
          unit: metric === "distinctUsers" ? ("count" as const) : ("percent" as const),
        }));
      const point = thresholdPoint(kind, null, { metrics });
      const result = evaluateHealthThresholds(
        [thresholdSeries(kind, [point])],
        buildHealthThresholdRules(
          thresholdConfig({
            crashRateReportedThreshold: "0",
            anrRateReportedThreshold: "0",
            excessiveWakeupRateReportedThreshold: "0",
          }),
        ),
      );
      expect(result.breaches).toEqual([]);
      expect(result.evaluatedPointCount).toBe(0);
      expect(result.status).toBe("NO_DATA");
    },
  );
});

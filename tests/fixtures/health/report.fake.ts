/** Synthetic Phase 5.3 Reporting boundary; never credentials, auth, network or browser. */
import type {
  PlayReportingClient,
  VitalsResourceLike,
} from "../../../src/googleplay/reporting/index.js";
import { DEFAULT_CONFIG } from "../../../src/config/index.js";
import { createHealthComposition } from "../../../src/health/composition.js";
import { HEALTH_METRIC_SPECS, type HealthMetricKind } from "../../../src/health/index.js";
import { dailyRow, rowsFor } from "./comparison.fake.js";

export const REPORT_TIME = "2026-10-03T00:30:45.123Z";
export const REPORT_FILE = "playops-health-report-2026-10-03T00-30-45-123Z.txt";
export const RAW_REPORT_MARKER = "FAKE-RAW-REPORT53-MUST-NOT-LEAK";

export function healthReportArgs(outputDir: string, extra: readonly string[] = []): string[] {
  return [
    "health",
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
    outputDir,
    ...extra,
  ];
}

interface FakeQuery {
  readonly name: string;
  readonly requestBody: {
    readonly metrics: readonly string[];
    readonly dimensions: readonly string[];
    readonly timelineSpec: {
      readonly aggregationPeriod: string;
      readonly startTime: {
        readonly year: number;
        readonly month: number;
        readonly day: number;
        readonly hours?: number;
        readonly timeZone?: { readonly id: string };
      };
      readonly endTime: unknown;
    };
  };
}
export interface FakeReportCall {
  readonly kind: HealthMetricKind;
  readonly method: "get" | "query";
  readonly params: { readonly name: string } | FakeQuery;
  readonly options: unknown;
}

export function fakeReportComposition(
  auditPath: string,
  mode:
    | "normal"
    | "precision"
    | "empty-current"
    | "empty-baseline"
    | "empty-both"
    | "unmatched"
    | "failure"
    | "unsafe" = "normal",
) {
  const calls: FakeReportCall[] = [];
  const resource = (kind: HealthMetricKind) => ({
    async get(params: { readonly name: string }, options?: { readonly retry: false }) {
      calls.push({ kind, method: "get", params, options });
      return {
        data: {
          name: params.name,
          freshnessInfo: {
            freshnesses: [
              { aggregationPeriod: "DAILY", latestEndTime: { year: 2026, month: 9, day: 24 } },
            ],
          },
          privateKey: RAW_REPORT_MARKER,
        },
      };
    },
    async query(params: FakeQuery, options?: { readonly retry: false }) {
      calls.push({ kind, method: "query", params, options });
      const current = params.requestBody.timelineSpec.startTime.day === 24;
      if (mode === "failure" && !current)
        throw Object.assign(new Error(RAW_REPORT_MARKER), { code: 400 });
      if (
        mode === "empty-both" ||
        (mode === "empty-current" && current) ||
        (mode === "empty-baseline" && !current)
      ) {
        return { data: { rows: [] } };
      }
      if (mode === "precision" && kind === "crash_rate") {
        return {
          data: { rows: rowsFor("beyond-js-float-precision", current ? "current" : "baseline") },
        };
      }
      if (mode === "unmatched" && kind === "crash_rate") {
        return {
          data: { rows: rowsFor("current-only-dimension-group", current ? "current" : "baseline") },
        };
      }
      const value =
        kind === "crash_rate"
          ? current
            ? "0.0155"
            : "0.0123"
          : kind === "anr_rate"
            ? current
              ? "0.0024"
              : "0.0020"
            : current
              ? "0.02"
              : "0.05";
      const metricValues = Object.fromEntries(
        params.requestBody.metrics.map((metric) => [
          metric,
          metric === "distinctUsers" ? (current ? "15000" : "12000") : value,
        ]),
      );
      const dimensions = params.requestBody.dimensions.map((name) => ({
        name,
        value: mode === "unsafe" ? "\u001b[31munsafe" : "SYNTHETIC-DIMENSION",
      }));
      const row = dailyRow(current ? 24 : 23, metricValues, dimensions);
      return { data: { rows: [row], privateKey: RAW_REPORT_MARKER } };
    },
  });
  // Fake generated transport only; all production normalization and comparison stay real.
  const vitals = {
    crashrate: resource("crash_rate"),
    anrrate: resource("anr_rate"),
    excessivewakeuprate: resource("excessive_wakeup_rate"),
  } as unknown as VitalsResourceLike;
  const client: PlayReportingClient = { version: "v1beta1", vitals };
  const composition = createHealthComposition(
    {
      ...DEFAULT_CONFIG,
      googlePlay: { packageName: "com.example.report53", serviceAccountJson: "FAKE-NOT-READ" },
      audit: { logPath: auditPath },
    },
    { reporting: client },
  );
  return { calls, client, composition, specs: HEALTH_METRIC_SPECS };
}

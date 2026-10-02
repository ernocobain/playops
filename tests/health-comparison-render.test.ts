/**
 * Phase 5.2 — deterministic renderer tests.
 *
 * The structured comparison is the source of truth; the text is derived from it.
 */
import { describe, expect, it } from "vitest";
import { analyzeHealthComparison, type HealthComparison } from "../src/health/comparison.js";
import {
  normalizeHealthRows,
  validateHealthMetricQuery,
  type HealthMetricSeries,
} from "../src/health/index.js";
import { renderHealthComparison } from "../src/health/render.js";
import {
  FAKE_MARKER,
  rowsFor,
  SCENARIO_FRESHNESS,
  scenarioByName,
} from "./fixtures/health/comparison.fake.js";

function series(name: string, side: "current" | "baseline"): HealthMetricSeries {
  const scenario = scenarioByName(name);
  const window = scenario[side];
  const query = validateHealthMetricQuery({
    kind: scenario.kind,
    granularity: scenario.granularity,
    startTime: window.startTime,
    endTime: window.endTime,
    dimensions: scenario.dimensions,
    metrics: scenario.metrics,
  });
  const points = normalizeHealthRows(rowsFor(name, side), query);
  const latest = (SCENARIO_FRESHNESS[name] ?? SCENARIO_FRESHNESS["default"] ?? [])[0];
  return {
    kind: scenario.kind,
    toolName: query.toolName,
    window: query.window,
    dimensions: query.dimensions,
    metrics: query.metrics,
    freshness:
      latest === undefined
        ? []
        : [{ aggregationPeriod: scenario.granularity, latestEndTimeUtc: latest }],
    points,
    pageCount: 1,
    rowCount: points.length,
  };
}

function render(name: string): string {
  const comparison = analyzeHealthComparison({
    current: [series(name, "current")],
    baseline: [series(name, "baseline")],
  });
  return renderHealthComparison(comparison);
}

function comparisonFor(name: string): HealthComparison {
  return analyzeHealthComparison({
    current: [series(name, "current")],
    baseline: [series(name, "baseline")],
  });
}

describe("Phase 5.2 deterministic summary renderer", () => {
  it("renders a stable, labeled header with current before baseline", () => {
    const text = render("crash-increase");
    const lines = text.split("\n");

    expect(lines[0]).toBe("App Health baseline comparison (DAILY)");
    expect(lines[1]).toBe("Current:  2026-09-24T07:00:00Z → 2026-09-25T07:00:00Z");
    expect(lines[2]).toBe("Baseline: 2026-09-23T07:00:00Z → 2026-09-24T07:00:00Z");
    expect(lines[3]).toBe("Dimensions: none");
    expect(lines[4]).toBe("Totals: 1 compared, 0 unavailable");
    expect(render("crash-increase")).toBe(text);
  });

  it("renders percentage-point language without conflating it with a percentage", () => {
    const text = render("crash-increase");

    expect(text).toContain("baseline 0.0123 → current 0.0155");
    expect(text).toContain("(+0.0032 percentage points; +26.0163% relative)");
    expect(text).toContain("— increased");
    // The absolute change must never be labelled as a plain percentage.
    expect(text).not.toContain("+0.0032%");
    expect(text).not.toContain("0.0032 %");
  });

  it("renders decreases, unchanged values and count units correctly", () => {
    const decrease = render("crash-decrease");
    expect(decrease).toContain("— decreased");
    expect(decrease).toContain("-0.0035 percentage points");

    const unchanged = render("crash-unchanged");
    expect(unchanged).toContain("baseline 0.0123 → current 0.0123");
    expect(unchanged).toContain("(no change)");
    expect(unchanged).toContain("— unchanged");

    const counts = render("current-window-empty");
    expect(counts).toContain("distinctUsers");
    expect(counts).not.toContain("percentage points");
  });

  it("renders unavailable data as unavailable rather than as zero", () => {
    const currentEmpty = render("current-window-empty");
    expect(currentEmpty).toContain("baseline 0.0123 → current (no data) — incomparable");
    expect(currentEmpty).not.toContain("0%");
    expect(currentEmpty).toContain("Totals: 0 compared, 2 unavailable");

    const baselineEmpty = render("baseline-window-empty");
    expect(baselineEmpty).toContain("baseline (no data) → current 0.0155 — incomparable");

    const bothEmpty = render("both-windows-empty");
    expect(bothEmpty).toContain("no data in either window — incomparable");
  });

  it("explains a zero baseline instead of printing an infinite change", () => {
    const text = render("baseline-zero-current-positive");
    expect(text).toContain("baseline 0 → current 0.0012");
    expect(text).toContain("relative change not defined (baseline is 0)");
    expect(text).not.toContain("Infinity");
    expect(text).not.toContain("NaN");

    const both = render("baseline-zero-current-zero");
    expect(both).toContain("(no change; relative change not defined (baseline is 0))");
  });

  it("renders dimension identities and preserves deterministic entry ordering", () => {
    const text = render("multiple-dimension-groups");
    const lines = text.split("\n").filter((line) => line.startsWith("  crashRate "));

    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("[countryCode=ID|versionCode=374]");
    expect(lines[0]).toContain("2026-09-22T07:00:00Z vs 2026-09-24T07:00:00Z:");
    expect(lines[1]).toContain("[countryCode=ID|versionCode=374]");
    expect(lines[1]).toContain("2026-09-23T07:00:00Z vs 2026-09-25T07:00:00Z:");
    expect(lines[2]).toContain("[countryCode=US|versionCode=375]");
    expect(lines[3]).toContain("[countryCode=US|versionCode=375]");

    const unidentified = render("crash-increase");
    expect(unidentified).toContain("crashRate [all]");
  });

  it("states freshness factually without alert language", () => {
    const text = render("freshness-lag");
    expect(text).toContain(
      "freshness: current window extends beyond the latest available DAILY data (2026-09-24T07:00:00Z)",
    );
    expect(render("crash-increase")).not.toContain("freshness:");
  });

  it("never emits severity or alert vocabulary and never leaks raw payloads", () => {
    const texts = [
      render("crash-increase"),
      render("crash-decrease"),
      render("crash-unchanged"),
      render("current-window-empty"),
      render("baseline-window-empty"),
      render("both-windows-empty"),
      render("baseline-zero-current-positive"),
      render("current-only-dimension-group"),
      render("multiple-dimension-groups"),
      render("freshness-lag"),
      render("hourly-multi-period"),
      render("beyond-js-float-precision"),
    ];
    for (const text of texts) {
      expect(text).not.toMatch(
        /critical|warning|alert|severity|anomaly|dangerous|healthy|GOOD|BAD/i,
      );
      expect(text).not.toContain(FAKE_MARKER);
      expect(text).not.toContain("decimalValue");
      expect(text).not.toContain("metricSet");
      expect(text).not.toContain("credential");
    }
  });

  it("renders every section of a multi-kind comparison deterministically", () => {
    const crash = comparisonFor("crash-increase");
    const anr = comparisonFor("anr-increase-multi-period");
    const combined: HealthComparison = {
      ...crash,
      kinds: ["crash_rate", "anr_rate"],
      sections: [...crash.sections, ...anr.sections],
      entryCount: crash.entryCount + anr.entryCount,
      comparedValueCount: crash.comparedValueCount + anr.comparedValueCount,
    };

    const text = renderHealthComparison(combined);
    expect(text).toContain("Crash rate — crashRate");
    expect(text).toContain("ANR rate — anrRate");
    expect(text.indexOf("Crash rate — crashRate")).toBeLessThan(text.indexOf("ANR rate — anrRate"));
    expect(renderHealthComparison(combined)).toBe(text);
  });
});

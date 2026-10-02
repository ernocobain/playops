/**
 * Phase 5.2 — deterministic human-readable renderer.
 *
 * The structured `HealthComparison` is the single source of truth; this module
 * only derives text from it (never the reverse). Output is a pure function of the
 * comparison: identical input yields byte-identical text.
 *
 * Wording policy: factual only. Directions are `increased` / `decreased` /
 * `unchanged` / `incomparable`; a percentage-unit absolute change is always
 * labelled "percentage points" (never "%"), a relative change is labelled
 * "% relative", and a zero baseline is explained instead of printing Infinity.
 * There is no severity, alerting or judgement vocabulary.
 */
import {
  HEALTH_KIND_LABELS,
  type HealthComparison,
  type HealthComparisonEntry,
  type HealthComparisonSection,
  type HealthComparisonValue,
} from "./comparison.js";

function identityLabel(entry: HealthComparisonEntry): string {
  return entry.dimensionKey === "" ? "[all]" : `[${entry.dimensionKey}]`;
}

function periodLabel(entry: HealthComparisonEntry): string {
  if (entry.periodIndex === null) return "";
  return `${entry.baselineStartTimeUtc ?? "(no data)"} vs ${entry.currentStartTimeUtc ?? "(no data)"}: `;
}

function deltaText(value: HealthComparisonValue): string {
  if (value.direction === "incomparable") return "";
  const unitNoun = value.unit === "percent" ? "percentage points" : "absolute change";
  const parts: string[] = [];
  if (value.direction === "unchanged") {
    parts.push("no change");
  } else {
    const absolute = value.absoluteDelta ?? "";
    const signed = absolute.startsWith("-") ? absolute : `+${absolute}`;
    parts.push(`${signed} ${unitNoun}`);
  }
  if (value.relativeDeltaPercent === undefined) {
    parts.push("relative change not defined (baseline is 0)");
  } else if (value.direction !== "unchanged") {
    parts.push(`${value.relativeDeltaPercent}% relative`);
  }
  return ` (${parts.join("; ")})`;
}

function valueLine(entry: HealthComparisonEntry, value: HealthComparisonValue): string {
  const prefix = `  ${value.metric} ${identityLabel(entry)} ${periodLabel(entry)}`;
  if (value.direction === "incomparable") {
    if (value.reason === "both-unavailable") {
      return `${prefix}no data in either window — incomparable`;
    }
    const baselinePart =
      value.baselineValue === undefined ? "baseline (no data)" : `baseline ${value.baselineValue}`;
    const currentPart =
      value.currentValue === undefined ? "current (no data)" : `current ${value.currentValue}`;
    return `${prefix}${baselinePart} → ${currentPart} — incomparable`;
  }
  return `${prefix}baseline ${value.baselineValue} → current ${value.currentValue}${deltaText(
    value,
  )} — ${value.direction}`;
}

function sectionLines(section: HealthComparisonSection): string[] {
  const lines: string[] = [
    "",
    `${HEALTH_KIND_LABELS[section.kind]} — ${section.metrics.join(", ")}`,
  ];
  const latestForPeriod = section.freshness.find(
    (entry) => entry.aggregationPeriod === section.granularity,
  )?.latestEndTimeUtc;
  if (section.currentBeyondFreshness && latestForPeriod !== undefined) {
    lines.push(
      `  freshness: current window extends beyond the latest available ${section.granularity} data (${latestForPeriod})`,
    );
  }
  if (section.baselineBeyondFreshness && latestForPeriod !== undefined) {
    lines.push(
      `  freshness: baseline window extends beyond the latest available ${section.granularity} data (${latestForPeriod})`,
    );
  }
  for (const entry of section.entries) {
    for (const value of entry.values) {
      lines.push(valueLine(entry, value));
    }
  }
  return lines;
}

/** Render the deterministic human-readable summary of a comparison. */
export function renderHealthComparison(comparison: HealthComparison): string {
  const lines: string[] = [
    `App Health baseline comparison (${comparison.granularity})`,
    `Current:  ${comparison.current.startTimeUtc} → ${comparison.current.endTimeUtc}`,
    `Baseline: ${comparison.baseline.startTimeUtc} → ${comparison.baseline.endTimeUtc}`,
    `Dimensions: ${comparison.dimensions.length === 0 ? "none" : comparison.dimensions.join(", ")}`,
    `Totals: ${comparison.comparedValueCount} compared, ${comparison.unavailableValueCount} unavailable`,
  ];
  for (const section of comparison.sections) {
    lines.push(...sectionLines(section));
  }
  return lines.join("\n");
}

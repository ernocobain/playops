/**
 * Phase 5.3: thin, dated envelope around the authoritative Phase 5.2 result.
 * The existing summary is reused verbatim; no metric arithmetic or second renderer.
 * UTF-8 / LF, exactly one added terminal newline, identical bytes for stdout/file.
 */
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { HealthComparisonResult } from "./compare-tool.js";
import { parseUtcInstant } from "./time.js";

export type HealthReportErrorCode =
  "OUTPUT_DIRECTORY_INVALID" | "REPORT_RENDER_FAILED" | "REPORT_EXISTS" | "REPORT_WRITE_FAILED";

export class HealthReportError extends Error {
  override readonly name = "HealthReportError";
  constructor(
    readonly code: HealthReportErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface HealthReport {
  readonly generatedAt: string;
  readonly filename: string;
  readonly result: HealthComparisonResult;
  readonly text: string;
}

function reportFilename(generatedAt: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(generatedAt)) {
    throw new HealthReportError("REPORT_RENDER_FAILED", "Report timestamp is invalid.");
  }
  parseUtcInstant(`${generatedAt.slice(0, 19)}Z`, "generatedAt");
  return `playops-health-report-${generatedAt.replace(/[:.]/gu, "-")}.txt`;
}

/** Exactly one clock read. The comparison/result is retained, never reconstructed. */
export function createHealthReport(
  result: HealthComparisonResult,
  now: () => Date = () => new Date(),
): HealthReport {
  try {
    const generatedAt = now().toISOString();
    const filename = reportFilename(generatedAt);
    // Fail safely instead of rewriting source values or saving terminal escape sequences.
    // eslint-disable-next-line no-control-regex -- reject unsafe controls/ANSI, allow normal text layout
    if (!result.summary.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(result.summary)) {
      throw new Error("Unsafe plain-text summary.");
    }
    const text = [
      "PlayOps App Health report",
      `Generated at: ${generatedAt}`,
      `File: ${filename}`,
      `Metric kinds: ${result.comparison.kinds.join(", ")}`,
      "",
      result.summary,
      "",
    ].join("\n");
    return Object.freeze({ generatedAt, filename, result, text });
  } catch (cause) {
    throw new HealthReportError("REPORT_RENDER_FAILED", "Health report could not be rendered.", {
      cause,
    });
  }
}

/** Existing directory only; canonicalize relative paths and directory symlinks. Never mkdir. */
export async function resolveHealthReportDirectory(outputDir: string): Promise<string> {
  try {
    // eslint-disable-next-line no-control-regex -- reject NUL/terminal controls in operator paths
    if (!outputDir || outputDir !== outputDir.trim() || /[\x00-\x1f\x7f-\x9f]/u.test(outputDir)) {
      throw new Error("Invalid output directory text.");
    }
    const directory = await fs.realpath(resolve(outputDir));
    if (!(await fs.stat(directory)).isDirectory()) throw new Error("Not a directory.");
    return directory;
  } catch (cause) {
    throw new HealthReportError(
      "OUTPUT_DIRECTORY_INVALID",
      "--output-dir must name an existing directory.",
      { cause },
    );
  }
}

/** Narrow trusted test seam for storage faults, not a CLI/model capability. */
export type HealthReportFileOps = Pick<typeof fs, "open" | "link" | "unlink"> & {
  readFile(path: string, encoding: "utf8"): Promise<string>;
};

/**
 * Complete sibling wx temp → fsync/close → exact read-back → exclusive hard-link
 * publication → best-effort unlink of ONLY our temp. Ordinary pre-publication
 * failures never expose a partial final report. Unlike rename, link cannot replace
 * a colliding target (including symlinks). Unsupported hard links fail closed.
 * No directory fsync/power-loss guarantee or protection against a hostile process
 * replacing the operator's directory is claimed. Crash/cleanup failures may leave
 * a complete temp sibling; an existing final report is NEVER deleted or replaced.
 */
export async function writeHealthReport(
  outputDir: string,
  report: HealthReport,
  ops: HealthReportFileOps = fs,
): Promise<string> {
  const directory = await resolveHealthReportDirectory(outputDir);
  if (report.filename !== reportFilename(report.generatedAt)) {
    throw new HealthReportError(
      "REPORT_WRITE_FAILED",
      "Report filename does not match its timestamp.",
    );
  }
  const finalPath = join(directory, report.filename);
  const tempPath = join(directory, `.${report.filename}.${randomUUID()}.tmp`);
  let ownsTemp = false;
  try {
    const handle = await ops.open(tempPath, "wx", 0o600);
    ownsTemp = true;
    try {
      await handle.writeFile(report.text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if ((await ops.readFile(tempPath, "utf8")) !== report.text) {
      throw new Error("Report read-back mismatch.");
    }
    try {
      await ops.link(tempPath, finalPath);
    } catch (cause) {
      if (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "EEXIST"
      ) {
        throw new HealthReportError(
          "REPORT_EXISTS",
          "Report already exists; nothing was overwritten.",
          { cause },
        );
      }
      throw cause;
    }
    return finalPath;
  } catch (cause) {
    if (cause instanceof HealthReportError) throw cause;
    throw new HealthReportError("REPORT_WRITE_FAILED", "Health report file could not be written.", {
      cause,
    });
  } finally {
    if (ownsTemp) await ops.unlink(tempPath).catch(() => undefined);
  }
}

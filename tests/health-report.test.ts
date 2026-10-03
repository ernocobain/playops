import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHealthComparisonTool } from "../src/health/compare-tool.js";
import {
  createHealthReport,
  writeHealthReport,
  resolveHealthReportDirectory,
  type HealthReportFileOps,
} from "../src/health/report.js";
import { rowsFor, scenarioByName } from "./fixtures/health/comparison.fake.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function outputDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-report53-"));
  dirs.push(dir);
  return dir;
}

async function comparison(name = "crash-increase") {
  const scenario = scenarioByName(name);
  const tool = createHealthComparisonTool({
    gateway: {
      readMetricSet: async () => ({}),
      queryMetricSet: async (_kind, request) => ({
        rows: rowsFor(name, request.timelineSpec.startTime.day === 24 ? "current" : "baseline"),
      }),
    },
  });
  return tool.tool.execute(
    {
      kinds: [scenario.kind],
      current: { startTime: scenario.current.startTime, endTime: scenario.current.endTime },
      baseline: { startTime: scenario.baseline.startTime, endTime: scenario.baseline.endTime },
      granularity: scenario.granularity,
      dimensions: scenario.dimensions,
      metrics: scenario.metrics,
    },
    {},
  );
}

describe("Phase 5.3 dated report envelope and file", () => {
  it("uses one injected UTC timestamp, the existing summary, and one exact saved string", async () => {
    const result = await comparison();
    const now = vi.fn(() => new Date("2026-10-03T00:30:45.123Z"));
    const report = createHealthReport(result, now);
    expect(now).toHaveBeenCalledTimes(1);
    expect(report.generatedAt).toBe("2026-10-03T00:30:45.123Z");
    expect(report.filename).toBe("playops-health-report-2026-10-03T00-30-45-123Z.txt");
    expect(report.result).toBe(result);
    expect(report.text).toBe(
      "PlayOps App Health report\nGenerated at: 2026-10-03T00:30:45.123Z\n" +
        "File: playops-health-report-2026-10-03T00-30-45-123Z.txt\nMetric kinds: crash_rate\n\n" +
        result.summary +
        "\n",
    );
    const dir = outputDir();
    const path = await writeHealthReport(dir, report);
    expect(path).toBe(join(dir, report.filename));
    expect(readFileSync(path, "utf8")).toBe(report.text);
    expect(readdirSync(dir)).toEqual([report.filename]);
  });

  it("is deterministic and normalizes an explicitly offset clock to UTC without mutating the result", async () => {
    const result = await comparison("beyond-js-float-precision");
    const before = JSON.stringify(result);
    const first = createHealthReport(result, () => new Date("2026-10-03T07:30:45.123+07:00"));
    const second = createHealthReport(result, () => new Date("2026-10-03T00:30:45.123Z"));
    expect(first.text).toBe(second.text);
    expect(first.filename).toBe(second.filename);
    expect(first.text).toContain("0.123456789012345678901234567890");
    expect(first.text).toContain("0.000000000000000000000000000001 percentage points");
    expect(JSON.stringify(result)).toBe(before);
    expect(first.text).not.toMatch(/severity|critical|alert|threshold/u);
  });

  it.each(["invalid", "+010000-01-01T00:00:00Z", "1969-12-31T23:59:59Z"])(
    "rejects an invalid/out-of-range clock: %s",
    async (time) => {
      const result = await comparison();
      expect(() => createHealthReport(result, () => new Date(time))).toThrowError(
        expect.objectContaining({ code: "REPORT_RENDER_FAILED" }),
      );
    },
  );

  it("rejects control/ANSI text instead of silently changing the existing renderer output", async () => {
    const result = await comparison();
    expect(() =>
      createHealthReport({ ...result, summary: result.summary + "\u001b[31m" }),
    ).toThrowError(expect.objectContaining({ code: "REPORT_RENDER_FAILED" }));
  });

  it("never overwrites a collision, including a symlink to another file", async () => {
    const report = createHealthReport(await comparison());
    const dir = outputDir();
    const victim = join(dir, "existing.txt");
    writeFileSync(victim, "KEEP-ME");
    const target = join(dir, report.filename);
    symlinkSync(victim, target);
    await expect(writeHealthReport(dir, report)).rejects.toMatchObject({ code: "REPORT_EXISTS" });
    expect(readFileSync(victim, "utf8")).toBe("KEEP-ME");
    expect(readdirSync(dir).sort()).toEqual(["existing.txt", report.filename].sort());
  });

  it("publishes at most one complete report when two writers collide", async () => {
    const report = createHealthReport(await comparison());
    const dir = outputDir();
    const results = await Promise.allSettled([
      writeHealthReport(dir, report),
      writeHealthReport(dir, report),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(failure?.status === "rejected" ? failure.reason : undefined).toMatchObject({
      code: "REPORT_EXISTS",
    });
    expect(readdirSync(dir)).toEqual([report.filename]);
    expect(readFileSync(join(dir, report.filename), "utf8")).toBe(report.text);
  });

  it("requires an existing directory and canonicalizes operator directory aliases", async () => {
    const dir = outputDir();
    const missing = join(dir, "missing", "nested");
    await expect(resolveHealthReportDirectory(missing)).rejects.toMatchObject({
      code: "OUTPUT_DIRECTORY_INVALID",
    });
    const file = join(dir, "not-directory");
    writeFileSync(file, "KEEP");
    await expect(resolveHealthReportDirectory(file)).rejects.toMatchObject({
      code: "OUTPUT_DIRECTORY_INVALID",
    });
    await expect(resolveHealthReportDirectory("\u0000bad")).rejects.toMatchObject({
      code: "OUTPUT_DIRECTORY_INVALID",
    });
    expect(await resolveHealthReportDirectory(join(dir, "..", dir.split("/").at(-1) ?? ""))).toBe(
      dir,
    );
    expect(readdirSync(dir)).toEqual(["not-directory"]);
  });

  it("refuses a filename traversal without writing outside the operator directory", async () => {
    const report = createHealthReport(await comparison());
    const dir = outputDir();
    await expect(
      writeHealthReport(dir, { ...report, filename: "../escaped.txt" }),
    ).rejects.toMatchObject({ code: "REPORT_WRITE_FAILED" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each(["write", "sync"] as const)(
    "cleans its temp after an ordinary %s failure and never publishes partial bytes",
    async (fault) => {
      const report = createHealthReport(await comparison());
      const dir = outputDir();
      const ops: HealthReportFileOps = {
        ...fs,
        async open(path, flags, mode) {
          const handle = await fs.open(path, flags, mode);
          if (fault === "write") {
            const write = handle.writeFile.bind(handle);
            vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
              await write("partial", "utf8");
              throw new Error("FAKE-FS-SECRET");
            });
          } else {
            vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("FAKE-FS-SECRET"));
          }
          return handle;
        },
      };
      await expect(writeHealthReport(dir, report, ops)).rejects.toMatchObject({
        code: "REPORT_WRITE_FAILED",
        message: "Health report file could not be written.",
      });
      expect(readdirSync(dir)).toEqual([]);
    },
  );

  it("fails closed on unsupported hard-link publication, with no fallback overwrite", async () => {
    const report = createHealthReport(await comparison());
    const dir = outputDir();
    const ops: HealthReportFileOps = {
      ...fs,
      link: async () => {
        throw Object.assign(new Error("RAW-FS-DETAIL"), { code: "ENOTSUP" });
      },
    };
    await expect(writeHealthReport(dir, report, ops)).rejects.toMatchObject({
      code: "REPORT_WRITE_FAILED",
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("rejects a temp read-back mismatch before final publication", async () => {
    const report = createHealthReport(await comparison());
    const dir = outputDir();
    const ops: HealthReportFileOps = {
      ...fs,
      readFile: async () => "CORRUPTED",
    };
    await expect(writeHealthReport(dir, report, ops)).rejects.toMatchObject({
      code: "REPORT_WRITE_FAILED",
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("retains an existing ordinary report byte-for-byte on repeat", async () => {
    const report = createHealthReport(await comparison());
    const dir = outputDir();
    const path = await writeHealthReport(dir, report);
    await expect(writeHealthReport(dir, { ...report, text: "REPLACEMENT" })).rejects.toMatchObject({
      code: "REPORT_EXISTS",
    });
    expect(readFileSync(path, "utf8")).toBe(report.text);
    expect(readdirSync(dir)).toEqual([report.filename]);
  });
});

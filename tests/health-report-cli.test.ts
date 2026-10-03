import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAuditEntries } from "../src/audit/index.js";
import { runCli } from "../src/cli/main.js";
import type { DoctorDeps } from "../src/doctor/doctor.js";
import {
  fakeReportComposition,
  healthReportArgs,
  REPORT_FILE,
  REPORT_TIME,
  RAW_REPORT_MARKER,
} from "./fixtures/health/report.fake.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});
function setup(mode: Parameters<typeof fakeReportComposition>[1] = "normal") {
  const root = mkdtempSync(join(tmpdir(), "playops-cli53-"));
  dirs.push(root);
  const outputDir = join(root, "reports");
  mkdirSync(outputDir);
  const auditPath = join(root, "audit.jsonl");
  const fake = fakeReportComposition(auditPath, mode);
  const stdout: string[] = [],
    stderr: string[] = [];
  const now = vi.fn(() => new Date(REPORT_TIME));
  const factory = vi.fn(async () => fake.composition);
  const output = {
    log: (text: string) => {
      stdout.push(text);
    },
    error: (text: string) => {
      stderr.push(text);
    },
  };
  const health = {
    io: { write: output.log, writeError: output.error },
    compositionFactory: factory,
    now,
  };
  const run = (extra: readonly string[] = []) =>
    runCli(
      healthReportArgs(outputDir, extra),
      {} as DoctorDeps,
      output,
      undefined,
      undefined,
      health,
    );
  return { root, outputDir, auditPath, fake, stdout, stderr, now, factory, output, health, run };
}

describe("Phase 5.3 real CLI → real Phase 5.2/5.1 → fake generated client", () => {
  it("routes all three kinds, reports once, and saves the exact stdout bytes", async () => {
    const s = setup("precision");
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("NO NETWORK"));
    expect(await s.run()).toBe(0);
    expect(s.stdout).toHaveLength(1);
    expect(s.stderr).toEqual([]);
    expect(s.now).toHaveBeenCalledTimes(1);
    expect(s.factory).toHaveBeenCalledTimes(1);
    expect(readdirSync(s.outputDir)).toEqual([REPORT_FILE]);
    expect(readFileSync(join(s.outputDir, REPORT_FILE), "utf8")).toBe(s.stdout[0]);
    expect(s.stdout[0]).toContain(`Generated at: ${REPORT_TIME}`);
    expect(s.stdout[0]).toContain("Metric kinds: crash_rate, anr_rate, excessive_wakeup_rate");
    expect(s.stdout[0]).toContain("0.123456789012345678901234567890");
    expect(s.stdout[0]).toContain("0.000000000000000000000000000001 percentage points");
    expect(s.stdout[0]).toContain("ANR rate — anrRate");
    expect(s.stdout[0]).toContain("Excessive wakeups — excessiveWakeupRate");
    expect(s.stdout[0]).toContain("freshness: current window extends beyond");
    expect(s.fake.calls.filter((call) => call.method === "get")).toHaveLength(6);
    expect(s.fake.calls.filter((call) => call.method === "query")).toHaveLength(6);
    expect(s.fake.calls.every((call) => JSON.stringify(call.options) === '{"retry":false}')).toBe(
      true,
    );
    expect(network).not.toHaveBeenCalled();
    const audit = readAuditEntries(s.auditPath);
    expect(
      audit.filter(
        (entry) =>
          entry.type === "verification.completed" &&
          entry.metadata?.code === "VERIFICATION_SKIPPED",
      ),
    ).toHaveLength(1);
    expect(
      audit.some((entry) => entry.type.startsWith("approval.") || entry.type.includes("alert")),
    ).toBe(false);
    expect(JSON.stringify(audit)).not.toContain(RAW_REPORT_MARKER);
    expect(JSON.stringify(audit)).not.toContain("0.123456789012345678901234567890");
    expect(s.stdout[0]).not.toContain(RAW_REPORT_MARKER);
    expect(s.stdout[0]).not.toMatch(/threshold|critical|severity|alert/u);
    expect(s.stdout[0]).not.toContain("\u001b");
  });

  it.each(["empty-current", "empty-baseline", "empty-both", "unmatched"] as const)(
    "preserves unavailable data in a successful report: %s",
    async (mode) => {
      const s = setup(mode);
      const extra = mode === "unmatched" ? ["--kinds=crash_rate", "--dimensions=deviceModel"] : [];
      expect(await s.run(extra)).toBe(0);
      const text = readFileSync(join(s.outputDir, REPORT_FILE), "utf8");
      expect(text).toBe(s.stdout[0]);
      expect(text).toContain("incomparable");
      if (mode === "empty-current") expect(text).toContain("current (no data)");
      if (mode === "empty-baseline") expect(text).toContain("baseline (no data)");
      if (mode === "empty-both") expect(text).toContain("no data in either window");
      if (mode === "unmatched") {
        expect(text).toContain("[deviceModel=google/coral]");
        expect(text).toContain("[deviceModel=google/panther]");
      }
      expect(text).not.toContain("0%");
    },
  );

  it("uses structured kind ordering even when selection order differs", async () => {
    const s = setup();
    expect(await s.run(["--kinds=excessive_wakeup_rate,anr_rate,crash_rate"])).toBe(0);
    const text = s.stdout[0] ?? "";
    expect(text).toContain("Metric kinds: crash_rate, anr_rate, excessive_wakeup_rate");
    expect(text.indexOf("Crash rate —")).toBeLessThan(text.indexOf("ANR rate —"));
    expect(text.indexOf("ANR rate —")).toBeLessThan(text.indexOf("Excessive wakeups —"));
    expect(text).toContain("Current:  2026-09-24T07:00:00Z → 2026-09-25T07:00:00Z");
    expect(text).toContain("Baseline: 2026-09-23T07:00:00Z → 2026-09-24T07:00:00Z");
  });

  it("reruns deterministically in a separate output directory with the same clock and source", async () => {
    const a = setup(),
      b = setup();
    expect(await a.run()).toBe(0);
    expect(await b.run()).toBe(0);
    expect(a.stdout).toEqual(b.stdout);
    expect(readdirSync(a.outputDir)).toEqual(readdirSync(b.outputDir));
  });

  it("refuses collision with no stdout or replacement content", async () => {
    const s = setup();
    expect(await s.run()).toBe(0);
    const original = readFileSync(join(s.outputDir, REPORT_FILE), "utf8");
    s.stdout.splice(0);
    expect(await s.run()).toBe(1);
    expect(s.stdout).toEqual([]);
    expect(s.stderr.join(" ")).toContain("already exists");
    expect(readFileSync(join(s.outputDir, REPORT_FILE), "utf8")).toBe(original);
    expect(readdirSync(s.outputDir)).toEqual([REPORT_FILE]);
  });

  it.each([
    ["--kinds=unknown"],
    ["--metrics=anrRate"],
    ["--credentials", "FAKE-SECRET"],
    ["--force"],
    ["--granularity=WEEKLY"],
  ])("invalid input has zero source/composition/clock/file effects: %j", async (...extra) => {
    const s = setup();
    expect(await s.run(extra)).toBe(1);
    expect(s.fake.calls).toEqual([]);
    expect(s.factory).not.toHaveBeenCalled();
    expect(s.now).not.toHaveBeenCalled();
    expect(readdirSync(s.outputDir)).toEqual([]);
    expect(s.stdout).toEqual([]);
    expect(s.stderr.join(" ")).not.toContain("FAKE-SECRET");
  });

  it("missing current/baseline flags and incompatible windows never reach the source", async () => {
    for (const fault of ["--current-start", "--baseline-end", "duration", "timestamp"]) {
      const s = setup();
      const args = healthReportArgs(s.outputDir);
      if (fault === "duration") args[args.indexOf("--baseline-start") + 1] = "2026-09-22T07:00:00Z";
      else if (fault === "timestamp") args[args.indexOf("--current-start") + 1] = "yesterday";
      else args.splice(args.indexOf(fault), 2);
      expect(await runCli(args, {} as DoctorDeps, s.output, undefined, undefined, s.health)).toBe(
        1,
      );
      expect(s.fake.calls).toEqual([]);
      expect(s.factory).not.toHaveBeenCalled();
      expect(readdirSync(s.outputDir)).toEqual([]);
    }
  });

  it("checks directory validity before configuration/credential initialization", async () => {
    const s = setup();
    const args = healthReportArgs(join(s.root, "missing", "nested"));
    expect(await runCli(args, {} as DoctorDeps, s.output, undefined, undefined, s.health)).toBe(1);
    expect(s.factory).not.toHaveBeenCalled();
    expect(s.fake.calls).toEqual([]);
    expect(readdirSync(s.root)).toEqual(["reports"]);
    expect(s.stderr.join(" ")).toContain("existing directory");
  });

  it("source failure returns no report or clock read and no raw error", async () => {
    const s = setup("failure");
    expect(await s.run()).toBe(1);
    expect(s.stdout).toEqual([]);
    expect(readdirSync(s.outputDir)).toEqual([]);
    expect(s.now).not.toHaveBeenCalled();
    expect(s.stderr.join(" ")).toBe("Health comparison failed. No report was saved.");
    expect(JSON.stringify(readAuditEntries(s.auditPath))).not.toContain(RAW_REPORT_MARKER);
  });

  it("unsafe renderer text fails before any report publication", async () => {
    const s = setup("unsafe");
    expect(await s.run(["--kinds=crash_rate", "--dimensions=deviceModel"])).toBe(1);
    expect(s.stdout).toEqual([]);
    expect(readdirSync(s.outputDir)).toEqual([]);
    expect(s.stderr.join(" ")).toContain("rendering failed");
  });

  it("an invalid injected clock fails rendering with no saved report", async () => {
    const s = setup();
    s.now.mockReturnValueOnce(new Date("invalid"));
    expect(await s.run()).toBe(1);
    expect(s.stdout).toEqual([]);
    expect(readdirSync(s.outputDir)).toEqual([]);
    expect(s.stderr.join(" ")).toContain("rendering failed");
  });

  it("file-output failure after comparison emits no report/false success", async () => {
    const s = setup();
    const factory = async () => {
      rmSync(s.outputDir, { recursive: true });
      return s.fake.composition;
    };
    expect(
      await runCli(
        healthReportArgs(s.outputDir),
        {} as DoctorDeps,
        s.output,
        undefined,
        undefined,
        { ...s.health, compositionFactory: factory },
      ),
    ).toBe(1);
    expect(s.fake.calls).toHaveLength(12);
    expect(s.stdout).toEqual([]);
    expect(s.stderr.join(" ")).toContain("output failed");
    expect(readdirSync(s.root)).toEqual(["audit.jsonl"]);
  });

  it("configuration errors are safe and never saved", async () => {
    const s = setup();
    s.factory.mockRejectedValueOnce(new Error(RAW_REPORT_MARKER));
    expect(await s.run()).toBe(1);
    expect(s.fake.calls).toEqual([]);
    expect(s.stdout).toEqual([]);
    expect(s.stderr.join(" ")).toContain("configuration");
    expect(s.stderr.join(" ")).not.toContain(RAW_REPORT_MARKER);
    expect(readdirSync(s.outputDir)).toEqual([]);
  });

  it("only emits stdout after file verification and awaits an asynchronous sink", async () => {
    const s = setup();
    const write = vi.fn(async (text: string) => {
      expect(readFileSync(join(s.outputDir, REPORT_FILE), "utf8")).toBe(text);
      await new Promise<void>((resolve) => setImmediate(resolve));
      s.stdout.push(text);
    });
    expect(
      await runCli(
        healthReportArgs(s.outputDir),
        {} as DoctorDeps,
        s.output,
        undefined,
        undefined,
        { ...s.health, io: { write, writeError: s.output.error } },
      ),
    ).toBe(0);
    expect(write).toHaveBeenCalledTimes(1);
    expect(s.stdout).toHaveLength(1);
  });

  it("retains the complete saved file if stdout fails, returning a safe operational failure", async () => {
    const s = setup();
    const write = async () => {
      throw new Error(RAW_REPORT_MARKER);
    };
    expect(
      await runCli(
        healthReportArgs(s.outputDir),
        {} as DoctorDeps,
        s.output,
        undefined,
        undefined,
        { ...s.health, io: { write, writeError: s.output.error } },
      ),
    ).toBe(1);
    expect(readdirSync(s.outputDir)).toEqual([REPORT_FILE]);
    expect(s.stderr.join(" ")).toContain("stdout could not be written");
    expect(s.stderr.join(" ")).not.toContain(RAW_REPORT_MARKER);
  });

  it("supports the existing line-oriented CliOutput fallback without adding an extra newline", async () => {
    const s = setup();
    const output = {
      log: (text: string) => {
        s.stdout.push(text + "\n");
      },
      error: s.output.error,
    };
    expect(
      await runCli(healthReportArgs(s.outputDir), {} as DoctorDeps, output, undefined, undefined, {
        compositionFactory: s.factory,
        now: s.now,
      }),
    ).toBe(0);
    expect(readFileSync(join(s.outputDir, REPORT_FILE), "utf8")).toBe(s.stdout[0]);
  });

  it("returns a safe operational failure when help stdout rejects", async () => {
    const s = setup();
    const write = async () => {
      throw new Error(RAW_REPORT_MARKER);
    };
    expect(
      await runCli(
        ["health", "report", "--help"],
        {} as DoctorDeps,
        s.output,
        undefined,
        undefined,
        { ...s.health, io: { write, writeError: s.output.error } },
      ),
    ).toBe(1);
    expect(s.stderr).toEqual(["Health command help could not be written to stdout."]);
    expect(s.factory).not.toHaveBeenCalled();
    expect(s.fake.calls).toEqual([]);
    expect(readdirSync(s.outputDir)).toEqual([]);
  });

  it.each([["health"], ["health", "--help"], ["health", "report", "--help"]])(
    "help has no composition/clock/file effects: %j",
    async (...args) => {
      const s = setup();
      expect(await runCli(args, {} as DoctorDeps, s.output, undefined, undefined, s.health)).toBe(
        0,
      );
      expect(s.factory).not.toHaveBeenCalled();
      expect(s.now).not.toHaveBeenCalled();
      expect(s.fake.calls).toEqual([]);
      expect(readdirSync(s.outputDir)).toEqual([]);
      expect(s.stdout.join(" ")).toContain("Usage: playops health report");
    },
  );
});

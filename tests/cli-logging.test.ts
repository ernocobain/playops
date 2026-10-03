import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as fs from "node:fs";
import { runCliWithLogging } from "../src/cli/logging.js";

const stderrWrite = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return { ...original, writeSync: stderrWrite };
});
beforeEach(() => {
  stderrWrite.mockReset();
});
const NOW = "2026-10-03T16:00:00.000Z";
function options(level: "debug" | "info" | "warn" | "error" = "info") {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      now: () => new Date(NOW),
      loadConfig: () => ({ logging: { level } }),
      sink: (line: string) => {
        lines.push(line);
      },
    },
  };
}

describe("narrow CLI diagnostics", () => {
  it("uses stderr in production without console or stdout", async () => {
    stderrWrite.mockReturnValue(100);
    expect(
      await runCliWithLogging(["doctor"], async () => 0, {
        now: () => new Date(NOW),
        loadConfig: () => ({ logging: { level: "info" } }),
      }),
    ).toBe(0);
    expect(stderrWrite).toHaveBeenCalledExactlyOnceWith(
      2,
      '{"timestamp":"2026-10-03T16:00:00.000Z","level":"info","message":"CLI command completed.","context":{"command":"doctor","exitCode":0}}\n',
    );
  });

  it.each([0, 1, 2] as const)(
    "preserves exit %d and logs only safe lifecycle metadata",
    async (exitCode) => {
      const s = options("debug");
      const run = vi.fn(async () => exitCode);
      expect(await runCliWithLogging(["reviews", "reply", "FAKE-RAW-ARGUMENT"], run, s.deps)).toBe(
        exitCode,
      );
      expect(run).toHaveBeenCalledTimes(1);
      expect(s.lines).toHaveLength(1);
      const log = JSON.parse(s.lines[0] ?? "{}") as { level: string; context: unknown };
      expect(log.level).toBe(exitCode === 0 ? "info" : exitCode === 2 ? "warn" : "error");
      expect(log.context).toEqual({ command: "reviews", exitCode });
      expect(s.lines.join("")).not.toContain("FAKE-RAW-ARGUMENT");
    },
  );

  it("composes diagnostics after the operator result, never before argument/config/report validation", async () => {
    const order: string[] = [];
    const s = options();
    await runCliWithLogging(
      ["health", "report"],
      async () => {
        order.push("operation");
        return 0;
      },
      {
        ...s.deps,
        loadConfig: () => {
          order.push("diagnostic-config");
          return { logging: { level: "info" } };
        },
        sink: (line) => {
          order.push("diagnostic-write");
          s.lines.push(line);
        },
      },
    );
    expect(order).toEqual(["operation", "diagnostic-config", "diagnostic-write"]);
  });

  it.each(
    [
      [],
      ["--help"],
      ["-h"],
      ["reviews"],
      ["health"],
      ["releases"],
      ["health", "report", "--help"],
      ["reviews", "triage", "--help"],
      ["FAKE-UNKNOWN-ARG"],
    ].map((args) => ({ args })),
  )(
    "keeps help and unknown commands quiet and does not read configuration: $args",
    async ({ args }) => {
      const s = options();
      const loadConfig = vi.fn(s.deps.loadConfig);
      const run = vi.fn(async () => 0 as const);
      expect(await runCliWithLogging(args, run, { ...s.deps, loadConfig })).toBe(0);
      expect(run).toHaveBeenCalledTimes(1);
      expect(loadConfig).not.toHaveBeenCalled();
      expect(s.lines).toEqual([]);
    },
  );

  it("applies the effective configured minimum level", async () => {
    const s = options("warn");
    await runCliWithLogging(["health", "report"], async () => 0, s.deps);
    expect(s.lines).toEqual([]);
    await runCliWithLogging(["health", "report"], async () => 1, s.deps);
    expect(s.lines).toHaveLength(1);
  });

  it("uses info for unreadable config without emitting the raw error or changing result", async () => {
    const s = options();
    await expect(
      runCliWithLogging(["doctor"], async () => 1, {
        ...s.deps,
        loadConfig() {
          throw new Error("FAKE-RAW-CONFIG-SECRET");
        },
      }),
    ).resolves.toBe(1);
    expect(s.lines).toHaveLength(1);
    expect(s.lines.join("")).not.toContain("FAKE-RAW-CONFIG-SECRET");
  });

  it("preserves a successful operation when stderr is closed", async () => {
    stderrWrite.mockImplementation(() => {
      throw new Error("FAKE-STDERR-ERROR");
    });
    await expect(
      runCliWithLogging(["doctor"], async () => 0, {
        loadConfig: () => ({ logging: { level: "info" } }),
      }),
    ).resolves.toBe(0);
    expect(stderrWrite).toHaveBeenCalledTimes(1);
  });

  it("never converts a thrown operation/audit failure into success or raw diagnostic text", async () => {
    const error = new Error("FAKE-RAW-OPERATION-ERROR");
    const s = options();
    await expect(
      runCliWithLogging(
        ["doctor"],
        async () => {
          throw error;
        },
        s.deps,
      ),
    ).rejects.toBe(error);
    expect(s.lines).toHaveLength(1);
    expect(s.lines.join("")).not.toContain(error.message);
    expect((JSON.parse(s.lines[0] ?? "{}") as { level: string }).level).toBe("error");
  });
});

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as fs from "node:fs";
import { runCliWithLogging } from "../src/cli/logging.js";
import { presentOperatorError } from "../src/errors/index.js";
import { ReleaseError } from "../src/releases/index.js";

const stderrWrite = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return { ...original, writeSync: stderrWrite };
});
beforeEach(() => {
  stderrWrite.mockReset();
  stderrWrite.mockReturnValue(100);
});

function options(level: "debug" | "info" | "warn" | "error" = "debug") {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      now: () => new Date("2026-10-03T16:00:00.000Z"),
      loadConfig: () => ({ logging: { level } }),
      sink: (line: string) => {
        lines.push(line);
      },
    },
  };
}

describe("Phase 6.3 CLI error boundary", () => {
  it("logs only allowlisted taxonomy metadata for a thrown typed failure", async () => {
    const error = new ReleaseError("UPLOAD_FAILED", "FAKE-SECRET-MESSAGE", {
      externalStateUncertain: true,
    });
    const s = options();
    await expect(
      runCliWithLogging(
        ["reviews", "reply", "FAKE-RAW-ARGUMENT"],
        async () => {
          throw error;
        },
        s.deps,
      ),
    ).rejects.toBe(error);

    expect(s.lines).toHaveLength(1);
    const line = s.lines[0] ?? "";
    expect(line).not.toContain("FAKE-SECRET-MESSAGE");
    expect(line).not.toContain("FAKE-RAW-ARGUMENT");
    expect(line).not.toContain("at Object.");
    const record = JSON.parse(line) as { level: string; context: Record<string, unknown> };
    expect(record.level).toBe("error");
    expect(record.context).toEqual({
      command: "reviews",
      exitCode: 1,
      category: "external-api",
      code: "UPLOAD_FAILED",
      externalStateUncertain: true,
    });
  });

  it("keeps the non-throwing lifecycle context unchanged", async () => {
    const s = options();
    expect(await runCliWithLogging(["doctor"], async () => 1, s.deps)).toBe(1);
    const record = JSON.parse(s.lines[0] ?? "{}") as { context: unknown };
    expect(record.context).toEqual({ command: "doctor", exitCode: 1 });
  });

  it("classifies a non-Error thrown value without leaking it", async () => {
    const s = options();
    await expect(
      runCliWithLogging(
        ["health", "report"],
        async () => {
          throw "FAKE-SECRET-MESSAGE";
        },
        s.deps,
      ),
    ).rejects.toBe("FAKE-SECRET-MESSAGE");
    const record = JSON.parse(s.lines[0] ?? "{}") as { context: Record<string, unknown> };
    expect(record.context).toMatchObject({
      command: "health",
      exitCode: 1,
      category: "runtime",
      code: "INTERNAL_ERROR",
    });
    expect(s.lines.join("")).not.toContain("FAKE-SECRET-MESSAGE");
  });

  it("renders a hostile cause through the boundary with no stack", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("FAKE-LEAK");
        },
        getOwnPropertyDescriptor() {
          throw new Error("FAKE-LEAK");
        },
      },
    );
    const text = presentOperatorError(hostile);
    expect(text).toContain("INTERNAL_ERROR");
    expect(text).not.toContain("FAKE-LEAK");
    expect(text).not.toContain("    at ");
  });

  it("makes the entrypoint cross the safe presentation boundary", () => {
    const source = readFileSync("src/cli/index.ts", "utf8");
    expect(source).toContain("presentOperatorError(");
    expect(source).toContain("writeSync(2,");
    expect(source).not.toContain(".stack");
    expect(source).not.toContain("JSON.stringify(cause");
    expect(source).not.toContain("String(cause");
    expect(source).not.toMatch(/console\.error\(\s*cause/iu);
  });

  it("documents the policy on every source path that prints operator errors", () => {
    for (const path of ["src/cli/index.ts", "src/errors/index.ts", "src/cli/logging.ts"]) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(/\.stack\b/u);
    }
  });
});

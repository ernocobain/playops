import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseConfigYaml } from "../src/config/loader.js";

const root = new URL("../", import.meta.url);
const metadata = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  name: string;
  version: string;
  license: string;
  private: boolean;
  type: string;
  engines: { node: string };
  bin: Record<string, string>;
  main?: string;
  exports?: unknown;
  types?: string;
  files: string[];
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
};

describe("Phase 6.1 CLI-only distribution contract", () => {
  it("advertises only the installed CLI, not the empty root library", () => {
    expect(metadata.main).toBeUndefined();
    expect(metadata.exports).toBeUndefined();
    expect(metadata.types).toBeUndefined();
    expect(metadata.bin).toEqual({ playops: "dist/cli/index.js" });
  });
  it("builds only before packing and ships runtime JS, the safe example and only operator guides", () => {
    expect(metadata.scripts.prepack).toBe("npm run build");
    expect(metadata.scripts["test:package"]).toBe("node scripts/package-acceptance.mjs");
    expect(metadata.files).toEqual([
      "dist/**/*.js",
      "config/playops.example.yaml",
      "docs/credentials.md",
      "docs/permissions-and-approvals.md",
      "docs/audit-log.md",
      "docs/release-pipeline.md",
    ]);
    for (const hook of ["prepare", "preinstall", "install", "postinstall", "publish"])
      expect(metadata.scripts[hook]).toBeUndefined();
  });
  it("keeps the approved runtime, private local distribution, version and four dependencies", () => {
    expect(metadata).toMatchObject({
      name: "playops",
      version: "0.0.0",
      license: "MIT",
      private: true,
      type: "module",
      engines: { node: ">=24 <25" },
    });
    expect(metadata.dependencies).toEqual({
      "@googleapis/androidpublisher": "^42.1.0",
      "@googleapis/playdeveloperreporting": "^15.0.1",
      "google-auth-library": "^11.1.0",
      yaml: "^2.9.1",
    });
  });
  it("safe example uses disabled reported-scale strings/null without legacy names or a real credential path", () => {
    const text = readFileSync(new URL("config/playops.example.yaml", root), "utf8");
    expect(text).not.toMatch(/\b(?:crash_rate_threshold|anr_rate_threshold)\b/);
    expect(parseConfigYaml(text)).toMatchObject({
      googlePlay: { serviceAccountJson: "" },
      health: {
        crashRateReportedThreshold: null,
        anrRateReportedThreshold: null,
        excessiveWakeupRateReportedThreshold: null,
      },
    });
    expect(text).toContain('crash_rate_reported_threshold: "0.01"');
    expect(text).toContain("not a recommendation");
  });
  it("runs deterministic native package-safety tests as part of the normal suite", () => {
    const result = execFileSync(
      process.execPath,
      ["--test", fileURLToPath(new URL("scripts/package-content.test.mjs", root))],
      { encoding: "utf8" },
    );
    expect(result).toContain("fail 0");
  });
});

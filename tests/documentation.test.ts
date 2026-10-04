import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NewAuditEntry } from "../src/audit/types.js";
import { ENV_VARS, parseConfigYaml } from "../src/config/loader.js";
import { parseReviewCommand } from "../src/cli/reviews.js";
import { parseHealthCommand } from "../src/cli/health.js";
import { runReleasesCli } from "../src/cli/releases.js";
import { runCli } from "../src/cli/main.js";
import { approveInteractively, createApprovalRequest } from "../src/runtime/approvals/index.js";
import { verifyToolOutcome } from "../src/runtime/verification/index.js";
import type { ToolDefinition } from "../src/runtime/tools/index.js";

const root = new URL("../", import.meta.url);
const helper = new URL("scripts/documentation-checks.mjs", root).href;
const read = (file: string): string => readFileSync(new URL(file, root), "utf8");
interface DocInspection {
  report: { documents: string[]; relativeLinks: number; cliExamples: string[] };
  yaml: string[];
  audit: string[];
}
const inspection = JSON.parse(
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { assertOperatorDocumentation, codeBlocks } from ${JSON.stringify(helper)};
       import { readFileSync } from "node:fs";
       const root = ${JSON.stringify(fileURLToPath(root))};
       const report = assertOperatorDocumentation(root);
       const blocks = report.documents.flatMap(file => codeBlocks(readFileSync(root + file, "utf8")));
       console.log(JSON.stringify({ report, yaml: blocks.filter(b => b.language === "yaml").map(b => b.text), audit: blocks.filter(b => b.language === "jsonl").map(b => b.text) }));`,
    ],
    { encoding: "utf8" },
  ),
) as DocInspection;

const commands = [...new Set(inspection.report.cliExamples)];

describe("Phase 6.4 operator documentation", () => {
  it("validates promised installed documents, relative links/anchors and safe examples", () => {
    expect(inspection.report.documents).toEqual([
      "README.md",
      "CHANGELOG.md",
      "docs/credentials.md",
      "docs/permissions-and-approvals.md",
      "docs/audit-log.md",
      "docs/release-pipeline.md",
      "docs/release-process.md",
    ]);
    expect(inspection.report.relativeLinks).toBeGreaterThan(0);
    expect(commands).toContain("playops --help");
    expect(commands).toContain("playops reviews reply example-review-id");
  });

  it("runs native positive and negative documentation checks without a docs framework", () => {
    const output = execFileSync(
      process.execPath,
      ["--test", fileURLToPath(new URL("scripts/documentation-checks.test.mjs", root))],
      { encoding: "utf8" },
    );
    expect(output).toContain("fail 0");
  });

  it.each(commands)("documented CLI syntax is implemented: %s", async (command) => {
    const args = command.split(/\s+/u).slice(1);
    const errors: string[] = [];
    const stdout: string[] = [];
    if (args[0] === "reviews") {
      expect(parseReviewCommand(args.slice(1)).kind).toBe(
        args.includes("--help") ? "help" : args[1],
      );
    } else if (args[0] === "health") {
      const parsed = parseHealthCommand(args.slice(1));
      expect(parsed.kind).toBe(args.includes("--help") ? "help" : "report");
      if (parsed.kind === "report") {
        expect(parsed.input.granularity).toBe("DAILY");
        expect(parsed.outputDir).toBe("./reports");
      }
    } else if (args[0] === "releases") {
      expect(
        await runReleasesCli(args.slice(1), {
          write: (text) => stdout.push(text),
          writeError: (text) => errors.push(text),
        }),
      ).toBe(1);
      expect(errors).toEqual([
        "No trusted composition-bound release operation is available; no API, credential, approval, or session access was performed.",
      ]);
      expect(stdout).toEqual([]);
    } else {
      // Doctor's real route, stopped at fake local config: no credential/API access.
      const forbid = (): never => {
        throw new Error("Fake boundary must not be used.");
      };
      const result = await runCli(
        args,
        {
          loadConfig: forbid,
          loadCredentials: forbid,
          authenticate: async () => forbid(),
          checkAndroidPublisher: async () => forbid(),
          checkPlayDeveloperReporting: async () => forbid(),
        },
        { log: (text) => stdout.push(text), error: (text) => errors.push(text) },
      );
      expect(result).toBe(args[0] === "doctor" ? 1 : 0);
      expect(errors).toEqual([]);
      expect(stdout.join("\n")).toContain(
        args[0] === "doctor" ? "CONFIG_INVALID" : "Usage: playops <command>",
      );
    }
  });

  it("documents every actual environment name and parses YAML examples without credentials", () => {
    const credentials = read("docs/credentials.md");
    for (const name of Object.values(ENV_VARS)) expect(credentials).toContain(name);
    expect(inspection.yaml.length).toBeGreaterThan(0);
    for (const text of inspection.yaml) {
      expect(parseConfigYaml(text)).toMatchObject({
        googlePlay: {
          packageName: "com.example.playopsdemo",
          serviceAccountJson: "/path/to/private/example-service-account.json",
        },
        logging: { level: "info" },
        health: {
          crashRateReportedThreshold: null,
          anrRateReportedThreshold: null,
          excessiveWakeupRateReportedThreshold: null,
        },
      });
    }
  });

  it("does not promise full prior-track preservation during release configuration", () => {
    const guide = read("docs/release-pipeline.md");
    expect(guide).toContain("one new release");
    expect(guide).toContain("none retained by default");
    expect(guide).toContain(
      "does not preserve the track's full prior release array or its metadata",
    );
    expect(guide).not.toContain("verifies the intended release while preserving non-target state");
  });

  it("documents the bounded single-delete policy for every temporary-edit workflow", () => {
    const guide = read("docs/release-pipeline.md");
    expect(guide).toContain("bounded to one delete attempt per temporary identity");
    expect(guide).toContain("ROLLOUT_VERIFICATION_CLEANUP_FAILED");
    expect(guide).toContain("keeps any written journal record");
    expect(guide).toContain("performs no automatic retry");
    // The pre-6.5 exception disclosure must be gone now that the rollout guard exists.
    expect(guide).not.toContain("Current rollout advancement is an exception");
    expect(guide).not.toContain("two workflow calls");
    expect(guide).not.toContain("not fixed by this documentation-only milestone");
  });

  it("example config comment clarifications do not change semantics", () => {
    const previous = execFileSync("git", ["show", "HEAD:config/playops.example.yaml"], {
      cwd: fileURLToPath(root),
      encoding: "utf8",
    });
    expect(parseConfigYaml(read("config/playops.example.yaml"))).toEqual(parseConfigYaml(previous));
  });

  it("synthetic JSONL examples match actual approval/verification event schemas", async () => {
    expect(inspection.audit).toHaveLength(1);
    const records = (inspection.audit[0] ?? "")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as NewAuditEntry & { id: string });
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual([
        "action",
        "actor",
        "id",
        "metadata",
        "status",
        "timestamp",
        "type",
      ]);
      expect(record.id).toMatch(/^[0-9a-f-]{36}$/u);
    }
    const requested = records[0];
    if (!requested) throw new Error("Missing synthetic request.");
    const metadata = requested.metadata;
    const requestId = String(metadata?.requestId);
    const requestDigest = String(metadata?.requestDigest);
    const appended: NewAuditEntry[] = [];
    const ledger = {
      append: (entry: NewAuditEntry) => {
        appended.push(entry);
      },
      read: () => [],
    };
    const request = createApprovalRequest(
      {
        toolName: "reviews.publish_reply",
        permission: "publish",
        requestDigest,
        safeSummary: "Synthetic example operation.",
      },
      { ledger, now: () => new Date("2026-01-01T00:00:00.000Z"), requestId: () => requestId },
    );
    await approveInteractively(
      request,
      { ask: async () => "yes" },
      {
        ledger,
        now: () => new Date("2026-01-01T00:00:05.000Z"),
      },
    );
    const tool: ToolDefinition<Record<string, never>, boolean> = {
      name: "reviews.publish_reply",
      description: "Synthetic verification only.",
      permission: "publish",
      inputSchema: { parse: () => ({}) },
      outputSchema: { parse: () => true },
      execute: async () => {
        throw new Error("No publish may execute.");
      },
      verify: async () => true,
    };
    await verifyToolOutcome(
      { tool, input: {}, output: true, context: {} },
      {
        ledger: {
          append: async (entry) => {
            appended.push({ ...entry, timestamp: "2026-01-01T00:00:06.000Z" });
          },
        },
        correlation: { requestId, requestDigest },
      },
    );
    expect(appended).toEqual(records.map(({ id: _id, ...entry }) => entry));
  });
});

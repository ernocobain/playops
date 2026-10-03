import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendAuditEntry, AuditError, readAuditEntries } from "../src/audit/index.js";
import { runCli } from "../src/cli/main.js";
import { runCliWithLogging } from "../src/cli/logging.js";
import { createReadlineApprovalPrompt } from "../src/cli/approval-prompt.js";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import type { DoctorDeps } from "../src/doctor/doctor.js";
import { createHealthComposition } from "../src/health/composition.js";
import {
  runAgent,
  createFileAgentLedger,
  type AgentToolBinding,
} from "../src/runtime/agent/index.js";
import { approveInteractively } from "../src/runtime/approvals/index.js";
import { ToolRegistry } from "../src/runtime/tools/index.js";
import type { LlmAdapter } from "../src/runtime/llm/index.js";
import type { LogSink } from "../src/logging/index.js";
import {
  fakeReportComposition,
  healthReportArgs,
  REPORT_FILE,
  REPORT_TIME,
} from "./fixtures/health/report.fake.js";
import { THRESHOLD_QUERY } from "./fixtures/health/thresholds.fake.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scope() {
  const root = mkdtempSync(join(tmpdir(), "playops-logging-regression-"));
  dirs.push(root);
  return root;
}
function diagnostics(sink: LogSink) {
  return {
    sink,
    loadConfig: () => ({ logging: { level: "info" as const } }),
    now: () => new Date(REPORT_TIME),
  };
}
function scripted(toolName: string, args: unknown): LlmAdapter {
  let turns = 0;
  return {
    provider: "scripted-fake-only",
    async complete() {
      turns += 1;
      return turns === 1
        ? { toolCalls: [{ id: "c1", name: toolName, arguments: args }], usage: { totalTokens: 0 } }
        : { content: "Synthetic operation finished.", toolCalls: [], usage: { totalTokens: 0 } };
    },
  };
}

for (const failure of [false, true]) {
  describe(`logging separation (diagnostic sink ${failure ? "failing" : "enabled"})`, () => {
    function sinkFor(lines: string[]): LogSink {
      return (line) => {
        if (failure) throw new Error("FAKE-RAW-DIAGNOSTIC-FAILURE");
        lines.push(line);
      };
    }

    it("keeps real health-report stdout exactly equal to saved bytes and diagnostics out of audit", async () => {
      const root = scope(),
        outputDir = join(root, "reports"),
        auditPath = join(root, "audit.jsonl");
      mkdirSync(outputDir);
      const fake = fakeReportComposition(auditPath, "precision");
      const args = healthReportArgs(outputDir);
      const stdout: string[] = [],
        errors: string[] = [],
        logs: string[] = [];
      const now = vi.fn(() => new Date(REPORT_TIME));
      const result = await runCliWithLogging(
        args,
        () =>
          runCli(
            args,
            {} as DoctorDeps,
            {
              log: (text) => {
                stdout.push(text);
              },
              error: (text) => {
                errors.push(text);
              },
            },
            undefined,
            undefined,
            {
              io: {
                write: (text) => {
                  stdout.push(text);
                },
                writeError: (text) => {
                  errors.push(text);
                },
              },
              compositionFactory: async () => fake.composition,
              now,
            },
          ),
        diagnostics(sinkFor(logs)),
      );
      expect(result).toBe(0);
      expect(stdout).toHaveLength(1);
      expect(readFileSync(join(outputDir, REPORT_FILE), "utf8")).toBe(stdout[0]);
      expect(now).toHaveBeenCalledTimes(1);
      expect(stdout[0]).not.toContain('"level"');
      expect(errors).toEqual([]);
      expect(logs).toHaveLength(failure ? 0 : 1);
      const audit = readAuditEntries(auditPath);
      expect(audit.some((entry) => entry.type === "verification.completed")).toBe(true);
      expect(
        audit.every(
          (entry) => !entry.type.startsWith("approval.") && !entry.type.includes("alert"),
        ),
      ).toBe(true);
      expect(readFileSync(auditPath, "utf8")).not.toContain("CLI command completed.");
    });

    it("preserves human-readable real approval prompts, approval ledger and mutation verification", async () => {
      const root = scope(),
        path = join(root, "audit.jsonl");
      const ledger = createFileAgentLedger(path),
        registry = new ToolRegistry();
      let executions = 0,
        verifications = 0,
        human = "";
      registry.register({
        name: "fake.publish",
        description: "Synthetic publish sentinel.",
        permission: "publish",
        inputSchema: { parse: (input: unknown) => input },
        outputSchema: { parse: (output: unknown) => output },
        async execute() {
          executions += 1;
          return { published: true };
        },
        async verify() {
          verifications += 1;
          return true;
        },
      });
      const binding: AgentToolBinding = {
        toolName: "fake.publish",
        llm: {
          name: "fake.publish",
          description: "Synthetic publish sentinel.",
          inputSchema: { type: "object" },
        },
        serializeResult: () => "Synthetic publication verified.",
        approval: {
          createRequestDigest: () => "fixed-safe-digest",
          createSafeSummary: () => "Publish synthetic sentinel output.",
        },
      };
      const input = new PassThrough(),
        output = new PassThrough();
      output.on("data", (chunk: Buffer) => {
        human += chunk.toString("utf8");
      });
      const prompt = createReadlineApprovalPrompt(input, output);
      const logs: string[] = [];
      const answer = setImmediate(() => input.write("yes\n"));
      try {
        expect(
          await runCliWithLogging(
            ["reviews", "reply", "synthetic-id"],
            async () => {
              const result = await runAgent({
                llm: scripted("fake.publish", {}),
                registry,
                bindings: [binding],
                messages: [{ role: "user", content: "Synthetic request." }],
                limits: { maxSteps: 2, maxToolCalls: 1, maxTotalTokens: 1 },
                ledger,
                runId: () => "logging-regression",
                now: () => new Date(REPORT_TIME),
                approvalResolver: {
                  resolve: (request) => approveInteractively(request, prompt, { ledger }),
                },
              });
              expect(result.ok).toBe(true);
              return result.ok ? 0 : 2;
            },
            diagnostics(sinkFor(logs)),
          ),
        ).toBe(0);
      } finally {
        clearImmediate(answer);
        input.destroy();
        output.destroy();
      }
      expect(human).toBe(
        "Approval required\n  Tool:       fake.publish\n  Permission: publish\n  Action:     Publish synthetic sentinel output.\nProceed? [y/N] ",
      );
      expect(human).not.toContain('"level"');
      expect(executions).toBe(1);
      expect(verifications).toBe(1);
      const audit = readAuditEntries(path);
      expect(audit.filter((entry) => entry.type === "approval.approved")).toHaveLength(1);
      expect(
        audit.filter(
          (entry) => entry.type === "verification.completed" && entry.metadata?.code === "VERIFIED",
        ),
      ).toHaveLength(1);
      expect(audit.some((entry) => entry.type === "agent.run.completed")).toBe(true);
      expect(readFileSync(path, "utf8")).not.toContain("CLI command completed.");
      expect(readFileSync(path, "utf8")).not.toContain("Publish synthetic sentinel output.");
    });

    it("preserves append-only audit shape, insertion order and legacy redaction", async () => {
      const path = join(scope(), "audit.jsonl");
      const metadata = {
        z: "kept",
        Authorization: "FAKE-AUDIT-SECRET",
        nested: { private_key: "FAKE-AUDIT-SECRET" },
        proofDigest: "digest",
      };
      const original = structuredClone(metadata);
      const first = appendAuditEntry(
        path,
        {
          type: "fixture.start",
          actor: "system",
          action: "fixture",
          status: "success",
          timestamp: REPORT_TIME,
          metadata,
        },
        { durable: true },
      );
      const prefix = readFileSync(path, "utf8");
      expect(prefix).toBe(JSON.stringify(first) + "\n");
      expect(JSON.stringify(first.metadata)).toBe(
        '{"z":"kept","Authorization":"[REDACTED]","nested":{"private_key":"[REDACTED]"},"proofDigest":"digest"}',
      );
      const logs: string[] = [];
      await runCliWithLogging(
        ["doctor"],
        async () => {
          appendAuditEntry(path, {
            type: "fixture.finish",
            actor: "system",
            action: "fixture",
            status: "success",
            timestamp: REPORT_TIME,
          });
          return 0;
        },
        diagnostics(sinkFor(logs)),
      );
      expect(readFileSync(path, "utf8").startsWith(prefix)).toBe(true);
      const entries = readAuditEntries(path);
      expect(entries).toHaveLength(2);
      expect(Object.keys(entries[1] ?? {}).sort()).toEqual([
        "action",
        "actor",
        "id",
        "status",
        "timestamp",
        "type",
      ]);
      expect(metadata).toEqual(original);
      expect(readFileSync(path, "utf8")).not.toContain("FAKE-AUDIT-SECRET");
    });

    it("keeps real durable threshold-alert audit events separate from diagnostics", async () => {
      const path = join(scope(), "audit.jsonl");
      const fake = fakeReportComposition(path);
      const composition = createHealthComposition(
        {
          ...DEFAULT_CONFIG,
          googlePlay: {
            packageName: "com.example.loggingfixture",
            serviceAccountJson: "FAKE-NOT-READ",
          },
          audit: { logPath: path },
          health: {
            crashRateReportedThreshold: "0",
            anrRateReportedThreshold: "0",
            excessiveWakeupRateReportedThreshold: "0",
          },
        },
        { reporting: fake.client },
      );
      const logs: string[] = [];
      await runCliWithLogging(
        ["health", "fixture-thresholds"],
        async () => {
          const result = await runAgent({
            llm: scripted("health.check_thresholds", THRESHOLD_QUERY),
            registry: composition.registry,
            bindings: composition.bindings,
            messages: [{ role: "user", content: "Synthetic threshold check." }],
            ledger: composition.ledger,
            limits: { maxSteps: 2, maxToolCalls: 1, maxTotalTokens: 1 },
          });
          expect(result.ok).toBe(true);
          return result.ok ? 0 : 1;
        },
        diagnostics(sinkFor(logs)),
      );
      const audit = readAuditEntries(path),
        alerts = audit.filter((entry) => entry.type === "health.threshold.alert");
      expect(alerts).toHaveLength(3);
      expect(alerts.map((entry) => entry.metadata?.metricKind)).toEqual([
        "crash_rate",
        "anr_rate",
        "excessive_wakeup_rate",
      ]);
      expect(
        alerts.every(
          (entry) => entry.metadata?.operator === ">" && entry.metadata.thresholdValue === "0",
        ),
      ).toBe(true);
      expect(audit.some((entry) => entry.type === "agent.run.completed")).toBe(true);
      expect(readFileSync(path, "utf8")).not.toContain("CLI command completed.");
      expect(logs.join("")).not.toContain("health.threshold.alert");
    });
  });
}

it("never applies diagnostic best-effort semantics to a failing durable audit write", async () => {
  const root = scope(),
    nonDirectory = join(root, "not-a-directory");
  writeFileSync(nonDirectory, "existing bytes");
  const result = runCliWithLogging(
    ["doctor"],
    async () => {
      appendAuditEntry(
        join(nonDirectory, "audit.jsonl"),
        { type: "fixture", actor: "system", action: "fixture", status: "success" },
        { durable: true },
      );
      return 0;
    },
    diagnostics(() => {
      throw new Error("FAKE-DIAGNOSTIC-ERROR");
    }),
  );
  await expect(result).rejects.toBeInstanceOf(AuditError);
  await expect(result).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });
  expect(readFileSync(nonDirectory, "utf8")).toBe("existing bytes");
});

/**
 * Phase 2.4 — verification model tests. Fake tools only; temp audit logs; no
 * network, no approvals, no execute.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAuditEntries, sanitizeAuditMetadata } from "../src/audit/index.js";
import * as approvals from "../src/runtime/approvals/index.js";
import * as permissions from "../src/runtime/permissions/index.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolPermissionLevel,
} from "../src/runtime/tools/index.js";
import { ToolRegistry } from "../src/runtime/tools/index.js";
import {
  createFileVerificationLedger,
  VerificationError,
  verifyToolOutcome,
  type VerificationLedger,
  type VerificationResult,
} from "../src/runtime/verification/index.js";

interface In {
  id: number;
  secretPassword?: string;
}
interface Out {
  ok: boolean;
  apiToken?: string;
}
const schema = <T>(): { parse(v: unknown): T } => ({ parse: (v) => v as T });
const RAW_INPUT_MARKER = "RAW-INPUT-MARKER-7a1";
const RAW_OUTPUT_MARKER = "RAW-OUTPUT-MARKER-9c3";
const SECRET_MARKER = "SECRET-IN-THROWN-ERROR-ff0";
const INPUT: In = { id: 42, secretPassword: RAW_INPUT_MARKER };
const OUTPUT: Out = { ok: true, apiToken: RAW_OUTPUT_MARKER };
const CONTEXT: ToolContext = Object.freeze({});

function makeTool(
  name: string,
  permission: ToolPermissionLevel,
  verify?: ToolDefinition<In, Out>["verify"],
): { tool: ToolDefinition<In, Out>; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => OUTPUT);
  const tool: ToolDefinition<In, Out> = {
    name,
    description: "fake",
    permission,
    inputSchema: schema<In>(),
    outputSchema: schema<Out>(),
    execute,
    ...(verify ? { verify } : {}),
  };
  return { tool, execute };
}

let dir: string;
let logPath: string;
let ledger: VerificationLedger;
beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "playops-verify-"));
  logPath = join(dir, "audit.jsonl");
  ledger = createFileVerificationLedger(logPath);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (
  tool: ToolDefinition<In, Out>,
  extra: Partial<Parameters<typeof verifyToolOutcome<In, Out>>[1]> = {},
) =>
  verifyToolOutcome({ tool, input: INPUT, output: OUTPUT, context: CONTEXT }, { ledger, ...extra });

const readLog = () => readFileSync(logPath, "utf8");

describe("policy: read is optional", () => {
  it("read without verifier → skipped / VERIFICATION_SKIPPED, required=false", async () => {
    const { tool } = makeTool("test.read", "read");
    const r = await run(tool);
    expect(r).toMatchObject({
      status: "skipped",
      code: "VERIFICATION_SKIPPED",
      required: false,
      verified: false,
    });
  });
  it("read verifier true → passed", async () => {
    const verify = vi.fn(async () => true);
    const r = await run(makeTool("test.read", "read", verify).tool);
    expect(r).toMatchObject({
      status: "passed",
      code: "VERIFIED",
      required: false,
      verified: true,
    });
    expect(verify).toHaveBeenCalledTimes(1);
  });
  it("read verifier false → failed", async () => {
    const r = await run(makeTool("test.read", "read", async () => false).tool);
    expect(r).toMatchObject({ status: "failed", code: "VERIFICATION_FAILED", verified: false });
  });
});

describe.each(["write", "destructive", "publish"] as const)("policy: %s is mandatory", (level) => {
  it("without verifier → failed / VERIFIER_REQUIRED, required=true", async () => {
    const r = await run(makeTool("test.mut", level).tool);
    expect(r).toMatchObject({
      status: "failed",
      code: "VERIFIER_REQUIRED",
      required: true,
      verified: false,
      permission: level,
    });
  });
  it("verifier true → passed", async () => {
    const r = await run(makeTool("test.mut", level, async () => true).tool);
    expect(r).toMatchObject({ status: "passed", code: "VERIFIED", required: true, verified: true });
  });
  it("verifier false → failed", async () => {
    const r = await run(makeTool("test.mut", level, async () => false).tool);
    expect(r).toMatchObject({
      status: "failed",
      code: "VERIFICATION_FAILED",
      required: true,
      verified: false,
    });
  });
});

describe("verifier errors", () => {
  it("throwing verifier → error / VERIFIER_ERROR result, not an exception", async () => {
    const r = await run(
      makeTool("test.write", "write", async () => {
        throw new Error(`boom ${SECRET_MARKER}`);
      }).tool,
    );
    expect(r).toMatchObject({ status: "error", code: "VERIFIER_ERROR", verified: false });
    expect(JSON.stringify(r)).not.toContain(SECRET_MARKER);
  });
  it("non-boolean verifier return is a VERIFIER_ERROR (fail closed)", async () => {
    const r = await run(
      makeTool(
        "test.write",
        "write",
        (async () => "yes") as unknown as ToolDefinition<In, Out>["verify"],
      ).tool,
    );
    expect(r.code).toBe("VERIFIER_ERROR");
  });
  it("raw thrown message and secret never enter audit JSONL", async () => {
    await run(
      makeTool("test.write", "write", async () => {
        throw new Error(`boom ${SECRET_MARKER}`);
      }).tool,
    );
    const log = readLog();
    expect(log).not.toContain(SECRET_MARKER);
    expect(log).not.toContain("boom");
    expect(JSON.parse(log.trim())).toMatchObject({
      type: "verification.completed",
      status: "failure",
      metadata: { code: "VERIFIER_ERROR", status: "error" },
    });
  });
});

describe("execution separation", () => {
  it("execute handler never called; approval & permission modules untouched", async () => {
    const approvalSpies = Object.entries(approvals)
      .filter(([, v]) => typeof v === "function" && !/^[A-Z]/.test(v.name))
      .map(([k]) => vi.spyOn(approvals, k as never));
    const permSpy = vi.spyOn(permissions, "evaluateToolPermission");
    const { tool, execute } = makeTool("test.delete", "destructive", async () => true);
    await run(tool);
    await run(makeTool("test.read", "read").tool);
    expect(execute).not.toHaveBeenCalled();
    for (const s of approvalSpies) expect(s).not.toHaveBeenCalled();
    expect(permSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("verifier contract", () => {
  it("receives input, output, context exactly once; nothing mutated", async () => {
    const verify = vi.fn(async () => true);
    const { tool } = makeTool("test.write", "write", verify);
    const correlation = { requestId: "req-1", requestDigest: "sha256:abc" };
    const snapshot = JSON.stringify({
      tool: {
        ...tool,
        execute: undefined,
        verify: undefined,
        inputSchema: undefined,
        outputSchema: undefined,
      },
      INPUT,
      OUTPUT,
      correlation,
    });
    await run(tool, { correlation });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(INPUT, OUTPUT, CONTEXT);
    const call = (verify.mock.calls as unknown as unknown[][])[0] ?? [];
    expect(call[0]).toBe(INPUT);
    expect(call[1]).toBe(OUTPUT);
    expect(call[2]).toBe(CONTEXT);
    expect(
      JSON.stringify({
        tool: {
          ...tool,
          execute: undefined,
          verify: undefined,
          inputSchema: undefined,
          outputSchema: undefined,
        },
        INPUT,
        OUTPUT,
        correlation,
      }),
    ).toBe(snapshot);
  });
  it("result is frozen and deterministic", async () => {
    const { tool } = makeTool("test.write", "write", async () => true);
    const a = await run(tool);
    const b = await run(tool);
    expect(Object.isFrozen(a)).toBe(true);
    expect(a).toEqual(b);
    expect(() => Object.assign(a, { verified: false })).toThrow();
  });
  it("works with a registered tool from ToolRegistry via typed definition", async () => {
    const registry = new ToolRegistry();
    const { tool, execute } = makeTool(
      "test.publish",
      "publish",
      async (i, o) => i.id === 42 && o.ok,
    );
    registry.register(tool);
    const r = await run(tool);
    expect(r.code).toBe("VERIFIED");
    expect(execute).not.toHaveBeenCalled();
    expect(registry.list()).toHaveLength(1);
  });
  it("fake mutation verifier can read back in-memory state", async () => {
    const store = new Map<number, boolean>([[42, true]]);
    const r = await run(
      makeTool("test.write", "write", async (i) => store.get(i.id) === true).tool,
    );
    expect(r.code).toBe("VERIFIED");
    store.set(42, false);
    const r2 = await run(
      makeTool("test.write", "write", async (i) => store.get(i.id) === true).tool,
    );
    expect(r2.code).toBe("VERIFICATION_FAILED");
  });
});

describe("audit", () => {
  it.each([
    ["passed", makeTool("test.write", "write", async () => true).tool, "success", "VERIFIED"],
    [
      "failed",
      makeTool("test.write", "write", async () => false).tool,
      "failure",
      "VERIFICATION_FAILED",
    ],
    ["skipped read", makeTool("test.read", "read").tool, "success", "VERIFICATION_SKIPPED"],
    [
      "missing mutation verifier",
      makeTool("test.delete", "destructive").tool,
      "failure",
      "VERIFIER_REQUIRED",
    ],
  ] as const)("%s → verification.completed recorded", async (_l, tool, status, code) => {
    await run(tool, { correlation: { requestId: "req-9", requestDigest: "sha256:d" } });
    const [entry] = await readAuditEntries(logPath);
    expect(entry).toMatchObject({
      type: "verification.completed",
      actor: "system",
      action: tool.name,
      status,
      metadata: {
        toolName: tool.name,
        permission: tool.permission,
        code,
        requestId: "req-9",
        requestDigest: "sha256:d",
      },
    });
    expect(typeof entry?.metadata?.required).toBe("boolean");
  });
  it("raw input/output/secrets absent from JSONL; only whitelisted keys", async () => {
    await run(makeTool("test.write", "write", async () => true).tool);
    const log = readLog();
    expect(log).not.toContain(RAW_INPUT_MARKER);
    expect(log).not.toContain(RAW_OUTPUT_MARKER);
    expect(log).not.toContain('"id":42');
    expect(log).not.toContain('"ok":true');
    const [entry] = await readAuditEntries(logPath);
    expect(Object.keys(entry?.metadata ?? {}).sort()).toEqual([
      "code",
      "permission",
      "required",
      "status",
      "toolName",
    ]);
  });
  it("correlation keys omitted from audit when not supplied", async () => {
    await run(makeTool("test.read", "read").tool);
    const [entry] = await readAuditEntries(logPath);
    expect(entry?.metadata ?? {}).not.toHaveProperty("requestId");
  });
  it("audit failure → typed VerificationError AUDIT_FAILURE with cause, safe message", async () => {
    const failing: VerificationLedger = {
      append: async () => {
        throw new Error(`disk full ${SECRET_MARKER}`);
      },
    };
    const p = verifyToolOutcome(
      {
        tool: makeTool("test.write", "write", async () => true).tool,
        input: INPUT,
        output: OUTPUT,
        context: CONTEXT,
      },
      { ledger: failing },
    );
    await expect(p).rejects.toBeInstanceOf(VerificationError);
    const err: unknown = await p.catch((e: unknown) => e);
    if (!(err instanceof VerificationError)) throw new Error("expected VerificationError");
    expect(err.code).toBe("AUDIT_FAILURE");
    expect(err.message).not.toContain(SECRET_MARKER);
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toContain("disk full");
  });
  it("existing sanitizer semantics intact for our metadata keys", () => {
    const meta = {
      toolName: "t",
      permission: "write",
      required: true,
      status: "passed",
      code: "VERIFIED",
      requestId: "r",
      requestDigest: "d",
    };
    expect(sanitizeAuditMetadata(meta)).toEqual(meta);
    expect(sanitizeAuditMetadata({ token: "x" })).toEqual({ token: "[REDACTED]" });
  });
});

describe("fail closed at untyped boundary", () => {
  it("unsupported permission → INVALID_TOOL failed result, recorded", async () => {
    const bad = {
      ...makeTool("test.x", "write").tool,
      permission: "admin",
    } as unknown as ToolDefinition<In, Out>;
    const r: VerificationResult = await run(bad);
    expect(r).toMatchObject({
      status: "failed",
      code: "INVALID_TOOL",
      required: true,
      verified: false,
    });
    expect(readLog()).toContain('"INVALID_TOOL"');
  });
  it("blank tool name / non-object tool → INVALID_TOOL", async () => {
    expect((await run({ ...makeTool("test.x", "write").tool, name: " " })).code).toBe(
      "INVALID_TOOL",
    );
    expect((await run(null as unknown as ToolDefinition<In, Out>)).code).toBe("INVALID_TOOL");
  });
  it("verify present but not a function → INVALID_TOOL", async () => {
    const bad = { ...makeTool("test.x", "write").tool, verify: 1 } as unknown as ToolDefinition<
      In,
      Out
    >;
    expect((await run(bad)).code).toBe("INVALID_TOOL");
  });
});

/**
 * Shared deterministic single-tool executor.
 *
 * These tests prove the executor drives the authoritative runAgent safety path
 * (registry -> permissions -> approval -> verifier -> audit) rather than
 * duplicating or bypassing any of it. Fully offline: fake tools, temp ledgers.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileAgentLedger, type AgentToolBinding } from "../src/runtime/agent/index.js";
import {
  DEFAULT_SINGLE_TOOL_CALL_ID,
  SingleToolExecutionError,
  createDeterministicToolAdapter,
  executeOneTool,
} from "../src/runtime/agent/execute-one-tool.js";
import { approveInteractively, createFileApprovalLedger } from "../src/runtime/approvals/index.js";
import { ToolRegistry, type ToolDefinition, type ToolSchema } from "../src/runtime/tools/index.js";
import { createFileVerificationLedger } from "../src/runtime/verification/index.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-exec-one-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const emptyInput: ToolSchema<Record<string, never>> = {
  parse(): Record<string, never> {
    return Object.freeze({});
  },
};

const numberOutput: ToolSchema<{ value: number }> = {
  parse(value: unknown): { value: number } {
    if (typeof value !== "object" || value === null) throw new Error("invalid output");
    const inner = (value as { value?: unknown }).value;
    if (typeof inner !== "number") throw new Error("invalid output");
    return Object.freeze({ value: inner });
  },
};

const doneOutput: ToolSchema<{ done: boolean }> = {
  parse(value: unknown): { done: boolean } {
    if (typeof value !== "object" || value === null) throw new Error("invalid output");
    const inner = (value as { done?: unknown }).done;
    if (typeof inner !== "boolean") throw new Error("invalid output");
    return Object.freeze({ done: inner });
  },
};

const readTool: ToolDefinition<Record<string, never>, unknown> = {
  name: "test.read",
  description: "Read-only test tool.",
  permission: "read",
  inputSchema: emptyInput,
  outputSchema: numberOutput,
  execute: async () => ({ value: 7 }),
};

const destructiveExecute = vi.fn(async () => ({ done: true }));

const destructiveTool: ToolDefinition<Record<string, never>, unknown> = {
  name: "test.destructive",
  description: "Destructive test tool.",
  permission: "destructive",
  inputSchema: emptyInput,
  outputSchema: doneOutput,
  execute: destructiveExecute,
  verify: async () => true,
};

/** Destructive tool with NO verifier: the executor must refuse to run it. */
const unverifiableTool: ToolDefinition<Record<string, never>, unknown> = {
  name: "test.unverifiable",
  description: "Destructive test tool without a verifier.",
  permission: "destructive",
  inputSchema: emptyInput,
  outputSchema: doneOutput,
  execute: async () => ({ done: true }),
};

function bindingFor(
  name: string,
  description: string,
  options: { readonly approval?: boolean; readonly echoOutput?: boolean } = {},
): AgentToolBinding {
  return {
    toolName: name,
    llm: {
      name,
      description,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    ...(options.approval === true
      ? {
          approval: {
            createRequestDigest: (): string => "d".repeat(64),
            createSafeSummary: (): string => "Test destructive action.",
          },
        }
      : {}),
    serializeResult: (output: unknown): string =>
      options.echoOutput === true ? JSON.stringify(output) : JSON.stringify({ ok: true }),
  };
}

const readBinding = bindingFor("test.read", "Read-only test tool.", { echoOutput: true });
const destructiveBinding = bindingFor("test.destructive", "Destructive test tool.", {
  approval: true,
});
const unverifiableBinding = bindingFor("test.unverifiable", "No verifier.", { approval: true });

function registryWith(
  ...tools: readonly ToolDefinition<Record<string, never>, unknown>[]
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}

describe("executeOneTool drives the authoritative safety path", () => {
  it("executes a read tool through runAgent and returns the serialized payload", async () => {
    const execution = await executeOneTool({
      registry: registryWith(readTool),
      binding: readBinding,
      input: {},
      ledger: createFileAgentLedger(join(tempDir(), "audit.jsonl")),
    });
    expect(execution.result.ok).toBe(true);
    expect(execution.result.toolCalls).toBe(1);
    expect(execution.payload).toEqual({ value: 7 });
  });

  it("fails closed with APPROVAL_REQUIRED and never executes when no resolver is supplied", async () => {
    destructiveExecute.mockClear();
    const execution = await executeOneTool({
      registry: registryWith(destructiveTool),
      binding: destructiveBinding,
      input: {},
      ledger: createFileAgentLedger(join(tempDir(), "audit.jsonl")),
    });
    expect(execution.result.ok).toBe(false);
    expect(execution.result.code).toBe("APPROVAL_REQUIRED");
    expect(destructiveExecute).not.toHaveBeenCalled();
  });

  it("executes a destructive tool once the human approval is granted", async () => {
    destructiveExecute.mockClear();
    const dir = tempDir();
    const approvalLedger = createFileApprovalLedger(join(dir, "approval.jsonl"));
    const execution = await executeOneTool({
      registry: registryWith(destructiveTool),
      binding: destructiveBinding,
      input: {},
      ledger: createFileAgentLedger(join(dir, "audit.jsonl")),
      approvalLedger,
      approvalResolver: {
        resolve: (request) =>
          approveInteractively(request, { ask: async () => "y" }, { ledger: approvalLedger }),
      },
      verificationLedger: createFileVerificationLedger(join(dir, "verification.jsonl")),
    });
    expect(execution.result.ok).toBe(true);
    expect(destructiveExecute).toHaveBeenCalledTimes(1);
  });

  it("denies execution when the human refuses", async () => {
    destructiveExecute.mockClear();
    const dir = tempDir();
    const approvalLedger = createFileApprovalLedger(join(dir, "approval.jsonl"));
    const execution = await executeOneTool({
      registry: registryWith(destructiveTool),
      binding: destructiveBinding,
      input: {},
      ledger: createFileAgentLedger(join(dir, "audit.jsonl")),
      approvalLedger,
      approvalResolver: {
        resolve: (request) =>
          approveInteractively(request, { ask: async () => "n" }, { ledger: approvalLedger }),
      },
    });
    expect(execution.result.ok).toBe(false);
    expect(execution.result.code).toBe("APPROVAL_DENIED");
    expect(destructiveExecute).not.toHaveBeenCalled();
  });

  it("refuses a mutating tool that declares no verifier", async () => {
    const dir = tempDir();
    const approvalLedger = createFileApprovalLedger(join(dir, "approval.jsonl"));
    const execution = await executeOneTool({
      registry: registryWith(unverifiableTool),
      binding: unverifiableBinding,
      input: {},
      ledger: createFileAgentLedger(join(dir, "audit.jsonl")),
      approvalLedger,
      approvalResolver: {
        resolve: (request) =>
          approveInteractively(request, { ask: async () => "y" }, { ledger: approvalLedger }),
      },
    });
    expect(execution.result.ok).toBe(false);
    expect(execution.result.code).toBe("VERIFIER_REQUIRED");
  });

  it("rejects an unregistered binding before any execution occurs", async () => {
    await expect(
      executeOneTool({
        registry: new ToolRegistry(),
        binding: readBinding,
        input: {},
        ledger: createFileAgentLedger(join(tempDir(), "audit.jsonl")),
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });
});

describe("deterministic tool adapter", () => {
  it("uses a stable default call id", () => {
    expect(DEFAULT_SINGLE_TOOL_CALL_ID).toBe("operator-step");
  });

  it("rejects a blank binding name or call id", () => {
    expect(() => createDeterministicToolAdapter({ ...readBinding, toolName: "  " }, {})).toThrow(
      SingleToolExecutionError,
    );
    expect(() => createDeterministicToolAdapter(readBinding, {}, " ")).toThrow(
      SingleToolExecutionError,
    );
  });

  it("emits exactly one tool call and then refuses a further turn", async () => {
    const adapter = createDeterministicToolAdapter(readBinding, {}, "step-x");
    const first = await adapter.complete({ messages: [], tools: [] });
    expect(first.toolCalls).toHaveLength(1);
    expect(first.toolCalls[0]?.name).toBe("test.read");
    expect(first.toolCalls[0]?.id).toBe("step-x");
    const second = await adapter.complete({
      messages: [{ role: "tool", toolCallId: "step-x", content: "{}" }],
      tools: [],
    });
    expect(second.toolCalls).toHaveLength(0);
    await expect(adapter.complete({ messages: [], tools: [] })).rejects.toThrow(
      SingleToolExecutionError,
    );
  });
});

/**
 * Phase 2.6 — agent loop tests. Scripted fake LlmAdapter, fake tools, temp audit
 * files, deterministic ids/estimators. No network, no Google, no 9Router.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAuditEntries } from "../src/audit/index.js";
import * as retryModule from "../src/googleplay/retry/index.js";
import {
  createFileAgentLedger,
  runAgent,
  type AgentApprovalResolver,
  type AgentLimits,
  type AgentRunResult,
  type AgentToolBinding,
} from "../src/runtime/agent/index.js";
import type { ApprovalGrant, ApprovalRequest } from "../src/runtime/approvals/index.js";
import {
  LlmError,
  type LlmAdapter,
  type LlmMessage,
  type LlmRequest,
  type LlmResponse,
} from "../src/runtime/llm/index.js";
import {
  ToolRegistry,
  type ToolDefinition,
  type ToolPermissionLevel,
} from "../src/runtime/tools/index.js";

// ---------- markers that must never appear in audit ----------
const USER_MARKER = "USER-MSG-MARKER-u1";
const SYSTEM_MARKER = "SYSTEM-MSG-MARKER-s1";
const ASSISTANT_MARKER = "ASSISTANT-TEXT-MARKER-a1";
const RAW_ARG_MARKER = "RAW-ARG-MARKER-r1";
const VALIDATED_MARKER = "VALIDATED-INPUT-MARKER-v1";
const RAW_OUTPUT_MARKER = "RAW-OUTPUT-MARKER-o1";
const SERIALIZED_MARKER = "SERIALIZED-RESULT-MARKER-z1";
const THROWN_SECRET = "THROWN-SECRET-MARKER-t1";
const ALL_MARKERS = [
  USER_MARKER,
  SYSTEM_MARKER,
  ASSISTANT_MARKER,
  RAW_ARG_MARKER,
  VALIDATED_MARKER,
  RAW_OUTPUT_MARKER,
  SERIALIZED_MARKER,
  THROWN_SECRET,
];

// ---------- fakes ----------
interface In {
  id: number;
  tag?: string;
}
interface Out {
  ok: boolean;
  payload?: string;
}

const inputSchema = {
  parse: (v: unknown): In => {
    if (typeof v !== "object" || v === null || typeof (v as { id?: unknown }).id !== "number")
      throw new Error(`bad input ${RAW_ARG_MARKER}`);
    return { id: (v as In).id, tag: VALIDATED_MARKER }; // normalized: tag replaced
  },
};
const outputSchema = {
  parse: (v: unknown): Out => {
    if (typeof v !== "object" || v === null || typeof (v as { ok?: unknown }).ok !== "boolean")
      throw new Error("bad output");
    return v as Out;
  },
};

interface FakeTool {
  def: ToolDefinition<In, Out>;
  execute: ReturnType<typeof vi.fn>;
  verify?: ReturnType<typeof vi.fn>;
}
function tool(
  name: string,
  permission: ToolPermissionLevel,
  opts: {
    verify?: boolean | "throw" | "false";
    output?: unknown;
    executeThrows?: boolean;
    noVerify?: boolean;
  } = {},
): FakeTool {
  const execute = vi.fn(async (): Promise<Out> => {
    if (opts.executeThrows) throw new Error(`exec failed ${THROWN_SECRET}`);
    return (opts.output ?? { ok: true, payload: RAW_OUTPUT_MARKER }) as Out;
  });
  const verify = opts.noVerify
    ? undefined
    : vi.fn(async () => {
        if (opts.verify === "throw") throw new Error(`verify failed ${THROWN_SECRET}`);
        return opts.verify !== "false";
      });
  const def: ToolDefinition<In, Out> = {
    name,
    description: "fake",
    permission,
    inputSchema,
    outputSchema,
    execute,
    ...(verify ? { verify } : {}),
  };
  return { def, execute, verify };
}

const binding = (toolName: string, extra: Partial<AgentToolBinding> = {}): AgentToolBinding => ({
  toolName,
  llm: {
    name: toolName,
    description: "fake tool",
    inputSchema: { type: "object", properties: { id: { type: "integer" } } },
  },
  serializeResult: (output, verification) =>
    `${SERIALIZED_MARKER}:${(output as Out).ok}:${verification.code}`,
  approval: {
    createRequestDigest: (input) => `sha256:fake-${(input as In).id}`,
    createSafeSummary: (input) => `Fake action on item ${(input as In).id}`,
  },
  ...extra,
});

const text = (content: string, usage = { totalTokens: 10 }): LlmResponse => ({
  content,
  toolCalls: [],
  finishReason: "stop",
  usage,
});
const calls = (
  toolCalls: { id: string; name: string; arguments: unknown }[],
  usage: LlmResponse["usage"] = { totalTokens: 10 },
  content?: string,
): LlmResponse => ({
  ...(content !== undefined ? { content } : {}),
  toolCalls,
  finishReason: "tool_calls",
  usage,
});

function scriptedLlm(responses: (LlmResponse | Error)[]): {
  adapter: LlmAdapter;
  requests: LlmRequest[];
  complete: ReturnType<typeof vi.fn>;
} {
  const requests: LlmRequest[] = [];
  const complete = vi.fn(async (request: LlmRequest): Promise<LlmResponse> => {
    requests.push(request);
    const next = responses.shift();
    if (!next) throw new Error("scripted LLM exhausted");
    if (next instanceof Error) throw next;
    return next;
  });
  return { adapter: { provider: "fake", complete }, requests, complete };
}

const approveAll: AgentApprovalResolver = {
  resolve: async (request: ApprovalRequest): Promise<ApprovalGrant> => ({
    record: { toolName: request.toolName, permission: request.permission, decision: "approved" },
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    source: "interactive",
  }),
};
const denyAll: AgentApprovalResolver = {
  resolve: async (request) => ({
    record: { toolName: request.toolName, permission: request.permission, decision: "denied" },
    requestId: request.requestId,
    requestDigest: request.requestDigest,
    source: "interactive",
  }),
};

let dir: string;
let logPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "playops-agent-"));
  logPath = join(dir, "audit.jsonl");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const limits: AgentLimits = { maxSteps: 10, maxToolCalls: 10, maxTotalTokens: 10_000 };
const messages: readonly LlmMessage[] = [
  { role: "system", content: SYSTEM_MARKER },
  { role: "user", content: USER_MARKER },
];
let seq = 0;
const runIds = () => `run-${++seq}`;

async function run(opts: {
  llm: LlmAdapter;
  tools: FakeTool[];
  bindings?: AgentToolBinding[];
  approval?: AgentApprovalResolver;
  limits?: Partial<AgentLimits>;
  estimateCost?: (r: LlmResponse) => number;
  maxEstimatedCost?: number;
  ledgerPath?: string;
}): Promise<AgentRunResult> {
  const registry = new ToolRegistry();
  for (const t of opts.tools) registry.register(t.def);
  return runAgent({
    llm: opts.llm,
    registry,
    bindings: opts.bindings ?? opts.tools.map((t) => binding(t.def.name)),
    messages,
    limits: { ...limits, ...opts.limits },
    ledger: createFileAgentLedger(opts.ledgerPath ?? logPath),
    ...(opts.approval ? { approvalResolver: opts.approval } : {}),
    ...(opts.estimateCost ? { estimateCost: opts.estimateCost } : {}),
    ...(opts.maxEstimatedCost !== undefined ? { maxEstimatedCost: opts.maxEstimatedCost } : {}),
    runId: runIds,
    now: () => new Date("2026-09-26T00:00:00Z"),
  });
}
const auditText = () => readFileSync(logPath, "utf8");
const auditTypes = () => readAuditEntries(logPath).map((e) => e.type);
const expectNoMarkers = () => {
  const t = auditText();
  for (const m of ALL_MARKERS) expect(t, m).not.toContain(m);
};

// ================= CORE FLOW =================
describe("core flow", () => {
  it("plain response → COMPLETED with final content; conversation order preserved", async () => {
    const { adapter } = scriptedLlm([text(ASSISTANT_MARKER)]);
    const r = await run({ llm: adapter, tools: [] });
    expect(r).toMatchObject({
      code: "COMPLETED",
      ok: true,
      finalContent: ASSISTANT_MARKER,
      steps: 1,
      toolCalls: 0,
      totalTokens: 10,
    });
    expect(r.conversation.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(Object.isFrozen(r)).toBe(true);
  });
  it("tool call → execute (validated input) → tool result with same id → next turn; history preserved", async () => {
    const read = tool("test.read", "read", { noVerify: true });
    const { adapter, requests } = scriptedLlm([
      calls([{ id: "c1", name: "test.read", arguments: { id: 7, tag: RAW_ARG_MARKER } }]),
      text("done"),
    ]);
    const r = await run({ llm: adapter, tools: [read] });
    expect(r.code).toBe("COMPLETED");
    expect(read.execute).toHaveBeenCalledTimes(1);
    expect(read.execute.mock.calls[0]?.[0]).toEqual({ id: 7, tag: VALIDATED_MARKER });
    const second = requests[1]?.messages ?? [];
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(second[2]).toMatchObject({
      role: "assistant",
      toolCalls: [{ id: "c1", name: "test.read" }],
    });
    expect(second[3]).toEqual({
      role: "tool",
      toolCallId: "c1",
      content: `${SERIALIZED_MARKER}:true:VERIFICATION_SKIPPED`,
    });
    expect(requests[0]?.tools?.[0]?.name).toBe("test.read");
    expect(r.steps).toBe(2);
    expect(r.toolCalls).toBe(1);
  });
  it("multiple tool calls execute sequentially in model order with matching ids", async () => {
    const a = tool("test.a", "read", { noVerify: true });
    const b = tool("test.b", "read", { noVerify: true });
    const order: string[] = [];
    a.execute.mockImplementation(async () => {
      order.push("a");
      return { ok: true };
    });
    b.execute.mockImplementation(async () => {
      order.push("b");
      return { ok: true };
    });
    const { adapter, requests } = scriptedLlm([
      calls([
        { id: "x1", name: "test.b", arguments: { id: 1 } },
        { id: "x2", name: "test.a", arguments: { id: 2 } },
      ]),
      text("done"),
    ]);
    await run({ llm: adapter, tools: [a, b] });
    expect(order).toEqual(["b", "a"]);
    expect(
      (requests[1]?.messages ?? [])
        .filter((m) => m.role === "tool")
        .map((m) => (m as { toolCallId: string }).toolCallId),
    ).toEqual(["x1", "x2"]);
  });
  it("empty model turn → EMPTY_RESPONSE, no spin", async () => {
    const { adapter, complete } = scriptedLlm([{ toolCalls: [], usage: { totalTokens: 1 } }]);
    const r = await run({ llm: adapter, tools: [] });
    expect(r.code).toBe("EMPTY_RESPONSE");
    expect(r.ok).toBe(false);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

// ================= SCHEMA SAFETY =================
describe("schema safety", () => {
  it("invalid input → INPUT_INVALID, execute 0, raw args and schema error absent from audit", async () => {
    const w = tool("test.write", "write");
    const { adapter } = scriptedLlm([
      calls([
        { id: "c1", name: "test.write", arguments: { id: "not-a-number", tag: RAW_ARG_MARKER } },
      ]),
    ]);
    const r = await run({ llm: adapter, tools: [w] });
    expect(r.code).toBe("INPUT_INVALID");
    expect(w.execute).not.toHaveBeenCalled();
    expectNoMarkers();
    expect(auditText()).not.toContain("bad input");
  });
  it("invalid output → OUTPUT_INVALID; verifier and serializer never run; mutation flagged uncertain", async () => {
    const w = tool("test.write", "write", { output: { nope: 1 } });
    const serialize = vi.fn(() => "x");
    const { adapter, complete } = scriptedLlm([
      calls([{ id: "c1", name: "test.write", arguments: { id: 1 } }]),
    ]);
    const r = await run({
      llm: adapter,
      tools: [w],
      bindings: [binding("test.write", { serializeResult: serialize })],
    });
    expect(r.code).toBe("OUTPUT_INVALID");
    expect(r.externalStateUncertain).toBe(true);
    expect(w.verify).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    expectNoMarkers();
  });
  it("invalid read output → OUTPUT_INVALID without uncertain external state", async () => {
    const rd = tool("test.read", "read", { output: "junk", noVerify: true });
    const { adapter } = scriptedLlm([
      calls([{ id: "c1", name: "test.read", arguments: { id: 1 } }]),
    ]);
    const r = await run({ llm: adapter, tools: [rd] });
    expect(r.code).toBe("OUTPUT_INVALID");
    expect(r.externalStateUncertain).toBe(false);
  });
});

// ================= VERIFIER PREFLIGHT =================
describe("mutation verifier preflight", () => {
  it("read without verifier executes", async () => {
    const rd = tool("test.read", "read", { noVerify: true });
    const r = await run({
      llm: scriptedLlm([calls([{ id: "c1", name: "test.read", arguments: { id: 1 } }]), text("ok")])
        .adapter,
      tools: [rd],
    });
    expect(r.code).toBe("COMPLETED");
    expect(rd.execute).toHaveBeenCalledTimes(1);
  });
  it.each(["write", "destructive", "publish"] as const)(
    "%s without verifier → VERIFIER_REQUIRED, execute 0",
    async (level) => {
      const t = tool("test.mut", level, { noVerify: true });
      const r = await run({
        llm: scriptedLlm([calls([{ id: "c1", name: "test.mut", arguments: { id: 1 } }])]).adapter,
        tools: [t],
        approval: approveAll,
      });
      expect(r.code).toBe("VERIFIER_REQUIRED");
      expect(t.execute).not.toHaveBeenCalled();
      expect(auditTypes()).toContain("agent.tool.denied");
    },
  );
});

// ================= PERMISSIONS / APPROVALS =================
describe("permissions and approvals", () => {
  it.each(["read", "write"] as const)("%s executes without approval resolver", async (level) => {
    const t = tool("test.t", level, level === "read" ? { noVerify: true } : {});
    const r = await run({
      llm: scriptedLlm([calls([{ id: "c1", name: "test.t", arguments: { id: 1 } }]), text("ok")])
        .adapter,
      tools: [t],
    });
    expect(r.code).toBe("COMPLETED");
    expect(t.execute).toHaveBeenCalledTimes(1);
  });
  it.each(["destructive", "publish"] as const)(
    "%s with no resolver → APPROVAL_REQUIRED, execute 0, verifier 0",
    async (level) => {
      const t = tool("test.hi", level);
      const r = await run({
        llm: scriptedLlm([calls([{ id: "c1", name: "test.hi", arguments: { id: 1 } }])]).adapter,
        tools: [t],
      });
      expect(r.code).toBe("APPROVAL_REQUIRED");
      expect(t.execute).not.toHaveBeenCalled();
      expect(t.verify).not.toHaveBeenCalled();
      expect(auditTypes()).toEqual(
        expect.arrayContaining(["agent.tool.denied", "agent.run.failed"]),
      );
      expect(auditTypes()).not.toContain("approval.requested");
    },
  );
  it.each(["destructive", "publish"] as const)(
    "%s denied approval → APPROVAL_DENIED, execute 0",
    async (level) => {
      const t = tool("test.hi", level);
      const r = await run({
        llm: scriptedLlm([calls([{ id: "c1", name: "test.hi", arguments: { id: 1 } }])]).adapter,
        tools: [t],
        approval: denyAll,
      });
      expect(r.code).toBe("APPROVAL_DENIED");
      expect(t.execute).not.toHaveBeenCalled();
      expect(auditTypes()).toEqual(
        expect.arrayContaining(["approval.requested", "agent.tool.denied"]),
      );
    },
  );
  it.each(["destructive", "publish"] as const)(
    "%s matching approval → executes once, verifies once",
    async (level) => {
      const t = tool("test.hi", level);
      const seen: ApprovalRequest[] = [];
      const resolver: AgentApprovalResolver = {
        resolve: async (req) => {
          seen.push(req);
          return approveAll.resolve(req);
        },
      };
      const r = await run({
        llm: scriptedLlm([
          calls([{ id: "c1", name: "test.hi", arguments: { id: 42, tag: RAW_ARG_MARKER } }]),
          text("ok"),
        ]).adapter,
        tools: [t],
        approval: resolver,
      });
      expect(r.code).toBe("COMPLETED");
      expect(t.execute).toHaveBeenCalledTimes(1);
      expect(t.verify).toHaveBeenCalledTimes(1);
      expect(seen[0]).toMatchObject({
        toolName: "test.hi",
        permission: level,
        requestDigest: "sha256:fake-42",
        safeSummary: "Fake action on item 42",
      });
      expect(seen[0]?.safeSummary).not.toContain(RAW_ARG_MARKER);
      expect(seen[0]?.safeSummary).not.toContain(VALIDATED_MARKER);
      expect(seen[0]?.requestId).not.toBe("run-" + seq);
    },
  );
  it("mismatched grant (other tool / other request) cannot execute", async () => {
    const t = tool("test.hi", "destructive");
    const wrong: AgentApprovalResolver = {
      resolve: async (req) => ({
        record: { toolName: "other.tool", permission: "destructive", decision: "approved" },
        requestId: req.requestId,
        requestDigest: req.requestDigest,
        source: "token",
      }),
    };
    const r = await run({
      llm: scriptedLlm([calls([{ id: "c1", name: "test.hi", arguments: { id: 1 } }])]).adapter,
      tools: [t],
      approval: wrong,
    });
    expect(r.code).toBe("APPROVAL_DENIED");
    expect(t.execute).not.toHaveBeenCalled();
    const wrongReq: AgentApprovalResolver = {
      resolve: async (req) => ({
        record: { toolName: req.toolName, permission: req.permission, decision: "approved" },
        requestId: "different-request",
        requestDigest: req.requestDigest,
        source: "token",
      }),
    };
    const r2 = await run({
      llm: scriptedLlm([calls([{ id: "c1", name: "test.hi", arguments: { id: 1 } }])]).adapter,
      tools: [t],
      approval: wrongReq,
    });
    expect(r2.code).toBe("APPROVAL_DENIED");
    expect(t.execute).not.toHaveBeenCalled();
  });
  it("high-risk binding without approval callbacks / blank callback results → INVALID_BINDING before run", async () => {
    const t = tool("test.hi", "destructive");
    await expect(
      run({
        llm: scriptedLlm([]).adapter,
        tools: [t],
        bindings: [binding("test.hi", { approval: undefined })],
        approval: approveAll,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    const blank = binding("test.hi", {
      approval: { createRequestDigest: () => " ", createSafeSummary: () => "x" },
    });
    const r = await run({
      llm: scriptedLlm([calls([{ id: "c1", name: "test.hi", arguments: { id: 1 } }])]).adapter,
      tools: [t],
      bindings: [blank],
      approval: approveAll,
    });
    expect(r.code).toBe("APPROVAL_REQUIRED");
    expect(t.execute).not.toHaveBeenCalled();
  });
});

// ================= BATCH PREFLIGHT =================
describe("two-pass batch preflight", () => {
  const w = () => tool("test.write", "write");
  it("two valid reads → both execute in order", async () => {
    const a = tool("test.a", "read", { noVerify: true });
    const b = tool("test.b", "read", { noVerify: true });
    const r = await run({
      llm: scriptedLlm([
        calls([
          { id: "1", name: "test.a", arguments: { id: 1 } },
          { id: "2", name: "test.b", arguments: { id: 2 } },
        ]),
        text("ok"),
      ]).adapter,
      tools: [a, b],
    });
    expect(r.code).toBe("COMPLETED");
    expect(a.execute).toHaveBeenCalledTimes(1);
    expect(b.execute).toHaveBeenCalledTimes(1);
  });
  it("valid write + invalid input → neither executes", async () => {
    const t = w();
    const r = await run({
      llm: scriptedLlm([
        calls([
          { id: "1", name: "test.write", arguments: { id: 1 } },
          { id: "2", name: "test.write", arguments: { id: "bad" } },
        ]),
      ]).adapter,
      tools: [t],
    });
    expect(r.code).toBe("INPUT_INVALID");
    expect(t.execute).not.toHaveBeenCalled();
  });
  it("valid write + unapproved destructive → neither executes", async () => {
    const t = w();
    const d = tool("test.del", "destructive");
    const r = await run({
      llm: scriptedLlm([
        calls([
          { id: "1", name: "test.write", arguments: { id: 1 } },
          { id: "2", name: "test.del", arguments: { id: 2 } },
        ]),
      ]).adapter,
      tools: [t, d],
    });
    expect(r.code).toBe("APPROVAL_REQUIRED");
    expect(t.execute).not.toHaveBeenCalled();
    expect(d.execute).not.toHaveBeenCalled();
  });
  it("duplicate toolCall ids → none execute", async () => {
    const t = w();
    const r = await run({
      llm: scriptedLlm([
        calls([
          { id: "dup", name: "test.write", arguments: { id: 1 } },
          { id: "dup", name: "test.write", arguments: { id: 2 } },
        ]),
      ]).adapter,
      tools: [t],
    });
    expect(r.code).toBe("INVALID_TOOL_CALL");
    expect(t.execute).not.toHaveBeenCalled();
  });
  it("blank toolCall id → none execute", async () => {
    const t = w();
    const r = await run({
      llm: scriptedLlm([calls([{ id: " ", name: "test.write", arguments: { id: 1 } }])]).adapter,
      tools: [t],
    });
    expect(r.code).toBe("INVALID_TOOL_CALL");
    expect(t.execute).not.toHaveBeenCalled();
  });
  it("unknown second tool (registered but unbound, or unregistered) → none execute", async () => {
    const t = w();
    const hidden = tool("test.hidden", "read", { noVerify: true });
    const r = await run({
      llm: scriptedLlm([
        calls([
          { id: "1", name: "test.write", arguments: { id: 1 } },
          { id: "2", name: "test.hidden", arguments: { id: 2 } },
        ]),
      ]).adapter,
      tools: [t, hidden],
      bindings: [binding("test.write")],
    });
    expect(r.code).toBe("UNKNOWN_TOOL");
    expect(t.execute).not.toHaveBeenCalled();
    expect(hidden.execute).not.toHaveBeenCalled();
    const r2 = await run({
      llm: scriptedLlm([calls([{ id: "1", name: "no.such", arguments: {} }])]).adapter,
      tools: [t],
    });
    expect(r2.code).toBe("UNKNOWN_TOOL");
  });
  it("batch over remaining maxToolCalls → none execute; exact equality allowed", async () => {
    const a = tool("test.a", "read", { noVerify: true });
    const r = await run({
      llm: scriptedLlm([
        calls([
          { id: "1", name: "test.a", arguments: { id: 1 } },
          { id: "2", name: "test.a", arguments: { id: 2 } },
          { id: "3", name: "test.a", arguments: { id: 3 } },
        ]),
      ]).adapter,
      tools: [a],
      limits: { maxToolCalls: 2 },
    });
    expect(r.code).toBe("MAX_TOOL_CALLS_REACHED");
    expect(a.execute).not.toHaveBeenCalled();
    const b = tool("test.a", "read", { noVerify: true });
    const r2 = await run({
      llm: scriptedLlm([
        calls([
          { id: "1", name: "test.a", arguments: { id: 1 } },
          { id: "2", name: "test.a", arguments: { id: 2 } },
        ]),
        text("ok"),
      ]).adapter,
      tools: [b],
      limits: { maxToolCalls: 2 },
    });
    expect(r2.code).toBe("COMPLETED");
    expect(b.execute).toHaveBeenCalledTimes(2);
  });
});

// ================= VERIFICATION =================
describe("verification integration", () => {
  it("read verifier false → VERIFICATION_FAILED; nothing sent to LLM", async () => {
    const rd = tool("test.read", "read", { verify: "false" });
    const { adapter, complete } = scriptedLlm([
      calls([{ id: "c1", name: "test.read", arguments: { id: 1 } }]),
    ]);
    const r = await run({ llm: adapter, tools: [rd] });
    expect(r.code).toBe("VERIFICATION_FAILED");
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it.each(["write", "destructive", "publish"] as const)(
    "%s verifier true → continues; result serialized with VERIFIED",
    async (level) => {
      const t = tool("test.m", level);
      const { adapter, requests } = scriptedLlm([
        calls([{ id: "c1", name: "test.m", arguments: { id: 1 } }]),
        text("ok"),
      ]);
      const r = await run({ llm: adapter, tools: [t], approval: approveAll });
      expect(r.code).toBe("COMPLETED");
      expect((requests[1]?.messages.at(-1) as { content: string }).content).toContain("VERIFIED");
    },
  );
  it("write verifier false / throw → VERIFICATION_FAILED; serializer never called; external state uncertain", async () => {
    for (const mode of ["false", "throw"] as const) {
      const t = tool("test.write", "write", { verify: mode });
      const serialize = vi.fn(() => "x");
      const r = await run({
        llm: scriptedLlm([calls([{ id: "c1", name: "test.write", arguments: { id: 1 } }])]).adapter,
        tools: [t],
        bindings: [binding("test.write", { serializeResult: serialize })],
      });
      expect(r.code).toBe("VERIFICATION_FAILED");
      expect(serialize).not.toHaveBeenCalled();
      expect(r.externalStateUncertain).toBe(true);
      expect(auditTypes()).toContain("verification.completed");
      expectNoMarkers();
    }
  });
});

// ================= EXECUTION / SERIALIZATION =================
describe("execution and serialization", () => {
  it("execute throws → EXECUTION_FAILED; raw error absent from audit; cause preserved", async () => {
    const t = tool("test.write", "write", { executeThrows: true });
    const r = await run({
      llm: scriptedLlm([calls([{ id: "c1", name: "test.write", arguments: { id: 1 } }])]).adapter,
      tools: [t],
    });
    expect(r.code).toBe("EXECUTION_FAILED");
    expect(r.externalStateUncertain).toBe(true);
    expect((r.cause as Error | undefined)?.message).toContain("exec failed");
    expectNoMarkers();
    expect(auditTypes()).toContain("agent.tool.execution.failed");
  });
  it("serializer runs only after verification; throws / non-string → SERIALIZATION_FAILED; raw output never used", async () => {
    const t = tool("test.write", "write");
    const order: string[] = [];
    t.verify?.mockImplementation(async () => {
      order.push("verify");
      return true;
    });
    const ser = vi.fn(() => {
      order.push("serialize");
      throw new Error(THROWN_SECRET);
    });
    const { adapter, complete } = scriptedLlm([
      calls([{ id: "c1", name: "test.write", arguments: { id: 1 } }]),
    ]);
    const r = await run({
      llm: adapter,
      tools: [t],
      bindings: [binding("test.write", { serializeResult: ser })],
    });
    expect(r.code).toBe("SERIALIZATION_FAILED");
    expect(order).toEqual(["verify", "serialize"]);
    expect(complete).toHaveBeenCalledTimes(1);
    expectNoMarkers();
    const t2 = tool("test.write", "write");
    const r2 = await run({
      llm: scriptedLlm([calls([{ id: "c1", name: "test.write", arguments: { id: 1 } }])]).adapter,
      tools: [t2],
      bindings: [
        binding("test.write", {
          serializeResult: (() => ({
            raw: RAW_OUTPUT_MARKER,
          })) as unknown as AgentToolBinding["serializeResult"],
        }),
      ],
    });
    expect(r2.code).toBe("SERIALIZATION_FAILED");
  });
});

// ================= GUARDS =================
describe("limits validation", () => {
  it.each([
    [{ maxSteps: 0 }],
    [{ maxSteps: 1.5 }],
    [{ maxToolCalls: -1 }],
    [{ maxTotalTokens: 0 }],
    [{ maxTotalTokens: Number.NaN }],
  ] as const)("invalid limits %j → INVALID_CONFIG before any LLM call", async (bad) => {
    const { adapter, complete } = scriptedLlm([text("x")]);
    await expect(run({ llm: adapter, tools: [], limits: bad })).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
    expect(complete).not.toHaveBeenCalled();
  });
  it("duplicate binding / binding to unregistered tool / llm name mismatch → INVALID_CONFIG", async () => {
    const rd = tool("test.read", "read", { noVerify: true });
    await expect(
      run({
        llm: scriptedLlm([]).adapter,
        tools: [rd],
        bindings: [binding("test.read"), binding("test.read")],
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await expect(
      run({ llm: scriptedLlm([]).adapter, tools: [rd], bindings: [binding("test.nope")] }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await expect(
      run({
        llm: scriptedLlm([]).adapter,
        tools: [rd],
        bindings: [
          binding("test.read", { llm: { name: "other", description: "d", inputSchema: {} } }),
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    await expect(
      run({ llm: scriptedLlm([]).adapter, tools: [], maxEstimatedCost: 1 }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
  });
});

describe("step guard", () => {
  it("final answer exactly at maxSteps allowed", async () => {
    const rd = tool("test.read", "read", { noVerify: true });
    const r = await run({
      llm: scriptedLlm([
        calls([{ id: "1", name: "test.read", arguments: { id: 1 } }]),
        text("final"),
      ]).adapter,
      tools: [rd],
      limits: { maxSteps: 2 },
    });
    expect(r.code).toBe("COMPLETED");
    expect(r.steps).toBe(2);
  });
  it("tool calls on the final allowed step are NOT executed → MAX_STEPS_REACHED; no LLM call beyond", async () => {
    const rd = tool("test.read", "read", { noVerify: true });
    const { adapter, complete } = scriptedLlm([
      calls([{ id: "1", name: "test.read", arguments: { id: 1 } }]),
      text("never"),
    ]);
    const r = await run({ llm: adapter, tools: [rd], limits: { maxSteps: 1 } });
    expect(r.code).toBe("MAX_STEPS_REACHED");
    expect(rd.execute).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe("token budget", () => {
  const rd = () => tool("test.read", "read", { noVerify: true });
  it("totalTokens accumulated; fallback to input+output; exact equality allowed", async () => {
    const t = rd();
    const r = await run({
      llm: scriptedLlm([
        calls([{ id: "1", name: "test.read", arguments: { id: 1 } }], { totalTokens: 60 }),
        text("ok", { inputTokens: 30, outputTokens: 10 } as never),
      ]).adapter,
      tools: [t],
      limits: { maxTotalTokens: 100 },
    });
    expect(r.code).toBe("COMPLETED");
    expect(r.totalTokens).toBe(100);
  });
  it("exceeding budget → TOKEN_BUDGET_EXCEEDED before tool execution; no further LLM call", async () => {
    const t = rd();
    const { adapter, complete } = scriptedLlm([
      calls([{ id: "1", name: "test.read", arguments: { id: 1 } }], { totalTokens: 101 }),
      text("never"),
    ]);
    const r = await run({ llm: adapter, tools: [t], limits: { maxTotalTokens: 100 } });
    expect(r.code).toBe("TOKEN_BUDGET_EXCEEDED");
    expect(t.execute).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(r.totalTokens).toBe(101);
  });
  it("missing usable usage → USAGE_UNAVAILABLE, no tool execution", async () => {
    const t = rd();
    const r = await run({
      llm: scriptedLlm([
        calls([{ id: "1", name: "test.read", arguments: { id: 1 } }], { inputTokens: 5 }),
      ]).adapter,
      tools: [t],
    });
    expect(r.code).toBe("USAGE_UNAVAILABLE");
    expect(t.execute).not.toHaveBeenCalled();
    const r2 = await run({
      llm: scriptedLlm([{ content: "x", toolCalls: [] }]).adapter,
      tools: [],
    });
    expect(r2.code).toBe("USAGE_UNAVAILABLE");
  });
});

describe("estimated cost guard", () => {
  const rd = () => tool("test.read", "read", { noVerify: true });
  it("deterministic estimator accumulated; exact equality allowed", async () => {
    const t = rd();
    const r = await run({
      llm: scriptedLlm([calls([{ id: "1", name: "test.read", arguments: { id: 1 } }]), text("ok")])
        .adapter,
      tools: [t],
      estimateCost: () => 0.5,
      maxEstimatedCost: 1,
    });
    expect(r.code).toBe("COMPLETED");
    expect(r.estimatedCost).toBe(1);
  });
  it("exceeding cost → COST_BUDGET_EXCEEDED before tool execution", async () => {
    const t = rd();
    const r = await run({
      llm: scriptedLlm([calls([{ id: "1", name: "test.read", arguments: { id: 1 } }])]).adapter,
      tools: [t],
      estimateCost: () => 1.5,
      maxEstimatedCost: 1,
    });
    expect(r.code).toBe("COST_BUDGET_EXCEEDED");
    expect(t.execute).not.toHaveBeenCalled();
  });
  const badEstimators: [string, (r: LlmResponse) => number][] = [
    [
      "throw",
      (): number => {
        throw new Error(THROWN_SECRET);
      },
    ],
    ["NaN", (): number => Number.NaN],
    ["Infinity", (): number => Number.POSITIVE_INFINITY],
    ["negative", (): number => -1],
  ];
  it.each(badEstimators)("estimator %s → COST_ESTIMATION_FAILED", async (_l, est) => {
    const t = rd();
    const r = await run({
      llm: scriptedLlm([calls([{ id: "1", name: "test.read", arguments: { id: 1 } }])]).adapter,
      tools: [t],
      estimateCost: est,
      maxEstimatedCost: 1,
    });
    expect(r.code).toBe("COST_ESTIMATION_FAILED");
    expect(t.execute).not.toHaveBeenCalled();
    expectNoMarkers();
  });
  it("no pricing table in the agent core", () => {
    const src = readFileSync(new URL("../src/runtime/agent/index.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/gpt-|claude|gemini|per[_-]?million|\$\d/i);
  });
});

// ================= AUDIT =================
describe("audit", () => {
  it("lifecycle events recorded with allowlisted metadata only; no content markers", async () => {
    const w = tool("test.write", "write");
    const r = await run({
      llm: scriptedLlm([
        calls([{ id: "c1", name: "test.write", arguments: { id: 1, tag: RAW_ARG_MARKER } }], {
          totalTokens: 7,
        }),
        text(ASSISTANT_MARKER, { totalTokens: 3 }),
      ]).adapter,
      tools: [w],
    });
    expect(r.code).toBe("COMPLETED");
    expect(auditTypes()).toEqual([
      "agent.run.started",
      "agent.llm.completed",
      "agent.tool.requested",
      "agent.tool.allowed",
      "agent.tool.execution.started",
      "verification.completed",
      "agent.tool.execution.completed",
      "agent.llm.completed",
      "agent.run.completed",
    ]);
    const entries = readAuditEntries(logPath);
    const allowed = new Set([
      "runId",
      "step",
      "toolCallId",
      "toolName",
      "permission",
      "decisionCode",
      "requestId",
      "requestDigest",
      "verificationStatus",
      "verificationCode",
      "provider",
      "model",
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "cumulativeTotalTokens",
      "estimatedCost",
      "cumulativeEstimatedCost",
      "code",
      "toolCallCount",
      "finishReason",
      "externalStateUncertain",
      "required",
      "status",
      "steps",
    ]);
    for (const e of entries)
      for (const k of Object.keys(e.metadata ?? {})) expect(allowed, `${e.type}.${k}`).toContain(k);
    expect(entries[1]?.metadata).toMatchObject({
      runId: "run-" + seq,
      step: 1,
      provider: "fake",
      totalTokens: 7,
      cumulativeTotalTokens: 7,
    });
    expect(entries.at(-1)?.metadata).toMatchObject({
      code: "COMPLETED",
      cumulativeTotalTokens: 10,
    });
    expectNoMarkers();
  });
  it("pre-execution audit failure → execute 0, AUDIT_FAILURE", async () => {
    const w = tool("test.write", "write");
    let n = 0;
    const ledger = {
      append: async (entry: { type: string }) => {
        n++;
        if (entry.type === "agent.tool.execution.started") throw new Error(`disk ${THROWN_SECRET}`);
      },
    };
    const registry = new ToolRegistry();
    registry.register(w.def);
    const r = await runAgent({
      llm: scriptedLlm([calls([{ id: "c1", name: "test.write", arguments: { id: 1 } }])]).adapter,
      registry,
      bindings: [binding("test.write")],
      messages,
      limits,
      ledger,
      verificationLedger: createFileAgentLedger(logPath),
      runId: runIds,
    });
    expect(r.code).toBe("AUDIT_FAILURE");
    expect(w.execute).not.toHaveBeenCalled();
    expect(r.externalStateUncertain).toBe(false);
    expect(n).toBeGreaterThan(0);
  });
  it("post-execution audit failure → run cannot report success; state uncertain", async () => {
    const w = tool("test.write", "write");
    const ledger = {
      append: async (entry: { type: string }) => {
        if (entry.type === "agent.tool.execution.completed") throw new Error("disk");
      },
    };
    const registry = new ToolRegistry();
    registry.register(w.def);
    const r = await runAgent({
      llm: scriptedLlm([calls([{ id: "c1", name: "test.write", arguments: { id: 1 } }]), text("x")])
        .adapter,
      registry,
      bindings: [binding("test.write")],
      messages,
      limits,
      ledger,
      verificationLedger: createFileAgentLedger(logPath),
      runId: runIds,
    });
    expect(r.code).toBe("AUDIT_FAILURE");
    expect(r.ok).toBe(false);
    expect(w.execute).toHaveBeenCalledTimes(1);
    expect(r.externalStateUncertain).toBe(true);
  });
});

// ================= LLM FAILURE =================
describe("LLM failures propagate safely, no retry", () => {
  it.each(["HTTP_ERROR", "TIMEOUT"] as const)(
    "LlmError %s → LLM_FAILED, complete called once, no Google retry module",
    async (code) => {
      const spies = Object.keys(retryModule)
        .filter(
          (k) =>
            typeof (retryModule as Record<string, unknown>)[k] === "function" && /^[a-z]/.test(k),
        )
        .map((k) => vi.spyOn(retryModule, k as never));
      const { adapter, complete } = scriptedLlm([
        new LlmError(code, "boom", "fake", "chat.completions", 429),
      ]);
      const r = await run({ llm: adapter, tools: [] });
      expect(r.code).toBe("LLM_FAILED");
      expect(complete).toHaveBeenCalledTimes(1);
      expect((r.cause as LlmError).code).toBe(code);
      for (const s of spies) expect(s).not.toHaveBeenCalled();
      expect(auditTypes()).toContain("agent.run.failed");
    },
  );
});

// ================= IMMUTABILITY =================
describe("immutability", () => {
  it("initial messages, limits, bindings, registry unchanged", async () => {
    const rd = tool("test.read", "read", { noVerify: true });
    const registry = new ToolRegistry();
    registry.register(rd.def);
    const msgs: LlmMessage[] = [{ role: "user", content: "hi" }];
    const lim: AgentLimits = { maxSteps: 5, maxToolCalls: 5, maxTotalTokens: 500 };
    const b = [binding("test.read")];
    const snap = JSON.stringify({
      msgs,
      lim,
      b: b.map((x) => ({ toolName: x.toolName, llm: x.llm })),
      tools: registry.list().map((t) => t.name),
    });
    const r = await runAgent({
      llm: scriptedLlm([calls([{ id: "1", name: "test.read", arguments: { id: 1 } }]), text("ok")])
        .adapter,
      registry,
      bindings: b,
      messages: msgs,
      limits: lim,
      ledger: createFileAgentLedger(logPath),
      runId: runIds,
    });
    expect(r.code).toBe("COMPLETED");
    expect(msgs).toHaveLength(1);
    expect(
      JSON.stringify({
        msgs,
        lim,
        b: b.map((x) => ({ toolName: x.toolName, llm: x.llm })),
        tools: registry.list().map((t) => t.name),
      }),
    ).toBe(snap);
    expect(r.conversation).toHaveLength(4);
  });
});

// ================= END-TO-END ACCEPTANCE =================
describe("scripted end-to-end acceptance", () => {
  it("read → write (verified) → final answer, with safe audit", async () => {
    const store = new Map<number, string>();
    const rd = tool("reviews.list", "read", { noVerify: true });
    rd.execute.mockImplementation(async () => ({ ok: true, payload: "2 reviews" }));
    const wr = tool("reviews.mark", "write");
    wr.execute.mockImplementation(async (input: In) => {
      store.set(input.id, "marked");
      return { ok: true };
    });
    wr.verify?.mockImplementation(async (input: In) => store.get(input.id) === "marked");
    const { adapter, requests } = scriptedLlm([
      calls([{ id: "t1", name: "reviews.list", arguments: { id: 0 } }], { totalTokens: 20 }),
      calls([{ id: "t2", name: "reviews.mark", arguments: { id: 5 } }], { totalTokens: 30 }),
      text("Marked review 5.", { totalTokens: 10 }),
    ]);
    const r = await run({ llm: adapter, tools: [rd, wr] });
    expect(r).toMatchObject({
      code: "COMPLETED",
      finalContent: "Marked review 5.",
      steps: 3,
      toolCalls: 2,
      totalTokens: 60,
    });
    expect(rd.execute).toHaveBeenCalledTimes(1);
    expect(wr.execute).toHaveBeenCalledTimes(1);
    expect(wr.verify).toHaveBeenCalledTimes(1);
    expect(wr.execute.mock.calls[0]?.[0]).toEqual({ id: 5, tag: VALIDATED_MARKER });
    expect(
      requests[2]?.messages
        .filter((m) => m.role === "tool")
        .map((m) => (m as { toolCallId: string }).toolCallId),
    ).toEqual(["t1", "t2"]);
    expect(auditTypes().filter((t) => t === "verification.completed")).toHaveLength(2);
    expect(auditTypes().filter((t) => t === "agent.tool.execution.completed")).toHaveLength(2);
    expectNoMarkers();
    expect(auditText()).not.toContain("2 reviews");
    expect(auditText()).not.toContain("Marked review");
  });
  it("high-risk: unapproved publish refused; approved publish executes once and completes", async () => {
    const pub = tool("release.publish", "publish");
    const r1 = await run({
      llm: scriptedLlm([calls([{ id: "p1", name: "release.publish", arguments: { id: 100 } }])])
        .adapter,
      tools: [pub],
    });
    expect(r1.code).toBe("APPROVAL_REQUIRED");
    expect(pub.execute).not.toHaveBeenCalled();
    expect(pub.verify).not.toHaveBeenCalled();
    expect(auditTypes()).toEqual([
      "agent.run.started",
      "agent.llm.completed",
      "agent.tool.requested",
      "agent.tool.denied",
      "agent.run.failed",
    ]);
    const pub2 = tool("release.publish", "publish");
    const { adapter, requests } = scriptedLlm([
      calls([{ id: "p1", name: "release.publish", arguments: { id: 100 } }]),
      text("Published."),
    ]);
    const r2 = await run({ llm: adapter, tools: [pub2], approval: approveAll });
    expect(r2.code).toBe("COMPLETED");
    expect(pub2.execute).toHaveBeenCalledTimes(1);
    expect(pub2.verify).toHaveBeenCalledTimes(1);
    expect((requests[1]?.messages.at(-1) as { content: string }).content).toContain("VERIFIED");
    expect(auditTypes()).toEqual(
      expect.arrayContaining([
        "approval.requested",
        "agent.tool.allowed",
        "verification.completed",
        "agent.run.completed",
      ]),
    );
    // `approval.approved` is written by the Phase 2.3 resolvers (interactive/token),
    // not by the loop; a fake resolver therefore leaves only `approval.requested`.
    const denied = readAuditEntries(logPath).find((e) => e.type === "agent.tool.allowed");
    expect(denied?.metadata).toMatchObject({
      toolName: "release.publish",
      permission: "publish",
      decisionCode: "ALLOWED",
      requestDigest: "sha256:fake-100",
    });
  });
});

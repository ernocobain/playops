/**
 * Agent loop (Phase 2.6).
 *
 * Composes Phases 2.1–2.5 into one bounded, fail-closed runtime loop:
 *
 *   LLM → tool calls → [PASS 1 preflight ALL] → [PASS 2 execute sequentially]
 *   → output schema → verification → safe serialization → tool results → LLM …
 *
 * Preflight per call: nonblank/unique id → binding → registry tool → binding
 * name = registry name → inputSchema.parse(args) → mutation verifier present →
 * evaluateToolPermission → approval (injected resolver) → re-evaluate. If ANY
 * call in a batch fails, NONE execute. Execution is sequential, in model order,
 * and NOT transactional: a later failure does not roll back earlier calls; audit
 * makes partial state visible and `externalStateUncertain` flags it.
 *
 * One step = one LlmAdapter.complete() call. No LLM retry. Token/cost guards are
 * checked after each response and BEFORE executing its tool calls (the request
 * itself has already been spent).
 *
 * Audit metadata is an explicit allowlist: never message content, arguments,
 * validated input, output, serialized results, raw errors, tokens, or keys.
 */
import { randomUUID } from "node:crypto";
import {
  appendAuditEntry,
  readAuditEntries,
  type AuditEntry,
  type NewAuditEntry,
} from "../../audit/index.js";
import {
  ApprovalGateError,
  createApprovalRequest,
  type ApprovalGrant,
  type ApprovalLedger,
  type ApprovalRequest,
} from "../approvals/index.js";
import {
  LlmError,
  type LlmAdapter,
  type LlmMessage,
  type LlmResponse,
  type LlmToolCall,
  type LlmToolDefinition,
} from "../llm/index.js";
import { evaluateToolPermission, type PermissionDecision } from "../permissions/index.js";
import {
  TOOL_PERMISSION_LEVELS,
  type RegisteredTool,
  type ToolContext,
  type ToolDefinition,
  type ToolPermissionLevel,
  type ToolRegistry,
} from "../tools/index.js";
import {
  VerificationError,
  verifyToolOutcome,
  type VerificationLedger,
  type VerificationResult,
} from "../verification/index.js";

// ---------------------------------------------------------------- public types

export interface AgentToolBinding {
  readonly toolName: string;
  /** Model-facing declaration; `llm.name` must equal `toolName`. */
  readonly llm: LlmToolDefinition;
  /** Explicit safety/presentation boundary; the only content the LLM ever sees. */
  readonly serializeResult: (output: unknown, verification: VerificationResult) => string;
  /** Mandatory for destructive/publish tools; loop never derives these itself. */
  readonly approval?: {
    readonly createRequestDigest: (validatedInput: unknown) => string;
    readonly createSafeSummary: (validatedInput: unknown) => string;
  };
}

export interface AgentApprovalResolver {
  resolve(request: ApprovalRequest): Promise<ApprovalGrant>;
}

export interface AgentLimits {
  /** One step = one LlmAdapter.complete() call. */
  readonly maxSteps: number;
  readonly maxToolCalls: number;
  readonly maxTotalTokens: number;
}

/** Async append boundary over the Phase 0.6 audit log. */
export interface AgentLedger {
  append(entry: NewAuditEntry): Promise<void>;
}

export interface AgentRunConfig {
  readonly llm: LlmAdapter;
  readonly registry: ToolRegistry;
  readonly bindings: readonly AgentToolBinding[];
  readonly messages: readonly LlmMessage[];
  readonly limits: AgentLimits;
  readonly ledger: AgentLedger;
  /** Defaults to `ledger`; separate only for tests. */
  readonly verificationLedger?: VerificationLedger;
  /**
   * Sync append/read ledger for Phase 2.3 `createApprovalRequest`. Defaults to
   * `ledger` when it also implements `ApprovalLedger` (as `createFileAgentLedger`
   * does); otherwise a destructive/publish call fails closed as APPROVAL_REQUIRED.
   */
  readonly approvalLedger?: ApprovalLedger;
  readonly approvalResolver?: AgentApprovalResolver;
  readonly estimateCost?: (response: LlmResponse) => number;
  readonly maxEstimatedCost?: number;
  readonly model?: string;
  readonly runId?: () => string;
  readonly now?: () => Date;
  readonly context?: ToolContext;
}

export type AgentRunCode =
  | "COMPLETED"
  | "EMPTY_RESPONSE"
  | "INVALID_TOOL_CALL"
  | "UNKNOWN_TOOL"
  | "INPUT_INVALID"
  | "OUTPUT_INVALID"
  | "VERIFIER_REQUIRED"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_DENIED"
  | "PERMISSION_DENIED"
  | "EXECUTION_FAILED"
  | "VERIFICATION_FAILED"
  | "SERIALIZATION_FAILED"
  | "MAX_STEPS_REACHED"
  | "MAX_TOOL_CALLS_REACHED"
  | "TOKEN_BUDGET_EXCEEDED"
  | "USAGE_UNAVAILABLE"
  | "COST_BUDGET_EXCEEDED"
  | "COST_ESTIMATION_FAILED"
  | "LLM_FAILED"
  | "AUDIT_FAILURE";

export interface AgentRunResult {
  readonly runId: string;
  readonly ok: boolean;
  readonly code: AgentRunCode;
  readonly finalContent?: string;
  readonly steps: number;
  readonly toolCalls: number;
  readonly totalTokens: number;
  readonly estimatedCost: number;
  /** True when a mutation may have executed without verified/recorded completion. No rollback is performed. */
  readonly externalStateUncertain: boolean;
  readonly conversation: readonly LlmMessage[];
  /** Infrastructure cause, preserved programmatically only. */
  readonly cause?: unknown;
}

/** Programmer/configuration failure only; everything at runtime is a result. */
export class AgentRunError extends Error {
  override readonly name = "AgentRunError";
  constructor(
    readonly code: "INVALID_CONFIG",
    message: string,
  ) {
    super(message);
  }
}

/**
 * One ledger over the existing audit JSONL usable by agent (async), verification
 * (async) and approval (sync) modules. `appendAuditEntry` is synchronous, so the
 * write is complete before the returned promise resolves; the sync
 * `ApprovalLedger.append` contract (`void`) is satisfied by the same call — the
 * ignored promise is already settled. This is the single documented cast.
 */
export function createFileAgentLedger(
  logPath: string,
): AgentLedger & VerificationLedger & ApprovalLedger {
  const append = (entry: NewAuditEntry): Promise<void> => {
    appendAuditEntry(logPath, entry);
    return Promise.resolve();
  };
  const read = (): readonly AuditEntry[] => readAuditEntries(logPath);
  return { append, read } as unknown as AgentLedger & VerificationLedger & ApprovalLedger;
}

// ---------------------------------------------------------------- internals

const ACTOR = "agent";
const MUTATING: ReadonlySet<ToolPermissionLevel> = new Set(["write", "destructive", "publish"]);
const GATED: ReadonlySet<ToolPermissionLevel> = new Set(["destructive", "publish"]);

const isBlank = (v: unknown): boolean => typeof v !== "string" || !v.trim();
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** Domain tools may explicitly mark a known pre-mutation failure as safe. */
function mutationFailureIsUncertain(cause: unknown): boolean {
  return !(
    typeof cause === "object" &&
    cause !== null &&
    Reflect.get(cause, "externalStateUncertain") === false
  );
}
const invalidConfig = (m: string): never => {
  throw new AgentRunError("INVALID_CONFIG", `Invalid agent configuration: ${m}`);
};

/**
 * THE ONE narrow dynamic-execution boundary. `RegisteredTool` erases generics
 * (Phase 2.1) so nobody can call handlers on unvalidated data. Here, and only
 * here, after `inputSchema.parse` has produced a value the tool's own schema
 * accepted, we view the tool as `ToolDefinition<unknown, unknown>` to invoke it.
 * TypeScript cannot recover Input/Output from a dynamic name; the cast is
 * sound because the parsed value is exactly what the schema promised.
 */
function asCallable(tool: RegisteredTool): ToolDefinition<unknown, unknown> {
  return tool as unknown as ToolDefinition<unknown, unknown>;
}

interface PreflightedCall {
  readonly call: LlmToolCall;
  readonly tool: RegisteredTool;
  readonly binding: AgentToolBinding;
  readonly input: unknown;
  readonly decision: PermissionDecision;
  readonly request?: ApprovalRequest;
}

interface Denial {
  readonly code: AgentRunCode;
  readonly call?: LlmToolCall;
  readonly toolName?: string;
  readonly permission?: ToolPermissionLevel;
  readonly decisionCode?: string;
  readonly requestId?: string;
  readonly requestDigest?: string;
}

interface Budget {
  totalTokens: number;
  estimatedCost: number;
  toolCalls: number;
}

class RunAudit {
  constructor(
    private readonly ledger: AgentLedger,
    private readonly runId: string,
    private readonly now: () => Date,
  ) {}
  async append(
    type: string,
    action: string,
    status: NewAuditEntry["status"],
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const safe: Record<string, unknown> = { runId: this.runId };
    for (const [k, v] of Object.entries(metadata)) if (v !== undefined) safe[k] = v;
    await this.ledger.append({
      type,
      actor: ACTOR,
      action,
      status,
      timestamp: this.now().toISOString(),
      metadata: safe,
    });
  }
}

function resolveUsage(r: LlmResponse): number | undefined {
  const u = r.usage;
  if (!u) return undefined;
  if (typeof u.totalTokens === "number" && Number.isFinite(u.totalTokens) && u.totalTokens >= 0)
    return u.totalTokens;
  if (
    typeof u.inputTokens === "number" &&
    typeof u.outputTokens === "number" &&
    Number.isFinite(u.inputTokens + u.outputTokens) &&
    u.inputTokens >= 0 &&
    u.outputTokens >= 0
  ) {
    return u.inputTokens + u.outputTokens;
  }
  return undefined;
}

function validateConfig(c: AgentRunConfig): void {
  if (typeof c !== "object" || c === null) invalidConfig("config must be an object");
  if (!c.llm || typeof c.llm.complete !== "function") invalidConfig("llm adapter required");
  if (!c.registry || typeof c.registry.get !== "function") invalidConfig("registry required");
  if (!c.ledger || typeof c.ledger.append !== "function") invalidConfig("ledger required");
  if (!Array.isArray(c.messages) || c.messages.length === 0)
    invalidConfig("messages must be a non-empty array");
  const l = c.limits;
  if (!l || !isPosInt(l.maxSteps)) invalidConfig("limits.maxSteps must be a positive integer");
  if (!isPosInt(l.maxToolCalls)) invalidConfig("limits.maxToolCalls must be a positive integer");
  if (!(
    typeof l.maxTotalTokens === "number" &&
    Number.isFinite(l.maxTotalTokens) &&
    l.maxTotalTokens > 0
  ))
    invalidConfig("limits.maxTotalTokens must be positive");
  if (c.maxEstimatedCost !== undefined) {
    if (!(Number.isFinite(c.maxEstimatedCost) && c.maxEstimatedCost >= 0))
      invalidConfig("maxEstimatedCost must be finite and non-negative");
    if (typeof c.estimateCost !== "function")
      invalidConfig("maxEstimatedCost requires estimateCost");
  }
  if (!Array.isArray(c.bindings)) invalidConfig("bindings must be an array");
  const seen = new Set<string>();
  for (const b of c.bindings) {
    if (!b || isBlank(b.toolName)) invalidConfig("binding toolName must be nonblank");
    if (seen.has(b.toolName)) invalidConfig(`duplicate binding for ${b.toolName}`);
    seen.add(b.toolName);
    if (!c.registry.has(b.toolName))
      invalidConfig(`binding refers to unregistered tool ${b.toolName}`);
    if (!b.llm || b.llm.name !== b.toolName)
      invalidConfig(`binding llm.name must equal toolName for ${b.toolName}`);
    if (typeof b.serializeResult !== "function")
      invalidConfig(`binding ${b.toolName} requires serializeResult`);
    const tool = c.registry.get(b.toolName);
    if (GATED.has(tool.permission)) {
      if (
        !b.approval ||
        typeof b.approval.createRequestDigest !== "function" ||
        typeof b.approval.createSafeSummary !== "function"
      ) {
        invalidConfig(
          `binding ${b.toolName} (${tool.permission}) requires approval.createRequestDigest and createSafeSummary`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------- run

export async function runAgent(config: AgentRunConfig): Promise<AgentRunResult> {
  validateConfig(config);
  const now = config.now ?? (() => new Date());
  const runId = (config.runId ?? randomUUID)();
  const audit = new RunAudit(config.ledger, runId, now);
  const verificationLedger: VerificationLedger = config.verificationLedger ?? config.ledger;
  const approvalLedger: ApprovalLedger | undefined =
    config.approvalLedger ?? (hasSyncRead(config.ledger) ? config.ledger : undefined);
  const bindings = new Map(config.bindings.map((b) => [b.toolName, b] as const));
  const llmTools: readonly LlmToolDefinition[] = Object.freeze(config.bindings.map((b) => b.llm));
  const conversation: LlmMessage[] = [...config.messages];
  const budget: Budget = { totalTokens: 0, estimatedCost: 0, toolCalls: 0 };
  const context: ToolContext = config.context ?? Object.freeze({});
  let steps = 0;
  let uncertain = false;

  const finish = (
    code: AgentRunCode,
    extra: { finalContent?: string; cause?: unknown } = {},
  ): AgentRunResult =>
    Object.freeze({
      runId,
      ok: code === "COMPLETED",
      code,
      ...(extra.finalContent !== undefined ? { finalContent: extra.finalContent } : {}),
      steps,
      toolCalls: budget.toolCalls,
      totalTokens: budget.totalTokens,
      estimatedCost: budget.estimatedCost,
      externalStateUncertain: uncertain,
      conversation: Object.freeze([...conversation]),
      ...(extra.cause !== undefined ? { cause: extra.cause } : {}),
    });

  const runMeta = () => ({
    steps,
    toolCallCount: budget.toolCalls,
    cumulativeTotalTokens: budget.totalTokens,
    cumulativeEstimatedCost: budget.estimatedCost,
    externalStateUncertain: uncertain,
  });

  /** Terminal helper: records agent.run.failed; audit failure here degrades to AUDIT_FAILURE result. */
  const fail = async (code: AgentRunCode, cause?: unknown): Promise<AgentRunResult> => {
    try {
      await audit.append("agent.run.failed", "agent.run", "failure", { code, ...runMeta() });
    } catch (auditCause) {
      return finish("AUDIT_FAILURE", { cause: auditCause });
    }
    return finish(code, { cause });
  };

  try {
    await audit.append("agent.run.started", "agent.run", "pending", {
      provider: config.llm.provider,
      model: config.model,
      toolCallCount: 0,
      cumulativeTotalTokens: 0,
      cumulativeEstimatedCost: 0,
    });
  } catch (cause) {
    return finish("AUDIT_FAILURE", { cause });
  }

  // ------------------------------------------------------------ main loop
  for (;;) {
    if (steps >= config.limits.maxSteps) return fail("MAX_STEPS_REACHED");
    steps += 1;

    let response: LlmResponse;
    try {
      response = await config.llm.complete({
        messages: Object.freeze([...conversation]),
        ...(llmTools.length > 0 ? { tools: llmTools } : {}),
      });
    } catch (cause) {
      return fail("LLM_FAILED", cause instanceof LlmError ? cause : cause);
    }

    // --- budgets (request already spent; guards stop side effects and further calls)
    const used = resolveUsage(response);
    if (used === undefined) {
      await safeAppend(audit, "agent.llm.completed", "failure", {
        step: steps,
        provider: config.llm.provider,
        model: response.model ?? config.model,
        finishReason: response.finishReason,
        code: "USAGE_UNAVAILABLE",
        cumulativeTotalTokens: budget.totalTokens,
      });
      return fail("USAGE_UNAVAILABLE");
    }
    budget.totalTokens += used;
    let stepCost: number | undefined;
    if (config.estimateCost) {
      try {
        stepCost = config.estimateCost(response);
      } catch (cause) {
        await safeAppend(audit, "agent.llm.completed", "failure", {
          step: steps,
          code: "COST_ESTIMATION_FAILED",
          cumulativeTotalTokens: budget.totalTokens,
        });
        return fail("COST_ESTIMATION_FAILED", cause);
      }
      if (typeof stepCost !== "number" || !Number.isFinite(stepCost) || stepCost < 0) {
        await safeAppend(audit, "agent.llm.completed", "failure", {
          step: steps,
          code: "COST_ESTIMATION_FAILED",
          cumulativeTotalTokens: budget.totalTokens,
        });
        return fail("COST_ESTIMATION_FAILED");
      }
      budget.estimatedCost += stepCost;
    }
    try {
      await audit.append("agent.llm.completed", "agent.llm", "success", {
        step: steps,
        provider: config.llm.provider,
        model: response.model ?? config.model,
        finishReason: response.finishReason,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        totalTokens: used,
        cumulativeTotalTokens: budget.totalTokens,
        estimatedCost: stepCost,
        cumulativeEstimatedCost: budget.estimatedCost,
        toolCallCount: response.toolCalls.length,
      });
    } catch (cause) {
      return finish("AUDIT_FAILURE", { cause });
    }

    // Append assistant turn to history (tool-call history preserved for continuation).
    conversation.push(
      Object.freeze({
        role: "assistant",
        ...(response.content !== undefined ? { content: response.content } : {}),
        ...(response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
      }),
    );

    if (budget.totalTokens > config.limits.maxTotalTokens) return fail("TOKEN_BUDGET_EXCEEDED");
    if (config.maxEstimatedCost !== undefined && budget.estimatedCost > config.maxEstimatedCost)
      return fail("COST_BUDGET_EXCEEDED");

    // --- terminal / empty turns
    if (response.toolCalls.length === 0) {
      if (isBlank(response.content)) return fail("EMPTY_RESPONSE");
      try {
        await audit.append("agent.run.completed", "agent.run", "success", {
          code: "COMPLETED",
          ...runMeta(),
        });
      } catch (cause) {
        return finish("AUDIT_FAILURE", { cause });
      }
      return finish("COMPLETED", { finalContent: response.content });
    }

    // Tool calls whose results could never be observed within the step budget are not executed.
    if (steps >= config.limits.maxSteps) return fail("MAX_STEPS_REACHED");
    if (budget.toolCalls + response.toolCalls.length > config.limits.maxToolCalls)
      return fail("MAX_TOOL_CALLS_REACHED");

    // ------------------------------------------------------------ PASS 1: preflight all
    const preflighted: PreflightedCall[] = [];
    const ids = new Set<string>();
    for (const call of response.toolCalls) {
      const outcome = await preflight(call, ids, {
        config,
        bindings,
        audit,
        steps,
        approvalLedger,
        now,
      });
      if ("code" in outcome) {
        await safeAppend(audit, "agent.tool.denied", "denied", {
          step: steps,
          toolCallId: outcome.call?.id,
          toolName: outcome.toolName,
          permission: outcome.permission,
          code: outcome.code,
          decisionCode: outcome.decisionCode,
          requestId: outcome.requestId,
          requestDigest: outcome.requestDigest,
        });
        return fail(outcome.code);
      }
      preflighted.push(outcome);
    }

    // ------------------------------------------------------------ PASS 2: execute sequentially (NOT transactional)
    const toolResults: LlmMessage[] = [];
    for (const p of preflighted) {
      const { call, tool, binding, input, decision, request } = p;
      const base = {
        step: steps,
        toolCallId: call.id,
        toolName: tool.name,
        permission: tool.permission,
        decisionCode: decision.code,
        requestId: request?.requestId,
        requestDigest: request?.requestDigest,
      };
      try {
        await audit.append("agent.tool.allowed", tool.name, "success", base);
        await audit.append("agent.tool.execution.started", tool.name, "pending", base);
      } catch (cause) {
        return finish("AUDIT_FAILURE", { cause }); // nothing executed for this call
      }
      const mutating = MUTATING.has(tool.permission);
      let rawOutput: unknown;
      try {
        rawOutput = await asCallable(tool).execute(input, context);
      } catch (cause) {
        if (mutating && mutationFailureIsUncertain(cause)) uncertain = true;
        await safeAppend(audit, "agent.tool.execution.failed", "failure", {
          ...base,
          code: "EXECUTION_FAILED",
          externalStateUncertain: uncertain,
        });
        return fail("EXECUTION_FAILED", cause);
      }
      budget.toolCalls += 1;
      let output: unknown;
      try {
        output = tool.outputSchema.parse(rawOutput);
      } catch {
        if (mutating) uncertain = true;
        await safeAppend(audit, "agent.tool.execution.failed", "failure", {
          ...base,
          code: "OUTPUT_INVALID",
          externalStateUncertain: uncertain,
        });
        return fail("OUTPUT_INVALID");
      }
      let verification: VerificationResult;
      try {
        verification = await verifyToolOutcome(
          { tool: asCallable(tool), input, output, context },
          {
            ledger: verificationLedger,
            correlation: {
              ...(request
                ? { requestId: request.requestId, requestDigest: request.requestDigest }
                : {}),
            },
          },
        );
      } catch (cause) {
        if (mutating) uncertain = true;
        return finish("AUDIT_FAILURE", {
          cause: cause instanceof VerificationError ? cause : cause,
        });
      }
      const verificationOk =
        verification.code === "VERIFIED" ||
        (!mutating && verification.code === "VERIFICATION_SKIPPED");
      if (!verificationOk) {
        if (mutating) uncertain = true;
        await safeAppend(audit, "agent.tool.execution.failed", "failure", {
          ...base,
          code: "VERIFICATION_FAILED",
          verificationStatus: verification.status,
          verificationCode: verification.code,
          externalStateUncertain: uncertain,
        });
        return fail("VERIFICATION_FAILED");
      }
      let serialized: unknown;
      try {
        serialized = binding.serializeResult(output, verification);
      } catch {
        serialized = undefined;
      }
      if (typeof serialized !== "string") {
        // Mutation happened and verified, but its result cannot be presented; do not fall back to raw output.
        await safeAppend(audit, "agent.tool.execution.failed", "failure", {
          ...base,
          code: "SERIALIZATION_FAILED",
          verificationStatus: verification.status,
          verificationCode: verification.code,
        });
        return fail("SERIALIZATION_FAILED");
      }
      try {
        await audit.append("agent.tool.execution.completed", tool.name, "success", {
          ...base,
          verificationStatus: verification.status,
          verificationCode: verification.code,
        });
      } catch (cause) {
        if (mutating) uncertain = true;
        return finish("AUDIT_FAILURE", { cause });
      }
      toolResults.push(Object.freeze({ role: "tool", toolCallId: call.id, content: serialized }));
    }
    conversation.push(...toolResults);
  }
}

function hasSyncRead(ledger: AgentLedger): ledger is AgentLedger & ApprovalLedger {
  return typeof (ledger as Partial<ApprovalLedger>).read === "function";
}

/** Best-effort audit for a path that is already failing; a second failure must not mask the first. */
async function safeAppend(
  audit: RunAudit,
  type: string,
  status: NewAuditEntry["status"],
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await audit.append(
      type,
      typeof metadata.toolName === "string" ? metadata.toolName : "agent.run",
      status,
      metadata,
    );
  } catch {
    /* swallowed deliberately: the primary failure code is reported instead */
  }
}

interface PreflightDeps {
  readonly config: AgentRunConfig;
  readonly bindings: ReadonlyMap<string, AgentToolBinding>;
  readonly audit: RunAudit;
  readonly steps: number;
  readonly approvalLedger: ApprovalLedger | undefined;
  readonly now: () => Date;
}

async function preflight(
  call: LlmToolCall,
  ids: Set<string>,
  d: PreflightDeps,
): Promise<PreflightedCall | Denial> {
  if (isBlank(call.id) || ids.has(call.id)) return { code: "INVALID_TOOL_CALL", call };
  ids.add(call.id);
  const binding = d.bindings.get(call.name);
  if (!binding || !d.config.registry.has(call.name))
    return { code: "UNKNOWN_TOOL", call, toolName: isBlank(call.name) ? undefined : call.name };
  const tool = d.config.registry.get(call.name);
  if (tool.name !== binding.toolName || !TOOL_PERMISSION_LEVELS.includes(tool.permission))
    return { code: "UNKNOWN_TOOL", call, toolName: call.name };

  await safeAppend(d.audit, "agent.tool.requested", "pending", {
    step: d.steps,
    toolCallId: call.id,
    toolName: tool.name,
    permission: tool.permission,
  });

  let input: unknown;
  try {
    input = tool.inputSchema.parse(call.arguments);
  } catch {
    return { code: "INPUT_INVALID", call, toolName: tool.name, permission: tool.permission };
  }
  if (MUTATING.has(tool.permission) && typeof tool.verify !== "function") {
    return { code: "VERIFIER_REQUIRED", call, toolName: tool.name, permission: tool.permission };
  }

  let decision = evaluateToolPermission(tool);
  let request: ApprovalRequest | undefined;
  if (decision.code === "APPROVAL_REQUIRED") {
    const resolver = d.config.approvalResolver;
    if (!resolver || !binding.approval || !d.approvalLedger)
      return {
        code: "APPROVAL_REQUIRED",
        call,
        toolName: tool.name,
        permission: tool.permission,
        decisionCode: decision.code,
      };
    let digest: unknown, summary: unknown;
    try {
      digest = binding.approval.createRequestDigest(input);
      summary = binding.approval.createSafeSummary(input);
    } catch {
      return {
        code: "APPROVAL_REQUIRED",
        call,
        toolName: tool.name,
        permission: tool.permission,
        decisionCode: decision.code,
      };
    }
    if (isBlank(digest) || isBlank(summary))
      return {
        code: "APPROVAL_REQUIRED",
        call,
        toolName: tool.name,
        permission: tool.permission,
        decisionCode: decision.code,
      };
    try {
      request = createApprovalRequest(
        {
          toolName: tool.name,
          permission: tool.permission,
          requestDigest: digest as string,
          safeSummary: summary as string,
        },
        { ledger: d.approvalLedger, now: d.now },
      );
    } catch (cause) {
      return {
        code:
          cause instanceof ApprovalGateError && cause.code === "AUDIT_FAILURE"
            ? "AUDIT_FAILURE"
            : "APPROVAL_REQUIRED",
        call,
        toolName: tool.name,
        permission: tool.permission,
        decisionCode: decision.code,
      };
    }
    let grant: ApprovalGrant;
    try {
      grant = await resolver.resolve(request);
    } catch {
      return {
        code: "APPROVAL_DENIED",
        call,
        toolName: tool.name,
        permission: tool.permission,
        decisionCode: decision.code,
        requestId: request.requestId,
        requestDigest: request.requestDigest,
      };
    }
    // Grant must be bound to exactly this request before its record is even considered.
    const bound =
      grant &&
      typeof grant === "object" &&
      grant.requestId === request.requestId &&
      grant.requestDigest === request.requestDigest;
    decision = bound ? evaluateToolPermission(tool, grant.record) : evaluateToolPermission(tool);
    if (!decision.allowed) {
      return {
        code: "APPROVAL_DENIED",
        call,
        toolName: tool.name,
        permission: tool.permission,
        decisionCode: decision.code,
        requestId: request.requestId,
        requestDigest: request.requestDigest,
      };
    }
  }
  if (!decision.allowed)
    return {
      code: "PERMISSION_DENIED",
      call,
      toolName: tool.name,
      permission: tool.permission,
      decisionCode: decision.code,
    };
  return { call, tool, binding, input, decision, ...(request ? { request } : {}) };
}

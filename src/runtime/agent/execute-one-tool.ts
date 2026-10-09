/**
 * Shared deterministic single-tool executor.
 *
 * Lifted from the pattern that was previously private to `src/cli/reviews.ts`.
 * It exists so that every non-LLM caller (the reviews CLI and the privileged
 * release daemon) executes a tool through exactly one authoritative safety path:
 *
 *   runAgent -> registry lookup -> inputSchema.parse -> permission decision
 *            -> human approval -> tool.execute -> mandatory verifier -> audit
 *
 * This module deliberately contains NO permission, approval, verifier, or audit
 * logic of its own. It only supplies a deterministic two-turn LLM adapter so
 * `runAgent` chooses exactly one pre-derived tool call and then stops.
 */
import {
  runAgent,
  type AgentApprovalResolver,
  type AgentLedger,
  type AgentRunResult,
  type AgentToolBinding,
} from "./index.js";
import type { ApprovalLedger } from "../approvals/index.js";
import type { LlmAdapter, LlmMessage, LlmRequest, LlmResponse } from "../llm/index.js";
import type { ToolContext, ToolRegistry } from "../tools/index.js";
import type { VerificationLedger } from "../verification/index.js";

export type SingleToolExecutionErrorCode =
  "ADAPTER_TURN_UNEXPECTED" | "ADAPTER_BINDING_MISMATCH" | "RESULT_NOT_SERIALIZABLE";

export class SingleToolExecutionError extends Error {
  override readonly name = "SingleToolExecutionError";

  constructor(
    readonly code: SingleToolExecutionErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface SingleToolExecution {
  readonly result: AgentRunResult;
  /** Parsed tool output when the step produced exactly one serializable tool message. */
  readonly payload?: unknown;
}

export interface SingleToolExecutorOptions {
  readonly registry: ToolRegistry;
  readonly binding: AgentToolBinding;
  /** Pre-derived tool input. Never model-controlled. */
  readonly input: unknown;
  readonly ledger: AgentLedger;
  /** Correlation id used for the single tool call; must be unique per step. */
  readonly toolCallId?: string;
  readonly messages?: readonly LlmMessage[];
  /** Supplying a resolver is what allows destructive/publish tools to run at all. */
  readonly approvalResolver?: AgentApprovalResolver;
  /** Required alongside a resolver: runAgent fails closed without an approval ledger. */
  readonly approvalLedger?: ApprovalLedger;
  readonly verificationLedger?: VerificationLedger;
  readonly context?: ToolContext;
}

/** Default correlation id for a single-tool step. */
export const DEFAULT_SINGLE_TOOL_CALL_ID = "operator-step";

const DEFAULT_MESSAGES: readonly LlmMessage[] = Object.freeze([
  { role: "user" as const, content: "Execute the explicit operator command step." },
]);

/** Limits guaranteeing exactly one tool call and no further model turn. */
const SINGLE_TOOL_LIMITS = Object.freeze({ maxSteps: 2, maxToolCalls: 1, maxTotalTokens: 1 });

/**
 * A deterministic two-step adapter: it never calls a provider and never chooses a
 * tool or an action. Turn 1 emits exactly the bound tool with the supplied input;
 * turn 2 completes once that call has been observed.
 */
export function createDeterministicToolAdapter(
  binding: AgentToolBinding,
  input: unknown,
  toolCallId: string = DEFAULT_SINGLE_TOOL_CALL_ID,
): LlmAdapter {
  if (
    !binding ||
    typeof binding.toolName !== "string" ||
    binding.toolName.trim().length === 0 ||
    typeof toolCallId !== "string" ||
    toolCallId.trim().length === 0
  ) {
    throw new SingleToolExecutionError(
      "ADAPTER_BINDING_MISMATCH",
      "Single-tool binding or call id is invalid.",
    );
  }
  let turn = 0;
  return {
    provider: "deterministic-single-tool",
    async complete(request: LlmRequest): Promise<LlmResponse> {
      turn += 1;
      if (turn === 1) {
        return {
          toolCalls: [{ id: toolCallId, name: binding.toolName, arguments: input }],
          usage: { totalTokens: 0 },
        };
      }
      const last = request.messages.at(-1);
      if (turn === 2 && last?.role === "tool" && last.toolCallId === toolCallId) {
        return { content: "Operator step completed.", toolCalls: [], usage: { totalTokens: 0 } };
      }
      throw new SingleToolExecutionError(
        "ADAPTER_TURN_UNEXPECTED",
        "Single-tool adapter received an unexpected conversation turn.",
      );
    },
  };
}

function extractPayload(
  result: AgentRunResult,
  toolCallId: string,
): { payload?: unknown } | undefined {
  const messages = result.conversation.filter(
    (item) => item.role === "tool" && item.toolCallId === toolCallId,
  );
  if (messages.length !== 1 || messages[0]?.role !== "tool") return undefined;
  try {
    return { payload: JSON.parse(messages[0].content) as unknown };
  } catch {
    return {};
  }
}

/**
 * Execute exactly one bound tool through the authoritative runAgent safety path.
 *
 * Never throws for ordinary denials: the caller inspects `result.ok` and
 * `result.code` (`APPROVAL_REQUIRED`, `APPROVAL_DENIED`, `PERMISSION_DENIED`,
 * `VERIFIER_REQUIRED`, ...). Only an unusable adapter/result shape throws.
 */
export async function executeOneTool(
  options: SingleToolExecutorOptions,
): Promise<SingleToolExecution> {
  const toolCallId = options.toolCallId ?? DEFAULT_SINGLE_TOOL_CALL_ID;
  const adapter = createDeterministicToolAdapter(options.binding, options.input, toolCallId);
  const result = await runAgent({
    llm: adapter,
    registry: options.registry,
    bindings: [options.binding],
    messages: options.messages ?? DEFAULT_MESSAGES,
    limits: SINGLE_TOOL_LIMITS,
    ledger: options.ledger,
    ...(options.approvalResolver ? { approvalResolver: options.approvalResolver } : {}),
    ...(options.approvalLedger ? { approvalLedger: options.approvalLedger } : {}),
    ...(options.verificationLedger ? { verificationLedger: options.verificationLedger } : {}),
    ...(options.context ? { context: options.context } : {}),
  });
  if (!result.ok) return { result };
  const extracted = extractPayload(result, toolCallId);
  if (extracted === undefined) return { result };
  return extracted.payload === undefined ? { result } : { result, payload: extracted.payload };
}

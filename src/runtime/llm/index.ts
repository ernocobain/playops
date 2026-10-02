/**
 * Provider-neutral LLM adapter contract (Phase 2.5).
 *
 * The agent runtime talks to models only through `LlmAdapter`. No provider
 * SDK, wire format, fetch Response, or model assumption leaks through here.
 *
 * `LlmToolDefinition.inputSchema` is a JSON-Schema-like *description* given to
 * the model for tool selection. It is NOT validation: the Phase 2.1
 * `ToolSchema.parse()` remains the only authority before execution, and
 * `LlmToolCall.arguments` is untrusted `unknown` until the executor (Phase 2.6)
 * parses it. Mapping registry tools → LLM declarations is deferred to 2.6.
 */

/** JSON-compatible value used for tool input descriptions. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface LlmToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON-Schema-like object describing the tool's input; description only. */
  readonly inputSchema: Readonly<Record<string, JsonValue>>;
}

/** A model's request to call a tool. `arguments` is parsed JSON, never trusted. */
export interface LlmToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface LlmSystemMessage {
  readonly role: "system";
  readonly content: string;
}
export interface LlmUserMessage {
  readonly role: "user";
  readonly content: string;
}
export interface LlmAssistantMessage {
  readonly role: "assistant";
  readonly content?: string;
  readonly toolCalls?: readonly LlmToolCall[];
}
/** Result of a tool call, as explicit string content (serialization decided by the caller). */
export interface LlmToolResultMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly content: string;
}

export type LlmMessage =
  LlmSystemMessage | LlmUserMessage | LlmAssistantMessage | LlmToolResultMessage;

export interface LlmRequest {
  readonly messages: readonly LlmMessage[];
  readonly tools?: readonly LlmToolDefinition[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

export interface LlmUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface LlmResponse {
  /** Absent when the model produced only tool calls. */
  readonly content?: string;
  /** Empty for a plain assistant turn; order preserved from the provider. */
  readonly toolCalls: readonly LlmToolCall[];
  readonly finishReason?: string;
  readonly usage?: LlmUsage;
  /** Opaque provider-reported model identifier, forwarded unchanged. */
  readonly model?: string;
}

export interface LlmAdapter {
  readonly provider: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export type LlmErrorCode =
  "INVALID_REQUEST" | "NETWORK_ERROR" | "TIMEOUT" | "HTTP_ERROR" | "INVALID_RESPONSE";

/**
 * Safe, provider-neutral failure. Messages are fixed strings; only provider
 * name, HTTP status, and operation are carried. Never credentials, headers,
 * request bodies, or upstream body text.
 */
export class LlmError extends Error {
  override readonly name = "LlmError";
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly provider: string,
    readonly operation: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

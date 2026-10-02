/**
 * 9Router provider (Phase 2.5) — the first concrete `LlmAdapter`.
 *
 * Transport: POST {baseUrl}/chat/completions, OpenAI-compatible Chat
 * Completions wire format (9Router documents `http://localhost:20128/v1` as an
 * OpenAI-compatible endpoint). Everything OpenAI-shaped is INTERNAL here.
 *
 * - `model` is an opaque caller string (9Router may route virtual/combo models).
 * - No env/config reads; the composition layer supplies `NineRouterConfig`.
 * - Node built-in fetch, injectable for tests; AbortController timeout.
 * - NO automatic retry: LLM calls are costly, nondeterministic, and may yield
 *   different tool calls on retry. Transient failures surface as typed errors.
 * - Provider output is untrusted and validated before normalization; malformed
 *   tool-call JSON fails safe as INVALID_RESPONSE.
 * - Authorization header is built internally and never appears in errors.
 */
import {
  LlmError,
  type LlmAdapter,
  type LlmRequest,
  type LlmResponse,
  type LlmToolCall,
  type LlmUsage,
} from "../../index.js";

export const NINE_ROUTER_PROVIDER = "9router";
/** Matches 9Router's documented local OpenAI-compatible root (IPv4 literal avoids localhost/IPv6 ambiguity). */
export const DEFAULT_9ROUTER_BASE_URL = "http://127.0.0.1:20128/v1";
/** Conservative default request timeout. */
export const DEFAULT_9ROUTER_TIMEOUT_MS = 60_000;

const OPERATION = "chat.completions";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface NineRouterConfig {
  readonly baseUrl: string;
  /** Opaque model identifier forwarded unchanged. */
  readonly model: string;
  /** Bearer credential; optional because a local 9Router may run without auth. */
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  /** Injectable for tests; defaults to `globalThis.fetch`. */
  readonly fetch?: FetchLike;
}

const fail = (
  code: LlmError["code"],
  message: string,
  status?: number,
  cause?: unknown,
): LlmError =>
  new LlmError(
    code,
    message,
    NINE_ROUTER_PROVIDER,
    OPERATION,
    status,
    cause === undefined ? undefined : { cause },
  );

const isBlank = (v: unknown): boolean => typeof v !== "string" || !v.trim();
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// ---------- request validation + wire mapping (internal) ----------

function validateRequest(request: LlmRequest): void {
  if (!isRecord(request) || !Array.isArray(request.messages) || request.messages.length === 0) {
    throw fail("INVALID_REQUEST", "LLM request must contain at least one message");
  }
  for (const m of request.messages) {
    if (!isRecord(m)) throw fail("INVALID_REQUEST", "LLM message must be an object");
    switch (m.role) {
      case "system":
      case "user":
        if (typeof m.content !== "string")
          throw fail("INVALID_REQUEST", "system/user content must be a string");
        break;
      case "assistant":
        if (m.content !== undefined && typeof m.content !== "string") {
          throw fail("INVALID_REQUEST", "assistant content must be a string when present");
        }
        if (m.toolCalls !== undefined) {
          if (!Array.isArray(m.toolCalls))
            throw fail("INVALID_REQUEST", "assistant toolCalls must be an array");
          for (const c of m.toolCalls) {
            if (!isRecord(c) || isBlank(c.id) || isBlank(c.name)) {
              throw fail("INVALID_REQUEST", "assistant tool call requires nonblank id and name");
            }
          }
        }
        break;
      case "tool":
        if (isBlank(m.toolCallId) || typeof m.content !== "string") {
          throw fail(
            "INVALID_REQUEST",
            "tool message requires nonblank toolCallId and string content",
          );
        }
        break;
      default:
        throw fail("INVALID_REQUEST", "unsupported message role");
    }
  }
  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools)) throw fail("INVALID_REQUEST", "tools must be an array");
    for (const t of request.tools) {
      if (
        !isRecord(t) ||
        isBlank(t.name) ||
        typeof t.description !== "string" ||
        !isRecord(t.inputSchema)
      ) {
        throw fail(
          "INVALID_REQUEST",
          "tool definition requires nonblank name, description, and object inputSchema",
        );
      }
    }
  }
  if (
    request.temperature !== undefined &&
    !(Number.isFinite(request.temperature) && request.temperature >= 0)
  ) {
    throw fail("INVALID_REQUEST", "temperature must be a finite non-negative number");
  }
  if (
    request.maxOutputTokens !== undefined &&
    !(Number.isInteger(request.maxOutputTokens) && request.maxOutputTokens > 0)
  ) {
    throw fail("INVALID_REQUEST", "maxOutputTokens must be a positive integer");
  }
}

function toWireMessages(request: LlmRequest): unknown[] {
  return request.messages.map((m) => {
    switch (m.role) {
      case "system":
      case "user":
        return { role: m.role, content: m.content };
      case "assistant": {
        const wire: Record<string, unknown> = { role: "assistant", content: m.content ?? null };
        if (m.toolCalls && m.toolCalls.length > 0) {
          wire.tool_calls = m.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.arguments ?? null) },
          }));
        }
        return wire;
      }
      case "tool":
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
  });
}

function toWireBody(request: LlmRequest, model: string): Record<string, unknown> {
  const body: Record<string, unknown> = { model, messages: toWireMessages(request), stream: false };
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }
  if (request.temperature !== undefined) body.temperature = request.temperature;
  // Chat Completions compatibility field `max_tokens` (widest OpenAI-compatible support).
  if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
  return body;
}

// ---------- response validation + normalization (internal) ----------

const invalid = (detail: string): LlmError =>
  fail("INVALID_RESPONSE", `Malformed provider response: ${detail}`, 200);

function normalizeUsage(raw: unknown): LlmUsage | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw invalid("usage must be an object");
  const pick = (key: string): number | undefined => {
    const v = raw[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
      throw invalid(`usage.${key} must be a non-negative number`);
    return v;
  };
  const usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
  const i = pick("prompt_tokens"),
    o = pick("completion_tokens"),
    t = pick("total_tokens");
  if (i !== undefined) usage.inputTokens = i;
  if (o !== undefined) usage.outputTokens = o;
  if (t !== undefined) usage.totalTokens = t;
  return Object.freeze(usage);
}

function normalizeToolCalls(raw: unknown): readonly LlmToolCall[] {
  if (raw === undefined || raw === null) return Object.freeze([]);
  if (!Array.isArray(raw)) throw invalid("tool_calls must be an array");
  return Object.freeze(
    raw.map((c): LlmToolCall => {
      if (!isRecord(c) || isBlank(c.id)) throw invalid("tool call requires nonblank id");
      const fn = c.function;
      if (!isRecord(fn) || isBlank(fn.name))
        throw invalid("tool call requires nonblank function name");
      if (typeof fn.arguments !== "string")
        throw invalid("tool call arguments must be a JSON string");
      let args: unknown;
      try {
        args = JSON.parse(fn.arguments);
      } catch {
        throw invalid("tool call arguments are not valid JSON");
      }
      return Object.freeze({ id: c.id as string, name: fn.name as string, arguments: args });
    }),
  );
}

function normalizeResponse(raw: unknown): LlmResponse {
  if (!isRecord(raw)) throw invalid("top-level value is not an object");
  if (!Array.isArray(raw.choices) || raw.choices.length === 0)
    throw invalid("choices missing or empty");
  const choice: unknown = raw.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message))
    throw invalid("selected choice has no message object");
  const message = choice.message;
  if (
    message.content !== undefined &&
    message.content !== null &&
    typeof message.content !== "string"
  ) {
    throw invalid("message content must be string or null");
  }
  if (
    choice.finish_reason !== undefined &&
    choice.finish_reason !== null &&
    typeof choice.finish_reason !== "string"
  ) {
    throw invalid("finish_reason must be a string");
  }
  if (raw.model !== undefined && raw.model !== null && typeof raw.model !== "string")
    throw invalid("model must be a string");
  const out: {
    content?: string;
    toolCalls: readonly LlmToolCall[];
    finishReason?: string;
    usage?: LlmUsage;
    model?: string;
  } = {
    toolCalls: normalizeToolCalls(message.tool_calls),
  };
  if (typeof message.content === "string") out.content = message.content;
  if (typeof choice.finish_reason === "string") out.finishReason = choice.finish_reason;
  const usage = normalizeUsage(raw.usage);
  if (usage) out.usage = usage;
  if (typeof raw.model === "string") out.model = raw.model;
  return Object.freeze(out);
}

// ---------- adapter ----------

export function create9RouterAdapter(config: NineRouterConfig): LlmAdapter {
  if (!isRecord(config) || isBlank(config.baseUrl))
    throw fail("INVALID_REQUEST", "9Router baseUrl must be nonblank");
  if (isBlank(config.model)) throw fail("INVALID_REQUEST", "9Router model must be nonblank");
  const timeoutMs = config.timeoutMs ?? DEFAULT_9ROUTER_TIMEOUT_MS;
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0))
    throw fail("INVALID_REQUEST", "timeoutMs must be a positive number");
  if (config.apiKey !== undefined && typeof config.apiKey !== "string")
    throw fail("INVALID_REQUEST", "apiKey must be a string");
  const fetchImpl: FetchLike = config.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const url = `${config.baseUrl.trim().replace(/\/+$/, "")}/chat/completions`;
  const { model, apiKey } = config;

  return Object.freeze({
    provider: NINE_ROUTER_PROVIDER,
    async complete(request: LlmRequest): Promise<LlmResponse> {
      validateRequest(request);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      if (apiKey && apiKey.trim()) headers.Authorization = `Bearer ${apiKey}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(toWireBody(request, model)),
          signal: controller.signal,
        });
      } catch (cause) {
        if (controller.signal.aborted)
          throw fail("TIMEOUT", `LLM request timed out after ${timeoutMs}ms`, undefined, cause);
        throw fail(
          "NETWORK_ERROR",
          "LLM request failed before a response was received",
          undefined,
          cause,
        );
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        // Body deliberately not read into the error: upstream text is untrusted and may echo secrets.
        throw fail("HTTP_ERROR", `LLM provider returned HTTP ${response.status}`, response.status);
      }
      let raw: unknown;
      try {
        raw = await response.json();
      } catch (cause) {
        throw fail(
          "INVALID_RESPONSE",
          "Malformed provider response: body is not JSON",
          response.status,
          cause,
        );
      }
      return normalizeResponse(raw);
    },
  });
}

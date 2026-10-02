/**
 * Phase 2.5 — LLM adapter + 9Router provider tests. Injected fake fetch only;
 * zero network, zero tool execution, zero audit.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as audit from "../src/audit/index.js";
import * as retry from "../src/googleplay/retry/index.js";
import * as approvals from "../src/runtime/approvals/index.js";
import * as permissions from "../src/runtime/permissions/index.js";
import * as verification from "../src/runtime/verification/index.js";
import {
  LlmError,
  type LlmAdapter,
  type LlmRequest,
  type LlmResponse,
} from "../src/runtime/llm/index.js";
import {
  create9RouterAdapter,
  DEFAULT_9ROUTER_BASE_URL,
  NINE_ROUTER_PROVIDER,
  type FetchLike,
} from "../src/runtime/llm/providers/9router/index.js";

const fixtures = JSON.parse(
  readFileSync(
    new URL("./fixtures/llm/9router-chat-completions.fake.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

const FAKE_KEY = "fake-api-key-DO-NOT-ECHO-4f9a";
const MODEL = "virtual/combo-opaque-model";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Captured {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}
function fakeFetch(...responses: (Response | Error)[]): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url: String(url),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    const next = responses[i++] ?? responses[responses.length - 1];
    if (next instanceof Error) throw next;
    return next as Response;
  };
  return { fetch, calls };
}

function adapter(
  fetch: FetchLike,
  extra: Partial<Parameters<typeof create9RouterAdapter>[0]> = {},
): LlmAdapter {
  return create9RouterAdapter({
    baseUrl: DEFAULT_9ROUTER_BASE_URL,
    model: MODEL,
    apiKey: FAKE_KEY,
    fetch,
    ...extra,
  });
}

const userReq: LlmRequest = { messages: [{ role: "user", content: "hi" }] };

async function expectLlmError(p: Promise<unknown>, code: LlmError["code"]): Promise<LlmError> {
  const err: unknown = await p.then(() => undefined).catch((e: unknown) => e);
  if (!(err instanceof LlmError)) throw new Error(`expected LlmError, got ${String(err)}`);
  expect(err.code).toBe(code);
  expect(err.provider).toBe(NINE_ROUTER_PROVIDER);
  expect(err.message).not.toContain(FAKE_KEY);
  return err;
}

describe("generic contract: response normalization", () => {
  it("plain assistant text", async () => {
    const r = await adapter(fakeFetch(jsonResponse(fixtures.text)).fetch).complete(userReq);
    expect(r).toMatchObject({
      content: "Hello from a fake model.",
      toolCalls: [],
      finishReason: "stop",
      model: "fake/routed-model-a",
    });
    expect(r.usage).toEqual({ inputTokens: 12, outputTokens: 7, totalTokens: 19 });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.toolCalls)).toBe(true);
  });
  it("no content but one tool call is valid; arguments parsed to unknown", async () => {
    const r = await adapter(fakeFetch(jsonResponse(fixtures.singleToolCall)).fetch).complete(
      userReq,
    );
    expect(r.content).toBeUndefined();
    expect(r.finishReason).toBe("tool_calls");
    expect(r.toolCalls).toEqual([
      {
        id: "call_fake_001",
        name: "reviews.list",
        arguments: { packageName: "com.example.fake", maxResults: 5 },
      },
    ]);
  });
  it("multiple tool calls preserve order; non-object JSON arguments allowed as unknown", async () => {
    const r = await adapter(fakeFetch(jsonResponse(fixtures.multiToolCall)).fetch).complete(
      userReq,
    );
    expect(r.toolCalls.map((c) => c.id)).toEqual(["call_fake_a", "call_fake_b", "call_fake_c"]);
    expect(r.toolCalls[2]?.arguments).toEqual([1, 2, 3]);
    expect(r.content).toBe("Working on it.");
    expect(r.usage).toBeUndefined();
  });
  it("finish reason 'length' normalized; missing model/usage stay undefined", async () => {
    const r = await adapter(fakeFetch(jsonResponse(fixtures.lengthFinish)).fetch).complete(userReq);
    expect(r.finishReason).toBe("length");
    expect(r.model).toBeUndefined();
  });
  it("normalized response never contains the API key or provider raw objects", async () => {
    const r = await adapter(fakeFetch(jsonResponse(fixtures.text)).fetch).complete(userReq);
    const s = JSON.stringify(r);
    expect(s).not.toContain(FAKE_KEY);
    expect(Object.keys(r).sort()).toEqual([
      "content",
      "finishReason",
      "model",
      "toolCalls",
      "usage",
    ]);
  });
});

describe("request mapping (OpenAI-compatible wire, internal to provider)", () => {
  const request: LlmRequest = {
    messages: [
      { role: "system", content: "You are PlayOps." },
      { role: "user", content: "List reviews" },
      {
        role: "assistant",
        content: "Sure.",
        toolCalls: [{ id: "call_1", name: "reviews.list", arguments: { maxResults: 2 } }],
      },
      { role: "tool", toolCallId: "call_1", content: '[{"id":"r-1"}]' },
      { role: "assistant", content: "Done." },
    ],
    tools: [
      {
        name: "reviews.list",
        description: "List reviews",
        inputSchema: { type: "object", properties: { maxResults: { type: "integer" } } },
      },
    ],
    temperature: 0.2,
    maxOutputTokens: 256,
  };
  it("maps url, method, headers, model, messages, tools, temperature, max_tokens", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse(fixtures.afterToolResult));
    await adapter(fetch).complete(request);
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c?.url).toBe("http://127.0.0.1:20128/v1/chat/completions");
    expect(c?.init.method).toBe("POST");
    const headers = c?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(c?.body.model).toBe(MODEL);
    expect(c?.body.stream).toBe(false);
    expect(c?.body.temperature).toBe(0.2);
    expect(c?.body.max_tokens).toBe(256);
    expect(c?.body.messages).toEqual([
      { role: "system", content: "You are PlayOps." },
      { role: "user", content: "List reviews" },
      {
        role: "assistant",
        content: "Sure.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "reviews.list", arguments: '{"maxResults":2}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: '[{"id":"r-1"}]' },
      { role: "assistant", content: "Done." },
    ]);
    expect(c?.body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "reviews.list",
          description: "List reviews",
          parameters: { type: "object", properties: { maxResults: { type: "integer" } } },
        },
      },
    ]);
  });
  it("omits temperature/max_tokens/tools when not supplied; no Authorization header without apiKey", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse(fixtures.text));
    await create9RouterAdapter({
      baseUrl: "http://127.0.0.1:20128/v1/",
      model: MODEL,
      fetch,
    }).complete(userReq);
    const [c] = calls;
    expect(c?.url).toBe("http://127.0.0.1:20128/v1/chat/completions");
    expect(c?.body).not.toHaveProperty("temperature");
    expect(c?.body).not.toHaveProperty("max_tokens");
    expect(c?.body).not.toHaveProperty("tools");
    expect(c?.init.headers as Record<string, string>).not.toHaveProperty("Authorization");
  });
  it("assistant history with tool calls and no content serializes content as null", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse(fixtures.text));
    await adapter(fetch).complete({
      messages: [{ role: "assistant", toolCalls: [{ id: "c", name: "t", arguments: null }] }],
    });
    expect((calls[0]?.body.messages as unknown[])[0]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c", type: "function", function: { name: "t", arguments: "null" } }],
    });
  });
  it("invalid requests rejected before fetch: empty messages, blank tool name, tool message without id, bad temperature", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse(fixtures.text));
    const a = adapter(fetch);
    await expectLlmError(a.complete({ messages: [] }), "INVALID_REQUEST");
    await expectLlmError(
      a.complete({
        messages: [{ role: "user", content: "x" }],
        tools: [{ name: " ", description: "d", inputSchema: {} }],
      }),
      "INVALID_REQUEST",
    );
    await expectLlmError(
      a.complete({ messages: [{ role: "tool", toolCallId: "", content: "x" }] }),
      "INVALID_REQUEST",
    );
    await expectLlmError(
      a.complete({ messages: [{ role: "user", content: "x" }], temperature: Number.NaN }),
      "INVALID_REQUEST",
    );
    await expectLlmError(
      a.complete({ messages: [{ role: "user", content: "x" }], maxOutputTokens: 0 }),
      "INVALID_REQUEST",
    );
    expect(calls).toHaveLength(0);
  });
  it("adapter config validated: blank baseUrl/model rejected at creation", () => {
    expect(() =>
      create9RouterAdapter({ baseUrl: " ", model: MODEL, fetch: fakeFetch().fetch }),
    ).toThrow(LlmError);
    expect(() =>
      create9RouterAdapter({
        baseUrl: DEFAULT_9ROUTER_BASE_URL,
        model: "",
        fetch: fakeFetch().fetch,
      }),
    ).toThrow(LlmError);
    expect(() =>
      create9RouterAdapter({
        baseUrl: DEFAULT_9ROUTER_BASE_URL,
        model: MODEL,
        timeoutMs: -1,
        fetch: fakeFetch().fetch,
      }),
    ).toThrow(LlmError);
  });
});

describe("response validation → INVALID_RESPONSE", () => {
  it.each([
    ["non-object top level", "just text"],
    ["array top level", []],
    ["missing choices", fixtures.missingChoices],
    ["empty choices", fixtures.emptyChoices],
    ["malformed message", fixtures.malformedMessage],
    ["content not string", fixtures.contentNotString],
    ["tool_calls not array", fixtures.toolCallsNotArray],
    ["blank tool name", fixtures.blankToolName],
    ["blank tool call id", fixtures.blankToolCallId],
    ["malformed tool arguments JSON", fixtures.malformedToolArguments],
    ["bad usage", fixtures.badUsage],
  ])("%s", async (_label, body) => {
    const err = await expectLlmError(
      adapter(fakeFetch(jsonResponse(body)).fetch).complete(userReq),
      "INVALID_RESPONSE",
    );
    expect(err.status).toBe(200);
    expect(err.message).not.toContain("not json");
  });
  it("non-JSON 200 body → INVALID_RESPONSE", async () => {
    await expectLlmError(
      adapter(fakeFetch(new Response("<html>oops</html>", { status: 200 })).fetch).complete(
        userReq,
      ),
      "INVALID_RESPONSE",
    );
  });
});

describe("HTTP / network / timeout errors — no retry", () => {
  it.each([401, 429, 500])(
    "HTTP %i → HTTP_ERROR, fetch called once, body not echoed",
    async (status) => {
      const { fetch, calls } = fakeFetch(jsonResponse(fixtures.httpErrorBody, status));
      const err = await expectLlmError(adapter(fetch).complete(userReq), "HTTP_ERROR");
      expect(err.status).toBe(status);
      expect(calls).toHaveLength(1);
      expect(err.message).not.toContain("UPSTREAM-SECRET-DETAIL-MARKER");
      expect(err.message).not.toContain("sk-fake");
      expect(JSON.stringify({ ...err, message: err.message, stack: undefined })).not.toContain(
        "Bearer",
      );
    },
  );
  it("network failure → NETWORK_ERROR with cause, once", async () => {
    const { fetch, calls } = fakeFetch(new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:20128"));
    const err = await expectLlmError(adapter(fetch).complete(userReq), "NETWORK_ERROR");
    expect(err.cause).toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(1);
  });
  it("timeout → TIMEOUT via AbortSignal (deterministic, no real waiting)", async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason ?? new Error("aborted")),
        );
      });
    vi.useFakeTimers();
    try {
      const p = adapter(fetch, { timeoutMs: 1000 }).complete(userReq);
      const settled = expectLlmError(p, "TIMEOUT");
      await vi.advanceTimersByTimeAsync(1000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
  it("timeout signal is passed to fetch and cleared on success (no dangling timer)", async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = fakeFetch(jsonResponse(fixtures.text));
      await adapter(fetch, { timeoutMs: 5000 }).complete(userReq);
      expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("security & isolation", () => {
  it("API key only in outgoing Authorization header; never in errors/response/toString", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse(fixtures.httpErrorBody, 401));
    const err = await expectLlmError(adapter(fetch).complete(userReq), "HTTP_ERROR");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toContain(FAKE_KEY);
    expect(String(err)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(err)).not.toContain(FAKE_KEY);
    expect(Object.keys(err)).not.toContain("headers");
    expect(Object.keys(err)).not.toContain("request");
  });
  it("no audit, retry, approval, permission, verification, or tool execute involvement; no console logging", async () => {
    const spies = [
      ...Object.keys(audit)
        .filter(
          (k) => typeof (audit as Record<string, unknown>)[k] === "function" && /^[a-z]/.test(k),
        )
        .map((k) => vi.spyOn(audit, k as never)),
      ...Object.keys(retry)
        .filter(
          (k) => typeof (retry as Record<string, unknown>)[k] === "function" && /^[a-z]/.test(k),
        )
        .map((k) => vi.spyOn(retry, k as never)),
      ...Object.keys(approvals)
        .filter(
          (k) =>
            typeof (approvals as Record<string, unknown>)[k] === "function" && /^[a-z]/.test(k),
        )
        .map((k) => vi.spyOn(approvals, k as never)),
      vi.spyOn(permissions, "evaluateToolPermission"),
      vi.spyOn(verification, "verifyToolOutcome"),
    ];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const execute = vi.fn();
    const r = await adapter(fakeFetch(jsonResponse(fixtures.multiToolCall)).fetch).complete({
      ...userReq,
      tools: [{ name: "reviews.get", description: "d", inputSchema: { type: "object" } }],
    });
    expect(r.toolCalls).toHaveLength(3);
    expect(execute).not.toHaveBeenCalled();
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("tool-call round trip (adapter only, no execution)", () => {
  it("tool call → tool-result message with same id → next text response", async () => {
    const { fetch, calls } = fakeFetch(
      jsonResponse(fixtures.singleToolCall),
      jsonResponse(fixtures.afterToolResult),
    );
    const a = adapter(fetch);
    const first: LlmResponse = await a.complete({
      messages: [{ role: "user", content: "How many new reviews?" }],
      tools: [{ name: "reviews.list", description: "d", inputSchema: { type: "object" } }],
    });
    const call = first.toolCalls[0];
    expect(call?.name).toBe("reviews.list");
    const second = await a.complete({
      messages: [
        { role: "user", content: "How many new reviews?" },
        { role: "assistant", content: first.content, toolCalls: first.toolCalls },
        { role: "tool", toolCallId: call?.id ?? "", content: '[{"id":"r-1"},{"id":"r-2"}]' },
      ],
    });
    expect(second.content).toBe("There are 2 new reviews.");
    expect(second.toolCalls).toEqual([]);
    const wire = calls[1]?.body.messages as Record<string, unknown>[];
    expect(wire[1]).toMatchObject({
      role: "assistant",
      tool_calls: [
        {
          id: "call_fake_001",
          function: {
            name: "reviews.list",
            arguments: '{"packageName":"com.example.fake","maxResults":5}',
          },
        },
      ],
    });
    expect(wire[2]).toEqual({
      role: "tool",
      tool_call_id: "call_fake_001",
      content: '[{"id":"r-1"},{"id":"r-2"}]',
    });
    expect(calls).toHaveLength(2);
  });
});

describe("fixtures hygiene", () => {
  it("fixture file carries fake marker and no bearer/private key material", () => {
    const raw = readFileSync(
      new URL("./fixtures/llm/9router-chat-completions.fake.json", import.meta.url),
      "utf8",
    );
    expect(raw).toContain("FAKE fixtures");
    expect(raw).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
    expect(raw).not.toContain("PRIVATE KEY");
    expect(raw).not.toContain(FAKE_KEY);
  });
});

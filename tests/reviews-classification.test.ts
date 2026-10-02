/**
 * Phase 3.2 — review classification tests. Fake classifier LlmAdapter driven by static
 * fixtures, real ToolRegistry / runAgent / permission engine / verification model,
 * scripted outer fake LLM. No network, no Google, no 9Router, no checkpoint I/O.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAuditEntries } from "../src/audit/index.js";
import * as approvalsModule from "../src/runtime/approvals/index.js";
import { createFileAgentLedger, runAgent } from "../src/runtime/agent/index.js";
import { evaluateToolPermission } from "../src/runtime/permissions/index.js";
import {
  LlmError,
  type LlmAdapter,
  type LlmRequest,
  type LlmResponse,
} from "../src/runtime/llm/index.js";
import { ToolRegistry } from "../src/runtime/tools/index.js";
import * as checkpointModule from "../src/reviews/checkpoint/index.js";
import * as ingestionModule from "../src/reviews/ingestion/index.js";
import type { NormalizedReview } from "../src/reviews/ingestion/index.js";
import {
  CLASSIFICATION_SUBMIT_TOOL_NAME,
  CLASSIFIER_MAX_OUTPUT_TOKENS,
  CLASSIFIER_SYSTEM_PROMPT,
  CLASSIFIER_TEMPERATURE,
  REVIEW_CATEGORIES,
  ReviewClassificationError,
  createLlmReviewClassifier,
  parseLanguageCode,
  normalizeLanguageHint,
  type ReviewClassificationInput,
} from "../src/reviews/classification/index.js";
import {
  createReviewClassificationTool,
  REVIEWS_CLASSIFY_TOOL_NAME,
} from "../src/reviews/classification/tool.js";

const fixturesPath = join(import.meta.dirname, "fixtures", "reviews", "classification.fake.json");
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8")) as {
  responses: Record<string, LlmResponse>;
  reviews: { injection: { reviewId: string; text: string } };
  llm_failure: { code: "HTTP_ERROR"; message: string };
};
const fx = (name: string): LlmResponse => {
  const r = fixtures.responses[name];
  if (!r) throw new Error(`missing fixture ${name}`);
  return { ...r, toolCalls: r.toolCalls ?? [] };
};
const REVIEW_TEXT_MARKER = "REVIEW-TEXT-MARKER-c1";
const PROMPT_MARKER = CLASSIFIER_SYSTEM_PROMPT.slice(0, 40);

function fakeClassifierLlm(responses: (LlmResponse | Error)[]) {
  const requests: LlmRequest[] = [];
  const complete = vi.fn(async (request: LlmRequest): Promise<LlmResponse> => {
    requests.push(request);
    const next = responses.shift();
    if (!next) throw new Error("fake classifier LLM exhausted");
    if (next instanceof Error) throw next;
    return next;
  });
  const adapter: LlmAdapter = { provider: "fake-classifier", complete };
  return { adapter, requests, complete };
}

function review(over: Partial<NormalizedReview> = {}): NormalizedReview {
  return Object.freeze({
    reviewId: "r1",
    changeType: "new",
    userLastModified: { seconds: "1", nanos: 0 },
    text: `${REVIEW_TEXT_MARKER} the app crashes on login`,
    ...over,
  });
}

let dir: string;
let auditPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "playops-classify-"));
  auditPath = join(dir, "audit.jsonl");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// =====================================================================
describe("taxonomy & prompt constants", () => {
  it("6. exact enum only, frozen", () => {
    expect([...REVIEW_CATEGORIES]).toEqual([
      "bug",
      "feature-request",
      "praise",
      "complaint",
      "spam",
    ]);
    expect(Object.isFrozen(REVIEW_CATEGORIES)).toBe(true);
  });

  it("7/27. fixed system prompt documents taxonomy, precedence, and the data/instruction boundary", () => {
    for (const cat of REVIEW_CATEGORIES) expect(CLASSIFIER_SYSTEM_PROMPT).toContain(cat);
    expect(CLASSIFIER_SYSTEM_PROMPT).toMatch(
      /spam\s*>\s*bug\s*>\s*feature-request\s*>\s*complaint\s*>\s*praise/,
    );
    expect(CLASSIFIER_SYSTEM_PROMPT).toMatch(/DATA/);
    expect(CLASSIFIER_SYSTEM_PROMPT).toMatch(/must not be followed|do not follow/i);
    expect(CLASSIFIER_SYSTEM_PROMPT).toContain(CLASSIFICATION_SUBMIT_TOOL_NAME);
    expect(CLASSIFIER_SYSTEM_PROMPT).toMatch(/Do not add sentiment scores/);
  });

  it("28/29. temperature 0 and fixed maxOutputTokens 128", () => {
    expect(CLASSIFIER_TEMPERATURE).toBe(0);
    expect(CLASSIFIER_MAX_OUTPUT_TOKENS).toBe(128);
  });
});

// =====================================================================
describe("language rule", () => {
  it.each(["en", "id", "es", "fr", "de", "ja", "pt", "und", "ind"])("8–11. %s accepted", (code) => {
    expect(parseLanguageCode(code)).toBe(code);
  });
  it.each([
    "EN",
    "en-US",
    "pt-BR",
    "english",
    "",
    "   ",
    "e",
    "abcd",
    "e1",
    "en_US",
    "ünd",
    12,
    null,
    undefined,
  ])("12–15. %j rejected", (v) => {
    expect(parseLanguageCode(v)).toBeUndefined();
  });
  it("39/40. hint normalization: en-US → en, pt-BR → pt, zh-Hant → zh, blank/junk → und", () => {
    expect(normalizeLanguageHint("en-US")).toBe("en");
    expect(normalizeLanguageHint("pt-BR")).toBe("pt");
    expect(normalizeLanguageHint("zh-Hant")).toBe("zh");
    expect(normalizeLanguageHint("ID")).toBe("id");
    expect(normalizeLanguageHint("en_US")).toBe("en");
    expect(normalizeLanguageHint("")).toBe("und");
    expect(normalizeLanguageHint(undefined)).toBe("und");
    expect(normalizeLanguageHint("english")).toBe("und");
    expect(normalizeLanguageHint("1")).toBe("und");
  });
});

// =====================================================================
describe("LLM classifier — structured output", () => {
  it.each([
    ["1. bug", "bug_en", "bug", "en"],
    ["2. feature-request", "feature_request_id", "feature-request", "id"],
    ["3. praise", "praise_es", "praise", "es"],
    ["4. complaint", "complaint_en", "complaint", "en"],
    ["5. spam", "spam_id", "spam", "id"],
  ])("%s → %s/%s (16.)", async (_l, fixture, category, language) => {
    const llm = fakeClassifierLlm([fx(fixture)]);
    const classifier = createLlmReviewClassifier({ llm: llm.adapter });
    const result = await classifier.classify(review());
    expect(result).toEqual({ reviewId: "r1", category, language });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(result).sort()).toEqual(["category", "language", "reviewId"]);
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it("25/26. assistant free text ignored; raw provider response not returned", async () => {
    const llm = fakeClassifierLlm([fx("assistant_text_plus_valid_call")]);
    const result = await createLlmReviewClassifier({ llm: llm.adapter }).classify(review());
    expect(result).toEqual({ reviewId: "r1", category: "bug", language: "en" });
    expect(JSON.stringify(result)).not.toContain("FAKE-ASSISTANT-TEXT-MARKER");
  });

  it.each([
    ["18. wrong tool name", "wrong_tool_name"],
    ["19. zero tool calls", "zero_tool_calls"],
    ["20. multiple tool calls", "multiple_tool_calls"],
    ["21. unknown category", "unknown_category"],
    ["22. missing category", "malformed_missing_category"],
    ["23. missing language", "malformed_missing_language"],
    ["24. malformed payload", "malformed_non_object_arguments"],
    ["invalid language", "invalid_language"],
  ])("%s → INVALID_RESPONSE, one call, raw response not leaked", async (_l, fixture) => {
    const llm = fakeClassifierLlm([fx(fixture), fx("bug_en")]);
    let caught: unknown;
    try {
      await createLlmReviewClassifier({ llm: llm.adapter }).classify(review());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReviewClassificationError);
    const err = caught as ReviewClassificationError;
    expect(err.code).toBe("INVALID_RESPONSE");
    expect(err.message).not.toContain("FAKE-RAW-RESPONSE-MARKER");
    expect(err.message).not.toContain("question");
    expect(llm.complete).toHaveBeenCalledTimes(1); // 47. no retry
  });

  it("17. structured args locally validated (extra keys rejected, non-string category rejected)", async () => {
    for (const args of [
      { category: "bug", language: "en", extra: true },
      { category: 1, language: "en" },
      { category: "bug", language: 5 },
      null,
      [],
    ]) {
      const llm = fakeClassifierLlm([
        {
          toolCalls: [{ id: "x", name: CLASSIFICATION_SUBMIT_TOOL_NAME, arguments: args }],
          finishReason: "tool_calls",
        },
      ]);
      await expect(
        createLlmReviewClassifier({ llm: llm.adapter }).classify(review()),
      ).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
      });
    }
  });
});

// =====================================================================
describe("LLM classifier — request construction", () => {
  it("27/28/29/30/31. deterministic request: fixed system prompt, temp 0, maxOutputTokens 128, one tool, selected fields only", async () => {
    const llm = fakeClassifierLlm([fx("bug_en"), fx("bug_en")]);
    const classifier = createLlmReviewClassifier({ llm: llm.adapter });
    const r = review({
      originalText: "aplikasi crash saat login",
      starRating: 2,
      reviewerLanguage: "id",
      appVersionName: "1.2.3",
      developerReply: { text: "DEV-REPLY-MARKER", lastModified: { seconds: "9", nanos: 0 } },
    });
    await classifier.classify(r);
    await classifier.classify(r);
    const [a, b] = llm.requests;
    expect(a).toEqual(b);
    expect(a?.temperature).toBe(0);
    expect(a?.maxOutputTokens).toBe(128);
    expect(a?.tools).toHaveLength(1);
    expect(a?.tools?.[0]?.name).toBe(CLASSIFICATION_SUBMIT_TOOL_NAME);
    expect(a?.tools?.[0]?.inputSchema).toEqual({
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["bug", "feature-request", "praise", "complaint", "spam"],
        },
        language: { type: "string", pattern: "^[a-z]{2,3}$" },
      },
      required: ["category", "language"],
      additionalProperties: false,
    });
    expect(a?.messages[0]).toEqual({ role: "system", content: CLASSIFIER_SYSTEM_PROMPT });
    expect(a?.messages).toHaveLength(2);
    const user = a?.messages[1] as { role: string; content: string };
    expect(user.role).toBe("user");
    expect(user.content).toContain(REVIEW_TEXT_MARKER);
    expect(user.content).toContain("aplikasi crash saat login");
    expect(user.content).toContain('"starRating":2');
    expect(user.content).toContain('"reviewerLanguage":"id"');
    expect(user.content).toContain('"reviewId":"r1"');
    expect(user.content).not.toContain("DEV-REPLY-MARKER");
    expect(user.content).not.toContain("1.2.3");
    expect(user.content).not.toContain("changeType");
    expect(user.content).not.toContain("userLastModified");
    expect(user.content).not.toContain("authorName");
    expect(user.content).not.toContain("deviceMetadata");
  });

  it("32/33. malicious review stays in the user/data message; system prompt and tool schema unchanged", async () => {
    const llm = fakeClassifierLlm([fx("injection_review_classified_complaint")]);
    const injected = fixtures.reviews.injection;
    const result = await createLlmReviewClassifier({ llm: llm.adapter }).classify(
      review({ reviewId: injected.reviewId, text: injected.text }),
    );
    const req = llm.requests[0];
    expect(req?.messages[0]).toEqual({ role: "system", content: CLASSIFIER_SYSTEM_PROMPT });
    expect((req?.messages[1] as { content: string }).content).toContain(injected.text);
    expect(req?.tools?.[0]?.name).toBe(CLASSIFICATION_SUBMIT_TOOL_NAME);
    expect(req?.tools?.[0]?.inputSchema).toEqual(llm.requests[0]?.tools?.[0]?.inputSchema);
    expect(result).toEqual({ reviewId: injected.reviewId, category: "complaint", language: "en" });
    expect(JSON.stringify(result)).not.toContain(PROMPT_MARKER);
  });

  it("does not mutate the NormalizedReview", async () => {
    const llm = fakeClassifierLlm([fx("bug_en")]);
    const r = review({ starRating: 1 });
    const snapshot = JSON.stringify(r);
    await createLlmReviewClassifier({ llm: llm.adapter }).classify(r);
    expect(JSON.stringify(r)).toBe(snapshot);
  });

  it("factory validates llm", () => {
    expect(() => createLlmReviewClassifier({ llm: {} as never })).toThrow(
      ReviewClassificationError,
    );
  });
});

// =====================================================================
describe("no-text fallback (no LLM)", () => {
  it.each([
    [5, "praise"],
    [4, "praise"],
    [3, "complaint"],
    [2, "complaint"],
    [1, "complaint"],
  ])("34–38. %d stars → %s, 42. LLM call count 0", async (stars, category) => {
    const llm = fakeClassifierLlm([]);
    const result = await createLlmReviewClassifier({ llm: llm.adapter }).classify(
      review({ text: "", starRating: stars, reviewerLanguage: "en-US" }),
    );
    expect(result).toEqual({ reviewId: "r1", category, language: "en" }); // 39
    expect(llm.complete).toHaveBeenCalledTimes(0);
  });

  it("40. missing language → und; whitespace-only text and originalText count as blank", async () => {
    const llm = fakeClassifierLlm([]);
    const result = await createLlmReviewClassifier({ llm: llm.adapter }).classify(
      review({ text: "   ", originalText: "\n", starRating: 5 }),
    );
    expect(result).toEqual({ reviewId: "r1", category: "praise", language: "und" });
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("41. missing text + missing/invalid rating → INVALID_ARGUMENT, no LLM", async () => {
    const llm = fakeClassifierLlm([]);
    for (const starRating of [undefined, 0, 6, 2.5, -1]) {
      await expect(
        createLlmReviewClassifier({ llm: llm.adapter }).classify(review({ text: "", starRating })),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("originalText alone is meaningful text → LLM is used", async () => {
    const llm = fakeClassifierLlm([fx("bug_en")]);
    await createLlmReviewClassifier({ llm: llm.adapter }).classify(
      review({ text: "", originalText: "crash" }),
    );
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it("invalid review input (blank reviewId) → INVALID_ARGUMENT", async () => {
    const llm = fakeClassifierLlm([]);
    await expect(
      createLlmReviewClassifier({ llm: llm.adapter }).classify(review({ reviewId: " " })),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

// =====================================================================
describe("LLM failure", () => {
  it("43–47. LlmError → LLM_FAILED, cause preserved, raw message not leaked, exactly one call, no retry", async () => {
    const providerError = new LlmError(
      fixtures.llm_failure.code,
      fixtures.llm_failure.message,
      "fake-provider",
      "complete",
      500,
    );
    const llm = fakeClassifierLlm([providerError, fx("bug_en")]);
    let caught: unknown;
    try {
      await createLlmReviewClassifier({ llm: llm.adapter }).classify(review());
    } catch (e) {
      caught = e;
    }
    const err = caught as ReviewClassificationError;
    expect(err).toBeInstanceOf(ReviewClassificationError);
    expect(err.code).toBe("LLM_FAILED");
    expect(err.cause).toBe(providerError);
    expect(err.message).not.toContain("FAKE-PROVIDER-ERROR-MARKER");
    expect(String(err)).not.toContain("FAKE-PROVIDER-ERROR-MARKER");
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it("non-LlmError throw is also wrapped as LLM_FAILED", async () => {
    const llm = fakeClassifierLlm([new TypeError("FAKE-PROVIDER-ERROR-MARKER boom")]);
    await expect(
      createLlmReviewClassifier({ llm: llm.adapter }).classify(review()),
    ).rejects.toMatchObject({
      code: "LLM_FAILED",
    });
  });
});

// =====================================================================
describe("reviews.classify runtime tool", () => {
  function makeTool(responses: (LlmResponse | Error)[] = [fx("bug_en")]) {
    const llm = fakeClassifierLlm(responses);
    const built = createReviewClassificationTool({
      classifier: createLlmReviewClassifier({ llm: llm.adapter }),
    });
    return { ...built, llm };
  }

  it("48/49/50/51. registers as read without verifier; binding name exact", () => {
    const { tool, binding } = makeTool();
    const registry = new ToolRegistry();
    registry.register(tool);
    const reg = registry.get(REVIEWS_CLASSIFY_TOOL_NAME);
    expect(REVIEWS_CLASSIFY_TOOL_NAME).toBe("reviews.classify");
    expect(reg.permission).toBe("read");
    expect(reg.verify).toBeUndefined();
    expect(binding.toolName).toBe("reviews.classify");
    expect(binding.llm.name).toBe("reviews.classify");
    expect(binding.approval).toBeUndefined();
  });

  it("52/54. input schema: reviewId + text/originalText/starRating only; provider config rejected", () => {
    const { tool } = makeTool();
    expect(tool.inputSchema.parse({ reviewId: "r1", text: "hi" })).toEqual({
      reviewId: "r1",
      text: "hi",
    });
    expect(tool.inputSchema.parse({ reviewId: "r1", starRating: 5 })).toEqual({
      reviewId: "r1",
      starRating: 5,
    });
    expect(
      tool.inputSchema.parse({
        reviewId: "r1",
        text: "a",
        originalText: "b",
        starRating: 3,
        reviewerLanguage: "id",
      }),
    ).toEqual({
      reviewId: "r1",
      text: "a",
      originalText: "b",
      starRating: 3,
      reviewerLanguage: "id",
    });
    for (const bad of [
      { text: "hi" },
      { reviewId: "", text: "hi" },
      { reviewId: "r1" },
      { reviewId: "r1", text: "" },
      { reviewId: "r1", text: 5 },
      { reviewId: "r1", starRating: 7 },
      { reviewId: "r1", text: "hi", provider: "x" },
      { reviewId: "r1", text: "hi", apiKey: "x" },
      { reviewId: "r1", text: "hi", baseUrl: "x" },
      { reviewId: "r1", text: "hi", model: "x" },
      { reviewId: "r1", text: "hi", prompt: "x" },
      { reviewId: "r1", text: "hi", temperature: 1 },
      { reviewId: "r1", text: "hi", maxTokens: 1 },
      { reviewId: "r1", text: "hi", checkpointPath: "x" },
      { reviewId: "r1", text: "hi", packageName: "x" },
      { reviewId: "r1", text: "hi", authorName: "x" },
      null,
      "r1",
      [],
    ]) {
      expect(() => tool.inputSchema.parse(bad)).toThrow(ReviewClassificationError);
    }
    const llmSchema = JSON.stringify(makeTool().binding.llm.inputSchema);
    for (const forbidden of [
      "provider",
      "apiKey",
      "baseUrl",
      "model",
      "prompt",
      "temperature",
      "maxTokens",
      "checkpointPath",
      "packageName",
    ]) {
      expect(llmSchema).not.toContain(`"${forbidden}"`);
    }
  });

  it("53. output schema validates classification and rejects junk", async () => {
    const { tool } = makeTool();
    const out = await tool.execute({ reviewId: "r1", text: "crash" }, {});
    expect(tool.outputSchema.parse(out)).toEqual({
      reviewId: "r1",
      category: "bug",
      language: "en",
    });
    for (const bad of [
      { reviewId: "r1", category: "bug" },
      { reviewId: "r1", category: "other", language: "en" },
      { reviewId: "r1", category: "bug", language: "EN" },
      { reviewId: "", category: "bug", language: "en" },
      { reviewId: "r1", category: "bug", language: "en", reasoning: "x" },
      null,
    ]) {
      expect(() => tool.outputSchema.parse(bad)).toThrow(ReviewClassificationError);
    }
  });

  it("55/56. serializer emits only reviewId/category/language, never review text", async () => {
    const { tool, binding } = makeTool();
    const out = await tool.execute({ reviewId: "r1", text: `${REVIEW_TEXT_MARKER} crash` }, {});
    const text = binding.serializeResult(out, {
      toolName: "reviews.classify",
      permission: "read",
      required: false,
      status: "skipped",
      code: "VERIFICATION_SKIPPED",
      verified: false,
    });
    expect(text).toBe('{"reviewId":"r1","category":"bug","language":"en"}');
    expect(text).not.toContain(REVIEW_TEXT_MARKER);
    expect(() => binding.serializeResult({ reviewId: "r1" }, undefined as never)).toThrow();
  });

  it("57. permission engine allows read without approval", () => {
    const { tool } = makeTool();
    const registry = new ToolRegistry();
    registry.register(tool);
    expect(evaluateToolPermission(registry.get("reviews.classify")).code).toBe("ALLOWED");
  });

  it("execute uses the no-text fallback without calling the LLM", async () => {
    const { tool, llm } = makeTool([]);
    await expect(
      tool.execute({ reviewId: "r9", starRating: 5, reviewerLanguage: "pt-BR" }, {}),
    ).resolves.toEqual({
      reviewId: "r9",
      category: "praise",
      language: "pt",
    });
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("factory validates classifier", () => {
    expect(() => createReviewClassificationTool({ classifier: {} as never })).toThrow(
      ReviewClassificationError,
    );
  });
});

// =====================================================================
describe("real Phase 2 integration through runAgent", () => {
  const limits = { maxSteps: 5, maxToolCalls: 5, maxTotalTokens: 10_000 };
  const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

  function outerLlm(responses: LlmResponse[]) {
    const requests: LlmRequest[] = [];
    const adapter: LlmAdapter = {
      provider: "fake-outer",
      complete: vi.fn(async (request: LlmRequest) => {
        requests.push(request);
        const next = responses.shift();
        if (!next) throw new Error("outer LLM exhausted");
        return next;
      }),
    };
    return { adapter, requests };
  }

  it("full lifecycle: read/ALLOWED → classifier LLM once → VERIFICATION_SKIPPED → safe result → COMPLETED", async () => {
    const classifierLlm = fakeClassifierLlm([fx("feature_request_id")]);
    const built = createReviewClassificationTool({
      classifier: createLlmReviewClassifier({ llm: classifierLlm.adapter }),
    });
    const execSpy = vi.spyOn(built.tool, "execute");
    const createSpy = vi.spyOn(approvalsModule, "createApprovalRequest");
    const loadSpy = vi.spyOn(checkpointModule, "createFileReviewCheckpointStore");
    const ingestSpy = vi.spyOn(ingestionModule, "ingestReviews");
    const registry = new ToolRegistry();
    registry.register(built.tool);
    const outer = outerLlm([
      {
        toolCalls: [
          {
            id: "c1",
            name: "reviews.classify",
            arguments: {
              reviewId: "r1",
              text: `${REVIEW_TEXT_MARKER} tolong tambah mode gelap`,
              reviewerLanguage: "id",
            },
          },
        ],
        finishReason: "tool_calls",
        usage,
      },
      { content: "Classified.", toolCalls: [], finishReason: "stop", usage },
    ]);
    const result = await runAgent({
      llm: outer.adapter,
      registry,
      bindings: [built.binding],
      messages: [{ role: "user", content: "Classify review r1." }],
      limits,
      ledger: createFileAgentLedger(auditPath),
      runId: () => "run-classify-1",
      now: () => new Date("2026-09-26T00:00:00Z"),
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBe("COMPLETED");
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(classifierLlm.complete).toHaveBeenCalledTimes(1);
    expect(createSpy).not.toHaveBeenCalled();
    expect(loadSpy).not.toHaveBeenCalled();
    expect(ingestSpy).not.toHaveBeenCalled();

    const toolMsg = outer.requests[1]?.messages.find((m) => m.role === "tool") as {
      content: string;
    };
    expect(toolMsg.content).toBe('{"reviewId":"r1","category":"feature-request","language":"id"}');
    expect(toolMsg.content).not.toContain(REVIEW_TEXT_MARKER);

    const entries = readAuditEntries(auditPath);
    const verification = entries.find((e) => e.type === "verification.completed");
    expect(verification?.metadata).toMatchObject({
      code: "VERIFICATION_SKIPPED",
      permission: "read",
      required: false,
    });
    expect(entries.some((e) => e.type.startsWith("approval."))).toBe(false);
    const auditText = readFileSync(auditPath, "utf8");
    expect(auditText).not.toContain(REVIEW_TEXT_MARKER);
    expect(auditText).not.toContain("mode gelap");
    expect(auditText).not.toContain(PROMPT_MARKER);
    expect(auditText).not.toContain("feature-request"); // classification content is not audited either
    expect(existsSync(join(dir, "state"))).toBe(false); // no checkpoint state created
  });

  it("prompt-injection-shaped review: text is data only; system prompt unchanged; nothing leaks", async () => {
    const injected = fixtures.reviews.injection;
    const classifierLlm = fakeClassifierLlm([fx("injection_review_classified_complaint")]);
    const built = createReviewClassificationTool({
      classifier: createLlmReviewClassifier({ llm: classifierLlm.adapter }),
    });
    const registry = new ToolRegistry();
    registry.register(built.tool);
    const outer = outerLlm([
      {
        toolCalls: [
          {
            id: "c1",
            name: "reviews.classify",
            arguments: { reviewId: injected.reviewId, text: injected.text },
          },
        ],
        finishReason: "tool_calls",
        usage,
      },
      { content: "Done.", toolCalls: [], finishReason: "stop", usage },
    ]);
    const result = await runAgent({
      llm: outer.adapter,
      registry,
      bindings: [built.binding],
      messages: [{ role: "user", content: "Classify." }],
      limits,
      ledger: createFileAgentLedger(auditPath),
    });
    expect(result.code).toBe("COMPLETED");
    const req = classifierLlm.requests[0];
    expect(req?.messages[0]).toEqual({ role: "system", content: CLASSIFIER_SYSTEM_PROMPT });
    expect(req?.messages[1]?.role).toBe("user");
    expect((req?.messages[1] as { content: string }).content).toContain(injected.text);
    const toolMsg = outer.requests[1]?.messages.find((m) => m.role === "tool") as {
      content: string;
    };
    expect(toolMsg.content).toBe(
      `{"reviewId":"${injected.reviewId}","category":"complaint","language":"en"}`,
    );
    expect(toolMsg.content).not.toContain(PROMPT_MARKER);
    const auditText = readFileSync(auditPath, "utf8");
    expect(auditText).not.toContain("Ignore all previous");
    expect(auditText).not.toContain(PROMPT_MARKER);
  });

  it("classifier LLM failure inside the tool → EXECUTION_FAILED; provider text absent from audit", async () => {
    const classifierLlm = fakeClassifierLlm([
      new LlmError("HTTP_ERROR", "FAKE-PROVIDER-ERROR-MARKER", "fake-provider", "complete", 500),
    ]);
    const built = createReviewClassificationTool({
      classifier: createLlmReviewClassifier({ llm: classifierLlm.adapter }),
    });
    const registry = new ToolRegistry();
    registry.register(built.tool);
    const outer = outerLlm([
      {
        toolCalls: [
          { id: "c1", name: "reviews.classify", arguments: { reviewId: "r1", text: "crash" } },
        ],
        finishReason: "tool_calls",
        usage,
      },
    ]);
    const result = await runAgent({
      llm: outer.adapter,
      registry,
      bindings: [built.binding],
      messages: [{ role: "user", content: "Classify." }],
      limits,
      ledger: createFileAgentLedger(auditPath),
    });
    expect(result.code).toBe("EXECUTION_FAILED");
    expect(result.externalStateUncertain).toBe(false); // read tool
    expect(readFileSync(auditPath, "utf8")).not.toContain("FAKE-PROVIDER-ERROR-MARKER");
    expect(classifierLlm.complete).toHaveBeenCalledTimes(1);
  });

  it("outer LLM cannot supply provider config → INPUT_INVALID before execute", async () => {
    const classifierLlm = fakeClassifierLlm([fx("bug_en")]);
    const built = createReviewClassificationTool({
      classifier: createLlmReviewClassifier({ llm: classifierLlm.adapter }),
    });
    const registry = new ToolRegistry();
    registry.register(built.tool);
    const outer = outerLlm([
      {
        toolCalls: [
          {
            id: "c1",
            name: "reviews.classify",
            arguments: { reviewId: "r1", text: "x", model: "evil" },
          },
        ],
        finishReason: "tool_calls",
        usage,
      },
    ]);
    const result = await runAgent({
      llm: outer.adapter,
      registry,
      bindings: [built.binding],
      messages: [{ role: "user", content: "Classify." }],
      limits,
      ledger: createFileAgentLedger(auditPath),
    });
    expect(result.code).toBe("INPUT_INVALID");
    expect(classifierLlm.complete).not.toHaveBeenCalled();
  });
});

// =====================================================================
describe("isolation & dependencies", () => {
  it("classification modules import only provider-neutral runtime + Phase 3.1 types; no 9Router/Google/checkpoint/browser", () => {
    const root = join(import.meta.dirname, "..");
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const f of ["src/reviews/classification/index.ts", "src/reviews/classification/tool.ts"]) {
      const src = strip(readFileSync(join(root, f), "utf8"));
      const imports = [...src.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1]);
      for (const imp of imports) {
        expect(imp).not.toMatch(/9router|providers/);
        expect(imp).not.toMatch(/@googleapis|googleplay/);
        expect(imp).not.toMatch(/checkpoint|source\/androidpublisher|reviews\/tool/);
        expect(imp).not.toMatch(/runtime\/browser/);
        expect(imp).not.toMatch(/^node:/);
      }
      expect(src).not.toMatch(/fetch\(/);
      expect(src).not.toMatch(/process\.env/);
      expect(src).not.toMatch(/reviews\.reply/);
      expect(src).not.toMatch(/as any/);
    }
  });

  it("fixture file is marked fake and contains no key-like material", () => {
    const raw = readFileSync(fixturesPath, "utf8");
    expect(raw).toMatch(/FAKE fixtures/);
    expect(raw).not.toMatch(/Bearer |sk-|PRIVATE KEY/);
  });

  it("no language-detection or LLM SDK dependency exists", () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
    };
    const names = Object.keys(pkg.dependencies ?? {});
    expect(names).toHaveLength(4);
    for (const bad of [
      "openai",
      "zod",
      "ajv",
      "axios",
      "langchain",
      "ai",
      "franc",
      "cld",
      "langdetect",
    ]) {
      expect(names).not.toContain(bad);
    }
  });

  it("typed input for classifier accepts a plain ReviewClassificationInput (not only NormalizedReview)", async () => {
    const llm = fakeClassifierLlm([fx("praise_es")]);
    const input: ReviewClassificationInput = { reviewId: "x", text: "me encanta" };
    await expect(createLlmReviewClassifier({ llm: llm.adapter }).classify(input)).resolves.toEqual({
      reviewId: "x",
      category: "praise",
      language: "es",
    });
  });
});

/**
 * Phase 3.3 — `reviews.draft_reply` runtime tool for the real Phase 2 runtime.
 *
 * Permission = `read`: drafting performs analysis/generation only, no Google mutation, no
 * durable local mutation → no approval, verification legitimately SKIPPED (no verifier).
 *
 * NEVER AUTO-PUBLISH: this module MUST NOT import or invoke reviews.reply or any Android
 * Publisher write operation. It MUST NOT create ApprovalRequest, publish tokens, or POST
 * requests. Future publication is a separate tool (Phase 3.4) and MUST pass the high-risk
 * runtime approval gate.
 *
 * NESTED LLM ACCOUNTING LIMITATION: `draft()` performs its own `LlmAdapter.complete()` which
 * is NOT included in the Phase 2.6 outer agent token/cost budget.
 */
import type { AgentToolBinding } from "../../runtime/agent/index.js";
import type { ToolDefinition, ToolSchema } from "../../runtime/tools/index.js";
import type { VerificationResult } from "../../runtime/verification/index.js";
import {
  REVIEW_CATEGORIES,
  type ReviewCategory,
  type ReviewClassification,
} from "../classification/index.js";
import type { NormalizedReview } from "../ingestion/index.js";
import {
  ReviewReplyDraftError,
  validateReplyText,
  type ReviewReplyDraft,
  type ReviewReplyDraftInput,
  type ReviewReplyDrafter,
} from "./index.js";

export const REVIEWS_DRAFT_REPLY_TOOL_NAME = "reviews.draft_reply";

const ALLOWED_REVIEW_KEYS = new Set([
  "reviewId",
  "text",
  "originalText",
  "starRating",
  "reviewerLanguage",
]);
const ALLOWED_CLASSIFICATION_KEYS = new Set(["reviewId", "category", "language"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function invalid(message: string): ReviewReplyDraftError {
  return new ReviewReplyDraftError("INVALID_ARGUMENT", message);
}

function parseReview(v: unknown): NormalizedReview {
  if (!isRecord(v)) throw invalid("review must be an object.");
  for (const key of Object.keys(v)) {
    if (!ALLOWED_REVIEW_KEYS.has(key)) throw invalid(`review has unsupported field "${key}".`);
  }
  const { reviewId, text, originalText, starRating, reviewerLanguage } = v;
  if (typeof reviewId !== "string" || reviewId.trim() === "")
    throw invalid("review.reviewId is required.");
  const out: Record<string, unknown> = { reviewId };
  if (text !== undefined) {
    if (typeof text !== "string") throw invalid("review.text must be a string.");
    out.text = text;
  }
  if (originalText !== undefined) {
    if (typeof originalText !== "string") throw invalid("review.originalText must be a string.");
    out.originalText = originalText;
  }
  if (starRating !== undefined) {
    if (
      typeof starRating !== "number" ||
      !Number.isInteger(starRating) ||
      starRating < 1 ||
      starRating > 5
    )
      throw invalid("review.starRating must be an integer from 1 to 5.");
    out.starRating = starRating;
  }
  if (reviewerLanguage !== undefined) {
    if (typeof reviewerLanguage !== "string")
      throw invalid("review.reviewerLanguage must be a string.");
    out.reviewerLanguage = reviewerLanguage;
  }
  return out as unknown as NormalizedReview;
}

function parseClassification(v: unknown): ReviewClassification {
  if (!isRecord(v)) throw invalid("classification must be an object.");
  for (const key of Object.keys(v)) {
    if (!ALLOWED_CLASSIFICATION_KEYS.has(key))
      throw invalid(`classification has unsupported field "${key}".`);
  }
  const { reviewId, category, language } = v;
  if (typeof reviewId !== "string" || reviewId.trim() === "")
    throw invalid("classification.reviewId is required.");
  if (!(REVIEW_CATEGORIES as readonly unknown[]).includes(category))
    throw invalid("classification.category is not valid.");
  if (typeof language !== "string" || !/^[a-z]{2,3}$/.test(language))
    throw invalid("classification.language is not valid.");
  return Object.freeze({ reviewId, category: category as ReviewCategory, language });
}

const inputSchema: ToolSchema<ReviewReplyDraftInput> = {
  parse(value: unknown): ReviewReplyDraftInput {
    if (!isRecord(value)) throw invalid("reviews.draft_reply input must be an object.");
    for (const key of Object.keys(value)) {
      if (key !== "review" && key !== "classification")
        throw invalid(`reviews.draft_reply input has unsupported field "${key}".`);
    }
    const review = parseReview((value as { review?: unknown }).review);
    const classification = parseClassification(
      (value as { classification?: unknown }).classification,
    );
    if (review.reviewId !== classification.reviewId) {
      throw invalid(
        `reviewId mismatch: review has "${review.reviewId}", classification has "${classification.reviewId}".`,
      );
    }
    return Object.freeze({ review, classification });
  },
};

const outputSchema: ToolSchema<ReviewReplyDraft> = {
  parse(value: unknown): ReviewReplyDraft {
    if (!isRecord(value)) throw invalid("Draft result must be an object.");
    const keys = Object.keys(value);
    if (keys.length !== 4)
      throw invalid("Draft result must have exactly reviewId, category, language, replyText.");
    const { reviewId, category, language, replyText } = value;
    if (typeof reviewId !== "string" || reviewId.trim() === "")
      throw invalid("Draft result reviewId is invalid.");
    if (!(REVIEW_CATEGORIES as readonly unknown[]).includes(category))
      throw invalid("Draft result category is invalid.");
    if (typeof language !== "string" || !/^[a-z]{2,3}$/.test(language))
      throw invalid("Draft result language is invalid.");
    const validated = validateReplyText(replyText);
    return Object.freeze({
      reviewId,
      category: category as ReviewCategory,
      language,
      replyText: validated,
    });
  },
};

export interface ReviewDraftReplyToolOptions {
  readonly drafter: ReviewReplyDrafter;
}

export interface ReviewDraftReplyTool {
  readonly tool: ToolDefinition<ReviewReplyDraftInput, ReviewReplyDraft>;
  readonly binding: AgentToolBinding;
}

export function createReviewDraftReplyTool(
  options: ReviewDraftReplyToolOptions,
): ReviewDraftReplyTool {
  const drafter = options?.drafter;
  if (!drafter || typeof drafter.draft !== "function") {
    throw invalid("drafter.draft must be a function.");
  }
  const description =
    "Draft a concise public reply to a Google Play review using the validated classification. The reply is draft text only — never published. Read-only analysis; no data is changed.";

  const tool: ToolDefinition<ReviewReplyDraftInput, ReviewReplyDraft> = {
    name: REVIEWS_DRAFT_REPLY_TOOL_NAME,
    description,
    permission: "read",
    inputSchema,
    outputSchema,
    async execute(input) {
      return drafter.draft(input);
    },
    // No verifier: read tool; verification is legitimately SKIPPED.
  };

  const binding: AgentToolBinding = {
    toolName: REVIEWS_DRAFT_REPLY_TOOL_NAME,
    llm: {
      name: REVIEWS_DRAFT_REPLY_TOOL_NAME,
      description,
      inputSchema: {
        type: "object",
        properties: {
          review: {
            type: "object",
            description: "Normalized review fields needed for drafting.",
            properties: {
              reviewId: { type: "string" },
              text: { type: "string" },
              originalText: { type: "string" },
              starRating: { type: "integer", minimum: 1, maximum: 5 },
              reviewerLanguage: { type: "string" },
            },
            required: ["reviewId"],
            additionalProperties: false,
          },
          classification: {
            type: "object",
            description: "Validated Phase 3.2 classification (reviewId, category, language).",
            properties: {
              reviewId: { type: "string" },
              category: { type: "string", enum: [...REVIEW_CATEGORIES] },
              language: { type: "string", pattern: "^[a-z]{2,3}$" },
            },
            required: ["reviewId", "category", "language"],
            additionalProperties: false,
          },
        },
        required: ["review", "classification"],
        additionalProperties: false,
      },
    },
    serializeResult(output: unknown, verification: VerificationResult): string {
      const result = outputSchema.parse(output);
      if (!verification || typeof verification.verified !== "boolean") {
        throw invalid("Verification result is required.");
      }
      return JSON.stringify({
        reviewId: result.reviewId,
        category: result.category,
        language: result.language,
        replyText: result.replyText,
      });
    },
  };

  return Object.freeze({ tool, binding });
}

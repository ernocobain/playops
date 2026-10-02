/**
 * Phase 3.2 — `reviews.classify` runtime tool for the real Phase 2 runtime.
 *
 * Permission = `read`: no Google mutation, no durable local mutation, analysis only →
 * no approval, verification legitimately SKIPPED (no verifier is declared on purpose).
 * Provider/model/prompt/temperature/token settings are composition-owned via the injected
 * `ReviewClassifier`; the model-supplied input can only carry review fields.
 */
import type { AgentToolBinding } from "../../runtime/agent/index.js";
import type { ToolDefinition, ToolSchema } from "../../runtime/tools/index.js";
import type { VerificationResult } from "../../runtime/verification/index.js";
import {
  isReviewCategory,
  parseLanguageCode,
  ReviewClassificationError,
  type ReviewClassification,
  type ReviewClassificationInput,
  type ReviewClassifier,
} from "./index.js";

export const REVIEWS_CLASSIFY_TOOL_NAME = "reviews.classify";

const ALLOWED_INPUT_KEYS = new Set([
  "reviewId",
  "text",
  "originalText",
  "starRating",
  "reviewerLanguage",
]);

function invalid(message: string): ReviewClassificationError {
  return new ReviewClassificationError("INVALID_ARGUMENT", message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const inputSchema: ToolSchema<ReviewClassificationInput> = {
  parse(value: unknown): ReviewClassificationInput {
    if (!isRecord(value)) throw invalid("reviews.classify input must be an object.");
    for (const key of Object.keys(value)) {
      if (!ALLOWED_INPUT_KEYS.has(key))
        throw invalid(`reviews.classify input has unsupported field "${key}".`);
    }
    const { reviewId, text, originalText, starRating, reviewerLanguage } = value;
    if (typeof reviewId !== "string" || reviewId.trim() === "")
      throw invalid("reviewId is required.");
    const out: Record<string, unknown> = { reviewId };
    if (text !== undefined) {
      if (typeof text !== "string") throw invalid("text must be a string.");
      out.text = text;
    }
    if (originalText !== undefined) {
      if (typeof originalText !== "string") throw invalid("originalText must be a string.");
      out.originalText = originalText;
    }
    if (starRating !== undefined) {
      if (
        typeof starRating !== "number" ||
        !Number.isInteger(starRating) ||
        starRating < 1 ||
        starRating > 5
      ) {
        throw invalid("starRating must be an integer from 1 to 5.");
      }
      out.starRating = starRating;
    }
    if (reviewerLanguage !== undefined) {
      if (typeof reviewerLanguage !== "string") throw invalid("reviewerLanguage must be a string.");
      out.reviewerLanguage = reviewerLanguage;
    }
    const hasText =
      (typeof text === "string" && text.trim() !== "") ||
      (typeof originalText === "string" && originalText.trim() !== "");
    if (!hasText && starRating === undefined) {
      throw invalid("reviews.classify needs text, originalText, or starRating.");
    }
    // Assembled field-by-field from validated values above; structural re-label only.
    return Object.freeze(out) as unknown as ReviewClassificationInput;
  },
};

const outputSchema: ToolSchema<ReviewClassification> = {
  parse(value: unknown): ReviewClassification {
    if (!isRecord(value)) throw invalid("Classification result must be an object.");
    const keys = Object.keys(value);
    if (keys.length !== 3)
      throw invalid("Classification result must have exactly reviewId, category, language.");
    const { reviewId, category, language } = value;
    if (typeof reviewId !== "string" || reviewId.trim() === "")
      throw invalid("Classification reviewId is invalid.");
    if (!isReviewCategory(category)) throw invalid("Classification category is invalid.");
    const lang = parseLanguageCode(language);
    if (lang === undefined) throw invalid("Classification language is invalid.");
    return Object.freeze({ reviewId, category, language: lang });
  },
};

export interface ReviewClassificationToolOptions {
  readonly classifier: ReviewClassifier;
}

export interface ReviewClassificationTool {
  readonly tool: ToolDefinition<ReviewClassificationInput, ReviewClassification>;
  readonly binding: AgentToolBinding;
}

export function createReviewClassificationTool(
  options: ReviewClassificationToolOptions,
): ReviewClassificationTool {
  const classifier = options?.classifier;
  if (!classifier || typeof classifier.classify !== "function") {
    throw invalid("classifier.classify must be a function.");
  }
  const description =
    "Classify one Google Play review into exactly one category (bug, feature-request, praise, complaint, spam) and its primary language code. Read-only analysis; no data is changed.";

  const tool: ToolDefinition<ReviewClassificationInput, ReviewClassification> = {
    name: REVIEWS_CLASSIFY_TOOL_NAME,
    description,
    permission: "read",
    inputSchema,
    outputSchema,
    async execute(input) {
      return classifier.classify(input);
    },
    // No verifier on purpose: read tool; verification is legitimately SKIPPED.
  };

  const binding: AgentToolBinding = {
    toolName: REVIEWS_CLASSIFY_TOOL_NAME,
    llm: {
      name: REVIEWS_CLASSIFY_TOOL_NAME,
      description,
      inputSchema: {
        type: "object",
        properties: {
          reviewId: { type: "string", description: "Review identifier from reviews.ingest." },
          text: { type: "string", description: "Review text (may be translated)." },
          originalText: {
            type: "string",
            description: "Original untranslated review text, if any.",
          },
          starRating: { type: "integer", minimum: 1, maximum: 5 },
          reviewerLanguage: {
            type: "string",
            description: "Language hint reported by Google, if any.",
          },
        },
        required: ["reviewId"],
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
      });
    },
  };

  return Object.freeze({ tool, binding });
}

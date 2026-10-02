/**
 * Phase 3.1 — `reviews.ingest` runtime tool composition for the real Phase 2 runtime.
 *
 * Permission = `write`: Google-side behavior is read-only, but execution mutates durable
 * local checkpoint state. Normal local mutation → no human approval, but Phase 2 policy
 * requires post-action verification, implemented here as LOCAL checkpoint read-back
 * (no Google call): checkpoint loads, packageName matches, and every timestamp this run
 * committed is present at an equal-or-newer value.
 *
 * packageName, checkpoint location, page bounds are bound by composition; the model input
 * is an empty object and any extra key is rejected by the authoritative ToolSchema.
 */
import type { AgentToolBinding } from "../runtime/agent/index.js";
import type { ToolDefinition, ToolSchema } from "../runtime/tools/index.js";
import type { VerificationResult } from "../runtime/verification/index.js";
import { compareReviewTimestamps, parseReviewTimestamp, ReviewIngestionError } from "./common.js";
import { parseReviewCheckpoint, type ReviewCheckpointStore } from "./checkpoint/index.js";
import {
  DEFAULT_REVIEW_MAX_PAGES,
  DEFAULT_REVIEW_PAGE_SIZE,
  ingestReviews,
  type NormalizedReview,
  type ReviewIngestionResult,
  type ReviewSource,
} from "./ingestion/index.js";

export const REVIEWS_INGEST_TOOL_NAME = "reviews.ingest";

export type ReviewsIngestInput = Readonly<Record<string, never>>;

export interface ReviewIngestionToolOptions {
  readonly packageName: string;
  readonly source: ReviewSource;
  readonly checkpointStore: ReviewCheckpointStore;
  readonly maxPages?: number;
  readonly pageSize?: number;
}

export interface ReviewIngestionTool {
  readonly tool: ToolDefinition<ReviewsIngestInput, ReviewIngestionResult>;
  readonly binding: AgentToolBinding;
}

const inputSchema: ToolSchema<ReviewsIngestInput> = {
  parse(value: unknown): ReviewsIngestInput {
    if (value === undefined || value === null) return Object.freeze({});
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new ReviewIngestionError("INVALID_ARGUMENT", "reviews.ingest input must be an object.");
    }
    const keys = Object.keys(value);
    if (keys.length > 0) {
      throw new ReviewIngestionError(
        "INVALID_ARGUMENT",
        `reviews.ingest accepts no input fields (received ${keys.length}).`,
      );
    }
    return Object.freeze({});
  },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonNegativeInt(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new ReviewIngestionError("INVALID_ARGUMENT", `Result field ${field} is invalid.`);
  }
  return v;
}

function optString(v: unknown, field: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    throw new ReviewIngestionError("INVALID_ARGUMENT", `Result field ${field} is invalid.`);
  }
  return v;
}

function optInt(v: unknown, field: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new ReviewIngestionError("INVALID_ARGUMENT", `Result field ${field} is invalid.`);
  }
  return v;
}

function parseNormalizedReview(v: unknown): NormalizedReview {
  if (!isRecord(v))
    throw new ReviewIngestionError("INVALID_ARGUMENT", "Result review is not an object.");
  if (typeof v.reviewId !== "string" || v.reviewId.trim() === "") {
    throw new ReviewIngestionError("INVALID_ARGUMENT", "Result review has invalid reviewId.");
  }
  if (v.changeType !== "new" && v.changeType !== "updated") {
    throw new ReviewIngestionError("INVALID_ARGUMENT", "Result review has invalid changeType.");
  }
  const userLastModified = parseReviewTimestamp(v.userLastModified);
  if (userLastModified === undefined) {
    throw new ReviewIngestionError(
      "INVALID_ARGUMENT",
      "Result review has invalid userLastModified.",
    );
  }
  if (typeof v.text !== "string") {
    throw new ReviewIngestionError("INVALID_ARGUMENT", "Result review has invalid text.");
  }
  const out: Record<string, unknown> = {
    reviewId: v.reviewId,
    changeType: v.changeType,
    userLastModified,
    text: v.text,
  };
  const originalText = optString(v.originalText, "originalText");
  if (originalText !== undefined) out.originalText = originalText;
  const starRating = optInt(v.starRating, "starRating");
  if (starRating !== undefined) out.starRating = starRating;
  const reviewerLanguage = optString(v.reviewerLanguage, "reviewerLanguage");
  if (reviewerLanguage !== undefined) out.reviewerLanguage = reviewerLanguage;
  const appVersionCode = optInt(v.appVersionCode, "appVersionCode");
  if (appVersionCode !== undefined) out.appVersionCode = appVersionCode;
  const appVersionName = optString(v.appVersionName, "appVersionName");
  if (appVersionName !== undefined) out.appVersionName = appVersionName;
  if (v.developerReply !== undefined) {
    if (!isRecord(v.developerReply) || typeof v.developerReply.text !== "string") {
      throw new ReviewIngestionError(
        "INVALID_ARGUMENT",
        "Result review has invalid developerReply.",
      );
    }
    const ts = parseReviewTimestamp(v.developerReply.lastModified);
    if (ts === undefined) {
      throw new ReviewIngestionError(
        "INVALID_ARGUMENT",
        "Result review has invalid developerReply.",
      );
    }
    out.developerReply = Object.freeze({ text: v.developerReply.text, lastModified: ts });
  }
  // Built field-by-field above from validated values; the widening record type is only an
  // assembly convenience, so this is a structural re-label, not a trust boundary.
  return Object.freeze(out) as unknown as NormalizedReview;
}

const outputSchema: ToolSchema<ReviewIngestionResult> = {
  parse(value: unknown): ReviewIngestionResult {
    if (!isRecord(value) || !Array.isArray(value.reviews)) {
      throw new ReviewIngestionError("INVALID_ARGUMENT", "reviews.ingest result is malformed.");
    }
    if (typeof value.checkpointChanged !== "boolean") {
      throw new ReviewIngestionError(
        "INVALID_ARGUMENT",
        "Result field checkpointChanged is invalid.",
      );
    }
    return Object.freeze({
      reviews: Object.freeze(value.reviews.map(parseNormalizedReview)),
      fetchedCount: nonNegativeInt(value.fetchedCount, "fetchedCount"),
      newCount: nonNegativeInt(value.newCount, "newCount"),
      updatedCount: nonNegativeInt(value.updatedCount, "updatedCount"),
      unchangedCount: nonNegativeInt(value.unchangedCount, "unchangedCount"),
      pageCount: nonNegativeInt(value.pageCount, "pageCount"),
      checkpointChanged: value.checkpointChanged,
    });
  },
};

export function createReviewIngestionTool(
  options: ReviewIngestionToolOptions,
): ReviewIngestionTool {
  const { packageName, source, checkpointStore } = options;
  if (typeof packageName !== "string" || packageName.trim() === "") {
    throw new ReviewIngestionError("INVALID_ARGUMENT", "packageName must be a non-empty string.");
  }
  if (!source || typeof source.listReviews !== "function") {
    throw new ReviewIngestionError("INVALID_ARGUMENT", "source.listReviews must be a function.");
  }
  if (!checkpointStore || typeof checkpointStore.load !== "function") {
    throw new ReviewIngestionError("INVALID_ARGUMENT", "checkpointStore must implement load/save.");
  }
  const maxPages = options.maxPages ?? DEFAULT_REVIEW_MAX_PAGES;
  const pageSize = options.pageSize ?? DEFAULT_REVIEW_PAGE_SIZE;
  if (!Number.isInteger(maxPages) || maxPages < 1 || !Number.isInteger(pageSize) || pageSize < 1) {
    throw new ReviewIngestionError(
      "INVALID_ARGUMENT",
      "maxPages/pageSize must be positive integers.",
    );
  }

  const tool: ToolDefinition<ReviewsIngestInput, ReviewIngestionResult> = {
    name: REVIEWS_INGEST_TOOL_NAME,
    description:
      "Fetch the currently available Google Play reviews for the configured app and return only reviews that are new or updated since the last local checkpoint. Google exposes only a recent review window; this is not full history.",
    permission: "write",
    inputSchema,
    outputSchema,
    async execute() {
      return ingestReviews({ packageName, source, checkpointStore, maxPages, pageSize });
    },
    /** Local read-back only. Never returns true without loading the persisted checkpoint. */
    async verify(_input, output) {
      let loaded: unknown;
      try {
        loaded = await checkpointStore.load();
      } catch {
        return false;
      }
      if (loaded === undefined) return output.reviews.length === 0 && !output.checkpointChanged;
      let checkpoint;
      try {
        checkpoint = parseReviewCheckpoint(loaded);
      } catch {
        return false;
      }
      if (checkpoint.packageName !== packageName) return false;
      for (const review of output.reviews) {
        const stored = checkpoint.reviews[review.reviewId];
        if (stored === undefined) return false;
        if (compareReviewTimestamps(stored, review.userLastModified) < 0) return false;
      }
      return true;
    },
  };

  const binding: AgentToolBinding = {
    toolName: REVIEWS_INGEST_TOOL_NAME,
    llm: {
      name: REVIEWS_INGEST_TOOL_NAME,
      description: tool.description,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    serializeResult(output: unknown, verification: VerificationResult): string {
      const result = outputSchema.parse(output);
      if (!verification || typeof verification.verified !== "boolean") {
        throw new ReviewIngestionError("INVALID_ARGUMENT", "Verification result is required.");
      }
      return JSON.stringify({
        tool: REVIEWS_INGEST_TOOL_NAME,
        verified: verification.verified,
        fetchedCount: result.fetchedCount,
        newCount: result.newCount,
        updatedCount: result.updatedCount,
        unchangedCount: result.unchangedCount,
        pageCount: result.pageCount,
        checkpointChanged: result.checkpointChanged,
        reviews: result.reviews,
      });
    },
  };

  return Object.freeze({ tool, binding });
}

/**
 * Phase 3.1 — incremental review ingestion (API-first, read-only on Google's side).
 *
 * LIMITATION: Google's reviews.list exposes only a recent window of reviews (documented by
 * Google as roughly the last week). Ingestion therefore yields "new/updated within the
 * window", never complete history. Previously known review IDs absent from the current
 * window are preserved in the checkpoint.
 *
 * Update watermark = userComment.lastModified only. A developer reply change never advances
 * the user-review checkpoint (it is normalized into `developerReply` for later phases).
 * Stale (older-than-checkpoint) API timestamps are treated as unchanged; stored timestamps
 * never move backwards.
 *
 * Commit rule: all pages fetched → all reviews normalized → delta computed → checkpoint
 * merged with max(old, observed) → saved once. Any failure leaves the checkpoint untouched.
 */
import {
  compareReviewTimestamps,
  maxReviewTimestamp,
  parseReviewTimestamp,
  ReviewIngestionError,
  type ReviewTimestamp,
} from "../common.js";
import {
  createEmptyReviewCheckpoint,
  parseReviewCheckpoint,
  type ReviewCheckpoint,
  type ReviewCheckpointStore,
} from "../checkpoint/index.js";

/** Confirmed against @googleapis/androidpublisher@42.1.0 Params$Resource$Reviews$List.maxResults (uint32). */
export const DEFAULT_REVIEW_PAGE_SIZE = 100;
/** Conservative: 50 × 100 = 5,000 reviews per run inside a one-week window. */
export const DEFAULT_REVIEW_MAX_PAGES = 50;

/** Untrusted remote review; structurally mirrors Schema$Review without importing the client. */
export type RemoteReview = Readonly<Record<string, unknown>>;

export interface ReviewSourceInput {
  readonly packageName: string;
  readonly maxResults: number;
  readonly pageToken?: string;
}

export interface ReviewSourcePage {
  readonly reviews: readonly RemoteReview[];
  readonly nextPageToken?: string;
}

export interface ReviewSource {
  listReviews(input: ReviewSourceInput): Promise<ReviewSourcePage>;
}

export type ReviewChangeType = "new" | "updated";

export interface NormalizedDeveloperReply {
  readonly text: string;
  readonly lastModified: ReviewTimestamp;
}

export interface NormalizedReview {
  readonly reviewId: string;
  readonly changeType: ReviewChangeType;
  readonly userLastModified: ReviewTimestamp;
  readonly text: string;
  readonly originalText?: string;
  readonly starRating?: number;
  readonly reviewerLanguage?: string;
  readonly appVersionCode?: number;
  readonly appVersionName?: string;
  readonly developerReply?: NormalizedDeveloperReply;
}

export interface ReviewIngestionResult {
  /** NEW and UPDATED only; oldest userLastModified first, then reviewId (code-point order). */
  readonly reviews: readonly NormalizedReview[];
  readonly fetchedCount: number;
  readonly newCount: number;
  readonly updatedCount: number;
  readonly unchangedCount: number;
  readonly pageCount: number;
  readonly checkpointChanged: boolean;
}

export interface ReviewIngestionInput {
  readonly packageName: string;
  readonly source: ReviewSource;
  readonly checkpointStore: ReviewCheckpointStore;
  readonly maxPages?: number;
  readonly pageSize?: number;
}

interface ObservedReview {
  readonly reviewId: string;
  readonly userLastModified: ReviewTimestamp;
  readonly fields: Omit<NormalizedReview, "reviewId" | "changeType" | "userLastModified">;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function remoteInvalid(detail: string): ReviewIngestionError {
  return new ReviewIngestionError("REMOTE_DATA_INVALID", `Remote review data invalid: ${detail}.`);
}

/** Validates checkpoint-critical fields strictly; optional fields are dropped when malformed. */
export function normalizeRemoteReview(raw: unknown): ObservedReview {
  if (!isRecord(raw)) throw remoteInvalid("review is not an object");
  const reviewId = raw.reviewId;
  if (typeof reviewId !== "string" || reviewId.trim() === "") {
    throw remoteInvalid("reviewId missing or blank");
  }
  const comments = raw.comments;
  if (!Array.isArray(comments)) throw remoteInvalid(`review ${reviewId} has no comments`);
  let user: Record<string, unknown> | undefined;
  let developer: Record<string, unknown> | undefined;
  for (const comment of comments) {
    if (!isRecord(comment)) continue;
    if (user === undefined && isRecord(comment.userComment)) user = comment.userComment;
    if (developer === undefined && isRecord(comment.developerComment)) {
      developer = comment.developerComment;
    }
  }
  if (user === undefined) throw remoteInvalid(`review ${reviewId} has no userComment`);
  const userLastModified = parseReviewTimestamp(user.lastModified);
  if (userLastModified === undefined) {
    throw remoteInvalid(`review ${reviewId} has invalid userComment.lastModified`);
  }

  const fields: Record<string, unknown> = { text: optionalString(user.text) ?? "" };
  const originalText = optionalString(user.originalText);
  if (originalText !== undefined) fields.originalText = originalText;
  const starRating = optionalInteger(user.starRating);
  if (starRating !== undefined) fields.starRating = starRating;
  const reviewerLanguage = optionalString(user.reviewerLanguage);
  if (reviewerLanguage !== undefined) fields.reviewerLanguage = reviewerLanguage;
  const appVersionCode = optionalInteger(user.appVersionCode);
  if (appVersionCode !== undefined) fields.appVersionCode = appVersionCode;
  const appVersionName = optionalString(user.appVersionName);
  if (appVersionName !== undefined) fields.appVersionName = appVersionName;
  if (developer !== undefined) {
    const replyTs = parseReviewTimestamp(developer.lastModified);
    const replyText = optionalString(developer.text);
    if (replyTs !== undefined && replyText !== undefined) {
      fields.developerReply = Object.freeze({ text: replyText, lastModified: replyTs });
    }
  }
  return { reviewId, userLastModified, fields: fields as ObservedReview["fields"] };
}

function validatePage(page: unknown): ReviewSourcePage {
  if (!isRecord(page) || !Array.isArray(page.reviews)) {
    throw remoteInvalid("page is not an object with a reviews array");
  }
  const next = page.nextPageToken;
  if (next !== undefined && (typeof next !== "string" || next === "")) {
    throw remoteInvalid("nextPageToken is not a non-empty string");
  }
  return {
    reviews: page.reviews as RemoteReview[],
    ...(next !== undefined ? { nextPageToken: next } : {}),
  };
}

function validateInput(input: ReviewIngestionInput): { maxPages: number; pageSize: number } {
  if (typeof input.packageName !== "string" || input.packageName.trim() === "") {
    throw new ReviewIngestionError("INVALID_ARGUMENT", "packageName must be a non-empty string.");
  }
  const maxPages = input.maxPages ?? DEFAULT_REVIEW_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new ReviewIngestionError("INVALID_ARGUMENT", "maxPages must be a positive integer.");
  }
  const pageSize = input.pageSize ?? DEFAULT_REVIEW_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new ReviewIngestionError("INVALID_ARGUMENT", "pageSize must be a positive integer.");
  }
  if (!input.source || typeof input.source.listReviews !== "function") {
    throw new ReviewIngestionError("INVALID_ARGUMENT", "source.listReviews must be a function.");
  }
  if (
    !input.checkpointStore ||
    typeof input.checkpointStore.load !== "function" ||
    typeof input.checkpointStore.save !== "function"
  ) {
    throw new ReviewIngestionError("INVALID_ARGUMENT", "checkpointStore must implement load/save.");
  }
  return { maxPages, pageSize };
}

async function loadCheckpoint(input: ReviewIngestionInput): Promise<ReviewCheckpoint> {
  let loaded: unknown;
  try {
    loaded = await input.checkpointStore.load();
  } catch (cause) {
    if (cause instanceof ReviewIngestionError) throw cause;
    throw new ReviewIngestionError("CHECKPOINT_READ_FAILED", "Checkpoint could not be loaded.", {
      cause,
    });
  }
  if (loaded === undefined) return createEmptyReviewCheckpoint(input.packageName);
  const checkpoint = parseReviewCheckpoint(loaded);
  if (checkpoint.packageName !== input.packageName) {
    throw new ReviewIngestionError(
      "CHECKPOINT_PACKAGE_MISMATCH",
      "Checkpoint belongs to a different package and will not be reused.",
    );
  }
  return checkpoint;
}

async function fetchAllPages(
  input: ReviewIngestionInput,
  maxPages: number,
  pageSize: number,
): Promise<{ raw: unknown[]; pageCount: number }> {
  const raw: unknown[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  let pageCount = 0;
  for (;;) {
    if (pageCount >= maxPages) {
      throw new ReviewIngestionError(
        "MAX_PAGES_EXCEEDED",
        `Review listing exceeded the ${maxPages}-page safety bound.`,
      );
    }
    let page: unknown;
    try {
      page = await input.source.listReviews({
        packageName: input.packageName,
        maxResults: pageSize,
        ...(pageToken !== undefined ? { pageToken } : {}),
      });
    } catch (cause) {
      throw new ReviewIngestionError("SOURCE_FAILED", "Review source request failed.", { cause });
    }
    pageCount += 1;
    const validated = validatePage(page);
    raw.push(...validated.reviews);
    const next = validated.nextPageToken;
    if (next === undefined) return { raw, pageCount };
    if (seenTokens.has(next)) {
      throw new ReviewIngestionError("PAGINATION_LOOP", "Review listing repeated a page token.");
    }
    seenTokens.add(next);
    pageToken = next;
  }
}

/** Duplicate reviewIds: greatest userLastModified wins; on ties the FIRST occurrence is kept. */
function dedupe(observed: readonly ObservedReview[]): Map<string, ObservedReview> {
  const byId = new Map<string, ObservedReview>();
  for (const item of observed) {
    const existing = byId.get(item.reviewId);
    if (
      existing === undefined ||
      compareReviewTimestamps(item.userLastModified, existing.userLastModified) > 0
    ) {
      byId.set(item.reviewId, item);
    }
  }
  return byId;
}

function compareForOutput(a: NormalizedReview, b: NormalizedReview): number {
  const byTime = compareReviewTimestamps(a.userLastModified, b.userLastModified);
  if (byTime !== 0) return byTime;
  if (a.reviewId < b.reviewId) return -1;
  if (a.reviewId > b.reviewId) return 1;
  return 0;
}

export async function ingestReviews(input: ReviewIngestionInput): Promise<ReviewIngestionResult> {
  const { maxPages, pageSize } = validateInput(input);
  const previous = await loadCheckpoint(input);
  const { raw, pageCount } = await fetchAllPages(input, maxPages, pageSize);

  const observed = raw.map(normalizeRemoteReview);
  const unique = dedupe(observed);

  const delta: NormalizedReview[] = [];
  let newCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  const merged: Record<string, ReviewTimestamp> = { ...previous.reviews };
  let checkpointChanged = false;

  for (const item of unique.values()) {
    const stored = previous.reviews[item.reviewId];
    let changeType: ReviewChangeType | undefined;
    if (stored === undefined) {
      changeType = "new";
      newCount += 1;
    } else if (compareReviewTimestamps(stored, item.userLastModified) < 0) {
      changeType = "updated";
      updatedCount += 1;
    } else {
      unchangedCount += 1;
    }
    if (changeType !== undefined) {
      delta.push(
        Object.freeze({
          reviewId: item.reviewId,
          changeType,
          userLastModified: item.userLastModified,
          ...item.fields,
        }),
      );
      merged[item.reviewId] =
        stored === undefined
          ? item.userLastModified
          : maxReviewTimestamp(stored, item.userLastModified);
      checkpointChanged = true;
    }
  }

  delta.sort(compareForOutput);

  if (checkpointChanged) {
    const next: ReviewCheckpoint = Object.freeze({
      version: previous.version,
      packageName: previous.packageName,
      reviews: Object.freeze(merged),
    });
    try {
      await input.checkpointStore.save(next);
    } catch (cause) {
      if (cause instanceof ReviewIngestionError) throw cause;
      throw new ReviewIngestionError("CHECKPOINT_WRITE_FAILED", "Checkpoint could not be saved.", {
        cause,
      });
    }
  }

  return Object.freeze({
    reviews: Object.freeze(delta),
    fetchedCount: raw.length,
    newCount,
    updatedCount,
    unchangedCount,
    pageCount,
    checkpointChanged,
  });
}

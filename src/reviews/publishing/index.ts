/** Phase 3.4 review reply publication. API-first gateway; no LLM, checkpoint, or browser.
 * Mutations must be invoked through the Phase 2 `publish` approval gate, not directly
 * by an untrusted caller. GET→POST is NOT an atomic compare-and-set: read-back can
 * detect but cannot prevent a concurrent edit between those requests.
 */
import { compareReviewTimestamps, parseReviewTimestamp, type ReviewTimestamp } from "../common.js";
import { validateReplyText } from "../drafting/index.js";

export type ReviewReplyPublishErrorCode =
  | "INVALID_ARGUMENT"
  | "REMOTE_DATA_INVALID"
  | "REVIEW_CHANGED"
  | "DEVELOPER_REPLY_CHANGED"
  | "READ_FAILED"
  | "PUBLISH_FAILED"
  | "PUBLISH_RESPONSE_INVALID";

/** Fixed safe messages; raw provider exceptions only as programmatic causes. */
export class ReviewReplyPublishError extends Error {
  override readonly name = "ReviewReplyPublishError";
  constructor(
    readonly code: ReviewReplyPublishErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
  }
}

export interface ReviewReplyRemoteState {
  readonly reviewId: string;
  readonly userLastModified: ReviewTimestamp;
  readonly developerReply?: {
    readonly text: string;
    readonly lastModified: ReviewTimestamp;
  };
}

export interface ReviewReplyPublishInput {
  readonly reviewId: string;
  readonly replyText: string;
  readonly expectedUserLastModified: ReviewTimestamp;
  /** null means no reply existed; a timestamp requires the same reply still to exist. */
  readonly expectedDeveloperReplyLastModified: ReviewTimestamp | null;
}

export interface AppliedReviewReply {
  readonly replyText: string;
  readonly lastEdited: ReviewTimestamp;
}

export interface ReviewReplyPublishResult extends AppliedReviewReply {
  readonly reviewId: string;
}

/** Narrow boundary; production delegates to the existing Publisher get/reply wrapper. */
export interface ReviewReplyGateway {
  getReviewState(reviewId: string): Promise<ReviewReplyRemoteState>;
  publishReply(reviewId: string, replyText: string): Promise<AppliedReviewReply>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalid(): never {
  throw new ReviewReplyPublishError(
    "INVALID_ARGUMENT",
    "Review reply publication input is invalid.",
  );
}
function remoteInvalid(): never {
  throw new ReviewReplyPublishError("REMOTE_DATA_INVALID", "Remote review state is invalid.");
}
function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
/** Approval input must already contain canonical lossless seconds and integer nanos. */
function expectedTimestamp(value: unknown): ReviewTimestamp {
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !== "nanos,seconds" ||
    typeof value.seconds !== "string"
  )
    invalid();
  const parsed = parseReviewTimestamp(value);
  if (parsed === undefined || parsed.seconds !== value.seconds || parsed.nanos !== value.nanos)
    invalid();
  return parsed;
}

/** Validates the exact action; no trimming before hashing or sending approved text. */
export function parseReviewReplyPublishInput(value: unknown): ReviewReplyPublishInput {
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !==
      "expectedDeveloperReplyLastModified,expectedUserLastModified,replyText,reviewId"
  )
    invalid();
  if (!nonblank(value.reviewId) || value.reviewId !== value.reviewId.trim()) invalid();
  let replyText: string;
  try {
    replyText = validateReplyText(value.replyText);
  } catch {
    invalid();
  }
  if (replyText !== value.replyText) invalid();
  const expectedUserLastModified = expectedTimestamp(value.expectedUserLastModified);
  const expectedDeveloperReplyLastModified =
    value.expectedDeveloperReplyLastModified === null
      ? null
      : expectedTimestamp(value.expectedDeveloperReplyLastModified);
  return Object.freeze({
    reviewId: value.reviewId,
    replyText,
    expectedUserLastModified,
    expectedDeveloperReplyLastModified,
  });
}

/** Parse `reviews.get` without leaking author, review text, device, or raw comments. */
export function normalizeReviewReplyRemoteState(
  raw: unknown,
  requestedReviewId: string,
): ReviewReplyRemoteState {
  if (
    !record(raw) ||
    !nonblank(requestedReviewId) ||
    raw.reviewId !== requestedReviewId ||
    !Array.isArray(raw.comments)
  )
    remoteInvalid();
  let user: Record<string, unknown> | undefined;
  let developer: Record<string, unknown> | undefined;
  for (const comment of raw.comments) {
    if (!record(comment)) remoteInvalid();
    if (comment.userComment !== undefined) {
      if (user || !record(comment.userComment)) remoteInvalid();
      user = comment.userComment;
    }
    if (comment.developerComment !== undefined) {
      if (developer || !record(comment.developerComment)) remoteInvalid();
      developer = comment.developerComment;
    }
  }
  const userLastModified = parseReviewTimestamp(user?.lastModified);
  if (userLastModified === undefined) remoteInvalid();
  if (developer === undefined)
    return Object.freeze({ reviewId: requestedReviewId, userLastModified });
  const lastModified = parseReviewTimestamp(developer.lastModified);
  if (lastModified === undefined || typeof developer.text !== "string") remoteInvalid();
  return Object.freeze({
    reviewId: requestedReviewId,
    userLastModified,
    developerReply: Object.freeze({ text: developer.text, lastModified }),
  });
}

function validRemoteState(value: unknown, reviewId: string): ReviewReplyRemoteState {
  if (!record(value) || value.reviewId !== reviewId) remoteInvalid();
  const userLastModified = parseReviewTimestamp(value.userLastModified);
  if (userLastModified === undefined) remoteInvalid();
  const reply = value.developerReply;
  if (reply === undefined) return { reviewId, userLastModified };
  if (!record(reply) || typeof reply.text !== "string") remoteInvalid();
  const lastModified = parseReviewTimestamp(reply.lastModified);
  if (lastModified === undefined) remoteInvalid();
  return { reviewId, userLastModified, developerReply: { text: reply.text, lastModified } };
}

export function parseReviewReplyPublishResult(value: unknown): ReviewReplyPublishResult {
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !== "lastEdited,replyText,reviewId" ||
    !nonblank(value.reviewId)
  ) {
    throw new ReviewReplyPublishError(
      "PUBLISH_RESPONSE_INVALID",
      "Published reply result is invalid; external state may have changed.",
    );
  }
  let text: string;
  try {
    text = validateReplyText(value.replyText);
  } catch {
    throw new ReviewReplyPublishError(
      "PUBLISH_RESPONSE_INVALID",
      "Published reply result is invalid; external state may have changed.",
    );
  }
  const lastEdited = parseReviewTimestamp(value.lastEdited);
  if (text !== value.replyText || lastEdited === undefined) {
    throw new ReviewReplyPublishError(
      "PUBLISH_RESPONSE_INVALID",
      "Published reply result is invalid; external state may have changed.",
    );
  }
  return Object.freeze({ reviewId: value.reviewId, replyText: text, lastEdited });
}

/** Approval is a runAgent prerequisite; this method itself never grants permission. */
export async function publishReviewReply(
  gateway: ReviewReplyGateway,
  rawInput: ReviewReplyPublishInput,
): Promise<ReviewReplyPublishResult> {
  const input = parseReviewReplyPublishInput(rawInput);
  if (
    !gateway ||
    typeof gateway.getReviewState !== "function" ||
    typeof gateway.publishReply !== "function"
  )
    invalid();
  let state: unknown;
  try {
    state = await gateway.getReviewState(input.reviewId);
  } catch (cause) {
    if (cause instanceof ReviewReplyPublishError && cause.code === "REMOTE_DATA_INVALID")
      throw cause;
    throw new ReviewReplyPublishError("READ_FAILED", "Pre-publish review read failed.", { cause });
  }
  const current = validRemoteState(state, input.reviewId);
  if (compareReviewTimestamps(current.userLastModified, input.expectedUserLastModified) !== 0) {
    throw new ReviewReplyPublishError(
      "REVIEW_CHANGED",
      "User review changed since the reply was prepared.",
    );
  }
  const expected = input.expectedDeveloperReplyLastModified;
  const observed = current.developerReply?.lastModified;
  if (
    expected === null
      ? observed !== undefined
      : observed === undefined || compareReviewTimestamps(observed, expected) !== 0
  ) {
    throw new ReviewReplyPublishError(
      "DEVELOPER_REPLY_CHANGED",
      "Developer reply changed since the action was prepared.",
    );
  }
  let applied: unknown;
  try {
    applied = await gateway.publishReply(input.reviewId, input.replyText);
  } catch (cause) {
    if (cause instanceof ReviewReplyPublishError && cause.code === "PUBLISH_RESPONSE_INVALID")
      throw cause;
    throw new ReviewReplyPublishError(
      "PUBLISH_FAILED",
      "Google reply mutation outcome is uncertain.",
      { cause },
    );
  }
  // The POST has already happened; any malformed response means uncertain state, NEVER retry.
  if (!record(applied) || applied.replyText !== input.replyText) {
    throw new ReviewReplyPublishError(
      "PUBLISH_RESPONSE_INVALID",
      "Published reply result is invalid; external state may have changed.",
    );
  }
  return parseReviewReplyPublishResult({
    reviewId: input.reviewId,
    replyText: applied.replyText,
    lastEdited: applied.lastEdited,
  });
}

/** Explicit post-action reviews.get, not a POST-response assertion; no rollback/retry. */
export async function verifyPublishedReviewReply(
  gateway: ReviewReplyGateway,
  input: ReviewReplyPublishInput,
  output: ReviewReplyPublishResult,
): Promise<boolean> {
  try {
    const expected = parseReviewReplyPublishInput(input);
    const applied = parseReviewReplyPublishResult(output);
    if (applied.reviewId !== expected.reviewId || applied.replyText !== expected.replyText)
      return false;
    const current = validRemoteState(
      await gateway.getReviewState(expected.reviewId),
      expected.reviewId,
    );
    return (
      compareReviewTimestamps(current.userLastModified, expected.expectedUserLastModified) === 0 &&
      current.developerReply?.text === expected.replyText &&
      compareReviewTimestamps(current.developerReply.lastModified, applied.lastEdited) >= 0
    );
  } catch {
    return false;
  }
}

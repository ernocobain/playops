/**
 * Android Publisher API boundary for PlayOps (Phase 1.2).
 *
 * Owns a small, stable interface over the official @googleapis/androidpublisher
 * v3 client. Consumes the authenticated client from Phase 1.1; never reads
 * credential files, config, or env, and never performs token acquisition.
 *
 * Phase 1.2 reads: reviews.list and reviews.get. Phase 3.4 adds only
 * approval-gated-at-runtime reviews.reply. Phase 4.1 adds temporary edit
 * creation/read-back and read-only track inspection; no release mutations.
 *
 * Pagination: one page per call; the caller controls pagination via
 * pageToken/nextPageToken (no automatic fetch-everything loop).
 */
import { androidpublisher, type androidpublisher_v3 } from "@googleapis/androidpublisher";
import type { GoogleAuthClient } from "../auth/index.js";
import { executeWithRetry, type ReadRetryOptions } from "../retry/index.js";
import { parseReviewTimestamp, type ReviewTimestamp } from "../../reviews/common.js";
import { validateReplyText } from "../../reviews/drafting/index.js";
import type { Readable } from "node:stream";

export type PublisherErrorCode = "INVALID_ARGUMENT" | "API_REQUEST_FAILED" | "INVALID_RESPONSE";
export type PublisherErrorReason =
  "TRACK_IDENTITY_MISMATCH" | "EDIT_IDENTITY_MISMATCH" | "CHANGES_ALREADY_IN_REVIEW";

/**
 * Safe, structured metadata projected from one generated-client/Gaxios failure.
 * Strict allowlist: numeric HTTP status, the Google API error status, the Google
 * structured reasons, and a system transport code. Never a raw message, header,
 * request config, URL, credential, response body, or raw Gaxios object.
 */
export interface PublisherErrorMetadata {
  /** Numeric HTTP status (400–599) when structurally available. */
  readonly status?: number;
  /** `response.data.error.status`, e.g. `FAILED_PRECONDITION`. */
  readonly googleStatus?: string;
  /** Deduped `response.data.error.errors[].reason` tokens, e.g. `failedPrecondition`. */
  readonly googleReasons?: readonly string[];
  /** System transport code such as `ECONNRESET`; only when no HTTP response exists. */
  readonly transportCode?: string;
}

const GOOGLE_STATUS_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const GOOGLE_REASON_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SYSTEM_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/;
const MAX_GOOGLE_REASONS = 10;

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericHttpStatus(raw: unknown): number | undefined {
  const status = typeof raw === "string" && /^\d{3}$/.test(raw) ? Number(raw) : raw;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : undefined;
}

/**
 * Project one unknown thrown value onto allowlisted, machine-readable fields.
 * Pure and total: it never throws, never reads a message, and never copies any
 * free-form content (headers, config, URL, body, credentials, or raw cause).
 */
export function projectPublisherErrorMetadata(cause: unknown): PublisherErrorMetadata {
  try {
    return projectPublisherErrorFields(cause);
  } catch {
    // A hostile or broken getter must never escape the boundary: report nothing.
    return Object.freeze({});
  }
}

function projectPublisherErrorFields(cause: unknown): PublisherErrorMetadata {
  const metadata: {
    status?: number;
    googleStatus?: string;
    googleReasons?: readonly string[];
    transportCode?: string;
  } = {};
  if (!isRecordValue(cause)) return Object.freeze(metadata);

  const response = isRecordValue(cause.response) ? cause.response : undefined;
  const status = numericHttpStatus(response?.status ?? cause.status ?? cause.code);
  if (status !== undefined) metadata.status = status;

  const data = response !== undefined && isRecordValue(response.data) ? response.data : undefined;
  const errorBody = data !== undefined && isRecordValue(data.error) ? data.error : undefined;
  if (errorBody !== undefined) {
    if (typeof errorBody.status === "string" && GOOGLE_STATUS_PATTERN.test(errorBody.status)) {
      metadata.googleStatus = errorBody.status;
    }
    if (Array.isArray(errorBody.errors)) {
      const reasons: string[] = [];
      for (const item of errorBody.errors) {
        if (reasons.length >= MAX_GOOGLE_REASONS) break;
        if (
          isRecordValue(item) &&
          typeof item.reason === "string" &&
          GOOGLE_REASON_PATTERN.test(item.reason) &&
          !reasons.includes(item.reason)
        ) {
          reasons.push(item.reason);
        }
      }
      if (reasons.length > 0) metadata.googleReasons = Object.freeze(reasons);
    }
  }

  // Only meaningful for a transport failure: with an HTTP response the numeric
  // status already carries the machine-readable classification.
  if (
    status === undefined &&
    typeof cause.code === "string" &&
    SYSTEM_CODE_PATTERN.test(cause.code)
  ) {
    metadata.transportCode = cause.code;
  }
  return Object.freeze(metadata);
}

/**
 * Typed publisher error. Safe diagnostics only: operation, packageName,
 * reviewId, and the allowlisted structured metadata above. Never auth headers,
 * tokens, private keys, credential objects, raw messages, or raw Gaxios config.
 */
export class PublisherError extends Error {
  override readonly name = "PublisherError";

  constructor(
    message: string,
    readonly code: PublisherErrorCode,
    options?: {
      cause?: unknown;
      reason?: PublisherErrorReason;
      externalStateUncertain?: boolean;
      metadata?: PublisherErrorMetadata;
    },
  ) {
    super(message, options);
    this.reason = options?.reason;
    this.externalStateUncertain = options?.externalStateUncertain;
    this.status = options?.metadata?.status;
    this.googleStatus = options?.metadata?.googleStatus;
    this.googleReasons = options?.metadata?.googleReasons;
    this.transportCode = options?.metadata?.transportCode;
  }

  readonly reason?: PublisherErrorReason;
  readonly externalStateUncertain?: boolean;
  /** Numeric HTTP status, when the generated client exposed one. */
  readonly status?: number;
  /** Google `error.status` token, e.g. `FAILED_PRECONDITION`. */
  readonly googleStatus?: string;
  /** Google `error.errors[].reason` tokens. */
  readonly googleReasons?: readonly string[];
  /** System transport code, e.g. `ECONNRESET`; only for transport failures. */
  readonly transportCode?: string;
}

/** PlayOps-owned review shape (alias of the official generated schema). */
export type Review = androidpublisher_v3.Schema$Review;

export interface ListReviewsInput {
  packageName: string;
  /** Token-based pagination cursor from a previous response. */
  pageToken?: string;
  maxResults?: number;
  translationLanguage?: string;
}

export interface ListReviewsResult {
  reviews: Review[];
  nextPageToken?: string;
}

export interface ListReleaseSummariesInput {
  /** Exact generated-client parent: applications/{packageName}/tracks/{track}. */
  readonly parent: string;
}

/** PlayOps-owned projection of Schema$ReleaseSummary. */
export interface PublisherReleaseSummary {
  readonly releaseName: string;
  readonly track: string;
  readonly versionCodes: readonly string[];
  readonly releaseLifecycleState: string;
}

export interface ListReleaseSummariesResult {
  readonly releases: readonly PublisherReleaseSummary[];
}

export interface GetReviewInput {
  packageName: string;
  reviewId: string;
  translationLanguage?: string;
}

export interface ReplyToReviewInput {
  readonly packageName: string;
  readonly reviewId: string;
  readonly replyText: string;
}

/** The applied reply only; never expose a generated Google response. */
export interface PublishedReviewReply {
  readonly replyText: string;
  readonly lastEdited: ReviewTimestamp;
}

/**
 * Narrow structural view of the generated client surface PlayOps uses.
 * The official Resource$Reviews satisfies this shape; tests inject fakes
 * here (and only here) — PlayOps validation/normalization is never mocked.
 */
export interface ReviewsResourceLike {
  list(
    params: {
      packageName: string;
      maxResults?: number;
      token?: string;
      translationLanguage?: string;
    },
    options?: { retry: false },
  ): Promise<{ data: androidpublisher_v3.Schema$ReviewsListResponse }>;
  get(
    params: {
      packageName: string;
      reviewId: string;
      translationLanguage?: string;
    },
    options?: { retry: false },
  ): Promise<{ data: androidpublisher_v3.Schema$Review }>;
  reply(
    params: {
      packageName: string;
      reviewId: string;
      requestBody: androidpublisher_v3.Schema$ReviewsReplyRequest;
    },
    options: { retry: false },
  ): Promise<{ data: androidpublisher_v3.Schema$ReviewsReplyResponse }>;
}

/** Minimal edit metadata owned by PlayOps; never expose the generated response. */
export interface PublisherEdit {
  readonly id: string;
  /** Lossless seconds-since-epoch string returned by Google, when present. */
  readonly expiryTimeSeconds?: string;
}

export const BUNDLE_UPLOAD_TIMEOUT_MS = 120_000;
export const BUNDLE_UPLOAD_MIME_TYPE = "application/octet-stream";

/**
 * Structural guarantee of `deleteEdit`: exactly one Google attempt with the
 * generated client's retry disabled. Callers that need to reason about a
 * delete acknowledgement (Phase 4.15 post-delete verification) bind these
 * literal facts instead of re-deriving them from the wrapper's internals.
 */
export const EDIT_DELETE_POLICY = Object.freeze({ attempts: 1, retry: false } as const);

export interface PublisherBundle {
  readonly versionCode: string;
  readonly sha256: string;
  readonly sha1?: string;
}

export interface UploadBundleInput {
  readonly packageName: string;
  readonly editId: string;
  readonly body: Readable;
}

export type ListBundlesInput = GetEditInput;

export interface BundlesResourceLike {
  list(
    params: { packageName: string; editId: string },
    options: { retry: false },
  ): Promise<{ data: unknown }>;
  upload(
    params: {
      packageName: string;
      editId: string;
      media: { mimeType: string; body: Readable };
    },
    options: { retry: false; timeout: number },
  ): Promise<{ data: unknown }>;
}

/** Narrow official Edits surface used by the release workflow. */
export interface EditsResourceLike {
  insert(params: { packageName: string }, options: { retry: false }): Promise<{ data: unknown }>;
  /** Official edits.delete surface; optional for legacy read-only fakes. */
  delete?(
    params: { packageName: string; editId: string },
    options: { retry: false },
  ): Promise<{ data: unknown }>;
  get(
    params: { packageName: string; editId: string },
    options: { retry: false },
  ): Promise<{ data: unknown }>;
  /** Official edits.commit surface; optional for legacy read-only test fakes. */
  commit?(
    params: {
      packageName: string;
      editId: string;
      changesInReviewBehavior: string;
      changesNotSentForReview: boolean;
    },
    options: { retry: false },
  ): Promise<{ data: unknown }>;
  /** Official edits.validate surface; optional for legacy read-only test fakes. */
  validate?(
    params: { packageName: string; editId: string },
    options: { retry: false },
  ): Promise<{ data: unknown }>;
  tracks: {
    list(
      params: { packageName: string; editId: string },
      options: { retry: false },
    ): Promise<{ data: unknown }>;
    get(
      params: { packageName: string; editId: string; track: string },
      options: { retry: false },
    ): Promise<{ data: unknown }>;
    update(
      params: {
        packageName: string;
        editId: string;
        track: string;
        requestBody: androidpublisher_v3.Schema$Track;
      },
      options: { retry: false },
    ): Promise<{ data: unknown }>;
  };
  bundles: BundlesResourceLike;
}

/** Narrow official direct deployed-release summary surface used by Phase 4.11. */
export interface ApplicationsResourceLike {
  tracks: {
    releases: {
      list(
        params: { parent: string },
        options: { retry: false },
      ): Promise<{ data: androidpublisher_v3.Schema$ListReleaseSummariesResponse }>;
    };
  };
}

export interface AndroidPublisherClient {
  readonly version: "v3";
  readonly reviews: ReviewsResourceLike;
  /** Optional only for legacy review-only fakes; production v3 client has edits. */
  readonly edits?: EditsResourceLike;
  /** Optional only for legacy pre-Phase-4.11 fakes; production v3 has this surface. */
  readonly applications?: ApplicationsResourceLike;
}

/** Factory for the official generated client (injectable for tests). */
export type PublisherClientFactory = (options: {
  version: "v3";
  auth: GoogleAuthClient;
  retry: false;
}) => AndroidPublisherClient;

const defaultFactory: PublisherClientFactory = (options) =>
  // The official Options type expects google-auth-library's concrete auth
  // classes. Our GoogleAuthClient is the Phase 1.1 boundary; a JWT instance
  // satisfies the official type at runtime, so we adapt structurally here.
  androidpublisher({
    version: options.version,
    auth: options.auth as never,
    retry: options.retry,
  }) as unknown as AndroidPublisherClient;

/** Create the PlayOps Android Publisher client around the Phase 1.1 auth client. */
export function createAndroidPublisherClient(
  auth: GoogleAuthClient,
  factory: PublisherClientFactory = defaultFactory,
): AndroidPublisherClient {
  // googleapis-common enables Gaxios retries by default, including PUT/DELETE.
  // Disable at client scope, and override again for each supported read call.
  return factory({ version: "v3", auth, retry: false });
}

function requireNonBlank(value: string, field: string, operation: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PublisherError(
      `${operation}: ${field} must be a non-empty string`,
      "INVALID_ARGUMENT",
    );
  }
  return value;
}

function optionalNonBlank(
  value: string | undefined,
  field: string,
  operation: string,
): string | undefined {
  if (value === undefined) return undefined;
  return requireNonBlank(value, field, operation);
}

function safeStatus(cause: unknown): number | undefined {
  return projectPublisherErrorMetadata(cause).status;
}

/**
 * Shared allowlisted failure options for every PublisherError raised because a
 * Google API call failed. Safe metadata is normalized exactly once, here at the
 * boundary; downstream modules never navigate the raw cause, config, or response.
 */
function apiFailureOptions(
  cause: unknown,
  extra?: {
    readonly reason?: PublisherErrorReason;
    readonly externalStateUncertain?: boolean;
  },
): {
  cause: unknown;
  metadata: PublisherErrorMetadata;
  reason?: PublisherErrorReason;
  externalStateUncertain?: boolean;
} {
  return {
    cause,
    metadata: projectPublisherErrorMetadata(cause),
    ...(extra?.reason !== undefined ? { reason: extra.reason } : {}),
    ...(extra?.externalStateUncertain !== undefined
      ? { externalStateUncertain: extra.externalStateUncertain }
      : {}),
  };
}

function wrapApiError(operation: string, context: string, cause: unknown): PublisherError {
  const metadata = projectPublisherErrorMetadata(cause);
  const statusText = metadata.status === undefined ? "" : ` (status ${metadata.status})`;
  return new PublisherError(
    `${operation} failed for ${context}${statusText}: Google API request failed`,
    "API_REQUEST_FAILED",
    { cause, metadata },
  );
}

/** List one page of reviews. Token-based pagination only (no startIndex). */
export async function listReviews(
  client: AndroidPublisherClient,
  input: ListReviewsInput,
  retryOptions?: ReadRetryOptions,
): Promise<ListReviewsResult> {
  const operation = "reviews.list";
  const packageName = requireNonBlank(input.packageName, "packageName", operation);
  const pageToken = optionalNonBlank(input.pageToken, "pageToken", operation);
  const translationLanguage = optionalNonBlank(
    input.translationLanguage,
    "translationLanguage",
    operation,
  );
  if (
    input.maxResults !== undefined &&
    (!Number.isInteger(input.maxResults) || input.maxResults < 1)
  ) {
    throw new PublisherError(
      `${operation}: maxResults must be a positive integer`,
      "INVALID_ARGUMENT",
    );
  }

  let response: { data: androidpublisher_v3.Schema$ReviewsListResponse };
  try {
    response = await executeWithRetry(
      () =>
        client.reviews.list(
          {
            packageName,
            ...(input.maxResults !== undefined ? { maxResults: input.maxResults } : {}),
            ...(pageToken !== undefined ? { token: pageToken } : {}),
            ...(translationLanguage !== undefined ? { translationLanguage } : {}),
          },
          { retry: false },
        ),
      { ...retryOptions, safety: "read" },
    );
  } catch (cause) {
    throw wrapApiError(operation, `package ${packageName}`, cause);
  }

  const data = response.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new PublisherError(`${operation}: response payload is not an object`, "INVALID_RESPONSE");
  }
  const reviews = data.reviews ?? [];
  if (!Array.isArray(reviews)) {
    throw new PublisherError(
      `${operation}: response "reviews" field is not an array`,
      "INVALID_RESPONSE",
    );
  }

  const nextPageToken = data.tokenPagination?.nextPageToken ?? undefined;
  return {
    reviews,
    ...(typeof nextPageToken === "string" && nextPageToken !== "" ? { nextPageToken } : {}),
  };
}

function normalizePublisherReleaseSummary(value: unknown): PublisherReleaseSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PublisherError(
      "applications.tracks.releases.list: release summary is invalid",
      "INVALID_RESPONSE",
    );
  }
  const summary = value as {
    releaseName?: unknown;
    track?: unknown;
    releaseLifecycleState?: unknown;
    activeArtifacts?: unknown;
  };
  if (
    typeof summary.releaseName !== "string" ||
    summary.releaseName.trim() === "" ||
    typeof summary.track !== "string" ||
    summary.track.trim() === "" ||
    typeof summary.releaseLifecycleState !== "string" ||
    summary.releaseLifecycleState.trim() === ""
  ) {
    throw new PublisherError(
      "applications.tracks.releases.list: release summary identity is invalid",
      "INVALID_RESPONSE",
    );
  }
  const activeArtifacts = summary.activeArtifacts ?? [];
  if (!Array.isArray(activeArtifacts)) {
    throw new PublisherError(
      "applications.tracks.releases.list: activeArtifacts is not an array",
      "INVALID_RESPONSE",
    );
  }
  const versionCodes = activeArtifacts.map((artifact) => {
    if (typeof artifact !== "object" || artifact === null || Array.isArray(artifact)) {
      throw new PublisherError(
        "applications.tracks.releases.list: artifact summary is invalid",
        "INVALID_RESPONSE",
      );
    }
    const versionCode = (artifact as { versionCode?: unknown }).versionCode;
    // The installed SDK exposes versionCode as number. Validate safe integer
    // before converting so PlayOps never performs an unsafe float round-trip.
    if (typeof versionCode !== "number" || !Number.isSafeInteger(versionCode) || versionCode < 1) {
      throw new PublisherError(
        "applications.tracks.releases.list: artifact versionCode is invalid",
        "INVALID_RESPONSE",
      );
    }
    return String(versionCode);
  });
  return Object.freeze({
    releaseName: summary.releaseName,
    track: summary.track,
    versionCodes: Object.freeze(versionCodes),
    releaseLifecycleState: summary.releaseLifecycleState,
  });
}

/**
 * Read current deployed release summaries for one exact track.
 *
 * The installed Android Publisher v3.42.1 response has no nextPageToken;
 * Google documents a maximum of 20 releases in this response. The single
 * GET is therefore complete for this SDK contract, while the existing bounded
 * read retry remains in force. Generated-client retry is disabled explicitly.
 */
export async function listReleaseSummaries(
  client: AndroidPublisherClient,
  input: ListReleaseSummariesInput,
  retryOptions?: ReadRetryOptions,
): Promise<ListReleaseSummariesResult> {
  const operation = "applications.tracks.releases.list";
  const parent = requireNonBlank(input.parent, "parent", operation);
  const resource = client.applications?.tracks?.releases;
  if (!resource || typeof resource.list !== "function") {
    throw new PublisherError(
      `${operation}: Android Publisher direct release-summary resource is unavailable`,
      "API_REQUEST_FAILED",
    );
  }

  let response: { data: androidpublisher_v3.Schema$ListReleaseSummariesResponse };
  try {
    response = await executeWithRetry(() => resource.list({ parent }, { retry: false }), {
      ...retryOptions,
      safety: "read",
    });
  } catch (cause) {
    throw wrapApiError(operation, parent, cause);
  }
  const data = response.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new PublisherError(`${operation}: response payload is not an object`, "INVALID_RESPONSE");
  }
  const releases = data.releases ?? [];
  if (!Array.isArray(releases)) {
    throw new PublisherError(
      `${operation}: response "releases" is not an array`,
      "INVALID_RESPONSE",
    );
  }
  return Object.freeze({
    releases: Object.freeze(releases.map(normalizePublisherReleaseSummary)),
  });
}

/** Get a single review by id. Returns the review data only. */
export async function getReview(
  client: AndroidPublisherClient,
  input: GetReviewInput,
  retryOptions?: ReadRetryOptions,
): Promise<Review> {
  const operation = "reviews.get";
  const packageName = requireNonBlank(input.packageName, "packageName", operation);
  const reviewId = requireNonBlank(input.reviewId, "reviewId", operation);
  const translationLanguage = optionalNonBlank(
    input.translationLanguage,
    "translationLanguage",
    operation,
  );

  let response: { data: androidpublisher_v3.Schema$Review };
  try {
    response = await executeWithRetry(
      () =>
        client.reviews.get(
          {
            packageName,
            reviewId,
            ...(translationLanguage !== undefined ? { translationLanguage } : {}),
          },
          { retry: false },
        ),
      { ...retryOptions, safety: "read" },
    );
  } catch (cause) {
    throw wrapApiError(operation, `package ${packageName} review ${reviewId}`, cause);
  }

  const data = response.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new PublisherError(`${operation}: response payload is not an object`, "INVALID_RESPONSE");
  }
  return data;
}

/**
 * One Google-side mutation attempt. Approval is enforced by runAgent's `publish`
 * permission; this low-level API wrapper validates but does not authorize callers.
 * A failed/malformed response can mean the mutation already reached Google.
 */
export async function replyToReview(
  client: AndroidPublisherClient,
  input: ReplyToReviewInput,
): Promise<PublishedReviewReply> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new PublisherError("reviews.reply: input is invalid", "INVALID_ARGUMENT");
  }
  const operation = "reviews.reply";
  const packageName = requireNonBlank(input.packageName, "packageName", operation);
  const reviewId = requireNonBlank(input.reviewId, "reviewId", operation);
  let replyText: string;
  try {
    replyText = validateReplyText(input.replyText);
  } catch {
    throw new PublisherError("reviews.reply: replyText is not publishable", "INVALID_ARGUMENT");
  }
  // Approval must cover the literal text transmitted; do not silently normalize it.
  if (replyText !== input.replyText) {
    throw new PublisherError(
      "reviews.reply: replyText must already be normalized",
      "INVALID_ARGUMENT",
    );
  }

  let response: { data: androidpublisher_v3.Schema$ReviewsReplyResponse };
  try {
    // No PlayOps read retry, no Gaxios retry; network failure is an ambiguous mutation.
    response = await client.reviews.reply(
      { packageName, reviewId, requestBody: { replyText } },
      { retry: false },
    );
  } catch (cause) {
    throw new PublisherError(
      "reviews.reply: Google mutation outcome is uncertain",
      "API_REQUEST_FAILED",
      apiFailureOptions(cause),
    );
  }
  const result = response?.data?.result;
  const lastEdited = parseReviewTimestamp(result?.lastEdited);
  if (result?.replyText !== replyText || lastEdited === undefined) {
    throw new PublisherError(
      "reviews.reply: mutation response is invalid; state may have changed",
      "INVALID_RESPONSE",
    );
  }
  return Object.freeze({ replyText, lastEdited });
}

export interface CreateEditInput {
  readonly packageName: string;
}

export interface GetEditInput {
  readonly packageName: string;
  readonly editId: string;
}

export type DeleteEditInput = GetEditInput;

export interface CommitEditInput extends GetEditInput {
  readonly changesInReviewBehavior: "ERROR_IF_IN_REVIEW";
  readonly changesNotSentForReview: false;
}

export type ListTracksInput = GetEditInput;

export interface GetTrackInput extends GetEditInput {
  readonly track: string;
}

export interface UpdateTrackInput extends GetTrackInput {
  readonly requestBody: androidpublisher_v3.Schema$Track;
}

export interface ListTracksResult {
  readonly tracks: readonly androidpublisher_v3.Schema$Track[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireEditResource(client: AndroidPublisherClient, operation: string): EditsResourceLike {
  if (!client || typeof client !== "object" || !client.edits) {
    throw new PublisherError(
      `${operation}: Android Publisher Edits resource is unavailable`,
      "API_REQUEST_FAILED",
    );
  }
  return client.edits;
}

function validOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    // eslint-disable-next-line no-control-regex -- reject control characters in server-generated ids
    !/[\s\x00-\x1f\x7f]/u.test(value)
  );
}

function normalizeEditResponse(
  value: unknown,
  operation: string,
  expectedId?: string,
): PublisherEdit {
  if (!isRecord(value) || !validOpaqueId(value.id)) {
    throw new PublisherError(`${operation}: edit response is invalid`, "INVALID_RESPONSE");
  }
  if (expectedId !== undefined && value.id !== expectedId) {
    throw new PublisherError(`${operation}: edit response id is invalid`, "INVALID_RESPONSE", {
      reason: "EDIT_IDENTITY_MISMATCH",
    });
  }
  let expiryTimeSeconds: string | undefined;
  if (value.expiryTimeSeconds !== undefined && value.expiryTimeSeconds !== null) {
    if (typeof value.expiryTimeSeconds !== "string" || !/^\d+$/.test(value.expiryTimeSeconds)) {
      throw new PublisherError(`${operation}: edit response is invalid`, "INVALID_RESPONSE");
    }
    expiryTimeSeconds = value.expiryTimeSeconds;
  }
  return Object.freeze({
    id: value.id,
    ...(expiryTimeSeconds !== undefined ? { expiryTimeSeconds } : {}),
  });
}

function validateEditInput(
  input: CreateEditInput | GetEditInput | GetTrackInput,
  operation: string,
  needsEditId: boolean,
  needsTrack: boolean,
): { packageName: string; editId?: string; track?: string } {
  if (!isRecord(input)) {
    throw new PublisherError(`${operation}: input is invalid`, "INVALID_ARGUMENT");
  }
  const packageName = requireNonBlank(input.packageName as string, "packageName", operation);
  const editId = needsEditId
    ? requireNonBlank(input.editId as string, "editId", operation)
    : undefined;
  const track = needsTrack ? requireNonBlank(input.track as string, "track", operation) : undefined;
  return {
    packageName,
    ...(editId !== undefined ? { editId } : {}),
    ...(track !== undefined ? { track } : {}),
  };
}

/**
 * Creates one temporary server-side edit for inspection. This is a remote
 * write, not publication; ambiguous outcomes are surfaced and never retried.
 */
export async function createEdit(
  client: AndroidPublisherClient,
  input: CreateEditInput,
): Promise<PublisherEdit> {
  const operation = "edits.insert";
  const { packageName } = validateEditInput(input, operation, false, false);
  const edits = requireEditResource(client, operation);
  let response: { data: unknown };
  try {
    response = await edits.insert({ packageName }, { retry: false });
  } catch (cause) {
    const status = safeStatus(cause);
    const statusText = status === undefined ? "" : ` (status ${status})`;
    throw new PublisherError(
      `${operation} failed for package ${packageName}${statusText}: edit creation outcome may be uncertain`,
      "API_REQUEST_FAILED",
      apiFailureOptions(cause),
    );
  }
  return normalizeEditResponse(response?.data, operation);
}

/** Delete exactly one explicitly supplied temporary edit; never retried. */
export async function deleteEdit(
  client: AndroidPublisherClient,
  input: DeleteEditInput,
): Promise<void> {
  const operation = "edits.delete";
  const { packageName, editId } = validateEditInput(input, operation, true, false);
  const edits = requireEditResource(client, operation);
  if (typeof edits.delete !== "function") {
    throw new PublisherError(
      `${operation}: Android Publisher edit-delete resource is unavailable`,
      "API_REQUEST_FAILED",
    );
  }
  try {
    await edits.delete({ packageName, editId: editId as string }, { retry: false });
  } catch (cause) {
    throw new PublisherError(
      `${operation} failed for package ${packageName} edit ${editId}: cleanup outcome is uncertain`,
      "API_REQUEST_FAILED",
      apiFailureOptions(cause, { externalStateUncertain: true }),
    );
  }
}

/** Read an edit within its package; bounded retry is owned by PlayOps. */
export async function getEdit(
  client: AndroidPublisherClient,
  input: GetEditInput,
  retryOptions?: ReadRetryOptions,
): Promise<PublisherEdit> {
  const operation = "edits.get";
  const { packageName, editId } = validateEditInput(input, operation, true, false);
  const edits = requireEditResource(client, operation);
  let response: { data: unknown };
  try {
    response = await executeWithRetry(
      () => edits.get({ packageName, editId: editId as string }, { retry: false }),
      { ...retryOptions, safety: "read" },
    );
  } catch (cause) {
    throw wrapApiError(operation, `package ${packageName} edit ${editId}`, cause);
  }
  return normalizeEditResponse(response?.data, operation, editId);
}

/** Validate one exact managed edit using the semantically read-only POST endpoint. */
export async function validateEdit(
  client: AndroidPublisherClient,
  input: GetEditInput,
  retryOptions?: ReadRetryOptions,
): Promise<PublisherEdit> {
  const operation = "edits.validate";
  const { packageName, editId } = validateEditInput(input, operation, true, false);
  const edits = requireEditResource(client, operation);
  if (typeof edits.validate !== "function") {
    throw new PublisherError(
      `${operation}: Android Publisher edit validation resource is unavailable`,
      "API_REQUEST_FAILED",
    );
  }
  let response: { data: unknown };
  try {
    response = await executeWithRetry(
      () =>
        edits.validate?.({ packageName, editId: editId as string }, { retry: false }) as Promise<{
          data: unknown;
        }>,
      { ...retryOptions, safety: "read" },
    );
  } catch (cause) {
    throw wrapApiError(operation, `package ${packageName} edit ${editId}`, cause);
  }
  return normalizeEditResponse(response?.data, operation, editId);
}

function structuredCommitRejectionReason(cause: unknown): PublisherErrorReason | undefined {
  if (!isRecord(cause) || !isRecord(cause.response) || !isRecord(cause.response.data)) {
    return undefined;
  }
  const data = cause.response.data;
  const error = isRecord(data.error) ? data.error : data;
  const structuredValues: unknown[] = [error.status, error.reason];
  if (Array.isArray(error.errors)) {
    for (const item of error.errors) {
      if (isRecord(item)) structuredValues.push(item.reason, item.status);
    }
  }
  return structuredValues.some(
    (value) => value === "CHANGES_ALREADY_IN_REVIEW" || value === "changesAlreadyInReview",
  )
    ? "CHANGES_ALREADY_IN_REVIEW"
    : undefined;
}

function isCertainCommitRejection(cause: unknown): boolean {
  const status = safeStatus(cause);
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Execute exactly one Google edits.commit mutation with the Phase 4.9 policy.
 * No PlayOps read retry or generated-client retry is permitted.
 */
export async function commitEdit(
  client: AndroidPublisherClient,
  input: CommitEditInput,
): Promise<PublisherEdit> {
  const operation = "edits.commit";
  const { packageName, editId } = validateEditInput(input, operation, true, false);
  if (
    input.changesInReviewBehavior !== "ERROR_IF_IN_REVIEW" ||
    input.changesNotSentForReview !== false
  ) {
    throw new PublisherError(
      `${operation}: Phase 4.10 commit policy is invalid`,
      "INVALID_ARGUMENT",
      { externalStateUncertain: false },
    );
  }
  const edits = requireEditResource(client, operation);
  if (typeof edits.commit !== "function") {
    throw new PublisherError(
      `${operation}: Android Publisher commit resource is unavailable`,
      "API_REQUEST_FAILED",
      { externalStateUncertain: false },
    );
  }
  let response: { data: unknown };
  try {
    response = await edits.commit(
      {
        packageName,
        editId: editId as string,
        changesInReviewBehavior: input.changesInReviewBehavior,
        changesNotSentForReview: input.changesNotSentForReview,
      },
      { retry: false },
    );
  } catch (cause) {
    const reason = structuredCommitRejectionReason(cause);
    throw new PublisherError(
      reason === "CHANGES_ALREADY_IN_REVIEW"
        ? `${operation}: changes are already in review`
        : isCertainCommitRejection(cause)
          ? `${operation}: Google rejected the commit request`
          : `${operation}: commit outcome is uncertain`,
      "API_REQUEST_FAILED",
      apiFailureOptions(cause, {
        reason,
        externalStateUncertain:
          reason !== undefined || isCertainCommitRejection(cause) ? false : true,
      }),
    );
  }
  try {
    const normalized = normalizeEditResponse(response?.data, operation, editId);
    if (normalized.expiryTimeSeconds === undefined) {
      throw new PublisherError(`${operation}: commit response is invalid`, "INVALID_RESPONSE");
    }
    return normalized;
  } catch (cause) {
    throw new PublisherError(
      `${operation}: commit response is invalid; external state may have changed`,
      "INVALID_RESPONSE",
      {
        cause,
        reason: cause instanceof PublisherError ? cause.reason : undefined,
        externalStateUncertain: true,
      },
    );
  }
}

/** List tracks for one validated edit; no mutation methods are exposed here. */
export async function listTracks(
  client: AndroidPublisherClient,
  input: ListTracksInput,
  retryOptions?: ReadRetryOptions,
): Promise<ListTracksResult> {
  const operation = "edits.tracks.list";
  const { packageName, editId } = validateEditInput(input, operation, true, false);
  const edits = requireEditResource(client, operation);
  let response: { data: unknown };
  try {
    response = await executeWithRetry(
      () => edits.tracks.list({ packageName, editId: editId as string }, { retry: false }),
      { ...retryOptions, safety: "read" },
    );
  } catch (cause) {
    throw wrapApiError(operation, `package ${packageName} edit ${editId}`, cause);
  }
  const data = response?.data;
  if (!isRecord(data)) {
    throw new PublisherError(`${operation}: response payload is not an object`, "INVALID_RESPONSE");
  }
  const tracks = data.tracks ?? [];
  if (!Array.isArray(tracks) || tracks.some((track) => !isRecord(track))) {
    throw new PublisherError(`${operation}: response tracks field is invalid`, "INVALID_RESPONSE");
  }
  return { tracks: tracks as androidpublisher_v3.Schema$Track[] };
}

function normalizeTrackResponse(
  value: unknown,
  operation: string,
  expectedTrack: string,
): androidpublisher_v3.Schema$Track {
  if (!isRecord(value) || typeof value.track !== "string" || value.track.trim() === "") {
    throw new PublisherError(`${operation}: response track is invalid`, "INVALID_RESPONSE");
  }
  if (value.track !== expectedTrack) {
    throw new PublisherError(`${operation}: response track is invalid`, "INVALID_RESPONSE", {
      reason: "TRACK_IDENTITY_MISMATCH",
    });
  }
  if (value.releases !== undefined && !Array.isArray(value.releases)) {
    throw new PublisherError(
      `${operation}: response releases field is invalid`,
      "INVALID_RESPONSE",
    );
  }
  return value as unknown as androidpublisher_v3.Schema$Track;
}

/** Read one track by exact API track name; bounded retry is owned by PlayOps. */
export async function getTrack(
  client: AndroidPublisherClient,
  input: GetTrackInput,
  retryOptions?: ReadRetryOptions,
): Promise<androidpublisher_v3.Schema$Track> {
  const operation = "edits.tracks.get";
  const { packageName, editId, track } = validateEditInput(input, operation, true, true);
  const edits = requireEditResource(client, operation);
  let response: { data: unknown };
  try {
    response = await executeWithRetry(
      () =>
        edits.tracks.get(
          { packageName, editId: editId as string, track: track as string },
          { retry: false },
        ),
      { ...retryOptions, safety: "read" },
    );
  } catch (cause) {
    throw wrapApiError(operation, `package ${packageName} edit ${editId} track ${track}`, cause);
  }
  return normalizeTrackResponse(response?.data, operation, track as string);
}

/**
 * Update one exact track inside an existing edit. This is one mutation attempt;
 * PlayOps and the generated client are both explicitly prevented from retrying it.
 */
export async function updateTrack(
  client: AndroidPublisherClient,
  input: UpdateTrackInput,
): Promise<androidpublisher_v3.Schema$Track> {
  const operation = "edits.tracks.update";
  const { packageName, editId, track } = validateEditInput(input, operation, true, true);
  if (!isRecord(input.requestBody)) {
    throw new PublisherError(`${operation}: request body is invalid`, "INVALID_ARGUMENT");
  }
  const edits = requireEditResource(client, operation);
  if (!edits.tracks || typeof edits.tracks.update !== "function") {
    throw new PublisherError(
      `${operation}: Android Publisher track update resource is unavailable`,
      "API_REQUEST_FAILED",
    );
  }
  let response: { data: unknown };
  try {
    response = await edits.tracks.update(
      {
        packageName,
        editId: editId as string,
        track: track as string,
        requestBody: input.requestBody,
      },
      { retry: false },
    );
  } catch (cause) {
    throw wrapApiError(operation, `package ${packageName} edit ${editId} track ${track}`, cause);
  }
  return normalizeTrackResponse(response?.data, operation, track as string);
}

const MAX_GOOGLE_PLAY_VERSION_CODE = 2_100_000_000;

function normalizePublisherBundle(value: unknown, operation: string): PublisherBundle {
  if (!isRecord(value)) {
    throw new PublisherError(`${operation}: bundle response is invalid`, "INVALID_RESPONSE");
  }
  const versionCode = value.versionCode;
  const sha256 = value.sha256;
  const sha1 = value.sha1;
  if (
    typeof versionCode !== "number" ||
    !Number.isSafeInteger(versionCode) ||
    versionCode <= 0 ||
    versionCode > MAX_GOOGLE_PLAY_VERSION_CODE ||
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/iu.test(sha256)
  ) {
    throw new PublisherError(`${operation}: bundle response is invalid`, "INVALID_RESPONSE");
  }
  if (
    sha1 !== undefined &&
    sha1 !== null &&
    (typeof sha1 !== "string" || !/^[0-9a-f]{40}$/iu.test(sha1))
  ) {
    throw new PublisherError(`${operation}: bundle response is invalid`, "INVALID_RESPONSE");
  }
  return Object.freeze({
    versionCode: String(versionCode),
    sha256: sha256.toLowerCase(),
    ...(typeof sha1 === "string" ? { sha1: sha1.toLowerCase() } : {}),
  });
}

function requireBundlesResource(
  client: AndroidPublisherClient,
  operation: string,
): BundlesResourceLike {
  const edits = requireEditResource(client, operation);
  if (
    !edits.bundles ||
    typeof edits.bundles.upload !== "function" ||
    typeof edits.bundles.list !== "function"
  ) {
    throw new PublisherError(
      `${operation}: Android Publisher bundle resource is unavailable`,
      "API_REQUEST_FAILED",
    );
  }
  return edits.bundles;
}

/**
 * Upload one caller-supplied stream to one existing edit. This is a mutation:
 * no PlayOps retry is used and generated retries are disabled on the request.
 */
export async function uploadBundle(
  client: AndroidPublisherClient,
  input: UploadBundleInput,
): Promise<PublisherBundle> {
  const operation = "edits.bundles.upload";
  if (!isRecord(input)) {
    throw new PublisherError(`${operation}: input is invalid`, "INVALID_ARGUMENT");
  }
  const packageName = requireNonBlank(input.packageName, "packageName", operation);
  const editId = requireNonBlank(input.editId, "editId", operation);
  if (!input.body || typeof input.body.pipe !== "function") {
    throw new PublisherError(
      `${operation}: media body must be a readable stream`,
      "INVALID_ARGUMENT",
    );
  }
  const bundles = requireBundlesResource(client, operation);
  let response: { data: unknown };
  try {
    response = await bundles.upload(
      {
        packageName,
        editId,
        media: { mimeType: BUNDLE_UPLOAD_MIME_TYPE, body: input.body },
      },
      { retry: false, timeout: BUNDLE_UPLOAD_TIMEOUT_MS },
    );
  } catch (cause) {
    const status = safeStatus(cause);
    const statusText = status === undefined ? "" : ` (status ${status})`;
    throw new PublisherError(
      `${operation} failed for package ${packageName} edit ${editId}${statusText}: mutation outcome may be uncertain`,
      "API_REQUEST_FAILED",
      apiFailureOptions(cause),
    );
  }
  return normalizePublisherBundle(response?.data, operation);
}

/** List bundle metadata for one edit using only the bounded PlayOps read retry. */
export async function listBundles(
  client: AndroidPublisherClient,
  input: ListBundlesInput,
  retryOptions?: ReadRetryOptions,
): Promise<readonly PublisherBundle[]> {
  const operation = "edits.bundles.list";
  const { packageName, editId } = validateEditInput(input, operation, true, false);
  const bundles = requireBundlesResource(client, operation);
  let response: { data: unknown };
  try {
    response = await executeWithRetry(
      () => bundles.list({ packageName, editId: editId as string }, { retry: false }),
      { ...retryOptions, safety: "read" },
    );
  } catch (cause) {
    throw wrapApiError(operation, `package ${packageName} edit ${editId}`, cause);
  }
  const data = response?.data;
  if (!isRecord(data)) {
    throw new PublisherError(`${operation}: response payload is not an object`, "INVALID_RESPONSE");
  }
  const rawBundles = data.bundles;
  if (rawBundles === undefined) return Object.freeze([]);
  if (!Array.isArray(rawBundles)) {
    throw new PublisherError(`${operation}: response bundles field is invalid`, "INVALID_RESPONSE");
  }
  return Object.freeze(rawBundles.map((bundle) => normalizePublisherBundle(bundle, operation)));
}

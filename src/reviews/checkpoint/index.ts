/**
 * Phase 3.1 — Review checkpoint store.
 *
 * Identity = reviewId → greatest observed userComment.lastModified. Pagination tokens are
 * never persisted. Format version 1 only; unknown versions are rejected (no migration).
 *
 * File store: caller-supplied path, Node built-ins only, atomic replace
 * (temp file → fsync → rename) so a partially written file can never become the accepted
 * checkpoint. CONCURRENCY LIMITATION: designed for a single PlayOps process per checkpoint
 * file; rename atomicity does not merge concurrent writers, so two processes ingesting the
 * same app concurrently may lose updates. No locking or database is introduced.
 */
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { ReviewIngestionError, parseReviewTimestamp, type ReviewTimestamp } from "../common.js";

export const REVIEW_CHECKPOINT_VERSION = 1 as const;

export interface ReviewCheckpoint {
  readonly version: typeof REVIEW_CHECKPOINT_VERSION;
  readonly packageName: string;
  readonly reviews: Readonly<Record<string, ReviewTimestamp>>;
}

export interface ReviewCheckpointStore {
  /** `undefined` when no checkpoint exists yet (fresh state). */
  load(): Promise<ReviewCheckpoint | undefined>;
  save(checkpoint: ReviewCheckpoint): Promise<void>;
}

export function createEmptyReviewCheckpoint(packageName: string): ReviewCheckpoint {
  return Object.freeze({
    version: REVIEW_CHECKPOINT_VERSION,
    packageName,
    reviews: Object.freeze({}),
  });
}

/** Structural validation of untrusted parsed JSON. Never echoes file content in messages. */
export function parseReviewCheckpoint(value: unknown): ReviewCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReviewIngestionError("CHECKPOINT_INVALID", "Checkpoint is not an object.");
  }
  const { version, packageName, reviews } = value as Record<string, unknown>;
  if (version !== REVIEW_CHECKPOINT_VERSION) {
    throw new ReviewIngestionError("CHECKPOINT_INVALID", "Checkpoint version is unsupported.");
  }
  if (typeof packageName !== "string" || packageName.trim() === "") {
    throw new ReviewIngestionError("CHECKPOINT_INVALID", "Checkpoint packageName is invalid.");
  }
  if (typeof reviews !== "object" || reviews === null || Array.isArray(reviews)) {
    throw new ReviewIngestionError("CHECKPOINT_INVALID", "Checkpoint reviews map is invalid.");
  }
  const parsed: Record<string, ReviewTimestamp> = {};
  for (const [reviewId, ts] of Object.entries(reviews as Record<string, unknown>)) {
    if (reviewId.trim() === "") {
      throw new ReviewIngestionError("CHECKPOINT_INVALID", "Checkpoint contains a blank reviewId.");
    }
    const timestamp = parseReviewTimestamp(ts);
    if (timestamp === undefined) {
      throw new ReviewIngestionError(
        "CHECKPOINT_INVALID",
        "Checkpoint contains an invalid review timestamp.",
      );
    }
    parsed[reviewId] = timestamp;
  }
  return Object.freeze({
    version: REVIEW_CHECKPOINT_VERSION,
    packageName,
    reviews: Object.freeze(parsed),
  });
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

export function createFileReviewCheckpointStore(path: string): ReviewCheckpointStore {
  if (typeof path !== "string" || path.trim() === "") {
    throw new ReviewIngestionError(
      "INVALID_ARGUMENT",
      "Checkpoint path must be a non-empty string.",
    );
  }
  return Object.freeze({
    async load(): Promise<ReviewCheckpoint | undefined> {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (cause) {
        if (isErrnoCode(cause, "ENOENT")) return undefined;
        throw new ReviewIngestionError("CHECKPOINT_READ_FAILED", "Checkpoint could not be read.", {
          cause,
        });
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (cause) {
        throw new ReviewIngestionError("CHECKPOINT_INVALID", "Checkpoint is not valid JSON.", {
          cause,
        });
      }
      return parseReviewCheckpoint(json);
    },

    async save(checkpoint: ReviewCheckpoint): Promise<void> {
      const validated = parseReviewCheckpoint(checkpoint);
      const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await mkdir(dirname(path), { recursive: true });
        const handle = await open(tempPath, "wx");
        try {
          await handle.writeFile(JSON.stringify(validated, null, 2) + "\n", "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(tempPath, path);
      } catch (cause) {
        await unlink(tempPath).catch(() => undefined);
        throw new ReviewIngestionError(
          "CHECKPOINT_WRITE_FAILED",
          "Checkpoint could not be written.",
          {
            cause,
          },
        );
      }
    },
  });
}

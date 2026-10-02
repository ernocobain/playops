/**
 * Phase 4.2 — release edit gateway boundary.
 *
 * Shared by `releases.open_edit` (creation) and `releases.inspect` (read-only
 * inspection of an already-tracked session). The adapter over the real Android
 * Publisher client implements this; tests implement it with fakes.
 *
 * The package name is bound by composition and never accepted from tool input.
 */
import type { Readable } from "node:stream";
import type { ReleaseCommitReviewBehavior } from "./commit-approval.js";
import type {
  GooglePlayEditSession,
  ReleaseBundle,
  ReleaseSummaryState,
  ReleaseTrackState,
  ReleaseTrackUpdateRequest,
} from "./index.js";

/** Narrow edit metadata returned by a real read-back; no raw Google response escapes. */
export interface ReleaseEditReadback {
  readonly id: string;
  readonly expiryTimeSeconds?: string;
}

export interface ReleaseEditGateway {
  /**
   * Creates exactly one new Google Play edit for the bound package.
   *
   * DESTRUCTIVE at the Google boundary: Google invalidates any other active edit
   * the same API user has open for the same application. Never called implicitly
   * by a read/inspection path.
   */
  createEdit(): Promise<GooglePlayEditSession>;
  /** Real package/edit-scoped read-back of one edit. */
  getEdit(session: GooglePlayEditSession): Promise<ReleaseEditReadback>;
  /** Lists tracks for one exact edit id. */
  listTracks(session: GooglePlayEditSession): Promise<readonly unknown[]>;
}

/**
 * Read-only view of the gateway used by `releases.inspect`. The inspection path has
 * no type-level (and no runtime) access to edit creation at all.
 */
export type ReleaseInspectionGateway = Pick<ReleaseEditGateway, "getEdit" | "listTracks">;

/** Bundle upload boundary; edit creation and all later release mutations are absent. */
export interface ReleaseBundleUploadGateway {
  getEdit(session: GooglePlayEditSession): Promise<ReleaseEditReadback>;
  uploadBundle(
    session: GooglePlayEditSession,
    input: { readonly body: Readable },
  ): Promise<ReleaseBundle>;
  listBundles(session: GooglePlayEditSession): Promise<readonly ReleaseBundle[]>;
}

/** Exact-name, read-only lookup of one track in the managed edit. */
export interface ReleaseTrackReadGateway {
  getTrack(session: GooglePlayEditSession, targetTrack: string): Promise<ReleaseTrackState>;
}

/** Read-only direct deployed-release summary boundary for Phase 4.11 Layer A. */
export interface ReleaseSummaryGateway {
  listReleaseSummaries(targetTrack: string): Promise<readonly ReleaseSummaryState[]>;
}

/** Narrow destructive boundary for the Phase 4.11 exact Track verification layer. */
export interface ReleaseTemporaryEditVerificationGateway {
  createEdit(): Promise<GooglePlayEditSession>;
  getTrack(session: GooglePlayEditSession, targetTrack: string): Promise<ReleaseTrackState>;
  deleteEdit(session: GooglePlayEditSession): Promise<void>;
}

/** Narrow gateway for Phase 4.4; it exposes only the reads needed by the gate. */
export type ReleaseVersionCodeVerificationGateway = Pick<
  ReleaseBundleUploadGateway,
  "getEdit" | "listBundles"
> &
  ReleaseTrackReadGateway;

/** Narrow gateway for Phase 4.5; it reads one managed edit and one exact track. */
export type ReleaseTargetTrackInspectionGateway = Pick<ReleaseEditGateway, "getEdit"> &
  ReleaseTrackReadGateway;

/** Gateway for the narrow Phase 4.6 configure-release operation. */
export interface ReleaseTrackUpdateGateway {
  getEdit(session: GooglePlayEditSession): Promise<ReleaseEditReadback>;
  listBundles(session: GooglePlayEditSession): Promise<readonly ReleaseBundle[]>;
  getTrack(session: GooglePlayEditSession, targetTrack: string): Promise<ReleaseTrackState>;
  updateTrack(
    session: GooglePlayEditSession,
    targetTrack: string,
    request: ReleaseTrackUpdateRequest,
  ): Promise<ReleaseTrackState>;
}

export type ReleaseConfigurationGateway = ReleaseTrackUpdateGateway;

/** Narrow gateway for the Phase 4.8 read-only Google edit validation gate. */
export interface ReleaseEditValidationGateway {
  getEdit(session: GooglePlayEditSession): Promise<ReleaseEditReadback>;
  validateEdit(session: GooglePlayEditSession): Promise<ReleaseEditReadback>;
}

export type ReleaseValidationGateway = ReleaseEditValidationGateway;

/** Narrow gateway for the Phase 4.10 exact commit boundary. */
export interface ReleaseEditCommitGateway {
  getEdit(session: GooglePlayEditSession): Promise<ReleaseEditReadback>;
  getTrack(session: GooglePlayEditSession, targetTrack: string): Promise<ReleaseTrackState>;
  validateEdit(session: GooglePlayEditSession): Promise<ReleaseEditReadback>;
  commitEdit(
    session: GooglePlayEditSession,
    policy: {
      readonly changesInReviewBehavior: ReleaseCommitReviewBehavior;
      readonly changesNotSentForReview: boolean;
    },
  ): Promise<ReleaseEditReadback>;
}

export type ReleaseCommitGateway = ReleaseEditCommitGateway;

/** Full Publisher adapter returned by the shared production composition. */
export type ReleaseGooglePlayGateway = ReleaseEditGateway &
  ReleaseBundleUploadGateway &
  ReleaseTrackReadGateway &
  ReleaseSummaryGateway &
  ReleaseTemporaryEditVerificationGateway &
  ReleaseTrackUpdateGateway &
  ReleaseEditValidationGateway &
  ReleaseEditCommitGateway;

/** Narrow gateway for the Phase 4.12 staged-rollout workflow. */
export type ReleaseRolloutGateway = Pick<
  ReleaseGooglePlayGateway,
  | "listReleaseSummaries"
  | "createEdit"
  | "getEdit"
  | "getTrack"
  | "updateTrack"
  | "validateEdit"
  | "commitEdit"
  | "deleteEdit"
>;

/** Narrow gateway for Phase 4.13 status-only halt/resume control. */
export type ReleaseStatusControlGateway = ReleaseRolloutGateway;

/**
 * Narrow read-only boundary for the Phase 4.15 hygiene inspection and for the
 * pre/post read-back of `releases.cleanup_known_edit`.
 *
 * It exposes exactly one read and has no type-level (or runtime) access to edit
 * creation, track mutation, validate, or commit.
 */
export type ReleaseEditHygieneGateway = Pick<ReleaseEditGateway, "getEdit">;

/**
 * Phase 4.15 exact-record abandonment boundary: the exact-identity read plus
 * exactly one retry-disabled delete of that same identity. The delete exists
 * solely so its acknowledgement can be bound into the narrow contextual
 * post-delete inactivity verifier; nothing here can create, update, validate,
 * commit, upload, or list.
 */
export type ReleaseEditCleanupGateway = ReleaseEditHygieneGateway &
  Pick<ReleaseTemporaryEditVerificationGateway, "deleteEdit">;

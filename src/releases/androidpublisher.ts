import {
  commitEdit as commitPublisherEdit,
  createEdit,
  deleteEdit as deletePublisherEdit,
  getEdit,
  getTrack as getPublisherTrack,
  listBundles as listPublisherBundles,
  listReleaseSummaries as listPublisherReleaseSummaries,
  listTracks,
  PublisherError,
  updateTrack as updatePublisherTrack,
  uploadBundle as uploadPublisherBundle,
  validateEdit as validatePublisherEdit,
  type AndroidPublisherClient,
} from "../googleplay/publisher/index.js";
import type { ReadRetryOptions } from "../googleplay/retry/index.js";
import {
  parseGooglePlayEditSession,
  normalizeReleaseBundle,
  normalizeReleaseTracks,
  ReleaseError,
  validateReleasePackageName,
  validateReleaseTargetTrack,
  type GooglePlayEditSession,
  type ReleaseErrorClassification,
  type ReleaseSummaryState,
  type ReleaseTrackState,
  type ReleaseTrackUpdateRequest,
} from "./index.js";
import type {
  ReleaseBundleUploadGateway,
  ReleaseGooglePlayGateway,
  ReleaseEditReadback,
} from "./gateway.js";

/**
 * Project a PublisherError onto the allowlisted ReleaseError classification.
 * Google SDK/Gaxios types, raw messages, headers, config, URLs, and response
 * bodies never cross this boundary.
 */
function classificationOf(cause: unknown): ReleaseErrorClassification | undefined {
  if (!(cause instanceof PublisherError)) return undefined;
  return Object.freeze({
    publisherCode: cause.code,
    ...(cause.status !== undefined ? { status: cause.status } : {}),
    ...(cause.googleStatus !== undefined ? { googleStatus: cause.googleStatus } : {}),
    ...(cause.googleReasons !== undefined ? { googleReasons: cause.googleReasons } : {}),
    ...(cause.transportCode !== undefined ? { transportCode: cause.transportCode } : {}),
  });
}

function mappedPublisherError(
  cause: unknown,
  fallback: ReleaseError["code"],
  message: string,
): ReleaseError {
  if (cause instanceof ReleaseError) return cause;
  const classification = classificationOf(cause);
  const classificationOption = classification !== undefined ? { classification } : {};
  if (
    cause instanceof PublisherError &&
    cause.reason === "TRACK_IDENTITY_MISMATCH" &&
    fallback === "TRACK_READ_FAILED"
  ) {
    return new ReleaseError(
      "TRACK_MISMATCH",
      "Google Play returned a different track than the requested target.",
      { cause, ...classificationOption },
    );
  }
  if (
    cause instanceof PublisherError &&
    cause.reason === "TRACK_IDENTITY_MISMATCH" &&
    fallback === "TRACK_UPDATE_RESPONSE_INVALID"
  ) {
    return new ReleaseError(
      "TRACK_UPDATE_RESPONSE_INVALID",
      "Google Play returned an invalid track-update response; remote state may be uncertain.",
      { cause, ...classificationOption },
    );
  }
  const code =
    cause instanceof PublisherError && cause.code === "INVALID_ARGUMENT"
      ? "INVALID_ARGUMENT"
      : cause instanceof PublisherError && cause.code === "INVALID_RESPONSE"
        ? fallback === "EDIT_CREATE_FAILED"
          ? "EDIT_INVALID"
          : fallback === "TRACK_LIST_FAILED"
            ? "TRACK_INVALID"
            : fallback
        : fallback;
  return new ReleaseError(code, message, { cause, ...classificationOption });
}

/** Adapter over the single Phase 1 Android Publisher client; package is bound here. */
export function createAndroidPublisherReleaseGateway(
  publisher: AndroidPublisherClient,
  packageName: string,
  retryOptions?: ReadRetryOptions,
): ReleaseGooglePlayGateway {
  const boundPackageName = validateReleasePackageName(packageName);
  if (!publisher || typeof publisher !== "object") {
    throw new ReleaseError("INVALID_ARGUMENT", "Android Publisher client is required.");
  }

  return Object.freeze({
    /**
     * Exactly one `edits.insert` attempt; never retried. A thrown transport error is
     * ambiguous: the edit may exist remotely even though the call failed.
     */
    async createEdit(): Promise<GooglePlayEditSession> {
      try {
        const edit = await createEdit(publisher, { packageName: boundPackageName });
        return parseGooglePlayEditSession(
          {
            packageName: boundPackageName,
            editId: edit.id,
            ...(edit.expiryTimeSeconds !== undefined
              ? { expiryTimeSeconds: edit.expiryTimeSeconds }
              : {}),
          },
          boundPackageName,
        );
      } catch (cause) {
        throw mappedPublisherError(
          cause,
          "EDIT_CREATE_FAILED",
          "Play edit creation failed; remote state may be uncertain.",
        );
      }
    },

    async listTracks(session: GooglePlayEditSession) {
      const validated = parseGooglePlayEditSession(session, boundPackageName);
      try {
        const result = await listTracks(
          publisher,
          { packageName: boundPackageName, editId: validated.editId },
          retryOptions,
        );
        return result.tracks;
      } catch (cause) {
        throw mappedPublisherError(cause, "TRACK_LIST_FAILED", "Release tracks could not be read.");
      }
    },

    async getEdit(session: GooglePlayEditSession): Promise<ReleaseEditReadback> {
      const validated = parseGooglePlayEditSession(session, boundPackageName);
      try {
        const edit = await getEdit(
          publisher,
          { packageName: boundPackageName, editId: validated.editId },
          retryOptions,
        );
        return Object.freeze({
          id: edit.id,
          ...(edit.expiryTimeSeconds !== undefined
            ? { expiryTimeSeconds: edit.expiryTimeSeconds }
            : {}),
        });
      } catch (cause) {
        throw mappedPublisherError(cause, "EDIT_INVALID", "Tracked edit read-back failed.");
      }
    },

    async deleteEdit(session: GooglePlayEditSession): Promise<void> {
      const validated = parseGooglePlayEditSession(session, boundPackageName);
      try {
        await deletePublisherEdit(publisher, {
          packageName: boundPackageName,
          editId: validated.editId,
        });
      } catch (cause) {
        throw new ReleaseError(
          "VERIFICATION_EDIT_CLEANUP_FAILED",
          "Temporary verification edit cleanup failed; external state may be uncertain.",
          { cause, externalStateUncertain: true },
        );
      }
    },

    async listReleaseSummaries(targetTrack: string): Promise<readonly ReleaseSummaryState[]> {
      const validatedTrack = validateReleaseTargetTrack(targetTrack);
      try {
        const result = await listPublisherReleaseSummaries(
          publisher,
          {
            parent: `applications/${boundPackageName}/tracks/${validatedTrack}`,
          },
          retryOptions,
        );
        return Object.freeze(
          result.releases.map((release) =>
            Object.freeze({
              releaseName: release.releaseName,
              track: release.track,
              versionCodes: Object.freeze([...release.versionCodes]),
              releaseLifecycleState: release.releaseLifecycleState,
            }),
          ),
        );
      } catch (cause) {
        const fallback =
          cause instanceof PublisherError && cause.code === "INVALID_RESPONSE"
            ? "RELEASE_SUMMARY_RESPONSE_INVALID"
            : "RELEASE_SUMMARY_READ_FAILED";
        throw mappedPublisherError(
          cause,
          fallback,
          "Google Play deployed release summaries could not be read.",
        );
      }
    },

    async validateEdit(session: GooglePlayEditSession): Promise<ReleaseEditReadback> {
      const validated = parseGooglePlayEditSession(session, boundPackageName);
      try {
        const edit = await validatePublisherEdit(
          publisher,
          { packageName: boundPackageName, editId: validated.editId },
          retryOptions,
        );
        return Object.freeze({
          id: edit.id,
          ...(edit.expiryTimeSeconds !== undefined
            ? { expiryTimeSeconds: edit.expiryTimeSeconds }
            : {}),
        });
      } catch (cause) {
        if (cause instanceof PublisherError && cause.reason === "EDIT_IDENTITY_MISMATCH") {
          throw new ReleaseError(
            "VALIDATION_RESPONSE_MISMATCH",
            "Google Play returned a different edit from the validation request.",
            { cause },
          );
        }
        if (cause instanceof PublisherError && cause.code === "INVALID_RESPONSE") {
          throw new ReleaseError(
            "VALIDATION_RESPONSE_INVALID",
            "Google Play returned an invalid edit-validation response.",
            { cause },
          );
        }
        throw mappedPublisherError(
          cause,
          "EDIT_VALIDATION_FAILED",
          "Google Play edit validation failed.",
        );
      }
    },

    async commitEdit(
      session: GooglePlayEditSession,
      policy: {
        readonly changesInReviewBehavior: "ERROR_IF_IN_REVIEW";
        readonly changesNotSentForReview: false;
      },
    ): Promise<ReleaseEditReadback> {
      const validated = parseGooglePlayEditSession(session, boundPackageName);
      if (
        policy.changesInReviewBehavior !== "ERROR_IF_IN_REVIEW" ||
        policy.changesNotSentForReview !== false
      ) {
        throw new ReleaseError(
          "COMMIT_POLICY_UNSUPPORTED",
          "Phase 4.10 commit policy is invalid.",
          { externalStateUncertain: false },
        );
      }
      try {
        const edit = await commitPublisherEdit(publisher, {
          packageName: boundPackageName,
          editId: validated.editId,
          changesInReviewBehavior: policy.changesInReviewBehavior,
          changesNotSentForReview: policy.changesNotSentForReview,
        });
        return Object.freeze({
          id: edit.id,
          expiryTimeSeconds: edit.expiryTimeSeconds,
        });
      } catch (cause) {
        if (cause instanceof PublisherError && cause.reason === "CHANGES_ALREADY_IN_REVIEW") {
          throw new ReleaseError(
            "CHANGES_ALREADY_IN_REVIEW",
            "Google Play rejected the commit because changes are already in review.",
            { cause, externalStateUncertain: false },
          );
        }
        if (cause instanceof PublisherError && cause.externalStateUncertain === false) {
          throw new ReleaseError(
            "COMMIT_REJECTED",
            "Google Play explicitly rejected the commit request.",
            { cause, externalStateUncertain: false },
          );
        }
        if (cause instanceof PublisherError && cause.code === "INVALID_RESPONSE") {
          throw new ReleaseError(
            "COMMIT_RESPONSE_INVALID",
            "Google Play returned an invalid commit response; external state may be uncertain.",
            { cause, externalStateUncertain: true },
          );
        }
        throw new ReleaseError("COMMIT_FAILED", "Google Play commit outcome is uncertain.", {
          cause,
          externalStateUncertain: true,
        });
      }
    },

    async getTrack(
      session: GooglePlayEditSession,
      targetTrack: string,
    ): Promise<ReleaseTrackState> {
      const validated = parseGooglePlayEditSession(session, boundPackageName);
      try {
        const remoteTrack = await getPublisherTrack(
          publisher,
          {
            packageName: boundPackageName,
            editId: validated.editId,
            track: targetTrack,
          },
          retryOptions,
        );
        const [track] = normalizeReleaseTracks([remoteTrack]);
        if (!track) {
          throw new ReleaseError("TRACK_INVALID", "Remote release track is invalid.");
        }
        return track;
      } catch (cause) {
        throw mappedPublisherError(
          cause,
          "TRACK_READ_FAILED",
          "Target release track could not be read.",
        );
      }
    },

    async updateTrack(
      session: GooglePlayEditSession,
      targetTrack: string,
      request: ReleaseTrackUpdateRequest,
    ): Promise<ReleaseTrackState> {
      const validated = parseGooglePlayEditSession(session, boundPackageName);
      if (request.track !== targetTrack) {
        throw new ReleaseError(
          "INVALID_ARGUMENT",
          "Track update target does not match the requested track.",
        );
      }
      try {
        const remoteTrack = await updatePublisherTrack(publisher, {
          packageName: boundPackageName,
          editId: validated.editId,
          track: targetTrack,
          requestBody: {
            track: request.track,
            releases: request.releases.map((release) => ({
              ...(release.name !== undefined ? { name: release.name } : {}),
              versionCodes: [...release.versionCodes],
              status: release.status,
              ...(release.userFraction !== undefined ? { userFraction: release.userFraction } : {}),
              ...(release.releaseNotes !== undefined
                ? {
                    releaseNotes: release.releaseNotes.map((note) => ({
                      language: note.language,
                      text: note.text,
                    })),
                  }
                : {}),
              ...(release.countryTargeting !== undefined
                ? {
                    countryTargeting: {
                      countries: [...release.countryTargeting.countries],
                      includeRestOfWorld: release.countryTargeting.includeRestOfWorld,
                    },
                  }
                : {}),
              ...(release.inAppUpdatePriority !== undefined
                ? { inAppUpdatePriority: release.inAppUpdatePriority }
                : {}),
            })),
          },
        });
        const [normalized] = normalizeReleaseTracks([remoteTrack]);
        if (!normalized || normalized.track !== targetTrack) {
          throw new ReleaseError(
            "TRACK_UPDATE_RESPONSE_INVALID",
            "Google Play returned an invalid track-update response; remote state may be uncertain.",
          );
        }
        return normalized;
      } catch (cause) {
        if (cause instanceof ReleaseError) throw cause;
        const fallback =
          cause instanceof PublisherError && cause.code === "INVALID_RESPONSE"
            ? "TRACK_UPDATE_RESPONSE_INVALID"
            : "TRACK_UPDATE_FAILED";
        throw mappedPublisherError(
          cause,
          fallback,
          "Google Play track update failed; remote edit state may be uncertain.",
        );
      }
    },

    async uploadBundle(
      session: GooglePlayEditSession,
      input: Parameters<ReleaseBundleUploadGateway["uploadBundle"]>[1],
    ) {
      const validated = parseGooglePlayEditSession(session, boundPackageName);
      try {
        const bundle = await uploadPublisherBundle(publisher, {
          packageName: boundPackageName,
          editId: validated.editId,
          body: input.body,
        });
        return normalizeReleaseBundle(bundle);
      } catch (cause) {
        const fallback =
          cause instanceof PublisherError && cause.code === "INVALID_RESPONSE"
            ? "UPLOAD_RESPONSE_INVALID"
            : "UPLOAD_FAILED";
        throw mappedPublisherError(
          cause,
          fallback,
          "Google Play bundle upload failed; remote state may be uncertain.",
        );
      }
    },

    async listBundles(session: GooglePlayEditSession) {
      const validated = parseGooglePlayEditSession(session, boundPackageName);
      try {
        const bundles = await listPublisherBundles(
          publisher,
          { packageName: boundPackageName, editId: validated.editId },
          retryOptions,
        );
        return Object.freeze(bundles.map(normalizeReleaseBundle));
      } catch (cause) {
        if (cause instanceof ReleaseError && cause.code === "UPLOAD_RESPONSE_INVALID") {
          throw new ReleaseError("BUNDLE_LIST_FAILED", "Google Play bundle list is invalid.", {
            cause,
          });
        }
        throw mappedPublisherError(
          cause,
          "BUNDLE_LIST_FAILED",
          "Google Play bundle metadata could not be read.",
        );
      }
    },
  });
}

/** Production boundary for Phase 3.4: the EXISTING narrow Publisher client only. */
import {
  getReview,
  replyToReview,
  PublisherError,
  type AndroidPublisherClient,
} from "../../googleplay/publisher/index.js";
import {
  normalizeReviewReplyRemoteState,
  ReviewReplyPublishError,
  type ReviewReplyGateway,
} from "./index.js";

export function createAndroidPublisherReplyGateway(
  client: AndroidPublisherClient,
  packageName: string,
): ReviewReplyGateway {
  if (
    typeof packageName !== "string" ||
    packageName.trim() === "" ||
    !client ||
    typeof client.reviews?.get !== "function" ||
    typeof client.reviews.reply !== "function"
  ) {
    throw new ReviewReplyPublishError(
      "INVALID_ARGUMENT",
      "Reply gateway configuration is invalid.",
    );
  }
  return Object.freeze({
    async getReviewState(reviewId: string) {
      // No translationLanguage: compare the original user-review watermark, not a translation.
      const raw = await getReview(client, { packageName, reviewId });
      return normalizeReviewReplyRemoteState(raw, reviewId);
    },
    async publishReply(reviewId: string, replyText: string) {
      try {
        return await replyToReview(client, { packageName, reviewId, replyText });
      } catch (cause) {
        if (cause instanceof PublisherError && cause.code === "INVALID_RESPONSE") {
          throw new ReviewReplyPublishError(
            "PUBLISH_RESPONSE_INVALID",
            "Published reply result is invalid; external state may have changed.",
            { cause },
          );
        }
        throw cause;
      }
    },
  });
}

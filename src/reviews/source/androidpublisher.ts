/**
 * Phase 3.1 — production ReviewSource backed by the Phase 1.2 Android Publisher wrapper.
 * Delegates one page per call to `listReviews`, which already owns Google retry behavior;
 * no second client, no raw REST, no retry duplication, no translationLanguage exposure.
 */
import { listReviews, type AndroidPublisherClient } from "../../googleplay/publisher/index.js";
import type {
  RemoteReview,
  ReviewSource,
  ReviewSourceInput,
  ReviewSourcePage,
} from "../ingestion/index.js";

export function createAndroidPublisherReviewSource(client: AndroidPublisherClient): ReviewSource {
  return Object.freeze({
    async listReviews(input: ReviewSourceInput): Promise<ReviewSourcePage> {
      const page = await listReviews(client, {
        packageName: input.packageName,
        maxResults: input.maxResults,
        ...(input.pageToken !== undefined ? { pageToken: input.pageToken } : {}),
      });
      // Generated Schema$Review objects are handed to the domain as untrusted records;
      // the domain re-validates every field it uses.
      return {
        reviews: page.reviews as unknown as readonly RemoteReview[],
        ...(page.nextPageToken !== undefined ? { nextPageToken: page.nextPageToken } : {}),
      };
    },
  });
}

/**
 * Live doctor dependencies — wires Phase 0/1.1/1.2/1.3 modules into the
 * doctor pipeline. All Google operations here are read-only.
 */
import { loadConfig, loadServiceAccountCredentials, type PlayOpsConfig } from "../config/index.js";
import {
  ANDROID_PUBLISHER_SCOPE,
  createGoogleAuthClient,
  getGoogleAccessToken,
  PLAY_DEVELOPER_REPORTING_SCOPE,
} from "../googleplay/auth/index.js";
import { createAndroidPublisherClient, listReviews } from "../googleplay/publisher/index.js";
import { createPlayReportingClient, getAnrRateMetricSet } from "../googleplay/reporting/index.js";
import type { GoogleAuthClient } from "../googleplay/auth/index.js";
import type { DoctorDeps } from "./doctor.js";

/** Build the production doctor dependency set (live Google calls, read-only). */
export function createLiveDoctorDeps(): DoctorDeps {
  return {
    loadConfig: () => loadConfig(),

    loadCredentials: (config: PlayOpsConfig) => loadServiceAccountCredentials(config),

    authenticate: async (credentials) => {
      const client = createGoogleAuthClient(credentials, [
        ANDROID_PUBLISHER_SCOPE,
        PLAY_DEVELOPER_REPORTING_SCOPE,
      ]);
      // Real token acquisition; the token value is discarded immediately.
      await getGoogleAccessToken(client);
      return client;
    },

    checkAndroidPublisher: async (config: PlayOpsConfig, auth: GoogleAuthClient) => {
      const publisher = createAndroidPublisherClient(auth);
      const result = await listReviews(publisher, {
        packageName: config.googlePlay.packageName,
        maxResults: 1,
      });
      return { reviewsRead: result.reviews.length };
    },

    checkPlayDeveloperReporting: async (config: PlayOpsConfig, auth: GoogleAuthClient) => {
      const reporting = createPlayReportingClient(auth);
      await getAnrRateMetricSet(reporting, config.googlePlay.packageName);
    },
  };
}

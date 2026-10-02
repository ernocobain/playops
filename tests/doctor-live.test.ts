import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatDoctorReport, runDoctor } from "../src/doctor/doctor.js";
import { createLiveDoctorDeps } from "../src/doctor/live.js";
import type { PlayOpsConfig, ServiceAccountCredentials } from "../src/config/index.js";

// Only the live module boundaries are faked. runDoctor validation, ordering,
// classification and report formatting are real; no Google HTTP can be called.
const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  loadServiceAccountCredentials: vi.fn(),
  createGoogleAuthClient: vi.fn(),
  getGoogleAccessToken: vi.fn(),
  createAndroidPublisherClient: vi.fn(),
  listReviews: vi.fn(),
  createPlayReportingClient: vi.fn(),
  getAnrRateMetricSet: vi.fn(),
}));

vi.mock("../src/config/index.js", () => ({
  loadConfig: mocks.loadConfig,
  loadServiceAccountCredentials: mocks.loadServiceAccountCredentials,
}));
vi.mock("../src/googleplay/auth/index.js", () => ({
  ANDROID_PUBLISHER_SCOPE: "https://www.googleapis.com/auth/androidpublisher",
  PLAY_DEVELOPER_REPORTING_SCOPE: "https://www.googleapis.com/auth/playdeveloperreporting",
  createGoogleAuthClient: mocks.createGoogleAuthClient,
  getGoogleAccessToken: mocks.getGoogleAccessToken,
}));
vi.mock("../src/googleplay/publisher/index.js", () => ({
  createAndroidPublisherClient: mocks.createAndroidPublisherClient,
  listReviews: mocks.listReviews,
}));
vi.mock("../src/googleplay/reporting/index.js", () => ({
  createPlayReportingClient: mocks.createPlayReportingClient,
  getAnrRateMetricSet: mocks.getAnrRateMetricSet,
}));

const PACKAGE = "com.example.app";
const CONFIG: PlayOpsConfig = {
  googlePlay: { packageName: PACKAGE, serviceAccountJson: "/outside-repo/fake-credentials.json" },
  agent: { maxSteps: 20, approvalTimeoutSeconds: 300 },
  health: { crashRateThreshold: 0.01, anrRateThreshold: 0.005 },
  audit: { logPath: "./logs/playops.audit.jsonl" },
  review: { checkpointPath: "" },
  release: { editSessionPath: "", editCleanupJournalPath: "" },
  llm: { nineRouter: { baseUrl: "", model: "" } },
};
const CREDENTIALS: ServiceAccountCredentials = {
  type: "service_account",
  clientEmail: "fake@example.iam.gserviceaccount.com",
  privateKey: "FAKE-KEY-DO-NOT-USE",
  tokenUri: "https://oauth2.googleapis.com/token",
  sourcePath: "/outside-repo/fake-credentials.json",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadConfig.mockReturnValue(CONFIG);
  mocks.loadServiceAccountCredentials.mockReturnValue(CREDENTIALS);
  mocks.getGoogleAccessToken.mockResolvedValue("FAKE-TOKEN-DO-NOT-USE");
  mocks.createGoogleAuthClient.mockReturnValue({ getAccessToken: vi.fn() });
  mocks.createAndroidPublisherClient.mockReturnValue({ reviews: { list: vi.fn() } });
  mocks.listReviews.mockResolvedValue({ reviews: [] });
  mocks.createPlayReportingClient.mockReturnValue({ vitals: { anrrate: { get: vi.fn() } } });
  mocks.getAnrRateMetricSet.mockResolvedValue({ name: `apps/${PACKAGE}/anrRateMetricSet` });
});

describe("live doctor wiring (mocked boundaries, zero network)", () => {
  it("loads credentials once, acquires both scopes, reuses auth and only invokes read-only APIs", async () => {
    const report = await runDoctor(createLiveDoctorDeps());
    expect(report.status).toBe("READY");
    expect(mocks.loadConfig).toHaveBeenCalledTimes(1);
    expect(mocks.loadServiceAccountCredentials).toHaveBeenCalledExactlyOnceWith(CONFIG);
    expect(mocks.createGoogleAuthClient).toHaveBeenCalledExactlyOnceWith(CREDENTIALS, [
      "https://www.googleapis.com/auth/androidpublisher",
      "https://www.googleapis.com/auth/playdeveloperreporting",
    ]);
    const auth = mocks.createGoogleAuthClient.mock.results[0]?.value;
    expect(mocks.getGoogleAccessToken).toHaveBeenCalledExactlyOnceWith(auth);
    expect(mocks.createAndroidPublisherClient).toHaveBeenCalledExactlyOnceWith(auth);
    expect(mocks.listReviews).toHaveBeenCalledExactlyOnceWith(
      mocks.createAndroidPublisherClient.mock.results[0]?.value,
      { packageName: PACKAGE, maxResults: 1 },
    );
    expect(mocks.createPlayReportingClient).toHaveBeenCalledExactlyOnceWith(auth);
    expect(mocks.getAnrRateMetricSet).toHaveBeenCalledExactlyOnceWith(
      mocks.createPlayReportingClient.mock.results[0]?.value,
      PACKAGE,
    );
    const output = formatDoctorReport(report);
    expect(output).not.toContain(CREDENTIALS.privateKey);
    expect(output).not.toContain("FAKE-TOKEN-DO-NOT-USE");
  });

  it("does not make API calls when token acquisition fails", async () => {
    mocks.getGoogleAccessToken.mockRejectedValue(new Error("token acquisition refused"));
    const report = await runDoctor(createLiveDoctorDeps());
    expect(report.checks.map((check) => check.status)).toEqual([
      "pass",
      "pass",
      "fail",
      "skip",
      "skip",
    ]);
    expect(mocks.listReviews).not.toHaveBeenCalled();
    expect(mocks.getAnrRateMetricSet).not.toHaveBeenCalled();
  });
});

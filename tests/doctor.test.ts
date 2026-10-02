/**
 * Phase 1.4 — doctor unit tests.
 *
 * Zero network, zero real credentials: every live boundary is injected.
 * PlayOps' own check ordering, skip logic, classification, exit-code mapping,
 * and output rendering are exercised for real.
 */
import { describe, expect, it } from "vitest";
import type { PlayOpsConfig, ServiceAccountCredentials } from "../src/config/index.js";
import { ConfigError } from "../src/config/index.js";
import { CredentialError } from "../src/config/index.js";
import { AuthError } from "../src/googleplay/auth/index.js";
import type { GoogleAuthClient } from "../src/googleplay/auth/index.js";
import { PublisherError } from "../src/googleplay/publisher/index.js";
import { ReportingError } from "../src/googleplay/reporting/index.js";
import { formatDoctorReport, runDoctor, type DoctorDeps } from "../src/doctor/doctor.js";
import { runCli } from "../src/cli/main.js";

const FAKE_TOKEN = "ya29.fake-token-1.4";
const FAKE_KEY = "-----BEGIN PRIVATE KEY-----\nFAKE-KEY-1.4\n-----END PRIVATE KEY-----\n";

function goodConfig(overrides: Partial<PlayOpsConfig["googlePlay"]> = {}): PlayOpsConfig {
  return {
    googlePlay: {
      packageName: "com.example.app",
      serviceAccountJson: "/secrets/fake-sa.json",
      ...overrides,
    },
    agent: { maxSteps: 20, approvalTimeoutSeconds: 300 },
    health: { crashRateThreshold: 0.01, anrRateThreshold: 0.005 },
    audit: { logPath: "./logs/playops.audit.jsonl" },
    review: { checkpointPath: "" },
    release: { editSessionPath: "", editCleanupJournalPath: "" },
    llm: { nineRouter: { baseUrl: "", model: "" } },
  };
}

const FAKE_AUTH: GoogleAuthClient = {
  getAccessToken: () => Promise.resolve({ token: FAKE_TOKEN }),
};
const FAKE_CREDENTIALS: ServiceAccountCredentials = {
  type: "service_account",
  clientEmail: "playops-fake@example.iam.gserviceaccount.com",
  privateKey: FAKE_KEY,
  tokenUri: "https://oauth2.googleapis.com/token",
  sourcePath: "/secrets/fake-sa.json",
};

function happyDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    loadConfig: () => goodConfig(),
    loadCredentials: () => FAKE_CREDENTIALS,
    authenticate: () => Promise.resolve(FAKE_AUTH),
    checkAndroidPublisher: () => Promise.resolve({ reviewsRead: 3 }),
    checkPlayDeveloperReporting: () => Promise.resolve(),
    ...overrides,
  };
}

function apiError(status: number, message: string): PublisherError {
  return new PublisherError(`reviews.list failed (${status}): ${message}`, "API_REQUEST_FAILED", {
    cause: Object.assign(new Error(message), { code: status }),
  });
}

describe("runDoctor", () => {
  it("returns READY + exit 0 when all checks pass", async () => {
    const report = await runDoctor(happyDeps());

    expect(report.status).toBe("READY");
    expect(report.exitCode).toBe(0);
    expect(report.checks.map((c) => c.status)).toEqual(["pass", "pass", "pass", "pass", "pass"]);
    expect(report.checks.map((c) => c.name)).toEqual([
      "CONFIG",
      "CREDENTIALS",
      "AUTH",
      "ANDROID_PUBLISHER",
      "PLAY_DEVELOPER_REPORTING",
    ]);
  });

  it("fails CONFIG and skips all later checks when config is blank", async () => {
    const report = await runDoctor(
      happyDeps({ loadConfig: () => goodConfig({ packageName: "" }) }),
    );

    expect(report.status).toBe("NOT READY");
    expect(report.exitCode).toBe(1);
    expect(report.checks[0]?.status).toBe("fail");
    expect(report.checks[0]?.message).toContain("CONFIG_INVALID");
    expect(report.checks.slice(1).map((c) => c.status)).toEqual(["skip", "skip", "skip", "skip"]);
  });

  it("fails CONFIG when loadConfig throws", async () => {
    const report = await runDoctor(
      happyDeps({
        loadConfig: () => {
          throw new ConfigError("bad yaml", "CONFIG_MALFORMED_YAML");
        },
      }),
    );
    expect(report.checks[0]?.status).toBe("fail");
    expect(report.exitCode).toBe(1);
  });

  it("fails CREDENTIALS (file missing) and skips auth + API checks", async () => {
    const report = await runDoctor(
      happyDeps({
        loadCredentials: () => {
          throw new CredentialError(
            "not found: /secrets/fake-sa.json",
            "CREDENTIAL_FILE_NOT_FOUND",
            "/secrets/fake-sa.json",
          );
        },
      }),
    );

    expect(report.checks[1]?.status).toBe("fail");
    expect(report.checks[1]?.message).toContain("CREDENTIAL_FILE_MISSING");
    expect(report.checks.slice(2).map((c) => c.status)).toEqual(["skip", "skip", "skip"]);
    expect(report.exitCode).toBe(1);
  });

  it("fails CREDENTIALS (invalid shape) with CREDENTIAL_INVALID", async () => {
    const report = await runDoctor(
      happyDeps({
        loadCredentials: () => {
          throw new CredentialError('missing "private_key"', "CREDENTIAL_INVALID_SHAPE");
        },
      }),
    );
    expect(report.checks[1]?.message).toContain("CREDENTIAL_INVALID");
  });

  it("fails AUTH and skips API checks", async () => {
    const report = await runDoctor(
      happyDeps({
        authenticate: () =>
          Promise.reject(new AuthError("token exchange failed", "ACCESS_TOKEN_FAILED")),
      }),
    );

    expect(report.checks[2]?.status).toBe("fail");
    expect(report.checks[2]?.message).toContain("AUTH_FAILED");
    expect(report.checks.slice(3).map((c) => c.status)).toEqual(["skip", "skip"]);
  });

  it("publisher success with zero reviews is still PASS", async () => {
    const report = await runDoctor(
      happyDeps({ checkAndroidPublisher: () => Promise.resolve({ reviewsRead: 0 }) }),
    );
    expect(report.checks[3]?.status).toBe("pass");
    expect(report.status).toBe("READY");
  });

  it("publisher 401 → API_UNAUTHORIZED, reporting skipped", async () => {
    const report = await runDoctor(
      happyDeps({ checkAndroidPublisher: () => Promise.reject(apiError(401, "unauthorized")) }),
    );
    expect(report.checks[3]?.status).toBe("fail");
    expect(report.checks[3]?.message).toContain("API_UNAUTHORIZED");
    expect(report.checks[3]?.message).toContain("401");
    expect(report.checks[4]?.status).toBe("skip");
    expect(report.checks[4]?.message).toContain("package access failed");
  });

  it("publisher 403 → PACKAGE_ACCESS_DENIED with safe guidance", async () => {
    const report = await runDoctor(
      happyDeps({ checkAndroidPublisher: () => Promise.reject(apiError(403, "forbidden")) }),
    );
    expect(report.checks[3]?.message).toContain("403");
    expect(report.checks[3]?.message).toContain("Users and permissions");
  });

  it("publisher 404 → PACKAGE_NOT_FOUND", async () => {
    const report = await runDoctor(
      happyDeps({ checkAndroidPublisher: () => Promise.reject(apiError(404, "not found")) }),
    );
    expect(report.checks[3]?.message).toContain("PACKAGE_NOT_FOUND");
  });

  it("publisher unknown failure → UNKNOWN_REMOTE_ERROR", async () => {
    const report = await runDoctor(
      happyDeps({
        checkAndroidPublisher: () =>
          Promise.reject(new PublisherError("weird", "INVALID_RESPONSE")),
      }),
    );
    expect(report.checks[3]?.message).toContain("UNKNOWN_REMOTE_ERROR");
  });

  it("reporting failure after publisher success → NOT READY", async () => {
    const report = await runDoctor(
      happyDeps({
        checkPlayDeveloperReporting: () =>
          Promise.reject(
            new ReportingError("vitals get failed (403)", "API_REQUEST_FAILED", {
              cause: Object.assign(new Error("forbidden"), { code: 403 }),
            }),
          ),
      }),
    );

    expect(report.checks[4]?.status).toBe("fail");
    expect(report.checks[4]?.message).toContain("REPORTING_ACCESS_DENIED");
    expect(report.status).toBe("NOT READY");
    expect(report.exitCode).toBe(1);
  });

  it("shows packageName and client_email safely", async () => {
    const report = await runDoctor(happyDeps());
    const output = formatDoctorReport(report);

    expect(output).toContain("com.example.app");
    expect(output).toContain("playops-fake@example.iam.gserviceaccount.com");
    expect(output).toContain("Status: READY");
  });

  it("never leaks token or private_key into report or rendered output", async () => {
    const report = await runDoctor(
      happyDeps({
        checkAndroidPublisher: () =>
          Promise.reject(
            new PublisherError(`Authorization: Bearer ${FAKE_TOKEN}`, "API_REQUEST_FAILED", {
              cause: Object.assign(new Error(`auth used ${FAKE_TOKEN} with ${FAKE_KEY}`), {
                code: 403,
              }),
            }),
          ),
      }),
    );
    const serialized = JSON.stringify(report) + formatDoctorReport(report);

    expect(serialized).not.toContain(FAKE_TOKEN);
    expect(serialized).not.toContain(FAKE_KEY);
    expect(serialized).not.toContain("Authorization:");
    expect(report.checks[3]?.message).toContain("403");
    expect(report.exitCode).toBe(1);
  });

  it("never prints raw config, credential, auth or reporting errors containing secrets", async () => {
    const cases: Partial<DoctorDeps>[] = [
      {
        loadConfig: () => {
          throw new Error(`bad YAML ${FAKE_TOKEN} ${FAKE_KEY}`);
        },
      },
      {
        loadCredentials: () => {
          throw new Error(`bad JSON ${FAKE_TOKEN} ${FAKE_KEY}`);
        },
      },
      {
        authenticate: () =>
          Promise.reject(new AuthError(`failure ${FAKE_TOKEN} ${FAKE_KEY}`, "ACCESS_TOKEN_FAILED")),
      },
      {
        checkPlayDeveloperReporting: () =>
          Promise.reject(
            new ReportingError(`secret ${FAKE_TOKEN} ${FAKE_KEY}`, "API_REQUEST_FAILED"),
          ),
      },
    ];
    for (const overrides of cases) {
      const report = await runDoctor(happyDeps(overrides));
      const serialized = JSON.stringify(report) + formatDoctorReport(report);
      expect(serialized).not.toContain(FAKE_TOKEN);
      expect(serialized).not.toContain(FAKE_KEY);
      expect(serialized).not.toContain("Authorization:");
    }
  });

  it("never prints arbitrary raw Google status codes", async () => {
    const report = await runDoctor(
      happyDeps({
        checkAndroidPublisher: () =>
          Promise.reject(
            new PublisherError("fail", "API_REQUEST_FAILED", {
              cause: Object.assign(new Error("bad"), { code: `Bearer ${FAKE_TOKEN}` }),
            }),
          ),
      }),
    );
    expect(formatDoctorReport(report)).not.toContain(FAKE_TOKEN);
    expect(report.checks[3]?.message).toContain("UNKNOWN_REMOTE_ERROR");
  });

  it("passes validated credentials to auth and reuses ONE client for both read APIs", async () => {
    const seen: unknown[] = [];
    const report = await runDoctor(
      happyDeps({
        authenticate: (credentials) => {
          seen.push(credentials);
          return Promise.resolve(FAKE_AUTH);
        },
        checkAndroidPublisher: (_config, auth) => {
          seen.push(auth);
          return Promise.resolve({ reviewsRead: 0 });
        },
        checkPlayDeveloperReporting: (_config, auth) => {
          seen.push(auth);
          return Promise.resolve();
        },
      }),
    );
    expect(report.status).toBe("READY");
    expect(seen).toEqual([FAKE_CREDENTIALS, FAKE_AUTH, FAKE_AUTH]);
  });

  it("rejects malformed package names without echoing attacker-controlled text", async () => {
    const report = await runDoctor(
      happyDeps({
        loadConfig: () =>
          goodConfig({ packageName: `com.example.${FAKE_TOKEN}\nAuthorization: ${FAKE_KEY}` }),
      }),
    );
    expect(report.exitCode).toBe(1);
    expect(formatDoctorReport(report)).not.toContain(FAKE_TOKEN);
    expect(formatDoctorReport(report)).not.toContain(FAKE_KEY);
  });

  it("omits unsafe service-account email from the diagnostic report", async () => {
    const report = await runDoctor(
      happyDeps({
        loadCredentials: () => ({
          ...FAKE_CREDENTIALS,
          clientEmail: `${FAKE_TOKEN}\nAuthorization: ${FAKE_KEY}`,
        }),
      }),
    );
    expect(report.status).toBe("READY");
    expect(formatDoctorReport(report)).not.toContain(FAKE_TOKEN);
    expect(formatDoctorReport(report)).not.toContain(FAKE_KEY);
  });

  it("maps exit codes: READY→0, NOT READY→1", async () => {
    const ready = await runDoctor(happyDeps());
    const notReady = await runDoctor(
      happyDeps({ loadConfig: () => goodConfig({ packageName: "" }) }),
    );
    expect(ready.exitCode).toBe(0);
    expect(notReady.exitCode).toBe(1);
  });

  it("keeps deterministic check ordering even on mid-chain failure", async () => {
    const report = await runDoctor(
      happyDeps({
        authenticate: () => Promise.reject(new AuthError("nope", "ACCESS_TOKEN_MISSING")),
      }),
    );
    expect(report.checks.map((c) => c.name)).toEqual([
      "CONFIG",
      "CREDENTIALS",
      "AUTH",
      "ANDROID_PUBLISHER",
      "PLAY_DEVELOPER_REPORTING",
    ]);
    expect(report.checks.map((c) => c.status)).toEqual(["pass", "pass", "fail", "skip", "skip"]);
  });

  it("renders failure output compactly without dumping raw Google errors", async () => {
    const report = await runDoctor(
      happyDeps({ checkAndroidPublisher: () => Promise.reject(apiError(403, "forbidden")) }),
    );
    const output = formatDoctorReport(report);

    expect(output).toContain("✗ ANDROID_PUBLISHER");
    expect(output).toContain("Status: NOT READY");
    // no serialized object noise
    expect(output).not.toContain("GaxiosError");
    expect(output).not.toContain('"config"');
    expect(output).not.toContain("stack");
  });
});

describe("runCli", () => {
  it("maps READY to 0, NOT READY to 1 without terminating the test process", async () => {
    const messages: string[] = [];
    const output = {
      log: (text: string) => {
        messages.push(text);
      },
      error: (text: string) => {
        messages.push(text);
      },
    };
    expect(await runCli(["doctor"], happyDeps(), output)).toBe(0);
    expect(
      await runCli(
        ["doctor"],
        happyDeps({ loadConfig: () => goodConfig({ packageName: "" }) }),
        output,
      ),
    ).toBe(1);
    expect(messages[0]).toContain("Status: READY");
    expect(messages[1]).toContain("Status: NOT READY");
  });

  it("only accepts the read-only doctor command and help", async () => {
    const messages: string[] = [];
    const output = {
      log: (text: string) => {
        messages.push(text);
      },
      error: (text: string) => {
        messages.push(text);
      },
    };
    expect(await runCli(["--help"], happyDeps(), output)).toBe(0);
    expect(await runCli(["doctor", "--publish"], happyDeps(), output)).toBe(1);
    expect(await runCli(["releases"], happyDeps(), output)).toBe(1);
    expect(messages[0]).toContain("doctor");
  });
});

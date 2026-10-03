/**
 * Phase 0.7 — credential locator unit tests.
 *
 * Fixture credentials contain FAKE values only. No test touches real Google
 * credentials, authenticates, or requests tokens. env/config precedence stays
 * in loadConfig(); these tests consume the resulting PlayOpsConfig directly.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadServiceAccountCredentials,
  resolveCredentialPath,
  type CredentialError,
  type PlayOpsConfig,
} from "../src/config/index.js";

const FIXTURE_PATH = resolve(import.meta.dirname, "fixtures/service-account.valid.json");
const FAKE_PRIVATE_KEY_FRAGMENT = "FAKE-FIXTURE-KEY-NOT-REAL";

let dir: string;
const savedCwd = process.cwd();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "playops-cred-test-"));
});

afterEach(() => {
  process.chdir(savedCwd);
  rmSync(dir, { recursive: true, force: true });
});

function configWith(path: string): PlayOpsConfig {
  return {
    googlePlay: { packageName: "com.example.app", serviceAccountJson: path },
    agent: { maxSteps: 20, approvalTimeoutSeconds: 300 },
    health: {
      crashRateReportedThreshold: null,
      anrRateReportedThreshold: null,
      excessiveWakeupRateReportedThreshold: null,
    },
    audit: { logPath: "./logs/playops.audit.jsonl" },
    review: { checkpointPath: "" },
    release: { editSessionPath: "", editCleanupJournalPath: "" },
    llm: { nineRouter: { baseUrl: "", model: "" } },
  };
}

function writeJson(name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

describe("resolveCredentialPath", () => {
  it("returns undefined when no path is configured", () => {
    expect(resolveCredentialPath(configWith(""))).toBeUndefined();
  });

  it("resolves relative paths against process.cwd()", () => {
    process.chdir(dir);
    expect(resolveCredentialPath(configWith("creds/sa.json"))).toBe(join(dir, "creds/sa.json"));
  });

  it("keeps absolute paths unchanged", () => {
    expect(resolveCredentialPath(configWith(FIXTURE_PATH))).toBe(FIXTURE_PATH);
  });
});

describe("loadServiceAccountCredentials", () => {
  it("loads a valid service-account fixture", () => {
    const creds = loadServiceAccountCredentials(configWith(FIXTURE_PATH));

    expect(creds.type).toBe("service_account");
    expect(creds.clientEmail).toContain("@");
    expect(creds.clientEmail).toContain("gserviceaccount.com");
    expect(creds.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(creds.tokenUri).toBe("https://oauth2.googleapis.com/token");
    expect(creds.sourcePath).toBe(FIXTURE_PATH);
  });

  it("loads via a relative path resolved from cwd", () => {
    mkdirSync(join(dir, "creds"));
    writeFileSync(join(dir, "creds", "sa.json"), JSON.stringify(validDoc()));
    process.chdir(dir);

    const creds = loadServiceAccountCredentials(configWith("creds/sa.json"));
    expect(creds.sourcePath).toBe(join(dir, "creds", "sa.json"));
    expect(creds.clientEmail).toBe("fixture@example.iam.gserviceaccount.com");
  });

  it("throws CREDENTIAL_PATH_NOT_CONFIGURED when path is empty", () => {
    try {
      loadServiceAccountCredentials(configWith(""));
      expect.unreachable();
    } catch (error) {
      expect((error as CredentialError).code).toBe("CREDENTIAL_PATH_NOT_CONFIGURED");
    }
  });

  it("throws CREDENTIAL_FILE_NOT_FOUND for a missing file", () => {
    const missing = join(dir, "missing.json");
    try {
      loadServiceAccountCredentials(configWith(missing));
      expect.unreachable();
    } catch (error) {
      const credError = error as CredentialError;
      expect(credError.code).toBe("CREDENTIAL_FILE_NOT_FOUND");
      expect(credError.path).toBe(missing);
      expect(credError.message).toContain(missing);
    }
  });

  it("throws CREDENTIAL_NOT_A_FILE when the path is a directory", () => {
    try {
      loadServiceAccountCredentials(configWith(dir));
      expect.unreachable();
    } catch (error) {
      expect((error as CredentialError).code).toBe("CREDENTIAL_NOT_A_FILE");
    }
  });

  it("throws CREDENTIAL_NOT_READABLE for an unreadable file", () => {
    const path = writeJson("unreadable.json", validDoc());
    chmodSync(path, 0o000);
    try {
      loadServiceAccountCredentials(configWith(path));
      expect.unreachable();
    } catch (error) {
      expect((error as CredentialError).code).toBe("CREDENTIAL_NOT_READABLE");
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it("throws CREDENTIAL_MALFORMED_JSON on broken JSON", () => {
    const path = writeJson("broken.json", '{"type": "service_account",');
    try {
      loadServiceAccountCredentials(configWith(path));
      expect.unreachable();
    } catch (error) {
      expect((error as CredentialError).code).toBe("CREDENTIAL_MALFORMED_JSON");
    }
  });

  it("throws CREDENTIAL_ROOT_NOT_OBJECT for a non-object root", () => {
    for (const [name, value] of [
      ["array.json", "[1,2,3]"],
      ["string.json", '"just a string"'],
      ["null.json", "null"],
    ] as const) {
      const path = writeJson(name, value);
      try {
        loadServiceAccountCredentials(configWith(path));
        expect.unreachable();
      } catch (error) {
        expect((error as CredentialError).code).toBe("CREDENTIAL_ROOT_NOT_OBJECT");
      }
    }
  });

  it("throws CREDENTIAL_INVALID_SHAPE when type is not service_account", () => {
    const path = writeJson("wrong-type.json", { ...validDoc(), type: "authorized_user" });
    try {
      loadServiceAccountCredentials(configWith(path));
      expect.unreachable();
    } catch (error) {
      const credError = error as CredentialError;
      expect(credError.code).toBe("CREDENTIAL_INVALID_SHAPE");
      expect(credError.message).toContain("authorized_user");
    }
  });

  it("requires non-empty client_email, private_key, token_uri", () => {
    const base = validDoc();
    for (const field of ["client_email", "private_key", "token_uri"] as const) {
      const missing = Object.fromEntries(Object.entries(base).filter(([key]) => key !== field));
      const path = writeJson(`missing-${field}.json`, missing);
      try {
        loadServiceAccountCredentials(configWith(path));
        expect.unreachable();
      } catch (error) {
        const credError = error as CredentialError;
        expect(credError.code).toBe("CREDENTIAL_INVALID_SHAPE");
        expect(credError.message).toContain(field);
      }
    }
  });

  it("rejects wrong field types (non-string values)", () => {
    const doc = { ...validDoc(), client_email: 42 } as Record<string, unknown>;
    const path = writeJson("bad-type.json", doc);
    try {
      loadServiceAccountCredentials(configWith(path));
      expect.unreachable();
    } catch (error) {
      expect((error as CredentialError).code).toBe("CREDENTIAL_INVALID_SHAPE");
    }
  });

  it("never leaks private_key content into any error", () => {
    const doc = validDoc(); // contains FAKE_PRIVATE_KEY_FRAGMENT in private_key
    const scenarios: Record<string, unknown>[] = [
      { ...doc, type: "authorized_user" },
      { ...doc, client_email: "" },
      { ...doc, token_uri: 123 },
    ];
    for (const scenario of scenarios) {
      const path = writeJson(`leak-${scenarios.indexOf(scenario)}.json`, scenario);
      try {
        loadServiceAccountCredentials(configWith(path));
        expect.unreachable();
      } catch (error) {
        const message = (error as Error).message;
        expect(message).not.toContain(FAKE_PRIVATE_KEY_FRAGMENT);
        expect(message).not.toContain("BEGIN PRIVATE KEY");
        expect(JSON.stringify(error)).not.toContain(FAKE_PRIVATE_KEY_FRAGMENT);
      }
    }
  });
});

function validDoc(): Record<string, unknown> {
  return {
    type: "service_account",
    client_email: "fixture@example.iam.gserviceaccount.com",
    private_key: `-----BEGIN PRIVATE KEY-----\n${FAKE_PRIVATE_KEY_FRAGMENT}\n-----END PRIVATE KEY-----\n`,
    token_uri: "https://oauth2.googleapis.com/token",
  };
}

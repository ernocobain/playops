/**
 * Phase 1.1 — Google auth module unit tests.
 *
 * No real credentials, no network, no Google Play access. The google library
 * boundary is injected via JwtFactory; PlayOps' own scope normalization and
 * token validation are never mocked away.
 */
import { describe, expect, it } from "vitest";
import type { ServiceAccountCredentials } from "../src/config/index.js";
import {
  ANDROID_PUBLISHER_SCOPE,
  AuthError,
  createGoogleAuthClient,
  getGoogleAccessToken,
  normalizeScopes,
  PLAY_DEVELOPER_REPORTING_SCOPE,
  type AccessTokenResponseLike,
  type GoogleAuthClient,
  type JwtFactory,
} from "../src/googleplay/auth/index.js";

const FAKE_PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\nFAKE-KEY-CONTENT-1.1\n-----END PRIVATE KEY-----\n";
const FAKE_TOKEN = "ya29.fake-access-token-1.1";

function fakeCredentials(): ServiceAccountCredentials {
  return {
    type: "service_account",
    clientEmail: "playops-fake@example.iam.gserviceaccount.com",
    privateKey: FAKE_PRIVATE_KEY,
    tokenUri: "https://oauth2.googleapis.com/token",
    sourcePath: "/tmp/fake-sa.json",
  };
}

interface CapturedOptions {
  email: string;
  key: string;
  scopes: string[];
}

/** Factory that records constructor options and returns a stub client. */
function recordingFactory(
  stub: GoogleAuthClient,
  captured: { value?: CapturedOptions },
): JwtFactory {
  return (options) => {
    captured.value = options;
    return stub;
  };
}

function stubClient(response: AccessTokenResponseLike): GoogleAuthClient {
  return { getAccessToken: () => Promise.resolve(response) };
}

function failingClient(cause: unknown): GoogleAuthClient {
  return {
    getAccessToken: () => Promise.reject(cause),
  };
}

describe("scope constants", () => {
  it("exposes the Android Publisher scope", () => {
    expect(ANDROID_PUBLISHER_SCOPE).toBe("https://www.googleapis.com/auth/androidpublisher");
  });

  it("exposes the Play Developer Reporting scope", () => {
    expect(PLAY_DEVELOPER_REPORTING_SCOPE).toBe(
      "https://www.googleapis.com/auth/playdeveloperreporting",
    );
  });
});

describe("createGoogleAuthClient", () => {
  it("creates a client from validated credentials with the publisher scope", () => {
    const captured: { value?: CapturedOptions } = {};
    const stub = stubClient({ token: FAKE_TOKEN });

    const client = createGoogleAuthClient(
      fakeCredentials(),
      [ANDROID_PUBLISHER_SCOPE],
      recordingFactory(stub, captured),
    );

    expect(client).toBe(stub);
    expect(captured.value?.email).toBe("playops-fake@example.iam.gserviceaccount.com");
    expect(captured.value?.key).toBe(FAKE_PRIVATE_KEY);
    expect(captured.value?.scopes).toEqual([ANDROID_PUBLISHER_SCOPE]);
  });

  it("passes the Reporting scope when supplied", () => {
    const captured: { value?: CapturedOptions } = {};
    createGoogleAuthClient(
      fakeCredentials(),
      [PLAY_DEVELOPER_REPORTING_SCOPE],
      recordingFactory(stubClient({ token: FAKE_TOKEN }), captured),
    );
    expect(captured.value?.scopes).toEqual([PLAY_DEVELOPER_REPORTING_SCOPE]);
  });

  it("supports multiple custom scopes", () => {
    const captured: { value?: CapturedOptions } = {};
    createGoogleAuthClient(
      fakeCredentials(),
      [PLAY_DEVELOPER_REPORTING_SCOPE, ANDROID_PUBLISHER_SCOPE],
      recordingFactory(stubClient({ token: FAKE_TOKEN }), captured),
    );
    expect(captured.value?.scopes).toEqual(
      [ANDROID_PUBLISHER_SCOPE, PLAY_DEVELOPER_REPORTING_SCOPE].sort(),
    );
  });

  it("normalizes duplicate scopes deterministically", () => {
    const captured: { value?: CapturedOptions } = {};
    createGoogleAuthClient(
      fakeCredentials(),
      [ANDROID_PUBLISHER_SCOPE, ANDROID_PUBLISHER_SCOPE, PLAY_DEVELOPER_REPORTING_SCOPE],
      recordingFactory(stubClient({ token: FAKE_TOKEN }), captured),
    );
    expect(captured.value?.scopes).toEqual(
      [ANDROID_PUBLISHER_SCOPE, PLAY_DEVELOPER_REPORTING_SCOPE].sort(),
    );
  });

  it("rejects an empty scope collection", () => {
    try {
      createGoogleAuthClient(fakeCredentials(), []);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe("INVALID_SCOPE");
    }
  });

  it("rejects blank scope strings", () => {
    for (const blank of ["", "   ", "\n\t"]) {
      try {
        createGoogleAuthClient(fakeCredentials(), [blank]);
        expect.unreachable();
      } catch (error) {
        expect((error as AuthError).code).toBe("INVALID_SCOPE");
      }
    }
  });

  it("wraps jwt construction failure in AUTH_CLIENT_CREATION_FAILED", () => {
    const badFactory: JwtFactory = () => {
      throw new Error("boom-from-library");
    };
    try {
      createGoogleAuthClient(fakeCredentials(), [ANDROID_PUBLISHER_SCOPE], badFactory);
      expect.unreachable();
    } catch (error) {
      const authError = error as AuthError;
      expect(authError.code).toBe("AUTH_CLIENT_CREATION_FAILED");
      expect(authError.message).toContain("playops-fake@example.iam.gserviceaccount.com");
      expect(authError.message).not.toContain(FAKE_PRIVATE_KEY);
      expect(authError.cause).toBeInstanceOf(Error);
    }
  });

  it("does not mutate the credentials input", () => {
    const creds = fakeCredentials();
    const snapshot = structuredClone(creds);
    createGoogleAuthClient(
      creds,
      [ANDROID_PUBLISHER_SCOPE],
      recordingFactory(stubClient({ token: FAKE_TOKEN }), {}),
    );
    expect(creds).toEqual(snapshot);
  });
});

describe("normalizeScopes", () => {
  it("sorts output deterministically regardless of input order", () => {
    const a = normalizeScopes(["b.scope", "a.scope", "c.scope"]);
    const b = normalizeScopes(["c.scope", "b.scope", "a.scope"]);
    expect(a).toEqual(b);
    expect(a).toEqual(["a.scope", "b.scope", "c.scope"]);
  });

  it("never adds scopes implicitly", () => {
    expect(normalizeScopes(["x.scope"])).toEqual(["x.scope"]);
  });
});

describe("getGoogleAccessToken", () => {
  it("returns a non-empty token on success", async () => {
    await expect(getGoogleAccessToken(stubClient({ token: FAKE_TOKEN }))).resolves.toBe(FAKE_TOKEN);
  });

  it("rejects a null token", async () => {
    await expect(getGoogleAccessToken(stubClient({ token: null }))).rejects.toMatchObject({
      name: "AuthError",
      code: "ACCESS_TOKEN_MISSING",
    });
  });

  it("rejects an undefined token", async () => {
    await expect(getGoogleAccessToken(stubClient({}))).rejects.toMatchObject({
      code: "ACCESS_TOKEN_MISSING",
    });
  });

  it("rejects an empty-string token", async () => {
    await expect(getGoogleAccessToken(stubClient({ token: "" }))).rejects.toMatchObject({
      code: "ACCESS_TOKEN_MISSING",
    });
  });

  it("wraps underlying library failure in ACCESS_TOKEN_FAILED without leaking secrets", async () => {
    const secretBearing = new Error("invalid_grant: key check failed");
    try {
      await getGoogleAccessToken(failingClient(secretBearing));
      expect.unreachable();
    } catch (error) {
      const authError = error as AuthError;
      expect(authError.code).toBe("ACCESS_TOKEN_FAILED");
      expect(authError.message).toContain("invalid_grant");
      expect(authError.message).not.toContain(FAKE_PRIVATE_KEY);
      expect(authError.message).not.toContain(FAKE_TOKEN);
      expect(authError.cause).toBe(secretBearing);
    }
  });

  it("error messages never contain the access token value", async () => {
    // Even a pathological underlying error echoing a token must not propagate
    // token material through our message beyond the library's own text.
    const cause = new Error("request failed");
    try {
      await getGoogleAccessToken(failingClient(cause));
      expect.unreachable();
    } catch (error) {
      expect((error as AuthError).message).not.toContain(FAKE_TOKEN);
    }
  });
});

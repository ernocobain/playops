/**
 * Phase 4.15 / Blocker B4 — safe structured PublisherError metadata.
 *
 * The production Google boundary must surface only allowlisted, machine-readable
 * classification. Raw messages, headers, request config, URLs, credentials,
 * tokens, response bodies, and the raw Gaxios object must never escape it.
 */
import { describe, expect, it } from "vitest";
import {
  EDIT_DELETE_POLICY,
  PublisherError,
  deleteEdit,
  getEdit,
  projectPublisherErrorMetadata,
  type AndroidPublisherClient,
} from "../src/googleplay/publisher/index.js";

const SECRETS = [
  "SECRET_TOKEN_VALUE",
  "SECRET_MESSAGE_TEXT",
  "SECRET_BODY_MARKER",
  "SECRET_URL_TOKEN",
];

function aipEnvelope(status: string, reason: string, code: number): Record<string, unknown> {
  return {
    code,
    message: SECRETS[1],
    status,
    errors: [{ domain: "androidpublisher.googleapis.com", reason, message: SECRETS[2] }],
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason }],
  };
}

function httpError(status: number, envelope: Record<string, unknown> | undefined): unknown {
  return {
    stack: "Error\n",
    message: SECRETS[1],
    cause: { message: SECRETS[1], code: status },
    config: {
      headers: { Authorization: `Bearer ${SECRETS[0]}` },
      url: { href: `https://example.invalid/x?token=${SECRETS[3]}` },
    },
    response: {
      status,
      statusText: "Synthetic",
      headers: { authorization: `Bearer ${SECRETS[0]}` },
      data: envelope ? { error: envelope } : { plain: SECRETS[2] },
    },
    code: status,
    status,
  };
}

const OBSERVED_POST_DELETE = httpError(
  400,
  aipEnvelope("FAILED_PRECONDITION", "failedPrecondition", 400),
);

describe("Phase 4.15 publisher error projection", () => {
  const cases: readonly (readonly [string, unknown, Record<string, unknown>])[] = [
    [
      "the exact observed post-delete tuple",
      OBSERVED_POST_DELETE,
      {
        status: 400,
        googleStatus: "FAILED_PRECONDITION",
        googleReasons: ["failedPrecondition"],
      },
    ],
    [
      "401",
      httpError(401, aipEnvelope("UNAUTHENTICATED", "authError", 401)),
      {
        status: 401,
        googleStatus: "UNAUTHENTICATED",
        googleReasons: ["authError"],
      },
    ],
    [
      "403",
      httpError(403, aipEnvelope("PERMISSION_DENIED", "forbidden", 403)),
      {
        status: 403,
        googleStatus: "PERMISSION_DENIED",
        googleReasons: ["forbidden"],
      },
    ],
    [
      "429",
      httpError(429, aipEnvelope("RESOURCE_EXHAUSTED", "rateLimitExceeded", 429)),
      {
        status: 429,
        googleStatus: "RESOURCE_EXHAUSTED",
        googleReasons: ["rateLimitExceeded"],
      },
    ],
    [
      "500",
      httpError(500, aipEnvelope("INTERNAL", "backendError", 500)),
      {
        status: 500,
        googleStatus: "INTERNAL",
        googleReasons: ["backendError"],
      },
    ],
  ];

  for (const [label, raw, expected] of cases) {
    it(`preserves only allowlisted fields for ${label}`, () => {
      const metadata = projectPublisherErrorMetadata(raw);
      expect(metadata).toEqual(expected);
      const serialized = JSON.stringify(metadata);
      for (const secret of SECRETS) expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("Bearer");
      expect(serialized).not.toContain("://");
      expect(serialized).not.toContain("config");
    });
  }

  it("reports a transport code only when no HTTP response exists", () => {
    expect(
      projectPublisherErrorMetadata({ message: SECRETS[1], code: "ECONNRESET", config: {} }),
    ).toEqual({ transportCode: "ECONNRESET" });
    // With a response, the numeric status is the classification; no transport code.
    expect(projectPublisherErrorMetadata({ code: "ECONNRESET", status: 503 }).status).toBe(503);
    expect(
      projectPublisherErrorMetadata({ code: "ECONNRESET", status: 503 }).transportCode,
    ).toBeUndefined();
    // A lowercase/long free-form string is never accepted as a system code.
    expect(
      projectPublisherErrorMetadata({ code: "secret_token_value" }).transportCode,
    ).toBeUndefined();
  });

  it("omits a Google status without a structured envelope", () => {
    const metadata = projectPublisherErrorMetadata(httpError(404, undefined));
    expect(metadata).toEqual({ status: 404 });
  });

  it("fails safely on malformed and hostile input", () => {
    const hostile = {
      get response(): never {
        throw new Error("hostile getter");
      },
    };
    const inputs: readonly unknown[] = [
      null,
      undefined,
      0,
      "a string",
      true,
      [],
      {},
      { response: null },
      { response: { data: { error: "not-an-object" } } },
      { response: { status: 200 } },
      { response: { status: "abc" } },
      {
        response: {
          data: {
            error: { status: "lowercase_status", errors: [null, {}, { reason: "ok_reason" }] },
          },
        },
      },
      { status: 418 },
      hostile,
    ];
    for (const input of inputs) {
      const metadata = projectPublisherErrorMetadata(input);
      expect(JSON.stringify(metadata)).not.toContain("SECRET");
      expect(Object.keys(metadata)).toEqual(
        Object.keys(metadata).filter((key) =>
          ["status", "googleStatus", "googleReasons", "transportCode"].includes(key),
        ),
      );
    }
    expect(projectPublisherErrorMetadata({ response: { status: 200 } })).toEqual({});
    expect(
      projectPublisherErrorMetadata({
        response: { data: { error: { status: "lowercase_status" } } },
      }),
    ).toEqual({});
    expect(
      projectPublisherErrorMetadata({
        response: { data: { error: { errors: [null, {}, { reason: "ok_reason" }] } } },
      }),
    ).toEqual({ googleReasons: ["ok_reason"] });
  });

  it("dedupes and caps google reasons", () => {
    const many = Array.from({ length: 25 }, (_, index) => ({ reason: `reason_${index}` }));
    const metadata = projectPublisherErrorMetadata(
      httpError(400, { code: 400, status: "FAILED_PRECONDITION", errors: many }),
    );
    expect(metadata.googleReasons).toHaveLength(10);
    const deduped = projectPublisherErrorMetadata(
      httpError(400, {
        code: 400,
        status: "FAILED_PRECONDITION",
        errors: [{ reason: "failedPrecondition" }, { reason: "failedPrecondition" }],
      }),
    );
    expect(deduped.googleReasons).toEqual(["failedPrecondition"]);
  });
});

function clientThatThrows(
  error: unknown,
  calls: { get: number; del: number },
): AndroidPublisherClient {
  return {
    version: "v3",
    reviews: {},
    edits: {
      get: async () => {
        calls.get += 1;
        throw error;
      },
      delete: async () => {
        calls.del += 1;
        throw error;
      },
    },
  } as unknown as AndroidPublisherClient;
}

const fastRetry = { sleep: async () => undefined } as const;

describe("Phase 4.15 PublisherError surfaces the metadata", () => {
  it("carries the observed tuple on the typed error, with unchanged code semantics", async () => {
    const calls = { get: 0, del: 0 };
    const client = clientThatThrows(OBSERVED_POST_DELETE, calls);
    let thrown: unknown;
    try {
      await getEdit(client, { packageName: "com.example.playops", editId: "edit-1" }, fastRetry);
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(PublisherError);
    const error = thrown as PublisherError;
    expect(error.code).toBe("API_REQUEST_FAILED");
    expect(error.reason).toBeUndefined();
    expect(error.externalStateUncertain).toBeUndefined();
    expect(error.status).toBe(400);
    expect(error.googleStatus).toBe("FAILED_PRECONDITION");
    expect(error.googleReasons).toEqual(["failedPrecondition"]);
    expect(error.transportCode).toBeUndefined();
    // The human-safe message still carries the status exactly as before.
    expect(error.message).toContain("(status 400)");
    expect(error.message).toContain("Google API request failed");
    // A read failure at 400 is not retryable: exactly one attempt.
    expect(calls.get).toBe(1);
  });

  it("never serializes the raw cause, message, header, or token", async () => {
    const client = clientThatThrows(OBSERVED_POST_DELETE, { get: 0, del: 0 });
    let error!: PublisherError;
    try {
      await getEdit(client, { packageName: "com.example.playops", editId: "edit-1" }, fastRetry);
    } catch (cause) {
      error = cause as PublisherError;
    }
    const serialized = JSON.stringify(error);
    for (const secret of SECRETS) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("config");
    expect(serialized).toContain("FAILED_PRECONDITION");
  });

  it("keeps the transport classification for a reset connection", async () => {
    const client = clientThatThrows(Object.assign(new Error(SECRETS[1]), { code: "ECONNRESET" }), {
      get: 0,
      del: 0,
    });
    let error!: PublisherError;
    try {
      await getEdit(client, { packageName: "com.example.playops", editId: "edit-1" }, fastRetry);
    } catch (cause) {
      error = cause as PublisherError;
    }
    // ECONNRESET is retryable for a read, so the bounded read retry runs to exhaustion.
    expect(error.transportCode).toBe("ECONNRESET");
    expect(error.status).toBeUndefined();
    expect(error.message).not.toContain("(status");
  });
});

describe("Phase 4.15 delete policy and retry semantics are unchanged", () => {
  it("declares exactly one delete attempt with retry disabled", () => {
    expect(EDIT_DELETE_POLICY).toEqual({ attempts: 1, retry: false });
  });

  it("never retries a delete and surfaces its metadata", async () => {
    const calls = { get: 0, del: 0 };
    const client = clientThatThrows(OBSERVED_POST_DELETE, calls);
    let error!: PublisherError;
    try {
      await deleteEdit(client, { packageName: "com.example.playops", editId: "edit-1" });
    } catch (cause) {
      error = cause as PublisherError;
    }
    expect(calls.del).toBe(1);
    expect(error.code).toBe("API_REQUEST_FAILED");
    expect(error.externalStateUncertain).toBe(true);
    expect(error.status).toBe(400);
    expect(error.googleStatus).toBe("FAILED_PRECONDITION");
  });

  it("still applies the bounded read retry to a retryable read status", async () => {
    const calls = { get: 0, del: 0 };
    const client = clientThatThrows(
      httpError(500, aipEnvelope("INTERNAL", "backendError", 500)),
      calls,
    );
    await expect(
      getEdit(client, { packageName: "com.example.playops", editId: "edit-1" }, fastRetry),
    ).rejects.toMatchObject({ code: "API_REQUEST_FAILED", status: 500 });
    expect(calls.get).toBe(3);
  });
});

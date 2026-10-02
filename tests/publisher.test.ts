/**
 * Phase 1.2 — Android Publisher client wrapper unit tests.
 *
 * No network, no real credentials. Only the official Google client boundary
 * (PublisherClientFactory / ReviewsResourceLike) is faked; PlayOps input
 * validation and result normalization are exercised for real.
 */
import { describe, expect, it } from "vitest";
import type { GoogleAuthClient } from "../src/googleplay/auth/index.js";
import {
  createAndroidPublisherClient,
  getReview,
  listReviews,
  type AndroidPublisherClient,
  type PublisherClientFactory,
  type PublisherError,
  type ReviewsResourceLike,
} from "../src/googleplay/publisher/index.js";

const FAKE_TOKEN = "ya29.fake-token-1.2";
const FAKE_KEY = "-----BEGIN PRIVATE KEY-----\nFAKE-KEY-1.2\n-----END PRIVATE KEY-----\n";

const fakeAuth: GoogleAuthClient = {
  getAccessToken: () => Promise.resolve({ token: FAKE_TOKEN }),
};

interface ListCall {
  packageName: string;
  maxResults?: number;
  token?: string;
  translationLanguage?: string;
}

interface GetCall {
  packageName: string;
  reviewId: string;
  translationLanguage?: string;
}

interface FakeReviews {
  calls: { list: ListCall[]; get: GetCall[] };
  listResponse: { data: unknown };
  getResponse: { data: unknown };
  failOn?: "list" | "get";
  failure?: unknown;
}

function fakeReviews(partial: Partial<FakeReviews> = {}): FakeReviews {
  return {
    calls: { list: [], get: [] },
    listResponse: { data: { reviews: [] } },
    getResponse: { data: { reviewId: "rev-1", authorName: "A" } },
    ...partial,
  };
}

function clientWith(reviews: FakeReviews): AndroidPublisherClient {
  const resource: ReviewsResourceLike = {
    list: (params) => {
      reviews.calls.list.push(params);
      if (reviews.failOn === "list") return Promise.reject(reviews.failure);
      return Promise.resolve(
        reviews.listResponse as Awaited<ReturnType<ReviewsResourceLike["list"]>>,
      );
    },
    get: (params) => {
      reviews.calls.get.push(params);
      if (reviews.failOn === "get") return Promise.reject(reviews.failure);
      return Promise.resolve(
        reviews.getResponse as Awaited<ReturnType<ReviewsResourceLike["get"]>>,
      );
    },
    reply: () => Promise.reject(new Error("Phase 1.2 read-only fake cannot publish")),
  };
  return { version: "v3", reviews: resource };
}

describe("createAndroidPublisherClient", () => {
  it("passes the Phase 1.1 auth client into a v3 publisher client", () => {
    const captured: { value?: { version: string; auth: unknown; retry: boolean } } = {};
    const factory: PublisherClientFactory = (options) => {
      captured.value = options;
      return clientWith(fakeReviews());
    };

    const client = createAndroidPublisherClient(fakeAuth, factory);

    expect(captured.value?.version).toBe("v3");
    expect(captured.value?.auth).toBe(fakeAuth);
    expect(captured.value?.retry).toBe(false);
    expect(client.version).toBe("v3");
  });
});

describe("listReviews", () => {
  it("retries a transient 429 once and returns the existing result shape", async () => {
    const client = clientWith(fakeReviews());
    let calls = 0;
    const retrySettings: unknown[] = [];
    client.reviews.list = (_params, options) => {
      retrySettings.push(options);
      return ++calls === 1
        ? Promise.reject(Object.assign(new Error("throttled"), { status: 429 }))
        : Promise.resolve({ data: { reviews: [{ reviewId: "r1" }] } });
    };
    const result = await listReviews(
      client,
      { packageName: "com.example.app" },
      { sleep: () => Promise.resolve(), random: () => 1 },
    );
    expect(calls).toBe(2);
    expect(retrySettings).toEqual([{ retry: false }, { retry: false }]);
    expect(result).toEqual({ reviews: [{ reviewId: "r1" }] });
  });

  it("calls reviews.list with the package name", async () => {
    const reviews = fakeReviews({
      listResponse: { data: { reviews: [{ reviewId: "r1" }] } },
    });
    const client = clientWith(reviews);

    const result = await listReviews(client, { packageName: "com.example.app" });

    expect(reviews.calls.list).toEqual([{ packageName: "com.example.app" }]);
    expect(result.reviews).toEqual([{ reviewId: "r1" }]);
    expect(result.nextPageToken).toBeUndefined();
  });

  it("propagates maxResults, token, and translationLanguage", async () => {
    const reviews = fakeReviews();
    const client = clientWith(reviews);

    await listReviews(client, {
      packageName: "com.example.app",
      maxResults: 25,
      pageToken: "page-2",
      translationLanguage: "id",
    });

    expect(reviews.calls.list).toEqual([
      {
        packageName: "com.example.app",
        maxResults: 25,
        token: "page-2",
        translationLanguage: "id",
      },
    ]);
  });

  it("normalizes nextPageToken from tokenPagination", async () => {
    const reviews = fakeReviews({
      listResponse: {
        data: {
          reviews: [{ reviewId: "r1" }, { reviewId: "r2" }],
          tokenPagination: { nextPageToken: "NEXT", previousPageToken: "PREV" },
        },
      },
    });
    const result = await listReviews(clientWith(reviews), { packageName: "com.example.app" });

    expect(result.reviews).toHaveLength(2);
    expect(result.nextPageToken).toBe("NEXT");
  });

  it("returns a predictable empty array when reviews is absent", async () => {
    const reviews = fakeReviews({ listResponse: { data: {} } });
    const result = await listReviews(clientWith(reviews), { packageName: "com.example.app" });
    expect(result.reviews).toEqual([]);
    expect(result.nextPageToken).toBeUndefined();
  });

  it("omits nextPageToken when it is empty", async () => {
    const reviews = fakeReviews({
      listResponse: { data: { reviews: [], tokenPagination: { nextPageToken: "" } } },
    });
    const result = await listReviews(clientWith(reviews), { packageName: "com.example.app" });
    expect(result.nextPageToken).toBeUndefined();
  });

  it("rejects blank packageName", async () => {
    const client = clientWith(fakeReviews());
    for (const bad of ["", "   "]) {
      await expect(listReviews(client, { packageName: bad })).rejects.toMatchObject({
        name: "PublisherError",
        code: "INVALID_ARGUMENT",
      });
    }
  });

  it("rejects invalid maxResults", async () => {
    const client = clientWith(fakeReviews());
    for (const bad of [0, -3, 2.5, Number.NaN]) {
      await expect(
        listReviews(client, { packageName: "com.example.app", maxResults: bad }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
  });

  it("rejects blank pageToken and blank translationLanguage", async () => {
    const client = clientWith(fakeReviews());
    await expect(
      listReviews(client, { packageName: "com.example.app", pageToken: " " }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      listReviews(client, { packageName: "com.example.app", translationLanguage: "" }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("wraps Google client failure in PublisherError with status, without secrets", async () => {
    const failure = Object.assign(new Error("backend exploded"), { code: 503 });
    const reviews = fakeReviews({ failOn: "list", failure });
    const client = clientWith(reviews);

    try {
      await listReviews(
        client,
        { packageName: "com.example.app" },
        { sleep: () => Promise.resolve() },
      );
      expect.unreachable();
    } catch (error) {
      const pubError = error as PublisherError;
      expect(pubError.code).toBe("API_REQUEST_FAILED");
      expect(pubError.message).toContain("reviews.list");
      expect(pubError.message).toContain("com.example.app");
      expect(pubError.message).toContain("503");
      expect(pubError.message).not.toContain(FAKE_TOKEN);
      expect(pubError.message).not.toContain(FAKE_KEY);
      expect(pubError.message).not.toContain("Authorization");
      expect(pubError.cause).toBe(failure);
    }
  });

  it("throws INVALID_RESPONSE when the payload shape is wrong", async () => {
    const reviews = fakeReviews({ listResponse: { data: { reviews: "not-an-array" } } });
    await expect(
      listReviews(clientWith(reviews), { packageName: "com.example.app" }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(reviews.calls.list).toHaveLength(1);
  });

  it("keeps the last cause but never copies its secret-bearing text into a domain error", async () => {
    const secret = "FAKE-PRIVATE-KEY-SHOULD-NOT-APPEAR";
    const failure = Object.assign(new Error(`private_key: ${secret}`), {
      code: 503,
      config: { headers: { Authorization: secret } },
    });
    const reviews = fakeReviews({ failOn: "list", failure });
    try {
      await listReviews(
        clientWith(reviews),
        { packageName: "com.example.app" },
        { sleep: () => Promise.resolve() },
      );
      expect.unreachable();
    } catch (error) {
      const wrapped = error as PublisherError;
      expect(wrapped.code).toBe("API_REQUEST_FAILED");
      expect(wrapped.cause).toBe(failure);
      expect(wrapped.message).toContain("503");
      expect(wrapped.message).not.toContain(secret);
      expect(JSON.stringify(wrapped)).not.toContain(secret);
    }
    expect(reviews.calls.list).toHaveLength(3);
  });
});

describe("getReview", () => {
  it("retries a transient 503 then returns the same review shape", async () => {
    const client = clientWith(fakeReviews());
    let calls = 0;
    const retrySettings: unknown[] = [];
    client.reviews.get = (_params, options) => {
      retrySettings.push(options);
      return ++calls === 1
        ? Promise.reject(Object.assign(new Error("temporary"), { code: 503 }))
        : Promise.resolve({ data: { reviewId: "rev-9" } });
    };
    const review = await getReview(
      client,
      { packageName: "com.example.app", reviewId: "rev-9" },
      { sleep: () => Promise.resolve() },
    );
    expect(calls).toBe(2);
    expect(retrySettings).toEqual([{ retry: false }, { retry: false }]);
    expect(review).toEqual({ reviewId: "rev-9" });
  });

  it("calls reviews.get with package name and review id", async () => {
    const reviews = fakeReviews({
      getResponse: { data: { reviewId: "rev-9", authorName: "Budi" } },
    });
    const client = clientWith(reviews);

    const review = await getReview(client, {
      packageName: "com.example.app",
      reviewId: "rev-9",
      translationLanguage: "id",
    });

    expect(reviews.calls.get).toEqual([
      { packageName: "com.example.app", reviewId: "rev-9", translationLanguage: "id" },
    ]);
    expect(review.reviewId).toBe("rev-9");
    expect(review.authorName).toBe("Budi");
  });

  it("rejects blank packageName and blank reviewId", async () => {
    const client = clientWith(fakeReviews());
    await expect(getReview(client, { packageName: "", reviewId: "r" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      getReview(client, { packageName: "com.example.app", reviewId: "  " }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("wraps Google client failure in PublisherError without secrets", async () => {
    const failure = Object.assign(new Error("not found"), { code: 404 });
    const client = clientWith(fakeReviews({ failOn: "get", failure }));

    try {
      await getReview(client, { packageName: "com.example.app", reviewId: "rev-x" });
      expect.unreachable();
    } catch (error) {
      const pubError = error as PublisherError;
      expect(pubError.code).toBe("API_REQUEST_FAILED");
      expect(pubError.message).toContain("reviews.get");
      expect(pubError.message).toContain("rev-x");
      expect(pubError.message).toContain("404");
      expect(pubError.message).not.toContain(FAKE_TOKEN);
      expect(pubError.message).not.toContain(FAKE_KEY);
    }
  });

  it("throws INVALID_RESPONSE when the payload is not an object", async () => {
    const client = clientWith(fakeReviews({ getResponse: { data: [1, 2] } }));
    await expect(
      getReview(client, { packageName: "com.example.app", reviewId: "rev-1" }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

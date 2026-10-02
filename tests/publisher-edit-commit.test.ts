import { describe, expect, it } from "vitest";
import {
  commitEdit,
  type AndroidPublisherClient,
  type EditsResourceLike,
  type ReviewsResourceLike,
} from "../src/googleplay/publisher/index.js";

interface Call {
  readonly params: unknown;
  readonly options: unknown;
}

function fakePublisher(
  options: {
    readonly responses?: readonly unknown[];
    readonly calls?: Call[];
  } = {},
): AndroidPublisherClient {
  const responses = [...(options.responses ?? [{ id: "edit-7", expiryTimeSeconds: "1900000000" }])];
  const calls = options.calls ?? [];
  const take = (): { data: unknown } => {
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return { data: value };
  };
  const edits: EditsResourceLike = {
    insert: async () => ({ data: { id: "unused", expiryTimeSeconds: "1900000000" } }),
    get: async () => ({ data: { id: "edit-7", expiryTimeSeconds: "1900000000" } }),
    commit: async (params, requestOptions) => {
      calls.push({ params, options: requestOptions });
      return take();
    },
    tracks: {
      list: async () => ({ data: { tracks: [] } }),
      get: async () => ({ data: { track: "production", releases: [] } }),
      update: async (params) => ({ data: { track: params.track, releases: [] } }),
    },
    bundles: {
      list: async () => ({ data: { bundles: [] } }),
      upload: async () => ({ data: { versionCode: 101, sha256: "a".repeat(64) } }),
    },
  };
  const reviews = {} as ReviewsResourceLike;
  return { version: "v3", reviews, edits };
}

describe("Publisher edits.commit wrapper", () => {
  it("forwards exact policy/path parameters, no body, and retry:false", async () => {
    const calls: Call[] = [];
    const result = await commitEdit(fakePublisher({ calls }), {
      packageName: "com.example.app",
      editId: "edit-7",
      changesInReviewBehavior: "ERROR_IF_IN_REVIEW",
      changesNotSentForReview: false,
    });

    expect(calls).toEqual([
      {
        params: {
          packageName: "com.example.app",
          editId: "edit-7",
          changesInReviewBehavior: "ERROR_IF_IN_REVIEW",
          changesNotSentForReview: false,
        },
        options: { retry: false },
      },
    ]);
    expect(result).toEqual({ id: "edit-7", expiryTimeSeconds: "1900000000" });
  });

  it.each([
    undefined,
    null,
    {},
    { id: "" },
    { id: "edit-7" },
    { id: "edit-7", expiryTimeSeconds: "bad" },
  ])("rejects malformed commit response %j without retry", async (response) => {
    const calls: Call[] = [];
    await expect(
      commitEdit(fakePublisher({ calls, responses: [response] }), {
        packageName: "com.example.app",
        editId: "edit-7",
        changesInReviewBehavior: "ERROR_IF_IN_REVIEW",
        changesNotSentForReview: false,
      }),
    ).rejects.toMatchObject({ name: "PublisherError", code: "INVALID_RESPONSE" });
    expect(calls).toHaveLength(1);
  });

  it("rejects a mismatched edit identity without retry", async () => {
    const calls: Call[] = [];
    await expect(
      commitEdit(
        fakePublisher({
          calls,
          responses: [{ id: "edit-other", expiryTimeSeconds: "1900000000" }],
        }),
        {
          packageName: "com.example.app",
          editId: "edit-7",
          changesInReviewBehavior: "ERROR_IF_IN_REVIEW",
          changesNotSentForReview: false,
        },
      ),
    ).rejects.toMatchObject({
      name: "PublisherError",
      code: "INVALID_RESPONSE",
      reason: "EDIT_IDENTITY_MISMATCH",
      externalStateUncertain: true,
    });
    expect(calls).toHaveLength(1);
  });

  it("maps structured changes-already-in-review rejection as explicit and certain", async () => {
    const failure = Object.assign(new Error("PRIVATE-DIAGNOSTIC"), {
      response: {
        status: 400,
        data: { error: { errors: [{ reason: "changesAlreadyInReview" }] } },
      },
    });
    const calls: Call[] = [];
    await expect(
      commitEdit(fakePublisher({ calls, responses: [failure] }), {
        packageName: "com.example.app",
        editId: "edit-7",
        changesInReviewBehavior: "ERROR_IF_IN_REVIEW",
        changesNotSentForReview: false,
      }),
    ).rejects.toMatchObject({
      name: "PublisherError",
      code: "API_REQUEST_FAILED",
      reason: "CHANGES_ALREADY_IN_REVIEW",
      externalStateUncertain: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("marks generic explicit 400 rejection certain and never retries", async () => {
    const failure = Object.assign(new Error("PRIVATE-400"), { status: 400 });
    const calls: Call[] = [];
    await expect(
      commitEdit(fakePublisher({ calls, responses: [failure] }), {
        packageName: "com.example.app",
        editId: "edit-7",
        changesInReviewBehavior: "ERROR_IF_IN_REVIEW",
        changesNotSentForReview: false,
      }),
    ).rejects.toMatchObject({
      name: "PublisherError",
      code: "API_REQUEST_FAILED",
      externalStateUncertain: false,
    });
    expect(calls).toHaveLength(1);
  });

  it.each([
    Object.assign(new Error("PRIVATE-500"), { status: 500 }),
    Object.assign(new Error("PRIVATE-TIMEOUT"), { code: "ETIMEDOUT" }),
    Object.assign(new Error("PRIVATE-RESET"), { code: "ECONNRESET" }),
  ])("marks ambiguous commit failure uncertain and never retries", async (failure) => {
    const calls: Call[] = [];
    await expect(
      commitEdit(fakePublisher({ calls, responses: [failure] }), {
        packageName: "com.example.app",
        editId: "edit-7",
        changesInReviewBehavior: "ERROR_IF_IN_REVIEW",
        changesNotSentForReview: false,
      }),
    ).rejects.toMatchObject({
      name: "PublisherError",
      code: "API_REQUEST_FAILED",
      externalStateUncertain: true,
    });
    expect(calls).toHaveLength(1);
  });
});

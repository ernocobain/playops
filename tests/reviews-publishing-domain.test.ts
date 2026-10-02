import { describe, expect, it, vi } from "vitest";
import {
  normalizeReviewReplyRemoteState,
  publishReviewReply,
  verifyPublishedReviewReply,
  type ReviewReplyGateway,
  type ReviewReplyPublishInput,
  type ReviewReplyRemoteState,
} from "../src/reviews/publishing/index.js";

const userTime = { seconds: "1700000000", nanos: 123 };
const oldReplyTime = { seconds: "1700000001", nanos: 2 };
const appliedTime = { seconds: "1700000002", nanos: 0 };
const input: ReviewReplyPublishInput = {
  reviewId: "review-one",
  replyText: "Thank you for your feedback.",
  expectedUserLastModified: userTime,
  expectedDeveloperReplyLastModified: null,
};
const remote: ReviewReplyRemoteState = { reviewId: input.reviewId, userLastModified: userTime };
function gateway(pre: ReviewReplyRemoteState = remote, post?: ReviewReplyRemoteState) {
  const sequence = [
    pre,
    post ?? { ...pre, developerReply: { text: input.replyText, lastModified: appliedTime } },
  ];
  const order: string[] = [];
  const getReviewState = vi.fn(async () => {
    order.push("GET");
    return sequence.shift() ?? pre;
  });
  const publishReply = vi.fn(async () => {
    order.push("POST");
    return { replyText: input.replyText, lastEdited: appliedTime };
  });
  return {
    gateway: { getReviewState, publishReply } as ReviewReplyGateway,
    getReviewState,
    publishReply,
    order,
  };
}

describe("normalizeReviewReplyRemoteState", () => {
  it("searches comments regardless of order and returns only minimal PlayOps state", () => {
    const raw = {
      reviewId: "review-one",
      authorName: "PRIVATE-AUTHOR",
      deviceMetadata: "PRIVATE-DEVICE",
      comments: [
        { developerComment: { text: "prior", lastModified: oldReplyTime } },
        { userComment: { text: "PRIVATE-REVIEW", lastModified: userTime } },
      ],
    };
    const state = normalizeReviewReplyRemoteState(raw, "review-one");
    expect(state).toEqual({
      reviewId: "review-one",
      userLastModified: userTime,
      developerReply: { text: "prior", lastModified: oldReplyTime },
    });
    expect(JSON.stringify(state)).not.toMatch(/PRIVATE-/);
  });
  it("supports no prior developer reply, rejects malformed critical data and ambiguous comments", () => {
    expect(
      normalizeReviewReplyRemoteState(
        { reviewId: "r", comments: [{ userComment: { lastModified: userTime } }] },
        "r",
      ),
    ).toEqual({ reviewId: "r", userLastModified: userTime });
    for (const raw of [
      { reviewId: "other", comments: [{ userComment: { lastModified: userTime } }] },
      { reviewId: "r", comments: [{ userComment: { lastModified: { seconds: "broken" } } }] },
      {
        reviewId: "r",
        comments: [
          { userComment: { lastModified: userTime } },
          { developerComment: { text: "x", lastModified: {} } },
        ],
      },
      {
        reviewId: "r",
        comments: [
          { userComment: { lastModified: userTime } },
          { userComment: { lastModified: userTime } },
        ],
      },
    ])
      expect(() => normalizeReviewReplyRemoteState(raw, "r")).toThrowError(
        expect.objectContaining({ code: "REMOTE_DATA_INVALID" }),
      );
  });
});

describe("publishReviewReply optimistic check and one POST", () => {
  it("preflight GET → one POST; leaves response in an owned frozen shape", async () => {
    const g = gateway();
    const out = await publishReviewReply(g.gateway, input);
    expect(g.order).toEqual(["GET", "POST"]);
    expect(g.publishReply).toHaveBeenCalledWith(input.reviewId, input.replyText);
    expect(out).toEqual({
      reviewId: input.reviewId,
      replyText: input.replyText,
      lastEdited: appliedTime,
    });
    expect(Object.isFrozen(out)).toBe(true);
  });
  it("blocks stale user review before POST, comparing nanos losslessly", async () => {
    const g = gateway({ ...remote, userLastModified: { ...userTime, nanos: 124 } });
    await expect(publishReviewReply(g.gateway, input)).rejects.toMatchObject({
      code: "REVIEW_CHANGED",
    });
    expect(g.publishReply).not.toHaveBeenCalled();
  });
  it("blocks unexpected prior developer reply and changed or missing existing reply", async () => {
    const old = { text: "old", lastModified: oldReplyTime };
    const g = gateway({ ...remote, developerReply: old });
    await expect(publishReviewReply(g.gateway, input)).rejects.toMatchObject({
      code: "DEVELOPER_REPLY_CHANGED",
    });
    expect(g.publishReply).not.toHaveBeenCalled();
    for (const state of [
      remote,
      { ...remote, developerReply: { text: "new", lastModified: { ...oldReplyTime, nanos: 3 } } },
    ]) {
      const next = gateway(state);
      await expect(
        publishReviewReply(next.gateway, {
          ...input,
          expectedDeveloperReplyLastModified: oldReplyTime,
        }),
      ).rejects.toMatchObject({ code: "DEVELOPER_REPLY_CHANGED" });
      expect(next.publishReply).not.toHaveBeenCalled();
    }
    const matching = gateway({ ...remote, developerReply: old });
    await expect(
      publishReviewReply(matching.gateway, {
        ...input,
        expectedDeveloperReplyLastModified: oldReplyTime,
      }),
    ).resolves.toMatchObject({ replyText: input.replyText });
  });
  it("rejects invalid arguments before GET/POST; never normalizes approved text silently", async () => {
    const g = gateway();
    for (const change of [
      { reviewId: " " },
      { replyText: "  changed  " },
      { replyText: "x".repeat(351) },
      { expectedUserLastModified: { seconds: "nan", nanos: 0 } },
      { expectedDeveloperReplyLastModified: undefined },
    ])
      await expect(
        publishReviewReply(g.gateway, { ...input, ...change } as ReviewReplyPublishInput),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(g.getReviewState).not.toHaveBeenCalled();
    expect(g.publishReply).not.toHaveBeenCalled();
  });
  it("wraps read and publish failures with fixed messages and preserves causes", async () => {
    const secret = new Error("RAW-SECRET-ERROR");
    const before = gateway();
    before.getReviewState.mockRejectedValue(secret);
    await expect(publishReviewReply(before.gateway, input)).rejects.toMatchObject({
      code: "READ_FAILED",
      cause: secret,
    });
    expect(before.publishReply).not.toHaveBeenCalled();
    const after = gateway();
    after.publishReply.mockRejectedValue(secret);
    let error: unknown;
    try {
      await publishReviewReply(after.gateway, input);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ code: "PUBLISH_FAILED", cause: secret });
    expect(String(error)).not.toContain("RAW-SECRET-ERROR");
    expect(after.publishReply).toHaveBeenCalledOnce();
  });
  it("rejects changed/malformed POST response without retry or pretending no mutation", async () => {
    const g = gateway();
    g.publishReply.mockResolvedValue({ replyText: "not what was asked", lastEdited: appliedTime });
    await expect(publishReviewReply(g.gateway, input)).rejects.toMatchObject({
      code: "PUBLISH_RESPONSE_INVALID",
    });
    expect(g.publishReply).toHaveBeenCalledOnce();
  });
});

describe("read-back verifier", () => {
  const output = { reviewId: input.reviewId, replyText: input.replyText, lastEdited: appliedTime };
  it("actually GETs and accepts exact reply with equal or newer timestamp", async () => {
    for (const ts of [appliedTime, { ...appliedTime, nanos: 1 }]) {
      const g = gateway({ ...remote, developerReply: { text: input.replyText, lastModified: ts } });
      expect(await verifyPublishedReviewReply(g.gateway, input, output)).toBe(true);
      expect(g.getReviewState).toHaveBeenCalledOnce();
    }
  });
  it("fails closed on missing/wrong/older reply, changed user, mismatched ID, or read failure", async () => {
    const invalidStates: ReviewReplyRemoteState[] = [
      remote,
      { ...remote, developerReply: { text: "other", lastModified: appliedTime } },
      { ...remote, developerReply: { text: input.replyText, lastModified: oldReplyTime } },
      {
        ...remote,
        userLastModified: { seconds: "1700000001", nanos: 123 },
        developerReply: { text: input.replyText, lastModified: appliedTime },
      },
      {
        ...remote,
        reviewId: "other",
        developerReply: { text: input.replyText, lastModified: appliedTime },
      },
    ];
    for (const s of invalidStates)
      expect(await verifyPublishedReviewReply(gateway(s).gateway, input, output)).toBe(false);
    const g = gateway();
    g.getReviewState.mockRejectedValue(new Error("RAW-SECRET"));
    expect(await verifyPublishedReviewReply(g.gateway, input, output)).toBe(false);
  });
});

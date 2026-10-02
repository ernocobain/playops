import { describe, expect, it, vi } from "vitest";
import type { AndroidPublisherClient } from "../src/googleplay/publisher/index.js";
import { createAndroidPublisherReplyGateway } from "../src/reviews/publishing/androidpublisher.js";

const userTime = { seconds: "1700000000", nanos: 0 };
const replyTime = { seconds: "1700000002", nanos: 1 };

function fakeClient(
  raw: unknown = { reviewId: "r1", comments: [{ userComment: { lastModified: userTime } }] },
) {
  const get = vi.fn(async () => ({ data: raw }));
  const reply = vi.fn(async (): Promise<{ data: unknown }> => ({
    data: { result: { replyText: "Safe reply", lastEdited: replyTime } },
  }));
  return {
    client: { version: "v3", reviews: { get, reply } } as unknown as AndroidPublisherClient,
    get,
    reply,
  };
}

describe("Android Publisher production reply gateway (fake generated client only)", () => {
  it("delegates to the existing getReview and replyToReview wrappers with bound package; no raw Google data escapes", async () => {
    const f = fakeClient({
      reviewId: "r1",
      authorName: "PRIVATE-AUTHOR",
      comments: [{ userComment: { text: "PRIVATE-TEXT", lastModified: userTime } }],
    });
    const g = createAndroidPublisherReplyGateway(f.client, "com.example.fake");
    const state = await g.getReviewState("r1");
    expect(state).toEqual({ reviewId: "r1", userLastModified: userTime });
    expect(JSON.stringify(state)).not.toMatch(/PRIVATE-/);
    expect(f.get).toHaveBeenCalledWith(
      { packageName: "com.example.fake", reviewId: "r1" },
      { retry: false },
    );
    const applied = await g.publishReply("r1", "Safe reply");
    expect(applied).toEqual({ replyText: "Safe reply", lastEdited: replyTime });
    expect(f.reply).toHaveBeenCalledWith(
      { packageName: "com.example.fake", reviewId: "r1", requestBody: { replyText: "Safe reply" } },
      { retry: false },
    );
  });
  it("rejects invalid package before requests and maps malformed mutation response to uncertain result", async () => {
    const f = fakeClient();
    expect(() => createAndroidPublisherReplyGateway(f.client, " ")).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
    expect(f.get).not.toHaveBeenCalled();
    expect(f.reply).not.toHaveBeenCalled();
    f.reply.mockResolvedValue({ data: {} });
    const g = createAndroidPublisherReplyGateway(f.client, "com.example.fake");
    await expect(g.publishReply("r1", "Safe reply")).rejects.toMatchObject({
      code: "PUBLISH_RESPONSE_INVALID",
    });
    expect(f.reply).toHaveBeenCalledOnce();
  });
});

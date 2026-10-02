import { describe, expect, it, vi } from "vitest";
import type { GoogleAuthClient } from "../src/googleplay/auth/index.js";
import {
  createAndroidPublisherClient,
  replyToReview,
  type AndroidPublisherClient,
  type PublisherError,
} from "../src/googleplay/publisher/index.js";

const input = {
  packageName: "com.example.fake",
  reviewId: "review-one",
  replyText: "Thank you for your feedback.",
};
const timestamp = { seconds: "1770000000", nanos: 123 };

function stub(data: unknown) {
  const reply = vi.fn(async () => ({ data }));
  const client = { version: "v3", reviews: { reply } } as unknown as AndroidPublisherClient;
  return { client, reply };
}

describe("reviews.reply narrow Publisher wrapper", () => {
  it("forwards exactly one POST to the existing client, disables generated retry and normalizes result", async () => {
    const { client, reply } = stub({
      result: { replyText: input.replyText, lastEdited: timestamp },
    });
    const output = await replyToReview(client, input);
    expect(reply).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith(
      {
        packageName: input.packageName,
        reviewId: input.reviewId,
        requestBody: { replyText: input.replyText },
      },
      { retry: false },
    );
    expect(output).toEqual({ replyText: input.replyText, lastEdited: timestamp });
    expect(Object.isFrozen(output)).toBe(true);
  });

  it("rejects malformed or altered response after one mutation; does not claim it never happened", async () => {
    for (const data of [
      {},
      null,
      { result: {} },
      { result: { replyText: "altered", lastEdited: timestamp } },
      { result: { replyText: input.replyText, lastEdited: { seconds: "bad" } } },
    ]) {
      const { client, reply } = stub(data);
      await expect(replyToReview(client, input)).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
      });
      expect(reply).toHaveBeenCalledOnce();
    }
  });

  it("rejects malformed direct input without touching the generated client", async () => {
    const { client, reply } = stub({});
    await expect(
      replyToReview(client, undefined as unknown as Parameters<typeof replyToReview>[1]),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      replyToReview(client, { ...input, replyText: 100 as unknown as string }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(reply).not.toHaveBeenCalled();
  });

  it("rejects blank ids and invalid or normalizable (not exact) reply text before POST", async () => {
    const { client, reply } = stub({});
    for (const override of [
      { packageName: " " },
      { reviewId: " " },
      { replyText: "" },
      { replyText: "  reply  " },
      { replyText: "x".repeat(351) },
      { replyText: "<b>markup</b>" },
      { replyText: "nul\u0000" },
    ]) {
      await expect(replyToReview(client, { ...input, ...override })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }
    expect(reply).not.toHaveBeenCalled();
  });

  it.each([{ status: 429 }, { status: 500 }, { code: "ECONNRESET" }])(
    "never retries ambiguous transport failure %j and redacts its message",
    async (status) => {
      const raw = Object.assign(new Error("RAW-TRANSPORT-SECRET-DO-NOT-LOG"), status);
      const reply = vi.fn(async () => {
        throw raw;
      });
      const client = { version: "v3", reviews: { reply } } as unknown as AndroidPublisherClient;
      let captured: PublisherError | undefined;
      try {
        await replyToReview(client, input);
      } catch (error) {
        captured = error as PublisherError;
      }
      expect(captured).toMatchObject({ code: "API_REQUEST_FAILED", cause: raw });
      expect(captured?.message).not.toContain("RAW-TRANSPORT-SECRET");
      expect(JSON.stringify(captured)).not.toContain("RAW-TRANSPORT-SECRET");
      expect(reply).toHaveBeenCalledOnce();
      expect(reply).toHaveBeenCalledWith(expect.any(Object), { retry: false });
    },
  );

  it("turns off constructor AND generated per-request retry for actual POST using fake transport", async () => {
    const requests: { retry?: boolean; method?: string }[] = [];
    const fakeAuth = {
      getAccessToken: () => Promise.resolve({ token: "FAKE-TOKEN" }),
      request: (options: { retry?: boolean; method?: string }) => {
        requests.push({ retry: options.retry, method: options.method });
        return Promise.reject(Object.assign(new Error("fake failure"), { status: 429 }));
      },
    } as GoogleAuthClient;
    const client = createAndroidPublisherClient(fakeAuth);
    await expect(replyToReview(client, input)).rejects.toMatchObject({
      code: "API_REQUEST_FAILED",
    });
    expect(requests).toEqual([{ retry: false, method: "POST" }]);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type PlayOpsConfig } from "../src/config/index.js";
import type { ServiceAccountCredentials } from "../src/config/index.js";
import type { GoogleAuthClient } from "../src/googleplay/auth/index.js";
import type { AndroidPublisherClient } from "../src/googleplay/publisher/index.js";
import type { LlmAdapter } from "../src/runtime/llm/index.js";
import {
  createLiveReviewComposition,
  createReviewComposition,
} from "../src/reviews/composition.js";

const pkg = "com.example.fake";
let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const raw = {
  reviewId: "r1",
  comments: [{ userComment: { lastModified: { seconds: "10", nanos: 9 }, text: "crash" } }],
};
function config(): PlayOpsConfig {
  dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "playops-composition-"));
  return {
    ...DEFAULT_CONFIG,
    googlePlay: { packageName: pkg, serviceAccountJson: "FAKE-LOCATION" },
    audit: { logPath: join(dir, "audit.jsonl") },
    review: { checkpointPath: join(dir, "reviews.checkpoint.json") },
    llm: { nineRouter: { baseUrl: "http://127.0.0.1:20128/v1", model: "fake-model" } },
  };
}
function fakeClient() {
  const list = vi.fn(async () => ({ data: { reviews: [raw] } }));
  const get = vi.fn(async () => ({ data: raw }));
  const reply = vi.fn(async () => ({
    data: { result: { replyText: "Thank you.", lastEdited: { seconds: "11", nanos: 0 } } },
  }));
  return {
    client: { version: "v3", reviews: { list, get, reply } } as AndroidPublisherClient,
    list,
    get,
    reply,
  };
}
const llm: LlmAdapter = {
  provider: "fake-domain-only",
  complete: vi.fn(async () => ({ content: "not used here", toolCalls: [] })),
};

describe("review composition root (fake boundaries only)", () => {
  it("builds the four existing tools around one Publisher client and one domain LLM", async () => {
    const f = fakeClient();
    const c = createReviewComposition(config(), { publisher: f.client, llm });
    expect(c.registry.list().map((tool) => [tool.name, tool.permission])).toEqual([
      ["reviews.ingest", "write"],
      ["reviews.classify", "read"],
      ["reviews.draft_reply", "read"],
      ["reviews.publish_reply", "publish"],
    ]);
    expect(c.bindings.map((binding) => binding.toolName)).toEqual(
      c.registry.list().map((tool) => tool.name),
    );
    const page = await c.source.listReviews({ packageName: pkg, maxResults: 100 });
    expect(page.reviews).toHaveLength(1);
    const current = await c.getCurrentReview("r1");
    expect(current.review.reviewId).toBe("r1");
    expect(current.review.text).toBe("crash");
    expect(current.state.userLastModified).toEqual({ seconds: "10", nanos: 9 });
    expect(f.list).toHaveBeenCalledWith({ packageName: pkg, maxResults: 100 }, { retry: false });
    expect(f.get).toHaveBeenCalledWith({ packageName: pkg, reviewId: "r1" }, { retry: false });
    expect(f.reply).not.toHaveBeenCalled();
  });
  it("rejects mismatched and malformed fresh review without drafting or publishing", async () => {
    const f = fakeClient();
    const c = createReviewComposition(config(), { publisher: f.client, llm });
    f.get.mockResolvedValueOnce({ data: { ...raw, reviewId: "different" } });
    await expect(c.getCurrentReview("r1")).rejects.toMatchObject({ code: "REMOTE_DATA_INVALID" });
    expect(f.reply).not.toHaveBeenCalled();
  });
  it("validates review-only settings before credentials, auth, client or provider creation", async () => {
    const base = config();
    const loadCredentials = vi.fn(() => {
      throw new Error("must not load");
    });
    const authenticate = vi.fn();
    const createPublisher = vi.fn();
    const createLlm = vi.fn();
    for (const bad of [
      { ...base, llm: { nineRouter: { baseUrl: "https://router.example/v1", model: "" } } },
      { ...base, llm: { nineRouter: { baseUrl: "file:///secret", model: "fake-model" } } },
      { ...base, review: { checkpointPath: "" } },
      { ...base, googlePlay: { ...base.googlePlay, serviceAccountJson: "" } },
    ]) {
      await expect(
        createLiveReviewComposition({
          loadConfig: () => bad,
          loadCredentials,
          authenticate,
          createPublisher,
          createLlm,
        }),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(loadCredentials).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
    expect(createPublisher).not.toHaveBeenCalled();
    expect(createLlm).not.toHaveBeenCalled();
  });
  it("loads credentials/auth/Publisher/provider exactly once and never exposes the key", async () => {
    const conf = {
      ...config(),
      llm: {
        nineRouter: {
          baseUrl: "https://router.example/v1",
          model: "fake-model",
          apiKey: "FAKE-SECRET-KEY",
        },
      },
    };
    const credentials = {
      type: "service_account",
      clientEmail: "fake@example.test",
      privateKey: "FAKE-KEY",
      tokenUri: "https://token.example",
      sourcePath: "FAKE-LOCATION",
    } as ServiceAccountCredentials;
    const auth = { getAccessToken: vi.fn() } as unknown as GoogleAuthClient;
    const f = fakeClient();
    const loadConfig = vi.fn(() => conf);
    const loadCredentials = vi.fn(() => credentials);
    const authenticate = vi.fn(() => auth);
    const createPublisher = vi.fn(() => f.client);
    const createLlm = vi.fn(() => llm);
    const composition = await createLiveReviewComposition({
      loadConfig,
      loadCredentials,
      authenticate,
      createPublisher,
      createLlm,
    });
    expect(composition.registry.list()).toHaveLength(4);
    expect(loadConfig).toHaveBeenCalledOnce();
    expect(loadCredentials).toHaveBeenCalledExactlyOnceWith(conf);
    expect(authenticate).toHaveBeenCalledExactlyOnceWith(credentials, [
      "https://www.googleapis.com/auth/androidpublisher",
    ]);
    expect(createPublisher).toHaveBeenCalledExactlyOnceWith(auth);
    expect(createLlm).toHaveBeenCalledExactlyOnceWith(conf.llm.nineRouter);
  });
});

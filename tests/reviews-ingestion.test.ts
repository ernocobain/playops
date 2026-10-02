/**
 * Phase 3.1 — review ingestion tests. Fake ReviewSource, temp checkpoint files, real
 * ToolRegistry / runAgent / permission engine / verification model, scripted fake LLM.
 * No network, no Google client, no credentials.
 */
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAuditEntries } from "../src/audit/index.js";
import * as approvalsModule from "../src/runtime/approvals/index.js";
import { createFileAgentLedger, runAgent } from "../src/runtime/agent/index.js";
import { evaluateToolPermission } from "../src/runtime/permissions/index.js";
import type { LlmAdapter, LlmRequest, LlmResponse } from "../src/runtime/llm/index.js";
import { ToolRegistry } from "../src/runtime/tools/index.js";
import {
  compareReviewTimestamps,
  parseReviewTimestamp,
  ReviewIngestionError,
} from "../src/reviews/common.js";
import {
  createEmptyReviewCheckpoint,
  createFileReviewCheckpointStore,
  parseReviewCheckpoint,
  type ReviewCheckpoint,
  type ReviewCheckpointStore,
} from "../src/reviews/checkpoint/index.js";
import {
  DEFAULT_REVIEW_PAGE_SIZE,
  DEFAULT_REVIEW_MAX_PAGES,
  ingestReviews,
  type ReviewSource,
  type ReviewSourceInput,
  type ReviewSourcePage,
  type RemoteReview,
} from "../src/reviews/ingestion/index.js";
import { createReviewIngestionTool, REVIEWS_INGEST_TOOL_NAME } from "../src/reviews/tool.js";

const PKG = "com.example.fake";
const REVIEW_TEXT_MARKER = "REVIEW-TEXT-MARKER-x1";
const RAW_ERROR_MARKER = "RAW-SOURCE-ERROR-MARKER-e1";

let dir: string;
let ckPath: string;
let auditPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "playops-reviews-"));
  ckPath = join(dir, "state", "reviews.checkpoint.json");
  auditPath = join(dir, "audit.jsonl");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------- fakes ----------
function ts(seconds: number | string, nanos = 0) {
  return { seconds: String(seconds), nanos };
}
function review(
  id: string,
  seconds: number,
  extra: Partial<{
    text: string;
    originalText: string;
    starRating: number;
    reviewerLanguage: string;
    appVersionCode: number;
    appVersionName: string;
    nanos: number;
    developer: { text: string; seconds: number };
    deviceMetadata: Record<string, unknown>;
  }> = {},
): RemoteReview {
  const user: Record<string, unknown> = {
    lastModified: ts(seconds, extra.nanos ?? 0),
    text: extra.text ?? `${REVIEW_TEXT_MARKER} ${id}`,
  };
  if (extra.originalText !== undefined) user.originalText = extra.originalText;
  if (extra.starRating !== undefined) user.starRating = extra.starRating;
  if (extra.reviewerLanguage !== undefined) user.reviewerLanguage = extra.reviewerLanguage;
  if (extra.appVersionCode !== undefined) user.appVersionCode = extra.appVersionCode;
  if (extra.appVersionName !== undefined) user.appVersionName = extra.appVersionName;
  if (extra.deviceMetadata !== undefined) user.deviceMetadata = extra.deviceMetadata;
  const comments: unknown[] = [{ userComment: user }];
  if (extra.developer) {
    comments.push({
      developerComment: { text: extra.developer.text, lastModified: ts(extra.developer.seconds) },
    });
  }
  return { reviewId: id, authorName: "Fake Author", comments } as RemoteReview;
}

function fakeSource(pages: ReviewSourcePage[] | ((input: ReviewSourceInput) => ReviewSourcePage)) {
  const calls: ReviewSourceInput[] = [];
  const source: ReviewSource = {
    listReviews: vi.fn(async (input: ReviewSourceInput) => {
      calls.push(input);
      if (typeof pages === "function") return pages(input);
      const idx = calls.length - 1;
      const page = pages[idx];
      if (!page) throw new Error(`fake source exhausted at page ${idx}`);
      return page;
    }),
  };
  return { source, calls };
}

function memoryStore(
  initial?: ReviewCheckpoint,
  opts: { failSave?: boolean; failLoad?: boolean } = {},
) {
  let current = initial;
  const saves: ReviewCheckpoint[] = [];
  const store: ReviewCheckpointStore = {
    load: vi.fn(async () => {
      if (opts.failLoad) throw new ReviewIngestionError("CHECKPOINT_READ_FAILED", "read failed");
      return current;
    }),
    save: vi.fn(async (cp: ReviewCheckpoint) => {
      if (opts.failSave) throw new ReviewIngestionError("CHECKPOINT_WRITE_FAILED", "write failed");
      saves.push(cp);
      current = cp;
    }),
  };
  return {
    store,
    saves,
    get current() {
      return current;
    },
  };
}

function checkpoint(entries: Record<string, [number, number?]>): ReviewCheckpoint {
  const reviews: Record<string, { seconds: string; nanos: number }> = {};
  for (const [id, [s, n]] of Object.entries(entries)) reviews[id] = ts(s, n ?? 0);
  return { version: 1, packageName: PKG, reviews };
}

function scriptedLlm(responses: LlmResponse[]) {
  const requests: LlmRequest[] = [];
  const adapter: LlmAdapter = {
    provider: "fake",
    complete: vi.fn(async (request: LlmRequest) => {
      requests.push(request);
      const next = responses.shift();
      if (!next) throw new Error("scripted LLM exhausted");
      return next;
    }),
  };
  return { adapter, requests };
}

// =====================================================================
describe("timestamps", () => {
  it("parses string seconds losslessly and defaults nanos to 0", () => {
    expect(parseReviewTimestamp({ seconds: "9007199254740993" })).toEqual({
      seconds: "9007199254740993",
      nanos: 0,
    });
    expect(parseReviewTimestamp({ seconds: "10", nanos: null })).toEqual({
      seconds: "10",
      nanos: 0,
    });
  });
  it.each([
    [undefined],
    [null],
    ["1700000000"],
    [{}],
    [{ seconds: null }],
    [{ seconds: "abc" }],
    [{ seconds: "1.5" }],
    [{ seconds: "10", nanos: -1 }],
    [{ seconds: "10", nanos: 1_000_000_000 }],
    [{ seconds: "10", nanos: 1.5 }],
    [{ seconds: 1.5 }],
  ])("rejects malformed timestamp %j", (value) => {
    expect(parseReviewTimestamp(value)).toBeUndefined();
  });
  it("compares seconds first then nanos without float loss", () => {
    expect(compareReviewTimestamps(ts("9007199254740993"), ts("9007199254740992"))).toBe(1);
    expect(compareReviewTimestamps(ts(1, 999_999_999), ts(2, 0))).toBe(-1);
    expect(compareReviewTimestamps(ts(5, 7), ts(5, 7))).toBe(0);
    expect(compareReviewTimestamps(ts(5, 8), ts(5, 7))).toBe(1);
  });
});

// =====================================================================
describe("checkpoint store", () => {
  it("1. missing checkpoint → undefined (empty initial state used by ingestion)", async () => {
    const store = createFileReviewCheckpointStore(ckPath);
    await expect(store.load()).resolves.toBeUndefined();
    expect(createEmptyReviewCheckpoint(PKG)).toEqual({ version: 1, packageName: PKG, reviews: {} });
  });

  it("2. valid checkpoint loads (frozen)", async () => {
    const store = createFileReviewCheckpointStore(ckPath);
    await store.save(checkpoint({ a: [10, 5] }));
    const loaded = await store.load();
    expect(loaded).toEqual({
      version: 1,
      packageName: PKG,
      reviews: { a: { seconds: "10", nanos: 5 } },
    });
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded?.reviews)).toBe(true);
  });

  it("3. malformed JSON rejected with CHECKPOINT_INVALID; original file retained", async () => {
    writeFileSync(ckPath.replace("/state/", "/"), "", { flag: "w" }); // ensure dir exists differently
    const store = createFileReviewCheckpointStore(join(dir, "ck.json"));
    writeFileSync(join(dir, "ck.json"), "{ not json");
    await expect(store.load()).rejects.toMatchObject({ code: "CHECKPOINT_INVALID" });
    expect(readFileSync(join(dir, "ck.json"), "utf8")).toBe("{ not json");
  });

  it("4. unsupported version rejected", () => {
    expect(() => parseReviewCheckpoint({ version: 2, packageName: PKG, reviews: {} })).toThrow(
      ReviewIngestionError,
    );
    expect(() => parseReviewCheckpoint({ version: "1", packageName: PKG, reviews: {} })).toThrow(
      /version/i,
    );
  });

  it.each([
    ["array", []],
    ["blank package", { version: 1, packageName: " ", reviews: {} }],
    ["reviews array", { version: 1, packageName: PKG, reviews: [] }],
    ["bad timestamp", { version: 1, packageName: PKG, reviews: { a: { seconds: "x" } } }],
    ["blank id", { version: 1, packageName: PKG, reviews: { "": { seconds: "1" } } }],
  ])("structural rejection: %s", (_l, value) => {
    expect(() => parseReviewCheckpoint(value)).toThrow(ReviewIngestionError);
  });

  it("5. package mismatch rejected by ingestion; checkpoint not reused", async () => {
    const other = { ...checkpoint({ a: [1] }), packageName: "com.other.app" };
    const mem = memoryStore(other);
    const { source } = fakeSource([{ reviews: [review("b", 2)] }]);
    await expect(
      ingestReviews({ packageName: PKG, source, checkpointStore: mem.store }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_PACKAGE_MISMATCH" });
    expect(mem.saves).toHaveLength(0);
  });

  it("6. atomic save produces valid final file with no temp leftovers", async () => {
    const store = createFileReviewCheckpointStore(ckPath);
    await store.save(checkpoint({ a: [1] }));
    const parsed = JSON.parse(readFileSync(ckPath, "utf8"));
    expect(parsed.version).toBe(1);
    expect(readdirSync(join(dir, "state")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("7. failed save does not claim success and leaves the prior file intact", async () => {
    const store = createFileReviewCheckpointStore(ckPath);
    await store.save(checkpoint({ a: [1] }));
    const before = readFileSync(ckPath, "utf8");
    chmodSync(join(dir, "state"), 0o500);
    try {
      await expect(store.save(checkpoint({ a: [2] }))).rejects.toMatchObject({
        code: "CHECKPOINT_WRITE_FAILED",
      });
    } finally {
      chmodSync(join(dir, "state"), 0o700);
    }
    expect(readFileSync(ckPath, "utf8")).toBe(before);
  });

  it("8. parent directory creation", async () => {
    const deep = join(dir, "a", "b", "c", "ck.json");
    await createFileReviewCheckpointStore(deep).save(checkpoint({}));
    expect(existsSync(deep)).toBe(true);
  });

  it("save rejects an invalid checkpoint object before touching disk", async () => {
    const store = createFileReviewCheckpointStore(ckPath);
    await expect(store.save({ version: 1, packageName: "", reviews: {} })).rejects.toMatchObject({
      code: "CHECKPOINT_INVALID",
    });
    expect(existsSync(ckPath)).toBe(false);
  });

  it("blank path rejected", () => {
    expect(() => createFileReviewCheckpointStore("")).toThrow(ReviewIngestionError);
  });

  it("read failure other than ENOENT → CHECKPOINT_READ_FAILED", async () => {
    const store = createFileReviewCheckpointStore(dir); // a directory, EISDIR
    await expect(store.load()).rejects.toMatchObject({ code: "CHECKPOINT_READ_FAILED" });
  });
});

// =====================================================================
describe("ingestion delta", () => {
  it("11. empty API list → zero changes, checkpoint unchanged (not re-saved)", async () => {
    const mem = memoryStore(checkpoint({ old: [1] }));
    const { source } = fakeSource([{ reviews: [] }]);
    const result = await ingestReviews({ packageName: PKG, source, checkpointStore: mem.store });
    expect(result).toMatchObject({
      reviews: [],
      fetchedCount: 0,
      newCount: 0,
      updatedCount: 0,
      unchangedCount: 0,
      pageCount: 1,
      checkpointChanged: false,
    });
    expect(mem.saves).toHaveLength(0);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reviews)).toBe(true);
  });

  it("12. one new review", async () => {
    const mem = memoryStore();
    const { source } = fakeSource([{ reviews: [review("r1", 100)] }]);
    const result = await ingestReviews({ packageName: PKG, source, checkpointStore: mem.store });
    expect(result.newCount).toBe(1);
    expect(result.reviews[0]).toMatchObject({ reviewId: "r1", changeType: "new" });
    expect(result.checkpointChanged).toBe(true);
    expect(mem.current?.reviews.r1).toEqual(ts(100));
  });

  it("13. existing unchanged review → not returned, no save", async () => {
    const mem = memoryStore(checkpoint({ r1: [100] }));
    const { source } = fakeSource([{ reviews: [review("r1", 100)] }]);
    const result = await ingestReviews({ packageName: PKG, source, checkpointStore: mem.store });
    expect(result).toMatchObject({
      unchangedCount: 1,
      newCount: 0,
      updatedCount: 0,
      checkpointChanged: false,
    });
    expect(result.reviews).toEqual([]);
    expect(mem.saves).toHaveLength(0);
  });

  it("14. existing updated review (nanos-only advance counts)", async () => {
    const mem = memoryStore(checkpoint({ r1: [100, 5] }));
    const { source } = fakeSource([{ reviews: [review("r1", 100, { nanos: 6 })] }]);
    const result = await ingestReviews({ packageName: PKG, source, checkpointStore: mem.store });
    expect(result.updatedCount).toBe(1);
    expect(result.reviews[0]).toMatchObject({ reviewId: "r1", changeType: "updated" });
    expect(mem.current?.reviews.r1).toEqual(ts(100, 6));
  });

  it("15. older/stale API timestamp → unchanged; checkpoint never moves backwards", async () => {
    const mem = memoryStore(checkpoint({ r1: [200] }));
    const { source } = fakeSource([{ reviews: [review("r1", 150)] }]);
    const result = await ingestReviews({ packageName: PKG, source, checkpointStore: mem.store });
    expect(result).toMatchObject({ unchangedCount: 1, checkpointChanged: false });
    expect(mem.saves).toHaveLength(0);
  });

  it("16. mixture new/updated/unchanged + 9. unseen stored IDs preserved", async () => {
    const mem = memoryStore(checkpoint({ keep: [1], same: [50], upd: [60] }));
    const { source } = fakeSource([
      { reviews: [review("same", 50), review("upd", 61), review("new", 70)] },
    ]);
    const result = await ingestReviews({ packageName: PKG, source, checkpointStore: mem.store });
    expect(result).toMatchObject({
      newCount: 1,
      updatedCount: 1,
      unchangedCount: 1,
      fetchedCount: 3,
    });
    expect(mem.current?.reviews).toEqual({
      keep: ts(1),
      same: ts(50),
      upd: ts(61),
      new: ts(70),
    });
  });

  it("17. deterministic order: oldest userLastModified first, then reviewId", async () => {
    const mem = memoryStore();
    const { source } = fakeSource([
      { reviews: [review("z", 30), review("b", 10), review("a", 10), review("m", 20)] },
    ]);
    const result = await ingestReviews({ packageName: PKG, source, checkpointStore: mem.store });
    expect(result.reviews.map((r) => r.reviewId)).toEqual(["a", "b", "m", "z"]);
  });

  it("18. equal timestamps + reviewId tie broken by code-point order of reviewId", async () => {
    const mem = memoryStore();
    const { source } = fakeSource([
      { reviews: [review("B", 10), review("a", 10), review("A", 10)] },
    ]);
    const result = await ingestReviews({ packageName: PKG, source, checkpointStore: mem.store });
    expect(result.reviews.map((r) => r.reviewId)).toEqual(["A", "B", "a"]);
  });

  it("10. stored timestamp never moves backwards even when mixed with advancing ones", async () => {
    const mem = memoryStore(checkpoint({ r1: [200], r2: [10] }));
    const { source } = fakeSource([{ reviews: [review("r1", 100), review("r2", 20)] }]);
    await ingestReviews({ packageName: PKG, source, checkpointStore: mem.store });
    expect(mem.current?.reviews).toEqual({ r1: ts(200), r2: ts(20) });
  });
});

// =====================================================================
describe("pagination", () => {
  it("19/20/21. multiple pages fetched, tokens propagated, no nextPageToken terminates; page size 100", async () => {
    const mem = memoryStore();
    const { source, calls } = fakeSource([
      { reviews: [review("a", 1)], nextPageToken: "t1" },
      { reviews: [review("b", 2)], nextPageToken: "t2" },
      { reviews: [review("c", 3)] },
    ]);
    const result = await ingestReviews({ packageName: PKG, source, checkpointStore: mem.store });
    expect(result.pageCount).toBe(3);
    expect(result.fetchedCount).toBe(3);
    expect(calls).toEqual([
      { packageName: PKG, maxResults: 100 },
      { packageName: PKG, maxResults: 100, pageToken: "t1" },
      { packageName: PKG, maxResults: 100, pageToken: "t2" },
    ]);
    expect(DEFAULT_REVIEW_PAGE_SIZE).toBe(100);
    expect(calls.every((c) => !("startIndex" in c))).toBe(true);
  });

  it("22. repeated token → PAGINATION_LOOP, checkpoint unchanged", async () => {
    const mem = memoryStore(checkpoint({ keep: [1] }));
    const { source } = fakeSource([
      { reviews: [review("a", 1)], nextPageToken: "t1" },
      { reviews: [review("b", 2)], nextPageToken: "t1" },
    ]);
    await expect(
      ingestReviews({ packageName: PKG, source, checkpointStore: mem.store }),
    ).rejects.toMatchObject({ code: "PAGINATION_LOOP" });
    expect(mem.saves).toHaveLength(0);
  });

  it("23. maxPages guard → MAX_PAGES_EXCEEDED; conservative default", async () => {
    const mem = memoryStore();
    const { source, calls } = fakeSource((input) => ({
      reviews: [review(`r-${input.pageToken ?? "0"}`, 1)],
      nextPageToken: `${input.pageToken ?? "0"}x`,
    }));
    await expect(
      ingestReviews({ packageName: PKG, source, checkpointStore: mem.store, maxPages: 3 }),
    ).rejects.toMatchObject({ code: "MAX_PAGES_EXCEEDED" });
    expect(calls).toHaveLength(3);
    expect(mem.saves).toHaveLength(0);
    expect(DEFAULT_REVIEW_MAX_PAGES).toBeGreaterThanOrEqual(10);
    expect(DEFAULT_REVIEW_MAX_PAGES).toBeLessThanOrEqual(100);
  });

  it("24. failure on later page → checkpoint unchanged, SOURCE_FAILED", async () => {
    const mem = memoryStore(checkpoint({ keep: [1] }));
    const { source } = fakeSource((input) => {
      if (input.pageToken === "t1") throw new Error(RAW_ERROR_MARKER);
      return { reviews: [review("a", 1)], nextPageToken: "t1" };
    });
    await expect(
      ingestReviews({ packageName: PKG, source, checkpointStore: mem.store }),
    ).rejects.toMatchObject({ code: "SOURCE_FAILED" });
    expect(mem.saves).toHaveLength(0);
  });

  it("invalid maxPages / packageName → INVALID_ARGUMENT before any source call", async () => {
    const mem = memoryStore();
    const { source, calls } = fakeSource([]);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(
        ingestReviews({ packageName: PKG, source, checkpointStore: mem.store, maxPages: bad }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
    await expect(
      ingestReviews({ packageName: " ", source, checkpointStore: mem.store }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(calls).toHaveLength(0);
  });

  it("malformed page shape from source → REMOTE_DATA_INVALID", async () => {
    const mem = memoryStore();
    const { source } = fakeSource([{ reviews: "nope" } as never]);
    await expect(
      ingestReviews({ packageName: PKG, source, checkpointStore: mem.store }),
    ).rejects.toMatchObject({ code: "REMOTE_DATA_INVALID" });
  });
});

// =====================================================================
describe("duplicates & malformed remote data", () => {
  it("25/26. duplicate reviewId across pages → one output; newer duplicate wins", async () => {
    const mem = memoryStore();
    const { source } = fakeSource([
      { reviews: [review("d", 10, { text: "old" })], nextPageToken: "t" },
      { reviews: [review("d", 20, { text: "newer" })] },
    ]);
    const result = await ingestReviews({ packageName: PKG, source, checkpointStore: mem.store });
    expect(result.fetchedCount).toBe(2);
    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0]).toMatchObject({
      reviewId: "d",
      text: "newer",
      userLastModified: ts(20),
    });
    expect(mem.current?.reviews.d).toEqual(ts(20));
  });

  it("equal-timestamp duplicates: first occurrence wins (documented)", async () => {
    const mem = memoryStore();
    const { source } = fakeSource([
      { reviews: [review("d", 10, { text: "first" }), review("d", 10, { text: "second" })] },
    ]);
    const result = await ingestReviews({ packageName: PKG, source, checkpointStore: mem.store });
    expect(result.reviews[0]?.text).toBe("first");
  });

  it.each([
    ["27. blank reviewId", { ...review("x", 1), reviewId: " " }],
    ["27b. missing reviewId", { ...review("x", 1), reviewId: undefined }],
    [
      "28. missing userComment",
      { reviewId: "x", comments: [{ developerComment: { text: "hi" } }] },
    ],
    ["28b. missing comments", { reviewId: "x" }],
    [
      "29. malformed lastModified",
      { reviewId: "x", comments: [{ userComment: { lastModified: { seconds: "abc" } } }] },
    ],
    ["29b. missing lastModified", { reviewId: "x", comments: [{ userComment: { text: "t" } }] }],
    ["non-object review", "string-review"],
  ])("%s → REMOTE_DATA_INVALID; 30. checkpoint unchanged", async (_l, bad) => {
    const mem = memoryStore(checkpoint({ keep: [1] }));
    const { source } = fakeSource([{ reviews: [review("ok", 5), bad as RemoteReview] }]);
    let caught: unknown;
    try {
      await ingestReviews({ packageName: PKG, source, checkpointStore: mem.store });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReviewIngestionError);
    expect((caught as ReviewIngestionError).code).toBe("REMOTE_DATA_INVALID");
    expect((caught as Error).message).not.toContain(REVIEW_TEXT_MARKER);
    expect((caught as Error).message).not.toContain("string-review");
    expect(mem.saves).toHaveLength(0);
  });

  it("31. developerComment change alone does not mark the user review updated", async () => {
    const mem = memoryStore(checkpoint({ r: [100] }));
    const { source } = fakeSource([
      { reviews: [review("r", 100, { developer: { text: "thanks!", seconds: 999 } })] },
    ]);
    const result = await ingestReviews({ packageName: PKG, source, checkpointStore: mem.store });
    expect(result).toMatchObject({ unchangedCount: 1, updatedCount: 0, checkpointChanged: false });
  });

  it("32. userComment lastModified change does mark it updated (developer reply carried along)", async () => {
    const mem = memoryStore(checkpoint({ r: [100] }));
    const { source } = fakeSource([
      { reviews: [review("r", 101, { developer: { text: "thanks!", seconds: 50 } })] },
    ]);
    const result = await ingestReviews({ packageName: PKG, source, checkpointStore: mem.store });
    expect(result.updatedCount).toBe(1);
    expect(result.reviews[0]?.developerReply).toEqual({ text: "thanks!", lastModified: ts(50) });
  });

  it("optional fields with wrong types are dropped, not fatal", async () => {
    const mem = memoryStore();
    const raw = {
      reviewId: "r",
      comments: [{ userComment: { lastModified: ts(1), starRating: "5", appVersionCode: "12" } }],
    } as RemoteReview;
    const { source } = fakeSource([{ reviews: [raw] }]);
    const result = await ingestReviews({ packageName: PKG, source, checkpointStore: mem.store });
    expect(result.reviews[0]).not.toHaveProperty("starRating");
    expect(result.reviews[0]).not.toHaveProperty("appVersionCode");
  });
});

// =====================================================================
describe("normalization", () => {
  it("33–39. normalizes selected fields incl. developer reply", async () => {
    const mem = memoryStore();
    const { source } = fakeSource([
      {
        reviews: [
          review("n", 42, {
            nanos: 7,
            text: "Great app",
            originalText: "Aplikasi bagus",
            starRating: 5,
            reviewerLanguage: "id",
            appVersionCode: 120,
            appVersionName: "1.2.0",
            developer: { text: "Terima kasih", seconds: 43 },
            deviceMetadata: { productName: "Pixel", screenWidthPx: 1080 },
          }),
        ],
      },
    ]);
    const result = await ingestReviews({ packageName: PKG, source, checkpointStore: mem.store });
    const r = result.reviews[0];
    expect(r).toEqual({
      reviewId: "n",
      changeType: "new",
      userLastModified: { seconds: "42", nanos: 7 },
      text: "Great app",
      originalText: "Aplikasi bagus",
      starRating: 5,
      reviewerLanguage: "id",
      appVersionCode: 120,
      appVersionName: "1.2.0",
      developerReply: { text: "Terima kasih", lastModified: { seconds: "43", nanos: 0 } },
    });
    expect(Object.isFrozen(r)).toBe(true);
  });

  it("40. optional missing fields handled predictably (text defaults to empty string; others absent)", async () => {
    const mem = memoryStore();
    const { source } = fakeSource([
      {
        reviews: [
          { reviewId: "m", comments: [{ userComment: { lastModified: ts(1) } }] } as RemoteReview,
        ],
      },
    ]);
    const result = await ingestReviews({ packageName: PKG, source, checkpointStore: mem.store });
    expect(result.reviews[0]).toEqual({
      reviewId: "m",
      changeType: "new",
      userLastModified: { seconds: "1", nanos: 0 },
      text: "",
    });
  });

  it("41. raw generated Google object / device metadata / authorName not returned", async () => {
    const mem = memoryStore();
    const { source } = fakeSource([
      { reviews: [review("n", 1, { deviceMetadata: { productName: "SECRET-DEVICE" } })] },
    ]);
    const result = await ingestReviews({ packageName: PKG, source, checkpointStore: mem.store });
    const json = JSON.stringify(result);
    expect(json).not.toContain("SECRET-DEVICE");
    expect(json).not.toContain("comments");
    expect(json).not.toContain("authorName");
    expect(json).not.toContain("deviceMetadata");
  });

  it("developer reply with malformed timestamp is dropped rather than fatal", async () => {
    const mem = memoryStore();
    const raw = review("n", 1);
    (raw as { comments: unknown[] }).comments.push({
      developerComment: { text: "x", lastModified: { seconds: "bad" } },
    });
    const { source } = fakeSource([{ reviews: [raw] }]);
    const result = await ingestReviews({ packageName: PKG, source, checkpointStore: mem.store });
    expect(result.reviews[0]).not.toHaveProperty("developerReply");
  });
});

// =====================================================================
describe("failure / durability", () => {
  it("61/62. source throws → SOURCE_FAILED; raw text not leaked; cause preserved", async () => {
    const mem = memoryStore();
    const { source } = fakeSource(() => {
      throw new Error(RAW_ERROR_MARKER);
    });
    let caught: unknown;
    try {
      await ingestReviews({ packageName: PKG, source, checkpointStore: mem.store });
    } catch (e) {
      caught = e;
    }
    const err = caught as ReviewIngestionError;
    expect(err.code).toBe("SOURCE_FAILED");
    expect(err.message).not.toContain(RAW_ERROR_MARKER);
    expect(String(err)).not.toContain(RAW_ERROR_MARKER);
    expect((err.cause as Error).message).toContain(RAW_ERROR_MARKER);
    expect(mem.saves).toHaveLength(0); // 65
  });

  it("63. checkpoint read failure → propagated typed error; no source call", async () => {
    const mem = memoryStore(undefined, { failLoad: true });
    const { source, calls } = fakeSource([{ reviews: [] }]);
    await expect(
      ingestReviews({ packageName: PKG, source, checkpointStore: mem.store }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_READ_FAILED" });
    expect(calls).toHaveLength(0);
  });

  it("64/67. checkpoint write failure → CHECKPOINT_WRITE_FAILED; no successful result", async () => {
    const mem = memoryStore(undefined, { failSave: true });
    const { source } = fakeSource([{ reviews: [review("a", 1)] }]);
    await expect(
      ingestReviews({ packageName: PKG, source, checkpointStore: mem.store }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_WRITE_FAILED" });
  });

  it("66. no checkpoint advancement after normalization failure (see malformed tests) — store.save never called", async () => {
    const mem = memoryStore(checkpoint({ keep: [1] }));
    const { source } = fakeSource([{ reviews: [{ reviewId: "x" } as RemoteReview] }]);
    await ingestReviews({ packageName: PKG, source, checkpointStore: mem.store }).catch(
      () => undefined,
    );
    expect(mem.store.save).not.toHaveBeenCalled();
  });

  it("store load returning wrong-shaped object is rejected as CHECKPOINT_INVALID", async () => {
    const store: ReviewCheckpointStore = {
      load: async () => ({ version: 7 }) as never,
      save: async () => undefined,
    };
    const { source } = fakeSource([{ reviews: [] }]);
    await expect(
      ingestReviews({ packageName: PKG, source, checkpointStore: store }),
    ).rejects.toMatchObject({
      code: "CHECKPOINT_INVALID",
    });
  });
});

// =====================================================================
describe("reviews.ingest runtime tool", () => {
  function makeTool(overrides: Partial<Parameters<typeof createReviewIngestionTool>[0]> = {}) {
    const { source } = fakeSource([{ reviews: [review("r1", 10), review("r2", 20)] }]);
    return createReviewIngestionTool({
      packageName: PKG,
      source,
      checkpointStore: createFileReviewCheckpointStore(ckPath),
      ...overrides,
    });
  }

  it("42/43/44/45/46. registered in real ToolRegistry as write with verifier; binding name exact", () => {
    const { tool, binding } = makeTool();
    const registry = new ToolRegistry();
    registry.register(tool);
    const reg = registry.get(REVIEWS_INGEST_TOOL_NAME);
    expect(REVIEWS_INGEST_TOOL_NAME).toBe("reviews.ingest");
    expect(reg.permission).toBe("write");
    expect(typeof reg.verify).toBe("function");
    expect(binding.toolName).toBe("reviews.ingest");
    expect(binding.llm.name).toBe("reviews.ingest");
    expect(binding.approval).toBeUndefined();
  });

  it("47/48. package bound by composition; input schema accepts {} and rejects unexpected keys/package", () => {
    const { tool } = makeTool();
    expect(tool.inputSchema.parse({})).toEqual({});
    expect(tool.inputSchema.parse(undefined)).toEqual({});
    expect(() => tool.inputSchema.parse({ packageName: "com.evil" })).toThrow();
    expect(() => tool.inputSchema.parse({ checkpointPath: "/tmp/x" })).toThrow();
    expect(() => tool.inputSchema.parse({ translationLanguage: "en" })).toThrow();
    expect(() => tool.inputSchema.parse("x")).toThrow();
    expect(() => tool.inputSchema.parse([])).toThrow();
    expect(JSON.stringify(makeTool().binding.llm.inputSchema)).not.toContain("packageName");
  });

  it("factory validates composition arguments", () => {
    const { source } = fakeSource([]);
    const store = createFileReviewCheckpointStore(ckPath);
    expect(() =>
      createReviewIngestionTool({ packageName: " ", source, checkpointStore: store }),
    ).toThrow(ReviewIngestionError);
    expect(() =>
      createReviewIngestionTool({ packageName: PKG, source, checkpointStore: store, maxPages: 0 }),
    ).toThrow(ReviewIngestionError);
  });

  it("49. output schema validates a real result and rejects junk", async () => {
    const { tool } = makeTool();
    const out = await tool.execute({}, {});
    expect(tool.outputSchema.parse(out)).toEqual(out);
    expect(() => tool.outputSchema.parse({ reviews: "x" })).toThrow();
    expect(() => tool.outputSchema.parse({ ...out, newCount: -1 })).toThrow();
    expect(() => tool.outputSchema.parse({ ...out, reviews: [{ reviewId: "" }] })).toThrow();
    expect(() => tool.outputSchema.parse(null)).toThrow();
  });

  it("50. serializer returns safe string with normalized content only", async () => {
    const { tool, binding } = makeTool();
    const out = await tool.execute({}, {});
    const text = binding.serializeResult(out, {
      toolName: "reviews.ingest",
      permission: "write",
      required: true,
      status: "passed",
      code: "VERIFIED",
      verified: true,
    });
    expect(typeof text).toBe("string");
    expect(text).toContain(REVIEW_TEXT_MARKER);
    expect(text).toContain('"newCount":2');
    expect(text).not.toContain(ckPath);
    expect(text).not.toContain("comments");
    expect(text).not.toContain("authorName");
    expect(() => binding.serializeResult("garbage", undefined as never)).toThrow();
  });

  it("51/52. permission engine allows write without approval; verifier present for preflight", () => {
    const { tool } = makeTool();
    const registry = new ToolRegistry();
    registry.register(tool);
    const decision = evaluateToolPermission(registry.get("reviews.ingest"));
    expect(decision.code).toBe("ALLOWED");
  });

  it("53/54. execute persists; verifier reads persisted checkpoint and confirms committed timestamps", async () => {
    const { tool } = makeTool();
    const out = await tool.execute({}, {});
    expect(existsSync(ckPath)).toBe(true);
    const realStore = createFileReviewCheckpointStore(ckPath);
    const loadSpy = vi.fn(() => realStore.load());
    const spyStore: ReviewCheckpointStore = { load: loadSpy, save: (cp) => realStore.save(cp) };
    const { tool: tool2 } = createReviewIngestionTool({
      packageName: PKG,
      source: fakeSource([]).source,
      checkpointStore: spyStore,
    });
    await expect(tool2.verify?.({}, out, {})).resolves.toBe(true);
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  it("verifier fails when checkpoint missing / package mismatch / timestamp regressed / malformed", async () => {
    const { tool } = makeTool();
    const out = await tool.execute({}, {});
    // regressed
    writeFileSync(
      ckPath,
      JSON.stringify({ version: 1, packageName: PKG, reviews: { r1: ts(1), r2: ts(20) } }),
    );
    await expect(tool.verify?.({}, out, {})).resolves.toBe(false);
    // missing id
    writeFileSync(
      ckPath,
      JSON.stringify({ version: 1, packageName: PKG, reviews: { r2: ts(20) } }),
    );
    await expect(tool.verify?.({}, out, {})).resolves.toBe(false);
    // package mismatch
    writeFileSync(
      ckPath,
      JSON.stringify({ version: 1, packageName: "com.other", reviews: { r1: ts(10), r2: ts(20) } }),
    );
    await expect(tool.verify?.({}, out, {})).resolves.toBe(false);
    // malformed
    writeFileSync(ckPath, "{bad");
    await expect(tool.verify?.({}, out, {})).resolves.toBe(false);
    // missing
    rmSync(ckPath);
    await expect(tool.verify?.({}, out, {})).resolves.toBe(false);
  });

  it("verifier passes for a no-change run (nothing claimed) and with newer-than-claimed stored timestamps", async () => {
    const { tool } = makeTool();
    const out = await tool.execute({}, {});
    writeFileSync(
      ckPath,
      JSON.stringify({ version: 1, packageName: PKG, reviews: { r1: ts(10, 1), r2: ts(99) } }),
    );
    await expect(tool.verify?.({}, out, {})).resolves.toBe(true);
  });

  it("execute maps domain errors to ReviewIngestionError (no raw leak)", async () => {
    const { tool } = makeTool({
      source: {
        listReviews: async () => {
          throw new Error(RAW_ERROR_MARKER);
        },
      },
    });
    let caught: unknown;
    try {
      await tool.execute({}, {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReviewIngestionError);
    expect((caught as Error).message).not.toContain(RAW_ERROR_MARKER);
  });
});

// =====================================================================
describe("runtime integration through real runAgent", () => {
  const limits = { maxSteps: 5, maxToolCalls: 5, maxTotalTokens: 10_000 };
  const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

  function runWith(
    tool: ReturnType<typeof createReviewIngestionTool>,
    llmResponses: LlmResponse[],
  ) {
    const registry = new ToolRegistry();
    registry.register(tool.tool);
    const llm = scriptedLlm(llmResponses);
    const createSpy = vi.spyOn(approvalsModule, "createApprovalRequest");
    const promise = runAgent({
      llm: llm.adapter,
      registry,
      bindings: [tool.binding],
      messages: [{ role: "user", content: "Ingest reviews." }],
      limits,
      ledger: createFileAgentLedger(auditPath),
      runId: () => "run-reviews-1",
      now: () => new Date("2026-09-26T00:00:00Z"),
    });
    return { promise, llm, createSpy, registry };
  }

  it("55/58/59/60. full scripted lifecycle → VERIFIED → serialized result to LLM → COMPLETED", async () => {
    const { source } = fakeSource([
      { reviews: [review("a", 1, { text: `${REVIEW_TEXT_MARKER} alpha` })], nextPageToken: "p2" },
      { reviews: [review("b", 2, { text: `${REVIEW_TEXT_MARKER} beta` })] },
    ]);
    const store = createFileReviewCheckpointStore(ckPath);
    const tool = createReviewIngestionTool({ packageName: PKG, source, checkpointStore: store });
    const execSpy = vi.spyOn(tool.tool, "execute");
    const verifySpy = vi.spyOn(tool.tool, "verify" as never);
    const { promise, llm, createSpy } = runWith(tool, [
      {
        toolCalls: [{ id: "c1", name: "reviews.ingest", arguments: {} }],
        finishReason: "tool_calls",
        usage,
      },
      { content: "Done: ingested.", toolCalls: [], finishReason: "stop", usage },
    ]);
    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.code).toBe("COMPLETED");
    expect(result.finalContent).toBe("Done: ingested.");
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(createSpy).not.toHaveBeenCalled();

    // result reached LLM on step 2 as a tool message with normalized content
    const second = llm.requests[1];
    expect(second).toBeDefined();
    const toolMsg = second?.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    const content = (toolMsg as { content: string }).content;
    expect(content).toContain(`${REVIEW_TEXT_MARKER} alpha`);
    expect(content).toContain('"newCount":2');
    expect(content).not.toContain("comments");
    expect(content).not.toContain("authorName");
    expect(content).not.toContain(ckPath);

    // model-facing declaration
    expect(llm.requests[0]?.tools?.[0]?.name).toBe("reviews.ingest");

    // audit: verified, no approval events, no review text, no path
    const entries = readAuditEntries(auditPath);
    const types = entries.map((e) => e.type);
    expect(types).toContain("verification.completed");
    expect(types).toContain("agent.tool.execution.completed");
    expect(types.some((t) => t.startsWith("approval."))).toBe(false);
    const auditText = readFileSync(auditPath, "utf8");
    expect(auditText).not.toContain(REVIEW_TEXT_MARKER);
    expect(auditText).not.toContain("alpha");
    expect(auditText).not.toContain(ckPath);
    expect(auditText).not.toContain("authorName");
    const verification = entries.find((e) => e.type === "verification.completed");
    expect(verification?.metadata).toMatchObject({ code: "VERIFIED", permission: "write" });

    // checkpoint persisted
    expect(JSON.parse(readFileSync(ckPath, "utf8")).reviews).toEqual({ a: ts(1), b: ts(2) });
  });

  it("56/57. broken checkpoint read-back → VERIFICATION_FAILED; result never sent to LLM", async () => {
    const { source } = fakeSource([{ reviews: [review("a", 1)] }]);
    // store whose save silently writes to a different file → verifier read-back fails
    const realStore = createFileReviewCheckpointStore(ckPath);
    const lyingStore: ReviewCheckpointStore = {
      load: () => realStore.load(),
      save: async () => undefined, // pretends to save
    };
    const tool = createReviewIngestionTool({
      packageName: PKG,
      source,
      checkpointStore: lyingStore,
    });
    const { promise, llm } = runWith(tool, [
      {
        toolCalls: [{ id: "c1", name: "reviews.ingest", arguments: {} }],
        finishReason: "tool_calls",
        usage,
      },
      { content: "should not be reached", toolCalls: [], finishReason: "stop", usage },
    ]);
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.code).toBe("VERIFICATION_FAILED");
    expect(result.externalStateUncertain).toBe(true);
    expect(llm.requests).toHaveLength(1);
    expect(readFileSync(auditPath, "utf8")).not.toContain(REVIEW_TEXT_MARKER);
  });

  it("source failure during agent run → EXECUTION_FAILED, no checkpoint file, raw error absent from audit", async () => {
    const tool = createReviewIngestionTool({
      packageName: PKG,
      source: {
        listReviews: async () => {
          throw new Error(RAW_ERROR_MARKER);
        },
      },
      checkpointStore: createFileReviewCheckpointStore(ckPath),
    });
    const { promise } = runWith(tool, [
      {
        toolCalls: [{ id: "c1", name: "reviews.ingest", arguments: {} }],
        finishReason: "tool_calls",
        usage,
      },
    ]);
    const result = await promise;
    expect(result.code).toBe("EXECUTION_FAILED");
    expect(existsSync(ckPath)).toBe(false);
    expect(readFileSync(auditPath, "utf8")).not.toContain(RAW_ERROR_MARKER);
  });

  it("model-invented input (packageName) → INPUT_INVALID before execute", async () => {
    const { source, calls } = fakeSource([{ reviews: [] }]);
    const tool = createReviewIngestionTool({
      packageName: PKG,
      source,
      checkpointStore: createFileReviewCheckpointStore(ckPath),
    });
    const { promise } = runWith(tool, [
      {
        toolCalls: [{ id: "c1", name: "reviews.ingest", arguments: { packageName: "com.evil" } }],
        finishReason: "tool_calls",
        usage,
      },
    ]);
    const result = await promise;
    expect(result.code).toBe("INPUT_INVALID");
    expect(calls).toHaveLength(0);
  });
});

// =====================================================================
describe("separation & dependencies", () => {
  it("reviews domain does not import the Google client, browser module, or googleplay internals except via the adapter file", () => {
    const root = join(import.meta.dirname, "..");
    const files = [
      "src/reviews/common.ts",
      "src/reviews/checkpoint/index.ts",
      "src/reviews/ingestion/index.ts",
      "src/reviews/tool.ts",
    ];
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const f of files) {
      const src = strip(readFileSync(join(root, f), "utf8"));
      expect(src).not.toMatch(/@googleapis/);
      expect(src).not.toMatch(/runtime\/browser/);
      expect(src).not.toMatch(/reviews\.reply|\.reply\(/);
      expect(src).not.toMatch(/\/home\/dhikrama/);
    }
    const adapter = strip(
      readFileSync(join(root, "src/reviews/source/androidpublisher.ts"), "utf8"),
    );
    expect(adapter).toMatch(/googleplay\/publisher\/index\.js/);
    expect(adapter).not.toMatch(/@googleapis/);
    expect(adapter).not.toMatch(/executeWithRetry|googleplay\/retry/);
  });
});

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAuditEntries } from "../src/audit/index.js";
import { runReviewsCli, reviewSnippet, type ReviewCliIo } from "../src/cli/reviews.js";
import { DEFAULT_CONFIG, type PlayOpsConfig } from "../src/config/index.js";
import type { AndroidPublisherClient } from "../src/googleplay/publisher/index.js";
import type { LlmAdapter, LlmRequest } from "../src/runtime/llm/index.js";
import { createReviewComposition } from "../src/reviews/composition.js";

const pkg = "com.example.fake";
const draft = "Terima kasih sudah melaporkan masalah ini. Kami menghargai masukan Anda.";
const reviewText = "Aplikasi crash saat masuk. REVIEW-PRIVATE-TEXT";
const key = "FAKE-API-KEY-PRIVATE";
const timestamp = (seconds: string, nanos = 0) => ({ seconds, nanos });
const userTime = timestamp("100", 9);
const developerTime = timestamp("101", 7);
const publishedTime = timestamp("102", 8);
const remote = (
  id: string,
  seconds: string,
  text: string,
  rating = 1,
  developer?: { text: string; lastModified: ReturnType<typeof timestamp> },
) => ({
  reviewId: id,
  authorName: "PRIVATE-AUTHOR",
  comments: [
    {
      userComment: {
        text,
        reviewerLanguage: "id-ID",
        starRating: rating,
        lastModified: timestamp(seconds, id === "r1" ? 9 : 0),
      },
    },
    ...(developer ? [{ developerComment: developer }] : []),
  ],
});
let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { force: true, recursive: true });
  vi.restoreAllMocks();
});
function harness(
  options: {
    reviews?: ReturnType<typeof remote>[];
    answer?: string;
    interactive?: boolean;
    staleUser?: boolean;
    staleDeveloper?: boolean;
    mismatch?: boolean;
    failClassification?: boolean;
    failPost?: boolean;
    draftText?: string;
  } = {},
) {
  dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "playops-review-cli-"));
  const checkpointPath = join(dir, "state", "checkpoint.json");
  const auditPath = join(dir, "audit.jsonl");
  const initial = options.reviews ?? [remote("r1", "100", reviewText)];
  const replyText = options.draftText ?? draft;
  const order: string[] = [];
  const list = vi.fn(async () => {
    order.push("LIST");
    return { data: { reviews: initial } };
  });
  let gets = 0;
  let posted = false;
  const get = vi.fn(async () => {
    order.push("GET");
    gets++;
    const current = initial[0];
    if (!current) throw new Error("fake source empty");
    if (gets >= 2 && options.staleUser)
      return { data: remote(current.reviewId, "101", reviewText) };
    if (gets >= 2 && options.staleDeveloper)
      return {
        data: remote(current.reviewId, "100", reviewText, 1, {
          text: "other reply",
          lastModified: timestamp("101", 8),
        }),
      };
    if (posted)
      return {
        data: remote(current.reviewId, "100", reviewText, 1, {
          text: options.mismatch ? "mismatched reply" : replyText,
          lastModified: publishedTime,
        }),
      };
    return { data: current };
  });
  const reply = vi.fn(async (_input: unknown) => {
    order.push("POST");
    posted = true;
    if (options.failPost) throw new Error("RAW-PROVIDER-SECRET");
    return { data: { result: { replyText, lastEdited: publishedTime } } };
  });
  const client = { version: "v3", reviews: { list, get, reply } } as AndroidPublisherClient;
  const domainCalls: LlmRequest[] = [];
  const llm: LlmAdapter = {
    provider: "fake-only",
    complete: vi.fn(async (req: LlmRequest) => {
      domainCalls.push(req);
      const tool = req.tools?.[0]?.name;
      if (tool === "submit_review_classification") {
        if (options.failClassification) throw new Error("RAW-LLM-SECRET");
        const id = JSON.parse(
          (req.messages[1] as { content: string }).content.split("\n")[1] ?? "{}",
        ) as { reviewId: string };
        return {
          toolCalls: [
            {
              id: "classification",
              name: tool,
              arguments: {
                category: id.reviewId === "r2" ? "praise" : "bug",
                language: id.reviewId === "r2" ? "en" : "id",
              },
            },
          ],
        };
      }
      if (tool === "submit_review_reply_draft")
        return { toolCalls: [{ id: "draft", name: tool, arguments: { replyText } }] };
      throw new Error("An outer model attempted to use the provider");
    }),
  };
  const config: PlayOpsConfig = {
    ...DEFAULT_CONFIG,
    googlePlay: { packageName: pkg, serviceAccountJson: "FAKE-LOCATION" },
    audit: { logPath: auditPath },
    review: { checkpointPath },
    llm: { nineRouter: { baseUrl: "http://127.0.0.1:20128/v1", model: "fake-model", apiKey: key } },
  };
  const composition = createReviewComposition(config, { publisher: client, llm });
  const written: string[] = [],
    errors: string[] = [],
    prompts: string[] = [];
  const io: ReviewCliIo = {
    write(message) {
      written.push(message);
    },
    writeError(message) {
      errors.push(message);
    },
    isInteractive: options.interactive ?? true,
    approvalPrompt: {
      ask: async (question) => {
        prompts.push(question);
        return options.answer ?? "no";
      },
    },
  };
  const run = (args: readonly string[]) => runReviewsCli(args, io, async () => composition);
  return {
    run,
    io,
    written,
    errors,
    prompts,
    list,
    get,
    reply,
    order,
    domainCalls,
    checkpointPath,
    auditPath,
    config,
    composition,
  };
}

describe("Review CLI triage with real Phase 3 tools and fake-only boundaries", () => {
  it("normalizes whitespace, bounds to 120 Unicode code points including the ellipsis, and does not mutate source", () => {
    const source = "  two \n words\t" + "😀".repeat(130);
    const excerpt = reviewSnippet(source);
    expect(excerpt).toBe(`two words ${"😀".repeat(109)}…`);
    expect(Array.from(excerpt)).toHaveLength(120);
    expect(source).toContain("\n");
  });
  it("zero changed reviews reports success, never classifies/drafts/approves/publishes", async () => {
    const h = harness({ reviews: [] });
    expect(await h.run(["triage"])).toBe(0);
    expect(h.written.join("\n")).toContain("No new or updated reviews.");
    expect(h.domainCalls).toHaveLength(0);
    expect(h.prompts).toHaveLength(0);
    expect(h.reply).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
    expect(existsSync(h.checkpointPath)).toBe(false);
  });
  it("two new reviews preserve Phase 3.1 order, classify both, show useful fields, persist checkpoint, never publish", async () => {
    const h = harness({
      reviews: [
        remote("r2", "200", "Great app!  PRAISE-PRIVATE-TEXT", 5),
        remote("r1", "100", reviewText, 1),
      ],
    });
    expect(await h.run(["triage"])).toBe(0);
    const displayed = h.written.join("\n");
    expect(displayed.indexOf("r1")).toBeLessThan(displayed.indexOf("r2"));
    expect(displayed).toContain("category=bug");
    expect(displayed).toContain("category=praise");
    expect(displayed).toContain("language=id");
    expect(displayed).toContain("language=en");
    expect(displayed).toContain("stars=1");
    expect(displayed).toContain("stars=5");
    expect(displayed).toContain("changeType=new");
    expect(displayed).toContain("REVIEW-PRIVATE-TEXT");
    expect(h.domainCalls.map((req) => req.tools?.[0]?.name)).toEqual([
      "submit_review_classification",
      "submit_review_classification",
    ]);
    expect(JSON.parse(readFileSync(h.checkpointPath, "utf8"))).toMatchObject({
      version: 1,
      packageName: pkg,
      reviews: { r1: userTime, r2: timestamp("200") },
    });
    expect(h.prompts).toHaveLength(0);
    expect(h.reply).not.toHaveBeenCalled();
    const events = readAuditEntries(h.auditPath);
    expect(
      events
        .filter((entry) => entry.type === "verification.completed")
        .map((entry) => entry.metadata?.code),
    ).toEqual(["VERIFIED", "VERIFICATION_SKIPPED", "VERIFICATION_SKIPPED"]);
    const audit = readFileSync(h.auditPath, "utf8");
    for (const marker of [reviewText, "PRAISE-PRIVATE-TEXT", draft, key, "FAKE-KEY", "safeSummary"])
      expect(audit).not.toContain(marker);
  });
  it("classifies updated reviews; unchanged second triage does not call the model again", async () => {
    const h = harness();
    expect(await h.run(["triage"])).toBe(0);
    h.list.mockImplementation(async () => ({
      data: { reviews: [remote("r1", "101", "New crash report", 1)] },
    }));
    expect(await h.run(["triage"])).toBe(0);
    expect(h.written.at(-1)).toContain("changeType=updated");
    const callsAfterUpdate = h.domainCalls.length;
    expect(await h.run(["triage"])).toBe(0);
    expect(h.written.at(-1)).toContain("No new or updated reviews.");
    expect(h.domainCalls).toHaveLength(callsAfterUpdate);
    expect(h.reply).not.toHaveBeenCalled();
  });
  it("classifier failure names review ID, does not invent a category, and honestly leaves checkpoint advanced", async () => {
    const h = harness({ failClassification: true });
    expect(await h.run(["triage"])).toBe(1);
    expect(h.errors.join("\n")).toContain("r1");
    expect(h.errors.join("\n")).toMatch(/checkpoint.*advanced/i);
    expect(h.written.join("\n")).not.toContain("category=");
    expect(existsSync(h.checkpointPath)).toBe(true);
    expect(h.reply).not.toHaveBeenCalled();
    expect(h.prompts).toHaveLength(0);
    expect(readFileSync(h.auditPath, "utf8")).not.toContain("RAW-LLM-SECRET");
  });
});

describe("Review CLI reply, command-driven; one real Phase 2 publish safety path", () => {
  it("denied draft is shown in full and PUBLIC before approval; no POST or checkpoint", async () => {
    const h = harness({ answer: "no" });
    expect(await h.run(["reply", "r1"])).toBe(2);
    expect(h.order).toEqual(["GET"]);
    expect(h.domainCalls.map((req) => req.tools?.[0]?.name)).toEqual([
      "submit_review_classification",
      "submit_review_reply_draft",
    ]);
    expect(h.written.join("\n")).toContain(reviewText);
    expect(h.written.join("\n")).toContain("category=bug");
    expect(h.written.join("\n")).toContain("language=id");
    expect(h.written.join("\n")).toContain(
      `PUBLIC REPLY DRAFT\n------------------\n${draft}\n------------------`,
    );
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain(draft);
    expect(h.errors.join("\n")).toMatch(/not published/i);
    expect(h.reply).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
    expect(existsSync(h.checkpointPath)).toBe(false);
    const audit = readFileSync(h.auditPath, "utf8");
    for (const marker of [reviewText, draft, key, "FAKE-KEY", "safeSummary", "RAW-LLM-SECRET"])
      expect(audit).not.toContain(marker);
    expect(readAuditEntries(h.auditPath).some((entry) => entry.type === "approval.denied")).toBe(
      true,
    );
  });
  it.each(["", "ok", "true", "n", "No"])(
    "denies without a default approval for answer %j",
    async (answer) => {
      const h = harness({ answer });
      expect(await h.run(["reply", "r1"])).toBe(2);
      expect(h.reply).not.toHaveBeenCalled();
    },
  );
  it("approved exact draft routes through real runAgent approval, one POST, read-back VERIFIED, and safe audit", async () => {
    const h = harness({ answer: "yes" });
    const forbiddenFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("NETWORK_FORBIDDEN");
    });
    const code = await h.run(["reply", "r1"]);
    expect({ code, errors: h.errors, order: h.order }).toEqual({
      code: 0,
      errors: [],
      order: ["GET", "GET", "POST", "GET"],
    });
    expect(h.reply).toHaveBeenCalledTimes(1);
    expect(h.get).toHaveBeenCalledTimes(3);
    expect(h.domainCalls.map((req) => req.tools?.[0]?.name)).toEqual([
      "submit_review_classification",
      "submit_review_reply_draft",
    ]);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain(draft);
    expect(h.written.join("\n")).toContain(
      `PUBLIC REPLY DRAFT\n------------------\n${draft}\n------------------`,
    );
    expect(h.reply.mock.calls[0]?.[0]).toMatchObject({
      reviewId: "r1",
      requestBody: { replyText: draft },
    });
    expect(h.written.at(-1)).toMatch(/VERIFIED/);
    expect(h.written.at(-1)).toContain("r1");
    expect(h.written.at(-1)).not.toContain(draft);
    expect(h.list).not.toHaveBeenCalled();
    expect(existsSync(h.checkpointPath)).toBe(false);
    expect(forbiddenFetch).not.toHaveBeenCalled();
    const audit = readFileSync(h.auditPath, "utf8");
    for (const marker of [
      reviewText,
      draft,
      key,
      "FAKE-KEY",
      "PRIVATE-AUTHOR",
      "safeSummary",
      "authorization",
      "RAW-LLM-SECRET",
    ])
      expect(audit.toLowerCase()).not.toContain(marker.toLowerCase());
    const events = readAuditEntries(h.auditPath);
    expect(events.map((entry) => entry.type)).toContain("approval.approved");
    expect(
      events.filter((entry) => entry.type === "verification.completed").at(-1)?.metadata?.code,
    ).toBe("VERIFIED");
  });
  it("the Phase 2 affirmative form 'y' approves, without weakening the exact draft", async () => {
    const h = harness({ answer: "y" });
    expect(await h.run(["reply", "r1"])).toBe(0);
    expect(h.reply).toHaveBeenCalledTimes(1);
  });
  it("stale user timestamp after approval makes zero POSTs and requires a fresh command", async () => {
    const h = harness({ answer: "yes", staleUser: true });
    expect(await h.run(["reply", "r1"])).toBe(1);
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(h.reply).not.toHaveBeenCalled();
    expect(h.errors.join("\n")).toMatch(/review.*changed/i);
    expect(h.errors.join("\n")).toContain("playops reviews reply");
    expect(h.prompts).toHaveLength(1);
    expect(h.domainCalls).toHaveLength(2);
    expect(h.written.join("\n")).not.toMatch(/Published successfully|status=VERIFIED/i);
  });
  it("existing public reply warns before approval and binds exact existing timestamp; stale edit aborts", async () => {
    const existing = remote("r1", "100", reviewText, 1, {
      text: "old developer reply",
      lastModified: developerTime,
    });
    const h = harness({ reviews: [existing], answer: "yes", staleDeveloper: true });
    expect(await h.run(["reply", "r1"])).toBe(1);
    expect(h.written.join("\n")).toContain(
      "THIS WILL UPDATE/REPLACE AN EXISTING PUBLIC DEVELOPER REPLY",
    );
    expect(h.errors.join("\n")).toMatch(/existing developer reply.*changed/i);
    expect(h.reply).not.toHaveBeenCalled();
  });
  it("post-POST mismatch has uncertain state, nonzero exit and no false success; never retries", async () => {
    const h = harness({ answer: "yes", mismatch: true });
    expect(await h.run(["reply", "r1"])).toBe(1);
    expect(h.order).toEqual(["GET", "GET", "POST", "GET"]);
    expect(h.reply).toHaveBeenCalledTimes(1);
    expect(h.errors.join("\n")).toMatch(
      /could not be verified.*external Google Play state may have changed/i,
    );
    expect(h.written.join("\n")).not.toMatch(/status=VERIFIED|Published successfully/i);
    const event = readAuditEntries(h.auditPath)
      .filter((entry) => entry.type === "agent.tool.execution.failed")
      .at(-1);
    expect(event?.metadata?.externalStateUncertain).toBe(true);
  });
  it("does not publish in a noninteractive terminal or with no approval prompt", async () => {
    const h = harness({ answer: "yes", interactive: false });
    expect(await h.run(["reply", "r1"])).toBe(2);
    expect(h.prompts).toHaveLength(0);
    expect(h.reply).not.toHaveBeenCalled();
    expect(h.errors.join("\n")).toMatch(/approval required/i);
    const second = { ...h.io, approvalPrompt: undefined };
    expect(await runReviewsCli(["reply", "r1"], second, async () => h.composition)).toBe(2);
    expect(h.reply).not.toHaveBeenCalled();
  });
  it("star-only review uses existing und/English fallback without a classifier LLM call", async () => {
    const star = remote("r1", "100", "", 5);
    const starUser = star.comments[0]?.userComment;
    if (!starUser) throw new Error("test fixture missing user comment");
    starUser.reviewerLanguage = "?";
    const h = harness({ reviews: [star], answer: "no", draftText: "Thank you for your feedback." });
    expect(await h.run(["reply", "r1"])).toBe(2);
    expect(h.domainCalls.map((req) => req.tools?.[0]?.name)).toEqual(["submit_review_reply_draft"]);
    expect(h.written.join("\n")).toContain("language=und");
    expect(h.written.join("\n")).toContain("Thank you for your feedback.");
    expect(h.reply).not.toHaveBeenCalled();
  });
  it("existing developer reply may be replaced ONLY with original timestamp bound and verified", async () => {
    const existing = remote("r1", "100", reviewText, 1, {
      text: "old developer reply",
      lastModified: developerTime,
    });
    const h = harness({ reviews: [existing], answer: "yes" });
    expect(await h.run(["reply", "r1"])).toBe(0);
    expect(h.written.join("\n")).toContain(
      "THIS WILL UPDATE/REPLACE AN EXISTING PUBLIC DEVELOPER REPLY",
    );
    expect(h.reply).toHaveBeenCalledTimes(1);
    expect(h.written.at(-1)).toContain("status=VERIFIED");
    const approved = readAuditEntries(h.auditPath).find(
      (event) => event.type === "approval.approved",
    );
    const executed = readAuditEntries(h.auditPath).find(
      (event) =>
        event.type === "agent.tool.execution.completed" && event.action === "reviews.publish_reply",
    );
    expect(approved?.metadata?.requestDigest).toBe(executed?.metadata?.requestDigest);
    expect(existsSync(h.checkpointPath)).toBe(false);
  });
  it("malformed direct GET review stops before classification, drafting and approval", async () => {
    const invalid = remote("r1", "100", reviewText);
    const invalidUser = invalid.comments[0]?.userComment;
    if (!invalidUser) throw new Error("test fixture missing user comment");
    invalidUser.lastModified.seconds = "invalid";
    const h = harness({ reviews: [invalid], answer: "yes" });
    expect(await h.run(["reply", "r1"])).toBe(1);
    expect(h.domainCalls).toHaveLength(0);
    expect(h.prompts).toHaveLength(0);
    expect(h.reply).not.toHaveBeenCalled();
  });
  it("ambiguous POST failure never retries and never prints raw provider errors", async () => {
    const h = harness({ answer: "yes", failPost: true });
    expect(await h.run(["reply", "r1"])).toBe(1);
    expect(h.reply).toHaveBeenCalledTimes(1);
    expect(h.errors.join("\n")).not.toContain("RAW-PROVIDER-SECRET");
    expect(h.errors.join("\n")).toMatch(/external Google Play state may have changed/i);
  });
  it("draft text remains byte-for-byte identical in terminal, approval summary, and POST", async () => {
    const fullDraft = "Line one.\nLine two with emoji 😀 and no truncation.";
    const h = harness({ draftText: fullDraft, answer: "yes" });
    expect(await h.run(["reply", "r1"])).toBe(0);
    expect(h.written.join("\n")).toContain(
      `PUBLIC REPLY DRAFT\n------------------\n${fullDraft}\n------------------`,
    );
    expect(h.prompts[0]).toContain(JSON.stringify(fullDraft));
    expect(h.reply.mock.calls[0]?.[0]).toMatchObject({ requestBody: { replyText: fullDraft } });
  });
});

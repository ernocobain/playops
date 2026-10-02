import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAuditEntries } from "../src/audit/index.js";
import {
  createFileAgentLedger,
  runAgent,
  type AgentApprovalResolver,
} from "../src/runtime/agent/index.js";
import {
  approveInteractively,
  createApprovalChallenge,
  createApprovalRequest,
  resolveApprovalToken,
} from "../src/runtime/approvals/index.js";
import type { LlmAdapter, LlmRequest, LlmResponse } from "../src/runtime/llm/index.js";
import { evaluateToolPermission } from "../src/runtime/permissions/index.js";
import { ToolRegistry } from "../src/runtime/tools/index.js";
import {
  createReviewPublishReplyTool,
  REVIEWS_PUBLISH_REPLY_TOOL_NAME,
} from "../src/reviews/publishing/tool.js";
import type {
  ReviewReplyGateway,
  ReviewReplyPublishInput,
  ReviewReplyRemoteState,
} from "../src/reviews/publishing/index.js";

const pkg = "com.example.fake";
const replyText = "PUBLIC-REPLY-UNIQUE-MARKER: Thank you for reporting this.";
const reviewText = "PRIVATE-REVIEW-TEXT-MARKER";
const secret = "FAKE-SECRET-TOKEN-MARKER";
const user = { seconds: "1700000000", nanos: 100 };
const prior = { seconds: "1700000001", nanos: 12 };
const applied = { seconds: "1700000002", nanos: 23 };
const request: ReviewReplyPublishInput = {
  reviewId: "r1",
  replyText,
  expectedUserLastModified: user,
  expectedDeveloperReplyLastModified: null,
};
const state = (
  developerReply?: ReviewReplyRemoteState["developerReply"],
): ReviewReplyRemoteState => ({
  reviewId: "r1",
  userLastModified: user,
  ...(developerReply ? { developerReply } : {}),
});

function gateway(before: ReviewReplyRemoteState = state(), after?: ReviewReplyRemoteState) {
  const states = [before, after ?? state({ text: replyText, lastModified: applied })];
  const order: string[] = [];
  const getReviewState = vi.fn(async () => {
    order.push("GET");
    return states.shift() ?? before;
  });
  const publishReply = vi.fn(async () => {
    order.push("POST");
    return { replyText, lastEdited: applied };
  });
  return {
    gateway: { getReviewState, publishReply } as ReviewReplyGateway,
    getReviewState,
    publishReply,
    order,
  };
}

function scripted(argumentsForCall: unknown) {
  const requests: LlmRequest[] = [];
  const complete = vi.fn(async (req: LlmRequest): Promise<LlmResponse> => {
    requests.push(req);
    if (requests.length === 1)
      return {
        toolCalls: [
          { id: "c1", name: REVIEWS_PUBLISH_REPLY_TOOL_NAME, arguments: argumentsForCall },
        ],
        usage: { totalTokens: 8 },
      };
    return { content: "Completed.", toolCalls: [], usage: { totalTokens: 5 } };
  });
  return { llm: { provider: "fake", complete } as LlmAdapter, requests, complete };
}

let dir: string;
let auditPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "playops-publish-"));
  auditPath = join(dir, "audit.jsonl");
});
afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
  vi.restoreAllMocks();
});

function approval(decision: "approved" | "denied"): AgentApprovalResolver {
  return {
    resolve: async (approvalRequest) =>
      approveInteractively(
        approvalRequest,
        {
          ask: async (summary) => {
            expect(summary).toContain("PUBLIC");
            expect(summary).toContain(pkg);
            expect(summary).toContain(replyText);
            return decision === "approved" ? "yes" : "no";
          },
        },
        { ledger: createFileAgentLedger(auditPath) },
      ),
  };
}
async function agent(
  g: ReturnType<typeof gateway>,
  args: unknown = request,
  resolver?: AgentApprovalResolver,
) {
  const { tool, binding } = createReviewPublishReplyTool({ packageName: pkg, gateway: g.gateway });
  const registry = new ToolRegistry();
  registry.register(tool);
  const outer = scripted(args);
  const result = await runAgent({
    registry,
    bindings: [binding],
    llm: outer.llm,
    messages: [{ role: "user", content: `Please publish a prepared reply. ${reviewText}` }],
    limits: { maxSteps: 3, maxToolCalls: 1, maxTotalTokens: 100 },
    ledger: createFileAgentLedger(auditPath),
    ...(resolver ? { approvalResolver: resolver } : {}),
  });
  return { result, registry, outer, audit: readAuditEntries(auditPath), tool, binding };
}
function auditIsSafe(): void {
  const text = readFileSync(auditPath, "utf8");
  for (const marker of [
    replyText,
    reviewText,
    secret,
    "safeSummary",
    "Authorization",
    "private_key",
  ])
    expect(text).not.toContain(marker);
  expect(text).toContain("requestDigest");
}

describe("reviews.publish_reply ToolSchema and approval binding", () => {
  it("is a real publish tool with verifier; enforces exact request schemas and hides package from LLM", () => {
    const g = gateway();
    const { tool, binding } = createReviewPublishReplyTool({
      packageName: pkg,
      gateway: g.gateway,
    });
    const registry = new ToolRegistry();
    registry.register(tool);
    expect(registry.get(REVIEWS_PUBLISH_REPLY_TOOL_NAME).permission).toBe("publish");
    expect(evaluateToolPermission(registry.get(REVIEWS_PUBLISH_REPLY_TOOL_NAME)).code).toBe(
      "APPROVAL_REQUIRED",
    );
    expect(typeof registry.get(REVIEWS_PUBLISH_REPLY_TOOL_NAME).verify).toBe("function");
    expect(binding.toolName).toBe("reviews.publish_reply");
    expect(binding.llm.name).toBe(binding.toolName);
    expect(binding.approval?.createRequestDigest).toBeTypeOf("function");
    expect(binding.approval?.createSafeSummary).toBeTypeOf("function");
    expect(JSON.stringify(binding.llm.inputSchema)).not.toMatch(
      /packageName|apiKey|credentials|approval|browser|retryCount/,
    );
    for (const invalid of [
      { ...request, packageName: "com.attacker" },
      { ...request, approval: true },
      { ...request, replyText: "x".repeat(351) },
      { ...request, replyText: "<a href='bad'>x</a>" },
      { ...request, expectedUserLastModified: { seconds: "bad", nanos: 0 } },
    ])
      expect(() => tool.inputSchema.parse(invalid)).toThrow();
    expect(tool.inputSchema.parse(request)).toEqual(request);
    expect(g.getReviewState).not.toHaveBeenCalled();
  });
  it("output schema rejects invalid timestamp, changed text, extra raw Google object, invalid reply text", () => {
    const { tool } = createReviewPublishReplyTool({ packageName: pkg, gateway: gateway().gateway });
    for (const bad of [
      { reviewId: "r1", replyText: "x".repeat(351), lastEdited: applied },
      { reviewId: "r1", replyText, lastEdited: { seconds: "bad", nanos: 0 } },
      { reviewId: "r1", replyText, lastEdited: applied, raw: { auth: secret } },
    ])
      expect(() => tool.outputSchema.parse(bad)).toThrow();
    expect(
      tool.outputSchema.parse({ reviewId: "r1", replyText, lastEdited: applied }),
    ).toMatchObject({ reviewId: "r1" });
  });
  it("SHA-256 digest deterministically binds package, ID, text, both expected timestamps; safe summary shows exact text", () => {
    const { binding } = createReviewPublishReplyTool({
      packageName: pkg,
      gateway: gateway().gateway,
    });
    const digest = (v: unknown) => binding.approval?.createRequestDigest(v);
    const d = digest(request);
    expect(d).toMatch(/^[a-f0-9]{64}$/);
    expect(d).toBe(digest(request));
    expect(d).not.toContain(replyText);
    for (const changed of [
      { ...request, replyText: "Reply B" },
      { ...request, reviewId: "r2" },
      { ...request, expectedUserLastModified: { ...user, nanos: 101 } },
      { ...request, expectedDeveloperReplyLastModified: prior },
      { ...request, expectedDeveloperReplyLastModified: { ...prior, nanos: 13 } },
    ])
      expect(digest(changed)).not.toBe(d);
    const other = createReviewPublishReplyTool({
      packageName: "com.other.fake",
      gateway: gateway().gateway,
    });
    expect(other.binding.approval?.createRequestDigest(request)).not.toBe(d);
    const summary = binding.approval?.createSafeSummary(request);
    expect(summary).toContain("PUBLIC");
    expect(summary).toContain(pkg);
    expect(summary).toContain("r1");
    expect(summary).toContain(replyText);
    expect(summary).not.toContain(secret);
  });
  it("serializer exposes only published/id/time, not reply or package", () => {
    const { binding } = createReviewPublishReplyTool({
      packageName: pkg,
      gateway: gateway().gateway,
    });
    const body = binding.serializeResult({ reviewId: "r1", replyText, lastEdited: applied }, {
      verified: true,
      code: "VERIFIED",
    } as Parameters<typeof binding.serializeResult>[1]);
    expect(JSON.parse(body)).toEqual({ reviewId: "r1", published: true, lastEdited: applied });
    expect(body).not.toContain(replyText);
    expect(body).not.toContain(pkg);
  });
});

describe("real Phase 2 agent integration; every Google operation is a fake gateway", () => {
  it("without resolver: APPROVAL_REQUIRED, no GET or POST, audit denial safe", async () => {
    const g = gateway();
    const { result, audit } = await agent(g);
    expect(result.code).toBe("APPROVAL_REQUIRED");
    expect(result.externalStateUncertain).toBe(false);
    expect(g.order).toEqual([]);
    expect(audit.map((e) => e.type)).toContain("agent.tool.denied");
  });
  it("invalid model input fails before approval or any external read", async () => {
    const g = gateway();
    const resolver = { resolve: vi.fn(approval("approved").resolve) };
    const { result } = await agent(g, { ...request, packageName: "com.attacker.fake" }, resolver);
    expect(result.code).toBe("INPUT_INVALID");
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(g.order).toEqual([]);
  });
  it("denied human approval blocks all GET/POST", async () => {
    const g = gateway();
    const { result, audit } = await agent(g, request, approval("denied"));
    expect(result.code).toBe("APPROVAL_DENIED");
    expect(g.order).toEqual([]);
    expect(audit.map((e) => e.type)).toContain("approval.denied");
    auditIsSafe();
  });
  it("exact interactive approval → GET, POST once, read-back GET, VERIFIED, safe serializer and audit", async () => {
    const g = gateway();
    // The Phase 2 approval ledger must contain a real affirmative decision before
    // the very first Google-side operation, not merely before the POST.
    g.gateway.getReviewState = async () => {
      expect(readAuditEntries(auditPath).some((entry) => entry.type === "approval.approved")).toBe(
        true,
      );
      return g.getReviewState();
    };
    const { result, audit, outer } = await agent(g, request, approval("approved"));
    expect(result.code).toBe("COMPLETED");
    expect(g.order).toEqual(["GET", "POST", "GET"]);
    expect(g.publishReply).toHaveBeenCalledOnce();
    expect(g.publishReply).toHaveBeenCalledWith("r1", replyText);
    const verification = audit.filter((e) => e.type === "verification.completed");
    expect(verification).toHaveLength(1);
    expect(verification[0]?.metadata).toMatchObject({
      status: "passed",
      code: "VERIFIED",
      permission: "publish",
    });
    expect(audit.map((e) => e.type)).toContain("approval.approved");
    const toolMessages = result.conversation.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(JSON.parse(toolMessages[0]?.content ?? "")).toEqual({
      reviewId: "r1",
      published: true,
      lastEdited: applied,
    });
    expect(toolMessages[0]?.content).not.toContain(replyText);
    expect(outer.requests[1]?.messages.at(-1)).toEqual(toolMessages[0]);
    auditIsSafe();
  });
  it("stale user or developer state blocks POST even after human approval", async () => {
    for (const preflight of [
      { ...state(), userLastModified: { ...user, nanos: 101 } },
      state({ text: "new manual reply", lastModified: prior }),
    ]) {
      const g = gateway(preflight);
      const { result } = await agent(g, request, approval("approved"));
      expect(result.code).toBe("EXECUTION_FAILED");
      expect(g.order).toEqual(["GET"]);
      expect(g.publishReply).not.toHaveBeenCalled();
      auditIsSafe();
    }
  });
  it("existing developer reply can be updated only when expected timestamp still matches", async () => {
    const g = gateway(state({ text: "prior reply", lastModified: prior }));
    const args = { ...request, expectedDeveloperReplyLastModified: prior };
    const { result } = await agent(g, args, approval("approved"));
    expect(result.code).toBe("COMPLETED");
    expect(g.order).toEqual(["GET", "POST", "GET"]);
  });
  it("real approval token bound to Reply A cannot authorize Reply B, another ID, or expected timestamp", async () => {
    for (const args of [
      { ...request, replyText: "Reply B" },
      { ...request, reviewId: "r2" },
      { ...request, expectedUserLastModified: { ...user, nanos: 101 } },
    ]) {
      const g = gateway();
      const resolver: AgentApprovalResolver = {
        resolve: async (pending) => {
          const ledger = createFileAgentLedger(auditPath);
          const old = createApprovalRequest(
            {
              toolName: pending.toolName,
              permission: pending.permission,
              requestDigest:
                createReviewPublishReplyTool({
                  packageName: pkg,
                  gateway: g.gateway,
                }).binding.approval?.createRequestDigest(request) ?? "",
              safeSummary: "Fake prior approval for Reply A",
            },
            { ledger, requestId: () => pending.requestId },
          );
          const challenge = createApprovalChallenge(old, { ledger });
          // Same requestId: only the exact requestDigest differs. Phase 2.3 must reject it.
          try {
            return resolveApprovalToken(pending, challenge.rawToken, { ledger });
          } catch (cause) {
            expect(cause).toMatchObject({ code: "TOKEN_REQUEST_MISMATCH" });
            throw cause;
          }
        },
      };
      const { result } = await agent(g, args, resolver);
      expect(result.code).toBe("APPROVAL_DENIED");
      expect(g.order).toEqual([]);
      auditIsSafe();
    }
  });
  it("race: user changes after POST -> VERIFICATION_FAILED, uncertain state, no result to outer LLM", async () => {
    const after = {
      ...state({ text: replyText, lastModified: applied }),
      userLastModified: { ...user, nanos: 101 },
    };
    const g = gateway(state(), after);
    const { result, audit, outer } = await agent(g, request, approval("approved"));
    expect(result.code).toBe("VERIFICATION_FAILED");
    expect(result.externalStateUncertain).toBe(true);
    expect(g.order).toEqual(["GET", "POST", "GET"]);
    expect(outer.complete).toHaveBeenCalledOnce();
    expect(result.conversation.filter((m) => m.role === "tool")).toHaveLength(0);
    expect(audit.filter((e) => e.type === "verification.completed")[0]?.metadata).toMatchObject({
      code: "VERIFICATION_FAILED",
    });
    auditIsSafe();
  });
  it("wrong reply visible after POST fails verification and does not send tool result", async () => {
    const g = gateway(state(), state({ text: "another reply", lastModified: applied }));
    const { result, audit, outer } = await agent(g, request, approval("approved"));
    expect(result.code).toBe("VERIFICATION_FAILED");
    expect(result.externalStateUncertain).toBe(true);
    expect(g.order).toEqual(["GET", "POST", "GET"]);
    expect(outer.complete).toHaveBeenCalledOnce();
    expect(result.conversation.some((message) => message.role === "tool")).toBe(false);
    expect(audit.find((entry) => entry.type === "verification.completed")?.metadata).toMatchObject({
      status: "failed",
    });
  });
  it("invalid POST response after mutation is uncertain and never retried", async () => {
    const g = gateway();
    g.publishReply.mockImplementation(async () => {
      g.order.push("POST");
      return { replyText: "changed remotely", lastEdited: applied };
    });
    const { result, outer } = await agent(g, request, approval("approved"));
    expect(result.code).toBe("EXECUTION_FAILED");
    expect(result.externalStateUncertain).toBe(true);
    expect(g.order).toEqual(["GET", "POST"]);
    expect(outer.complete).toHaveBeenCalledOnce();
  });
  it("ambiguous mutation transport failure -> one POST, externalStateUncertain, no second attempt", async () => {
    const g = gateway();
    g.publishReply.mockImplementation(async () => {
      g.order.push("POST");
      throw Object.assign(new Error(`raw ${secret}`), { status: 429 });
    });
    const { result } = await agent(g, request, approval("approved"));
    expect(result.code).toBe("EXECUTION_FAILED");
    expect(result.externalStateUncertain).toBe(true);
    expect(g.order).toEqual(["GET", "POST"]);
    expect(g.publishReply).toHaveBeenCalledOnce();
    auditIsSafe();
  });
});

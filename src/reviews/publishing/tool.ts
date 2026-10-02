/** Phase 3.4: one explicit high-risk runtime tool. Never auto-publish drafts.
 * Execution is available ONLY through Phase 2's publish-permission approval path in
 * supported agent workflows. Direct invocation of ToolDefinition.execute or the low-
 * level Publisher wrapper is outside that authorization boundary; do not expose them
 * to untrusted callers. No classification, LLM, checkpoint, or browser dependency.
 */
import { createHash } from "node:crypto";
import type { AgentToolBinding } from "../../runtime/agent/index.js";
import type { ToolDefinition, ToolSchema } from "../../runtime/tools/index.js";
import type { VerificationResult } from "../../runtime/verification/index.js";
import {
  parseReviewReplyPublishInput,
  parseReviewReplyPublishResult,
  publishReviewReply,
  verifyPublishedReviewReply,
  ReviewReplyPublishError,
  type ReviewReplyGateway,
  type ReviewReplyPublishInput,
  type ReviewReplyPublishResult,
} from "./index.js";

export const REVIEWS_PUBLISH_REPLY_TOOL_NAME = "reviews.publish_reply";
const TIMESTAMP_SCHEMA = {
  type: "object",
  properties: {
    seconds: { type: "string", pattern: "^-?[0-9]{1,19}$" },
    nanos: { type: "integer", minimum: 0, maximum: 999_999_999 },
  },
  required: ["seconds", "nanos"],
  additionalProperties: false,
};
const inputSchema: ToolSchema<ReviewReplyPublishInput> = { parse: parseReviewReplyPublishInput };
const outputSchema: ToolSchema<ReviewReplyPublishResult> = { parse: parseReviewReplyPublishResult };

export interface ReviewPublishReplyToolOptions {
  readonly packageName: string;
  readonly gateway: ReviewReplyGateway;
}
export interface ReviewPublishReplyTool {
  readonly tool: ToolDefinition<ReviewReplyPublishInput, ReviewReplyPublishResult>;
  readonly binding: AgentToolBinding;
}

/** Binds the app ID in trusted composition, not in LLM/model input. */
export function createReviewPublishReplyTool(
  options: ReviewPublishReplyToolOptions,
): ReviewPublishReplyTool {
  const packageName = options?.packageName;
  const gateway = options?.gateway;
  if (
    typeof packageName !== "string" ||
    packageName.trim() === "" ||
    !gateway ||
    typeof gateway.getReviewState !== "function" ||
    typeof gateway.publishReply !== "function"
  ) {
    throw new ReviewReplyPublishError(
      "INVALID_ARGUMENT",
      "Reply publishing tool configuration is invalid.",
    );
  }
  const description =
    "Publish an existing, already-validated public Google Play review reply for the configured app. Requires exact human approval; checks review state before POST and verifies using reviews.get after.";
  const tool: ToolDefinition<ReviewReplyPublishInput, ReviewReplyPublishResult> = {
    name: REVIEWS_PUBLISH_REPLY_TOOL_NAME,
    description,
    permission: "publish", // public content; can notify a real reviewer
    inputSchema,
    outputSchema,
    async execute(input) {
      return publishReviewReply(gateway, input);
    },
    async verify(input, output) {
      return verifyPublishedReviewReply(gateway, input, output);
    },
  };
  const binding: AgentToolBinding = {
    toolName: REVIEWS_PUBLISH_REPLY_TOOL_NAME,
    llm: {
      name: REVIEWS_PUBLISH_REPLY_TOOL_NAME,
      description,
      inputSchema: {
        type: "object",
        properties: {
          reviewId: { type: "string" },
          replyText: {
            type: "string",
            maxLength: 350,
            description: "Already-drafted exact public plain-text reply.",
          },
          expectedUserLastModified: TIMESTAMP_SCHEMA,
          expectedDeveloperReplyLastModified: { anyOf: [TIMESTAMP_SCHEMA, { type: "null" }] },
        },
        required: [
          "reviewId",
          "replyText",
          "expectedUserLastModified",
          "expectedDeveloperReplyLastModified",
        ],
        additionalProperties: false,
      },
    },
    approval: {
      createRequestDigest(validatedInput: unknown): string {
        const input = inputSchema.parse(validatedInput);
        // Positional JSON tuple is deterministic; null is distinct from an existing timestamp.
        // Hash only — the audit ledger never sees raw reply text.
        const canonical = JSON.stringify([
          1,
          REVIEWS_PUBLISH_REPLY_TOOL_NAME,
          packageName,
          input.reviewId,
          input.replyText,
          input.expectedUserLastModified.seconds,
          input.expectedUserLastModified.nanos,
          input.expectedDeveloperReplyLastModified === null
            ? null
            : [
                input.expectedDeveloperReplyLastModified.seconds,
                input.expectedDeveloperReplyLastModified.nanos,
              ],
        ]);
        return createHash("sha256").update(canonical, "utf8").digest("hex");
      },
      createSafeSummary(validatedInput: unknown): string {
        const input = inputSchema.parse(validatedInput);
        // JSON escaping makes the exact string inspectable without multiline spoofing.
        return `Publish this PUBLIC Google Play reply for app ${JSON.stringify(packageName)}, review ${JSON.stringify(input.reviewId)}:\n${JSON.stringify(input.replyText)}`;
      },
    },
    serializeResult(output: unknown, verification: VerificationResult): string {
      if (verification?.code !== "VERIFIED") {
        throw new ReviewReplyPublishError(
          "PUBLISH_RESPONSE_INVALID",
          "Unverified reply cannot be reported as published.",
        );
      }
      const result = outputSchema.parse(output);
      // The outer LLM does not need the public reply text, package ID, or approval.
      return JSON.stringify({
        reviewId: result.reviewId,
        published: true,
        lastEdited: result.lastEdited,
      });
    },
  };
  return Object.freeze({ tool, binding });
}

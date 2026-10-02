/** Explicit Review Agent commands; no implicit publish or CLI approval bypass. */
import {
  runAgent,
  type AgentApprovalResolver,
  type AgentRunResult,
  type AgentToolBinding,
} from "../runtime/agent/index.js";
import type { LlmAdapter, LlmRequest, LlmResponse } from "../runtime/llm/index.js";
import type { ApprovalPrompt } from "../runtime/approvals/index.js";
import { approveInteractively } from "../runtime/approvals/index.js";
import type { ReviewComposition } from "../reviews/composition.js";
import type {
  ReviewClassification,
  ReviewClassificationInput,
} from "../reviews/classification/index.js";
import type { NormalizedReview } from "../reviews/ingestion/index.js";
import { parseReviewTimestamp } from "../reviews/common.js";
import {
  parseReviewReplyPublishInput,
  ReviewReplyPublishError,
  type ReviewReplyPublishInput,
} from "../reviews/publishing/index.js";

export class ReviewCliError extends Error {
  override readonly name = "ReviewCliError";
  readonly code = "CLI_ARGUMENT_INVALID";
  constructor() {
    super('Invalid reviews command or arguments. Run "playops reviews --help".');
  }
}

export type ReviewCommand =
  | { readonly kind: "help"; readonly topic: "reviews" | "triage" | "reply" }
  | { readonly kind: "triage" }
  | { readonly kind: "reply"; readonly reviewId: string };

/** Positional-only parser. No --yes, --force, or regenerated-draft --approve token. */
export function parseReviewCommand(args: readonly string[]): ReviewCommand {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help"))
    return { kind: "help", topic: "reviews" };
  if (args[0] === "triage") {
    if (args.length === 1) return { kind: "triage" };
    if (args.length === 2 && args[1] === "--help") return { kind: "help", topic: "triage" };
  }
  if (args[0] === "reply") {
    if (args.length === 2 && args[1] === "--help") return { kind: "help", topic: "reply" };
    const id = args[1];
    if (
      args.length === 2 &&
      typeof id === "string" &&
      id.length <= 512 &&
      !id.startsWith("-") &&
      // eslint-disable-next-line no-control-regex -- intentional: reject control chars in review IDs
      /^[^\s\x00-\x1f\x7f]+$/u.test(id)
    )
      return { kind: "reply", reviewId: id };
  }
  throw new ReviewCliError();
}

export interface ReviewCliIo {
  write(message: string): void;
  writeError(message: string): void;
  readonly isInteractive: boolean;
  readonly approvalPrompt?: ApprovalPrompt;
}
export type ReviewCliExitCode = 0 | 1 | 2;
export type ReviewCompositionFactory = () => Promise<ReviewComposition>;

/** Terminal-only Unicode-code-point snippet, preserving the underlying review. */
export function reviewSnippet(text: string): string {
  const readable = text.replace(/\s+/gu, " ").trim();
  if (!readable) return "(no text)";
  const points = Array.from(readable);
  return points.length > 120 ? `${points.slice(0, 119).join("")}…` : readable;
}

function classificationInput(
  review: Pick<
    NormalizedReview,
    "reviewId" | "text" | "originalText" | "starRating" | "reviewerLanguage"
  >,
): ReviewClassificationInput {
  return {
    reviewId: review.reviewId,
    text: review.text,
    ...(review.originalText !== undefined ? { originalText: review.originalText } : {}),
    ...(review.starRating !== undefined ? { starRating: review.starRating } : {}),
    ...(review.reviewerLanguage !== undefined ? { reviewerLanguage: review.reviewerLanguage } : {}),
  };
}

const HELP: Record<"reviews" | "triage" | "reply", string> = {
  reviews:
    "Usage: playops reviews <command>\n\n  reviews triage             Read new/updated reviews and classify them.\n  reviews reply <reviewId>  Draft a reply, show it, request approval, and only then publish and verify it.",
  triage:
    "Usage: playops reviews triage\nRead new/updated reviews and classify them. No reply is drafted or published.",
  reply:
    "Usage: playops reviews reply <reviewId>\nDraft a reply, show it, request approval, and only then publish and verify it. Publishing creates/updates a public Google Play reply and requires explicit human approval (interactive terminal only).",
};

/** A deterministic two-step adapter: never calls a provider or chooses a tool/action. */
function preparedToolAdapter(binding: AgentToolBinding, input: unknown): LlmAdapter {
  let turn = 0;
  return {
    provider: "deterministic-review-cli",
    async complete(request: LlmRequest): Promise<LlmResponse> {
      turn += 1;
      if (turn === 1) {
        return {
          toolCalls: [{ id: "review-step", name: binding.toolName, arguments: input }],
          usage: { totalTokens: 0 },
        };
      }
      const last = request.messages.at(-1);
      if (turn === 2 && last?.role === "tool" && last.toolCallId === "review-step") {
        return { content: "Review step completed.", toolCalls: [], usage: { totalTokens: 0 } };
      }
      throw new ReviewCliError();
    },
  };
}

interface ReviewStep {
  readonly result: AgentRunResult;
  readonly payload?: unknown;
}
/** Every domain tool is executed through real registry/permissions/verification/audit. */
async function runReviewStep(
  composition: ReviewComposition,
  binding: AgentToolBinding,
  input: unknown,
  approvalResolver?: AgentApprovalResolver,
): Promise<ReviewStep> {
  const result = await runAgent({
    llm: preparedToolAdapter(binding, input),
    registry: composition.registry,
    bindings: [binding],
    messages: [{ role: "user", content: "Execute the explicit review command step." }],
    limits: { maxSteps: 2, maxToolCalls: 1, maxTotalTokens: 1 },
    ledger: composition.ledger,
    ...(approvalResolver ? { approvalResolver } : {}),
  });
  if (!result.ok) return { result };
  const messages = result.conversation.filter(
    (item) => item.role === "tool" && item.toolCallId === "review-step",
  );
  if (messages.length !== 1 || messages[0]?.role !== "tool") return { result };
  try {
    return { result, payload: JSON.parse(messages[0].content) as unknown };
  } catch {
    return { result };
  }
}

export async function runReviewsCli(
  args: readonly string[],
  io: ReviewCliIo,
  compositionFactory: ReviewCompositionFactory,
): Promise<ReviewCliExitCode> {
  let command: ReviewCommand;
  try {
    command = parseReviewCommand(args);
  } catch {
    io.writeError('Invalid reviews command or arguments. Run "playops reviews --help".');
    return 1;
  }
  if (command.kind === "help") {
    io.write(HELP[command.topic]);
    return 0;
  }
  let composition: ReviewComposition;
  try {
    composition = await compositionFactory();
  } catch {
    io.writeError(
      "Review command configuration could not be initialized. Check review, LLM, audit, and Google Play settings.",
    );
    return 1;
  }
  if (command.kind === "triage") {
    let step: ReviewStep;
    try {
      step = await runReviewStep(composition, composition.ingestionTool.binding, {});
    } catch {
      io.writeError("Review ingestion could not complete; checkpoint state may need inspection.");
      return 1;
    }
    if (!step.result.ok || step.payload === undefined) {
      io.writeError("Review ingestion failed; checkpoint state may need inspection.");
      return 1;
    }
    let result;
    try {
      result = composition.ingestionTool.tool.outputSchema.parse(step.payload);
    } catch {
      io.writeError("Review ingestion result was invalid; checkpoint state may need inspection.");
      return 1;
    }
    if (result.reviews.length === 0) {
      io.write("No new or updated reviews.");
      return 0;
    }
    for (const review of result.reviews) {
      let classified: ReviewStep;
      try {
        classified = await runReviewStep(
          composition,
          composition.classificationTool.binding,
          classificationInput(review),
        );
      } catch {
        io.writeError(
          `Classification failed for review ${JSON.stringify(review.reviewId)}. The ingestion checkpoint may already have advanced; reply can still fetch the review directly.`,
        );
        return 1;
      }
      if (!classified.result.ok || classified.payload === undefined) {
        io.writeError(
          `Classification failed for review ${JSON.stringify(review.reviewId)} (${classified.result.code}). The ingestion checkpoint may already have advanced; reply can still fetch the review directly.`,
        );
        return 1;
      }
      let category;
      try {
        category = composition.classificationTool.tool.outputSchema.parse(classified.payload);
      } catch {
        io.writeError(
          `Classification failed for review ${JSON.stringify(review.reviewId)}. The ingestion checkpoint may already have advanced.`,
        );
        return 1;
      }
      if (category.reviewId !== review.reviewId) {
        io.writeError(
          `Classification failed for review ${JSON.stringify(review.reviewId)}. The ingestion checkpoint may already have advanced.`,
        );
        return 1;
      }
      io.write(
        `reviewId=${JSON.stringify(review.reviewId)} changeType=${review.changeType}${review.starRating === undefined ? "" : ` stars=${review.starRating}`} language=${category.language} category=${category.category} text=${JSON.stringify(reviewSnippet(review.text || review.originalText || ""))}`,
      );
    }
    return 0;
  }
  const reviewId = command.reviewId;
  let fresh: Awaited<ReturnType<typeof composition.getCurrentReview>>;
  try {
    fresh = await composition.getCurrentReview(reviewId);
  } catch {
    io.writeError(
      `Could not fetch or normalize review ${JSON.stringify(reviewId)}. Nothing was published.`,
    );
    return 1;
  }
  const { review, state } = fresh;
  let classified: ReviewStep;
  try {
    classified = await runReviewStep(
      composition,
      composition.classificationTool.binding,
      classificationInput(review),
    );
  } catch {
    io.writeError(
      `Classification failed for review ${JSON.stringify(reviewId)}. Nothing was published.`,
    );
    return 1;
  }
  if (!classified.result.ok || classified.payload === undefined) {
    io.writeError(
      `Classification failed for review ${JSON.stringify(reviewId)} (${classified.result.code}). Nothing was published.`,
    );
    return 1;
  }
  let category: ReviewClassification;
  try {
    category = composition.classificationTool.tool.outputSchema.parse(classified.payload);
  } catch {
    io.writeError(
      `Classification result invalid for review ${JSON.stringify(reviewId)}. Nothing was published.`,
    );
    return 1;
  }
  if (category.reviewId !== reviewId) {
    io.writeError("Classification review ID mismatch. Nothing was published.");
    return 1;
  }
  const draftInput = { review: classificationInput(review), classification: category };
  let drafted: ReviewStep;
  try {
    drafted = await runReviewStep(composition, composition.draftTool.binding, draftInput);
  } catch {
    io.writeError(`Drafting failed for review ${JSON.stringify(reviewId)}. Nothing was published.`);
    return 1;
  }
  if (!drafted.result.ok || drafted.payload === undefined) {
    io.writeError(
      `Drafting failed for review ${JSON.stringify(reviewId)} (${drafted.result.code}). Nothing was published.`,
    );
    return 1;
  }
  let prepared: ReviewReplyPublishInput;
  try {
    const draft = composition.draftTool.tool.outputSchema.parse(drafted.payload);
    if (
      draft.reviewId !== reviewId ||
      draft.category !== category.category ||
      draft.language !== category.language
    )
      throw new ReviewCliError();
    prepared = parseReviewReplyPublishInput({
      reviewId,
      replyText: draft.replyText,
      expectedUserLastModified: state.userLastModified,
      expectedDeveloperReplyLastModified: state.developerReply?.lastModified ?? null,
    });
  } catch {
    io.writeError(
      `Draft result invalid for review ${JSON.stringify(reviewId)}. Nothing was published.`,
    );
    return 1;
  }
  io.write(
    `Review ${JSON.stringify(reviewId)}${review.starRating === undefined ? "" : ` stars=${review.starRating}`} text=${JSON.stringify(reviewSnippet(review.text || review.originalText || ""))}`,
  );
  io.write(`Classification: category=${category.category} language=${category.language}`);
  if (state.developerReply)
    io.write("THIS WILL UPDATE/REPLACE AN EXISTING PUBLIC DEVELOPER REPLY.");
  else io.write("This will create the first PUBLIC developer reply.");
  io.write(`PUBLIC REPLY DRAFT\n------------------\n${prepared.replyText}\n------------------`);
  const resolver: AgentApprovalResolver | undefined =
    io.isInteractive && io.approvalPrompt
      ? {
          resolve: (request) =>
            approveInteractively(request, io.approvalPrompt as ApprovalPrompt, {
              ledger: composition.ledger,
            }),
        }
      : undefined;
  let published: ReviewStep;
  try {
    published = await runReviewStep(
      composition,
      composition.publishTool.binding,
      prepared,
      resolver,
    );
  } catch {
    io.writeError(
      "Reply publishing could not be verified; external Google Play state may have changed. Inspect manually before retrying.",
    );
    return 1;
  }
  if (
    published.result.code === "APPROVAL_REQUIRED" ||
    published.result.code === "APPROVAL_DENIED"
  ) {
    io.writeError(
      published.result.code === "APPROVAL_REQUIRED"
        ? "Explicit interactive approval required; reply not published."
        : "Approval denied or cancelled; reply not published.",
    );
    return 2;
  }
  if (!published.result.ok || published.payload === undefined) {
    const cause = published.result.cause;
    if (
      cause instanceof ReviewReplyPublishError &&
      (cause.code === "REVIEW_CHANGED" || cause.code === "DEVELOPER_REPLY_CHANGED")
    ) {
      io.writeError(
        `${cause.code === "REVIEW_CHANGED" ? "User review" : "Existing developer reply"} changed since the draft was prepared; draft not published. Rerun playops reviews reply ${JSON.stringify(reviewId)} for a fresh draft.`,
      );
      return 1;
    }
    io.writeError(
      "Reply publishing could not be verified; external Google Play state may have changed. Inspect manually before retrying.",
    );
    return 1;
  }
  try {
    const result = published.payload as Record<string, unknown>;
    if (result.reviewId !== reviewId || result.published !== true) throw new ReviewCliError();
    const lastEdited = parseReviewTimestamp(result.lastEdited);
    if (!lastEdited) throw new ReviewCliError();
    io.write(
      `reviewId=${JSON.stringify(reviewId)} status=VERIFIED lastEdited=${lastEdited.seconds}s/${lastEdited.nanos}ns`,
    );
    return 0;
  } catch {
    io.writeError(
      "Reply publishing result invalid; external Google Play state may have changed. Inspect manually.",
    );
    return 1;
  }
}

/** Phase 3.5 review composition root: one Google Publisher client and one domain LLM.
 * Domain modules remain ignorant of config, environment and terminal streams.
 */
import { loadConfig, loadServiceAccountCredentials, type PlayOpsConfig } from "../config/index.js";
import { ANDROID_PUBLISHER_SCOPE, createGoogleAuthClient } from "../googleplay/auth/index.js";
import {
  createAndroidPublisherClient,
  getReview,
  type AndroidPublisherClient,
} from "../googleplay/publisher/index.js";
import { createFileAgentLedger, type AgentToolBinding } from "../runtime/agent/index.js";
import type { LlmAdapter } from "../runtime/llm/index.js";
import { create9RouterAdapter } from "../runtime/llm/providers/9router/index.js";
import { ToolRegistry } from "../runtime/tools/index.js";
import { createLlmReviewClassifier } from "./classification/index.js";
import { createReviewClassificationTool } from "./classification/tool.js";
import { compareReviewTimestamps, ReviewIngestionError } from "./common.js";
import { createFileReviewCheckpointStore, type ReviewCheckpointStore } from "./checkpoint/index.js";
import { createLlmReviewReplyDrafter } from "./drafting/index.js";
import { createReviewDraftReplyTool } from "./drafting/tool.js";
import {
  normalizeRemoteReview,
  type NormalizedReview,
  type ReviewSource,
} from "./ingestion/index.js";
import { createAndroidPublisherReplyGateway } from "./publishing/androidpublisher.js";
import {
  normalizeReviewReplyRemoteState,
  type ReviewReplyGateway,
  type ReviewReplyRemoteState,
} from "./publishing/index.js";
import { createReviewPublishReplyTool } from "./publishing/tool.js";
import { createAndroidPublisherReviewSource } from "./source/androidpublisher.js";
import { createReviewIngestionTool } from "./tool.js";

/** Fixed-message configuration failure; raw values, paths and keys are never echoed. */
export class ReviewCompositionError extends Error {
  override readonly name = "ReviewCompositionError";
  readonly code = "CONFIG_INVALID";
}

/** Validate the complete command configuration before credentials or any mutation. */
export function validateReviewConfig(config: PlayOpsConfig): void {
  const invalid = (key: string): never => {
    throw new ReviewCompositionError(`Review CLI requires valid ${key}.`);
  };
  if (
    !config ||
    !config.googlePlay ||
    typeof config.googlePlay.packageName !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(config.googlePlay.packageName)
  )
    invalid("google_play.package_name");
  if (
    typeof config.googlePlay.serviceAccountJson !== "string" ||
    !config.googlePlay.serviceAccountJson.trim()
  )
    invalid("google_play.service_account_json");
  if (!config.audit || typeof config.audit.logPath !== "string" || !config.audit.logPath.trim())
    invalid("audit.log_path");
  if (
    !config.review ||
    typeof config.review.checkpointPath !== "string" ||
    !config.review.checkpointPath.trim()
  )
    invalid("review.checkpoint_path");
  const llm = config.llm?.nineRouter;
  const modelInvalid =
    !llm ||
    typeof llm.model !== "string" ||
    !llm.model.trim() ||
    /[\x00-\x1f\x7f]/u.test(llm.model); // eslint-disable-line no-control-regex -- intentional: reject control chars in model names
  if (modelInvalid) invalid("llm.nine_router.model");
  if (typeof llm.baseUrl !== "string" || !llm.baseUrl.trim()) invalid("llm.nine_router.base_url");
  let url: URL;
  try {
    url = new URL(llm.baseUrl);
  } catch {
    return invalid("llm.nine_router.base_url");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    /\s/u.test(llm.baseUrl)
  )
    invalid("llm.nine_router.base_url");
  if (llm.apiKey !== undefined && typeof llm.apiKey !== "string")
    invalid("llm.nine_router.api_key");
  if (!config.agent || !Number.isInteger(config.agent.maxSteps) || config.agent.maxSteps < 2)
    invalid("agent.max_steps (minimum 2)");
}

export interface FreshReview {
  /** Phase 3.1 normalization; no fabricated ingestion changeType on direct GET. */
  readonly review: Omit<NormalizedReview, "changeType">;
  /** Phase 3.4 strict state (including existing developer reply) for optimistic publish. */
  readonly state: ReviewReplyRemoteState;
}
export interface ReviewComposition {
  readonly packageName: string;
  readonly source: ReviewSource;
  readonly gateway: ReviewReplyGateway;
  readonly checkpointStore: ReviewCheckpointStore;
  readonly registry: ToolRegistry;
  readonly bindings: readonly AgentToolBinding[];
  readonly ledger: ReturnType<typeof createFileAgentLedger>;
  readonly ingestionTool: ReturnType<typeof createReviewIngestionTool>;
  readonly classificationTool: ReturnType<typeof createReviewClassificationTool>;
  readonly draftTool: ReturnType<typeof createReviewDraftReplyTool>;
  readonly publishTool: ReturnType<typeof createReviewPublishReplyTool>;
  getCurrentReview(reviewId: string): Promise<FreshReview>;
}

/** Shared construction for production and fake-only tests; one client and adapter. */
export function createReviewComposition(
  config: PlayOpsConfig,
  deps: { readonly publisher: AndroidPublisherClient; readonly llm: LlmAdapter },
): ReviewComposition {
  validateReviewConfig(config);
  const packageName = config.googlePlay.packageName;
  const publisher = deps.publisher;
  const source = createAndroidPublisherReviewSource(publisher);
  const gateway = createAndroidPublisherReplyGateway(publisher, packageName);
  const checkpointStore = createFileReviewCheckpointStore(config.review.checkpointPath);
  const classifier = createLlmReviewClassifier({ llm: deps.llm });
  const drafter = createLlmReviewReplyDrafter({ llm: deps.llm });
  const ingestionTool = createReviewIngestionTool({ packageName, source, checkpointStore });
  const classificationTool = createReviewClassificationTool({ classifier });
  const draftTool = createReviewDraftReplyTool({ drafter });
  const publishTool = createReviewPublishReplyTool({ packageName, gateway });
  const registry = new ToolRegistry();
  registry.register(ingestionTool.tool);
  registry.register(classificationTool.tool);
  registry.register(draftTool.tool);
  registry.register(publishTool.tool);
  const bindings = Object.freeze([
    ingestionTool.binding,
    classificationTool.binding,
    draftTool.binding,
    publishTool.binding,
  ]);
  const ledger = createFileAgentLedger(config.audit.logPath);
  return Object.freeze({
    packageName,
    source,
    gateway,
    checkpointStore,
    registry,
    bindings,
    ledger,
    ingestionTool,
    classificationTool,
    draftTool,
    publishTool,
    async getCurrentReview(reviewId: string): Promise<FreshReview> {
      // One actual reviews.get, shared by display/classification/drafting/state capture.
      const raw = await getReview(publisher, { packageName, reviewId });
      const observed = normalizeRemoteReview(raw);
      const state = normalizeReviewReplyRemoteState(raw, reviewId);
      if (
        observed.reviewId !== reviewId ||
        compareReviewTimestamps(observed.userLastModified, state.userLastModified) !== 0
      ) {
        throw new ReviewIngestionError(
          "REMOTE_DATA_INVALID",
          "Fetched review identity/state is invalid.",
        );
      }
      const review = Object.freeze({
        reviewId: observed.reviewId,
        userLastModified: observed.userLastModified,
        ...observed.fields,
      });
      return Object.freeze({ review, state });
    },
  });
}

/** Only composition knows the concrete 9Router provider and credential/config loaders. */
export interface LiveReviewFactories {
  readonly loadConfig?: typeof loadConfig;
  readonly loadCredentials?: typeof loadServiceAccountCredentials;
  readonly authenticate?: typeof createGoogleAuthClient;
  readonly createPublisher?: typeof createAndroidPublisherClient;
  readonly createLlm?: typeof create9RouterAdapter;
}
export async function createLiveReviewComposition(
  factories: LiveReviewFactories = {},
): Promise<ReviewComposition> {
  const config = (factories.loadConfig ?? loadConfig)();
  validateReviewConfig(config); // before credentials, auth, provider, or Publisher creation
  const credentials = (factories.loadCredentials ?? loadServiceAccountCredentials)(config);
  const auth = (factories.authenticate ?? createGoogleAuthClient)(credentials, [
    ANDROID_PUBLISHER_SCOPE,
  ]);
  const publisher = (factories.createPublisher ?? createAndroidPublisherClient)(auth);
  const llm = (factories.createLlm ?? create9RouterAdapter)(config.llm.nineRouter);
  return createReviewComposition(config, { publisher, llm });
}

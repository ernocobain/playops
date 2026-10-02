import {
  loadConfig,
  loadServiceAccountCredentials,
  type PlayOpsConfig,
  type ServiceAccountCredentials,
} from "../config/index.js";
import {
  ANDROID_PUBLISHER_SCOPE,
  createGoogleAuthClient,
  type GoogleAuthClient,
} from "../googleplay/auth/index.js";
import {
  createAndroidPublisherClient,
  type AndroidPublisherClient,
} from "../googleplay/publisher/index.js";
import { createFileAgentLedger, type AgentToolBinding } from "../runtime/agent/index.js";
import { ToolRegistry } from "../runtime/tools/index.js";
import { createAndroidPublisherReleaseGateway } from "./androidpublisher.js";
import {
  createReleaseBundleUploadTool,
  type ReleaseBundleUploadToolOptions,
} from "./bundle-upload-tool.js";
import {
  createReleaseVersionCodeVerificationTool,
  type ReleaseVersionCodeVerificationToolOptions,
} from "./version-code-tool.js";
import {
  createReleaseTargetTrackInspectionTool,
  type ReleaseTargetTrackInspectionToolOptions,
} from "./target-track-tool.js";
import {
  createReleaseConfigureReleaseTool,
  type ReleaseConfigureReleaseToolOptions,
} from "./configure-release-tool.js";
import {
  createReleaseNotesAttachmentTool,
  type ReleaseNotesAttachmentToolOptions,
} from "./release-notes-tool.js";
import {
  createReleaseEditValidationTool,
  type EditValidationToolOptions,
} from "./validate-edit-tool.js";
import { ReleaseError, validateReleasePackageName, type ReleaseBundle } from "./index.js";
import type { ReleaseGooglePlayGateway } from "./gateway.js";
import { createReleaseCommitTool, type ReleaseCommitToolOptions } from "./commit-edit-tool.js";
import {
  createReleaseSummaryInspectionTool,
  type ReleaseSummaryInspectionToolOptions,
} from "./inspect-committed-release-tool.js";
import {
  createReleaseExactVerificationTool,
  type ReleaseExactVerificationToolOptions,
} from "./verify-committed-release-tool.js";
import { createReleaseVerificationIntent } from "./readback-approval.js";
import { createReleaseRolloutTool, type ReleaseRolloutToolOptions } from "./rollout-tool.js";
import type { ReleaseRolloutIntent } from "./rollout-approval.js";
import {
  createReleaseStatusControlTool,
  type ReleaseStatusControlToolOptions,
} from "./status-control-tool.js";
import type { ReleaseStatusControlIntent } from "./status-control-approval.js";
import { createReleaseEditOpenTool } from "./open-tool.js";
import {
  createFileReleaseEditCleanupJournal,
  type ReleaseEditCleanupJournal,
} from "./cleanup-journal.js";
import { createReleaseEditHygieneTool } from "./hygiene-tool.js";
import { createReleaseEditCleanupTool, type ReleaseEditCleanupCandidate } from "./cleanup-tool.js";
import {
  createFileReleaseEditSessionStore,
  type ReleaseEditSessionStore,
} from "./session-store.js";
import { createReleaseInspectionTool } from "./tool.js";

/** Fixed safe message; configuration values and credential paths are not echoed. */
export class ReleaseCompositionError extends Error {
  override readonly name = "ReleaseCompositionError";
  readonly code = "CONFIG_INVALID";
}

export interface ReleaseCompositionOptions {
  /** Operation-scoped operator input; it is not persisted in PlayOpsConfig. */
  readonly bundleUpload?: Pick<ReleaseBundleUploadToolOptions, "artifactPath">;
  /** Operation-scoped Phase 4.3 identity and operator-selected track; not config or model input. */
  readonly versionCodeVerification?: Pick<
    ReleaseVersionCodeVerificationToolOptions,
    "targetTrack"
  > & { readonly uploadedBundle: ReleaseBundle };
  /** Operation-scoped operator-selected track; never model/config input. */
  readonly targetTrackInspection?: Pick<ReleaseTargetTrackInspectionToolOptions, "targetTrack">;
  /** Operation-scoped Phase 4.6 release intent and verified bundle identity. */
  readonly configureRelease?: Pick<
    ReleaseConfigureReleaseToolOptions,
    | "targetTrack"
    | "releaseName"
    | "releaseStatus"
    | "initialRolloutFraction"
    | "uploadedBundle"
    | "retainVersionCodes"
  >;
  /** Operation-scoped Phase 4.7 notes and Phase 4.6 configured-release identity. */
  readonly attachReleaseNotes?: Pick<
    ReleaseNotesAttachmentToolOptions,
    "targetTrack" | "configuredRelease" | "uploadedBundle" | "localizedReleaseNotes"
  >;
  /** Operation-scoped exact Phase 4.9 intent for the Phase 4.10 publish boundary. */
  readonly commitEdit?: Pick<ReleaseCommitToolOptions, "intent">;
  /** Operation-scoped exact Phase 4.9 intent for safe Phase 4.11 Layer A. */
  readonly inspectCommittedRelease?: Pick<ReleaseCommitToolOptions, "intent">;
  /** Operation-scoped exact Phase 4.9 intent for destructive Phase 4.11 Layer B. */
  readonly verifyCommittedRelease?: Pick<ReleaseCommitToolOptions, "intent">;
  /** Operation-scoped exact Phase 4.12 staged-rollout advancement. */
  readonly updateRolloutFraction?: Pick<ReleaseRolloutToolOptions, "intent"> & {
    readonly intent: ReleaseRolloutIntent;
  };
  /** Operation-scoped exact Phase 4.13 HALT status-control intent. */
  readonly haltRollout?: Pick<ReleaseStatusControlToolOptions, "intent"> & {
    readonly intent: ReleaseStatusControlIntent;
  };
  /** Operation-scoped exact Phase 4.13 RESUME status-control intent. */
  readonly resumeRollout?: Pick<ReleaseStatusControlToolOptions, "intent"> & {
    readonly intent: ReleaseStatusControlIntent;
  };
  /**
   * Phase 4.15: the exact known edit record to abandon (managed session record or
   * one journalled verification-edit record). Trusted operator/composition input;
   * never model-selected and never a wildcard.
   */
  readonly cleanupKnownEdit?: { readonly candidate: ReleaseEditCleanupCandidate };
}

export interface ReleaseComposition {
  readonly packageName: string;
  readonly gateway: ReleaseGooglePlayGateway;
  readonly store: ReleaseEditSessionStore;
  readonly registry: ToolRegistry;
  readonly openTool: ReturnType<typeof createReleaseEditOpenTool>["tool"];
  readonly openBinding: AgentToolBinding;
  readonly inspectTool: ReturnType<typeof createReleaseInspectionTool>["tool"];
  readonly inspectBinding: AgentToolBinding;
  readonly bundleUploadTool?: ReturnType<typeof createReleaseBundleUploadTool>["tool"];
  readonly bundleUploadBinding?: AgentToolBinding;
  readonly versionCodeVerificationTool?: ReturnType<
    typeof createReleaseVersionCodeVerificationTool
  >["tool"];
  readonly versionCodeVerificationBinding?: AgentToolBinding;
  readonly targetTrackInspectionTool?: ReturnType<
    typeof createReleaseTargetTrackInspectionTool
  >["tool"];
  readonly targetTrackInspectionBinding?: AgentToolBinding;
  readonly configureReleaseTool?: ReturnType<typeof createReleaseConfigureReleaseTool>["tool"];
  readonly configureReleaseBinding?: AgentToolBinding;
  readonly attachReleaseNotesTool?: ReturnType<typeof createReleaseNotesAttachmentTool>["tool"];
  readonly attachReleaseNotesBinding?: AgentToolBinding;
  readonly validateEditTool: ReturnType<typeof createReleaseEditValidationTool>["tool"];
  readonly validateEditBinding: AgentToolBinding;
  readonly commitEditTool?: ReturnType<typeof createReleaseCommitTool>["tool"];
  readonly commitEditBinding?: AgentToolBinding;
  readonly inspectCommittedReleaseTool?: ReturnType<
    typeof createReleaseSummaryInspectionTool
  >["tool"];
  readonly inspectCommittedReleaseBinding?: AgentToolBinding;
  readonly verifyCommittedReleaseTool?: ReturnType<
    typeof createReleaseExactVerificationTool
  >["tool"];
  readonly verifyCommittedReleaseBinding?: AgentToolBinding;
  readonly updateRolloutFractionTool?: ReturnType<typeof createReleaseRolloutTool>["tool"];
  readonly updateRolloutFractionBinding?: AgentToolBinding;
  readonly haltRolloutTool?: ReturnType<typeof createReleaseStatusControlTool>["tool"];
  readonly haltRolloutBinding?: AgentToolBinding;
  readonly resumeRolloutTool?: ReturnType<typeof createReleaseStatusControlTool>["tool"];
  readonly resumeRolloutBinding?: AgentToolBinding;
  /** Phase 4.15 durable known-edit journal, when the operator configured one. */
  readonly cleanupJournal?: ReleaseEditCleanupJournal;
  readonly inspectEditHygieneTool?: ReturnType<typeof createReleaseEditHygieneTool>["tool"];
  readonly inspectEditHygieneBinding?: AgentToolBinding;
  readonly cleanupKnownEditTool?: ReturnType<typeof createReleaseEditCleanupTool>["tool"];
  readonly cleanupKnownEditBinding?: AgentToolBinding;
  readonly ledger: ReturnType<typeof createFileAgentLedger>;
}

function validateReleaseConfig(config: PlayOpsConfig): string {
  if (!config || !config.googlePlay || !config.audit || !config.release) {
    throw new ReleaseCompositionError(
      "Release operations require valid Google Play, audit, and release configuration.",
    );
  }
  let packageName: string;
  try {
    packageName = validateReleasePackageName(config.googlePlay.packageName);
  } catch (cause) {
    throw new ReleaseCompositionError(
      "Release operations require a valid Google Play package name.",
      {
        cause,
      },
    );
  }
  if (
    typeof config.googlePlay.serviceAccountJson !== "string" ||
    config.googlePlay.serviceAccountJson.trim() === ""
  ) {
    throw new ReleaseCompositionError(
      "Release operations require a service-account credential path.",
    );
  }
  if (typeof config.audit.logPath !== "string" || config.audit.logPath.trim() === "") {
    throw new ReleaseCompositionError("Release operations require an audit log path.");
  }
  if (
    typeof config.release.editSessionPath !== "string" ||
    config.release.editSessionPath.trim() === ""
  ) {
    // No implicit default: the tracked edit session path is operator configuration.
    throw new ReleaseCompositionError("Release operations require an edit session path.");
  }
  return packageName;
}

/** Compose fake and live clients through the same real Phase 2 tool boundary. */
export function createReleaseComposition(
  config: PlayOpsConfig,
  deps: { readonly publisher: AndroidPublisherClient; readonly now?: () => Date },
  options: ReleaseCompositionOptions = {},
): ReleaseComposition {
  const packageName = validateReleaseConfig(config);
  if (!deps?.publisher) {
    throw new ReleaseCompositionError("Release operations require an Android Publisher client.");
  }
  const gateway = createAndroidPublisherReleaseGateway(deps.publisher, packageName);
  const store = createFileReleaseEditSessionStore(config.release.editSessionPath, {
    expectedPackageName: packageName,
  });
  // Phase 4.15: the durable known-edit journal is operator configuration. It is
  // optional overall, but every journal-backed capability below requires it, so a
  // requested journal-backed capability without a configured path fails closed.
  const cleanupJournal =
    typeof config.release.editCleanupJournalPath === "string" &&
    config.release.editCleanupJournalPath.trim() !== ""
      ? createFileReleaseEditCleanupJournal(config.release.editCleanupJournalPath, {
          expectedPackageName: packageName,
        })
      : undefined;
  if (
    cleanupJournal === undefined &&
    (options.verifyCommittedRelease !== undefined ||
      options.updateRolloutFraction !== undefined ||
      options.haltRollout !== undefined ||
      options.resumeRollout !== undefined ||
      options.cleanupKnownEdit !== undefined)
  ) {
    throw new ReleaseCompositionError(
      "Release operations require an edit cleanup journal path for journal-backed release capabilities.",
    );
  }
  const ledger = createFileAgentLedger(config.audit.logPath);
  const open = createReleaseEditOpenTool({
    packageName,
    gateway,
    store,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const inspect = createReleaseInspectionTool({
    packageName,
    gateway,
    store,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const bundleUpload = options.bundleUpload
    ? createReleaseBundleUploadTool({
        packageName,
        ...options.bundleUpload,
        gateway,
        sessionStore: store,
        ...(deps.now ? { now: deps.now } : {}),
      })
    : undefined;
  const versionCodeVerification = options.versionCodeVerification
    ? createReleaseVersionCodeVerificationTool({
        packageName,
        targetTrack: options.versionCodeVerification.targetTrack,
        uploadedBundle: options.versionCodeVerification.uploadedBundle,
        gateway,
        sessionStore: store,
        ...(deps.now ? { now: deps.now } : {}),
      })
    : undefined;
  const targetTrackInspection = options.targetTrackInspection
    ? createReleaseTargetTrackInspectionTool({
        packageName,
        targetTrack: options.targetTrackInspection.targetTrack,
        gateway,
        sessionStore: store,
        ...(deps.now ? { now: deps.now } : {}),
      })
    : undefined;
  const configureRelease = options.configureRelease
    ? createReleaseConfigureReleaseTool({
        packageName,
        ...options.configureRelease,
        gateway,
        sessionStore: store,
        ...(deps.now ? { now: deps.now } : {}),
      })
    : undefined;
  const attachReleaseNotes = options.attachReleaseNotes
    ? createReleaseNotesAttachmentTool({
        packageName,
        ...options.attachReleaseNotes,
        gateway,
        sessionStore: store,
        ...(deps.now ? { now: deps.now } : {}),
      })
    : undefined;
  const validateEdit = createReleaseEditValidationTool({
    packageName,
    gateway,
    sessionStore: store,
    ...(deps.now ? { now: deps.now } : {}),
  } satisfies EditValidationToolOptions);
  const commitEdit = options.commitEdit
    ? createReleaseCommitTool({
        packageName,
        intent: options.commitEdit.intent,
        gateway,
        sessionStore: store,
        auditLedger: ledger,
        ...(deps.now ? { now: deps.now } : {}),
      })
    : undefined;
  const inspectCommittedRelease = options.inspectCommittedRelease
    ? createReleaseSummaryInspectionTool({
        packageName,
        intent: createReleaseVerificationIntent(options.inspectCommittedRelease.intent),
        gateway,
        auditLedger: ledger,
        ...(deps.now ? { now: deps.now } : {}),
      } satisfies ReleaseSummaryInspectionToolOptions)
    : undefined;
  const verifyCommittedRelease =
    options.verifyCommittedRelease && cleanupJournal
      ? createReleaseExactVerificationTool({
          packageName,
          intent: createReleaseVerificationIntent(options.verifyCommittedRelease.intent),
          summaryGateway: gateway,
          temporaryEditGateway: gateway,
          sessionStore: store,
          cleanupJournal,
          auditLedger: ledger,
          ...(deps.now ? { now: deps.now } : {}),
        } satisfies ReleaseExactVerificationToolOptions)
      : undefined;
  const updateRolloutFraction =
    options.updateRolloutFraction && cleanupJournal
      ? createReleaseRolloutTool({
          packageName,
          intent: options.updateRolloutFraction.intent,
          gateway,
          sessionStore: store,
          cleanupJournal,
          auditLedger: ledger,
          ...(deps.now ? { now: deps.now } : {}),
        })
      : undefined;
  const haltRollout =
    options.haltRollout && cleanupJournal
      ? createReleaseStatusControlTool({
          packageName,
          intent: options.haltRollout.intent,
          gateway,
          sessionStore: store,
          cleanupJournal,
          auditLedger: ledger,
          ...(deps.now ? { now: deps.now } : {}),
        })
      : undefined;
  const resumeRollout =
    options.resumeRollout && cleanupJournal
      ? createReleaseStatusControlTool({
          packageName,
          intent: options.resumeRollout.intent,
          gateway,
          sessionStore: store,
          cleanupJournal,
          auditLedger: ledger,
          ...(deps.now ? { now: deps.now } : {}),
        })
      : undefined;
  // Phase 4.15 read-only hygiene report; available whenever a journal is configured.
  const inspectEditHygiene = cleanupJournal
    ? createReleaseEditHygieneTool({
        packageName,
        gateway,
        store,
        cleanupJournal,
        ...(deps.now ? { now: deps.now } : {}),
      })
    : undefined;
  // Phase 4.15 exact-record abandonment; requires a trusted candidate binding.
  const cleanupKnownEdit =
    options.cleanupKnownEdit && cleanupJournal
      ? createReleaseEditCleanupTool({
          packageName,
          candidate: options.cleanupKnownEdit.candidate,
          gateway,
          sessionStore: store,
          cleanupJournal,
          ...(deps.now ? { now: deps.now } : {}),
        })
      : undefined;
  const registry = new ToolRegistry();
  registry.register(open.tool);
  registry.register(inspect.tool);
  if (bundleUpload) registry.register(bundleUpload.tool);
  if (versionCodeVerification) registry.register(versionCodeVerification.tool);
  if (targetTrackInspection) registry.register(targetTrackInspection.tool);
  if (configureRelease) registry.register(configureRelease.tool);
  if (attachReleaseNotes) registry.register(attachReleaseNotes.tool);
  registry.register(validateEdit.tool);
  if (commitEdit) registry.register(commitEdit.tool);
  if (inspectCommittedRelease) registry.register(inspectCommittedRelease.tool);
  if (verifyCommittedRelease) registry.register(verifyCommittedRelease.tool);
  if (updateRolloutFraction) registry.register(updateRolloutFraction.tool);
  if (haltRollout) registry.register(haltRollout.tool);
  if (resumeRollout) registry.register(resumeRollout.tool);
  if (inspectEditHygiene) registry.register(inspectEditHygiene.tool);
  if (cleanupKnownEdit) registry.register(cleanupKnownEdit.tool);
  return Object.freeze({
    packageName,
    gateway,
    store,
    registry,
    openTool: open.tool,
    openBinding: open.binding,
    inspectTool: inspect.tool,
    inspectBinding: inspect.binding,
    ...(bundleUpload
      ? {
          bundleUploadTool: bundleUpload.tool,
          bundleUploadBinding: bundleUpload.binding,
        }
      : {}),
    ...(versionCodeVerification
      ? {
          versionCodeVerificationTool: versionCodeVerification.tool,
          versionCodeVerificationBinding: versionCodeVerification.binding,
        }
      : {}),
    ...(targetTrackInspection
      ? {
          targetTrackInspectionTool: targetTrackInspection.tool,
          targetTrackInspectionBinding: targetTrackInspection.binding,
        }
      : {}),
    ...(configureRelease
      ? {
          configureReleaseTool: configureRelease.tool,
          configureReleaseBinding: configureRelease.binding,
        }
      : {}),
    ...(attachReleaseNotes
      ? {
          attachReleaseNotesTool: attachReleaseNotes.tool,
          attachReleaseNotesBinding: attachReleaseNotes.binding,
        }
      : {}),
    validateEditTool: validateEdit.tool,
    validateEditBinding: validateEdit.binding,
    ...(commitEdit
      ? {
          commitEditTool: commitEdit.tool,
          commitEditBinding: commitEdit.binding,
        }
      : {}),
    ...(inspectCommittedRelease
      ? {
          inspectCommittedReleaseTool: inspectCommittedRelease.tool,
          inspectCommittedReleaseBinding: inspectCommittedRelease.binding,
        }
      : {}),
    ...(verifyCommittedRelease
      ? {
          verifyCommittedReleaseTool: verifyCommittedRelease.tool,
          verifyCommittedReleaseBinding: verifyCommittedRelease.binding,
        }
      : {}),
    ...(updateRolloutFraction
      ? {
          updateRolloutFractionTool: updateRolloutFraction.tool,
          updateRolloutFractionBinding: updateRolloutFraction.binding,
        }
      : {}),
    ...(haltRollout
      ? {
          haltRolloutTool: haltRollout.tool,
          haltRolloutBinding: haltRollout.binding,
        }
      : {}),
    ...(resumeRollout
      ? {
          resumeRolloutTool: resumeRollout.tool,
          resumeRolloutBinding: resumeRollout.binding,
        }
      : {}),
    ...(cleanupJournal ? { cleanupJournal } : {}),
    ...(inspectEditHygiene
      ? {
          inspectEditHygieneTool: inspectEditHygiene.tool,
          inspectEditHygieneBinding: inspectEditHygiene.binding,
        }
      : {}),
    ...(cleanupKnownEdit
      ? {
          cleanupKnownEditTool: cleanupKnownEdit.tool,
          cleanupKnownEditBinding: cleanupKnownEdit.binding,
        }
      : {}),
    ledger,
  });
}

export interface LiveReleaseFactories {
  readonly loadConfig?: typeof loadConfig;
  readonly loadCredentials?: typeof loadServiceAccountCredentials;
  readonly authenticate?: typeof createGoogleAuthClient;
  readonly createPublisher?: (auth: GoogleAuthClient) => AndroidPublisherClient;
}

/** One config load, credential load, auth client, and existing Android Publisher client. */
export async function createLiveReleaseComposition(
  factories: LiveReleaseFactories = {},
  options: ReleaseCompositionOptions = {},
): Promise<ReleaseComposition> {
  let config: PlayOpsConfig;
  let packageName: string;
  try {
    config = (factories.loadConfig ?? loadConfig)();
    packageName = validateReleaseConfig(config);
  } catch (cause) {
    if (cause instanceof ReleaseCompositionError) throw cause;
    if (cause instanceof ReleaseError) {
      throw new ReleaseCompositionError("Release configuration is invalid.", { cause });
    }
    throw new ReleaseCompositionError("Release configuration could not be loaded.", {
      cause,
    });
  }

  try {
    const credentials: ServiceAccountCredentials = (
      factories.loadCredentials ?? loadServiceAccountCredentials
    )(config);
    const auth = (factories.authenticate ?? createGoogleAuthClient)(credentials, [
      ANDROID_PUBLISHER_SCOPE,
    ]);
    const publisher = (factories.createPublisher ?? createAndroidPublisherClient)(auth);
    // Package validation above precedes all credential/auth/client construction.
    if (packageName !== config.googlePlay.packageName) {
      throw new ReleaseCompositionError("Release package binding changed during composition.");
    }
    return createReleaseComposition(config, { publisher }, options);
  } catch (cause) {
    if (cause instanceof ReleaseCompositionError) throw cause;
    throw new ReleaseCompositionError("Release dependencies could not be initialized.", {
      cause,
    });
  }
}

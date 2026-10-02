/**
 * Phase 4.13 — explicit approval-gated HALT/RESUME status control.
 *
 * The two capabilities share one status-only lifecycle but have distinct names,
 * preconditions, approval digests, summaries, and desired statuses.
 */
import type { NewAuditEntry } from "../audit/index.js";
import type { AgentToolBinding } from "../runtime/agent/index.js";
import type { ToolDefinition, ToolSchema } from "../runtime/tools/index.js";
import type { VerificationResult } from "../runtime/verification/index.js";
import {
  compareEpochSeconds,
  createReleaseEditSession,
  epochSecondsFromDate,
  parseGooglePlayEditSession,
  ReleaseError,
  type ReleaseState,
  type ReleaseTrackReleaseUpdate,
  type ReleaseTrackState,
  type ReleaseTrackUpdateRequest,
} from "./index.js";
import type { ReleaseEditSessionStore } from "./session-store.js";
import type { ReleaseStatusControlGateway } from "./gateway.js";
import {
  assertStatusControlRoundTripSafe,
  createReleaseStatusControlApprovalBinding,
  HALT_ROLLOUT_OPERATION_KIND,
  HALT_ROLLOUT_TOOL_NAME,
  RESUME_ROLLOUT_TOOL_NAME,
  type ReleaseStatusControlIntent,
} from "./status-control-approval.js";
import {
  inspectDirectReleaseSummaryForIdentity,
  verifyExactTrackState,
  type ReleaseExactTrackExpectation,
} from "./readback.js";
import { ensureRemoteEditMatches, normalizeValidationResponse } from "./validate-edit-tool.js";
import { releaseTrackStatesEqual } from "./rollout-tool.js";
import type { ReleaseEditCleanupJournal } from "./cleanup-journal.js";

export { HALT_ROLLOUT_TOOL_NAME, RESUME_ROLLOUT_TOOL_NAME } from "./status-control-approval.js";

export interface StatusControlResult {
  readonly targetTrack: string;
  readonly versionCode: string;
  readonly releaseName: string;
  readonly previousStatus: "inProgress" | "halted";
  readonly status: "inProgress" | "halted";
  readonly userFraction: number;
  readonly committed: true;
  readonly liveRolloutStateVerified: true;
  readonly servingPropagationVerified: false;
}

export interface ReleaseStatusControlAuditLedger {
  append(entry: NewAuditEntry): Promise<void>;
}

export interface ReleaseStatusControlToolOptions {
  readonly packageName: string;
  readonly intent: ReleaseStatusControlIntent;
  readonly gateway: ReleaseStatusControlGateway;
  readonly sessionStore: ReleaseEditSessionStore;
  /**
   * Phase 4.15: durable journal that must persist the exact temporary
   * verification-edit id BEFORE any further Google call, and drop it after a
   * confirmed delete.
   */
  readonly cleanupJournal: ReleaseEditCleanupJournal;
  readonly auditLedger: ReleaseStatusControlAuditLedger;
  readonly now?: () => Date;
}

export interface ReleaseStatusControlTool {
  readonly tool: ToolDefinition<Record<string, never>, StatusControlResult>;
  readonly binding: AgentToolBinding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validFraction(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1;
}

const inputSchema: ToolSchema<Record<string, never>> = {
  parse(value: unknown): Record<string, never> {
    if (!isRecord(value) || Object.keys(value).length !== 0) {
      throw new ReleaseError("INVALID_ARGUMENT", "Status-control input is invalid.");
    }
    return Object.freeze({});
  },
};

const outputSchema: ToolSchema<StatusControlResult> = {
  parse(value: unknown): StatusControlResult {
    if (!isRecord(value)) {
      throw new ReleaseError(
        "STATUS_CONTROL_POST_COMMIT_MISMATCH",
        "Status-control result is invalid.",
      );
    }
    const keys = Object.keys(value).sort();
    const expected = [
      "committed",
      "liveRolloutStateVerified",
      "previousStatus",
      "releaseName",
      "servingPropagationVerified",
      "status",
      "targetTrack",
      "userFraction",
      "versionCode",
    ];
    if (
      keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index]) ||
      typeof value.targetTrack !== "string" ||
      typeof value.versionCode !== "string" ||
      typeof value.releaseName !== "string" ||
      (value.previousStatus !== "inProgress" && value.previousStatus !== "halted") ||
      (value.status !== "inProgress" && value.status !== "halted") ||
      typeof value.userFraction !== "number" ||
      !validFraction(value.userFraction) ||
      value.committed !== true ||
      value.liveRolloutStateVerified !== true ||
      value.servingPropagationVerified !== false
    ) {
      throw new ReleaseError(
        "STATUS_CONTROL_POST_COMMIT_MISMATCH",
        "Status-control result is invalid.",
      );
    }
    return Object.freeze({
      targetTrack: value.targetTrack,
      versionCode: value.versionCode,
      releaseName: value.releaseName,
      previousStatus: value.previousStatus,
      status: value.status,
      userFraction: value.userFraction,
      committed: true,
      liveRolloutStateVerified: true,
      servingPropagationVerified: false,
    });
  },
};

function targetRelease(track: ReleaseTrackState, intent: ReleaseStatusControlIntent): ReleaseState {
  const matches = track.releases.filter((release) =>
    release.versionCodes.includes(intent.versionCode),
  );
  if (matches.length === 0) {
    throw new ReleaseError(
      "TARGET_ROLLOUT_RELEASE_NOT_FOUND",
      "The status-control release was not found.",
      {
        externalStateUncertain: false,
      },
    );
  }
  if (matches.length > 1) {
    throw new ReleaseError(
      "TARGET_ROLLOUT_RELEASE_AMBIGUOUS",
      "The status-control release is ambiguous.",
      {
        externalStateUncertain: false,
      },
    );
  }
  const release = matches[0];
  if (!release || release.name !== intent.releaseName) {
    throw new ReleaseError(
      "TARGET_ROLLOUT_RELEASE_NOT_FOUND",
      "The status-control release identity changed.",
      {
        externalStateUncertain: false,
      },
    );
  }
  return release;
}

function exactExpectation(
  track: ReleaseTrackState,
  intent: ReleaseStatusControlIntent,
): ReleaseExactTrackExpectation {
  const release = targetRelease(track, intent);
  return {
    targetTrack: intent.targetTrack,
    versionCode: intent.versionCode,
    expectedReleaseName: intent.releaseName,
    expectedStatus: intent.desiredStatus,
    expectedUserFraction: intent.expectedUserFraction,
    expectedReleaseNotes: release.releaseNotes ?? [],
    expectedVersionCodes: release.versionCodes,
    expectedCountryTargeting: release.countryTargeting,
    expectedInAppUpdatePriority: release.inAppUpdatePriority,
  };
}

function buildDesiredTrack(
  track: ReleaseTrackState,
  intent: ReleaseStatusControlIntent,
): ReleaseTrackUpdateRequest {
  assertStatusControlRoundTripSafe(track, intent.versionCode, intent.desiredStatus);
  let matches = 0;
  const releases: ReleaseTrackReleaseUpdate[] = track.releases.map((release) => {
    const isTarget = release.versionCodes.includes(intent.versionCode);
    if (isTarget) matches += 1;
    return {
      ...(release.name !== undefined ? { name: release.name } : {}),
      versionCodes: [...release.versionCodes],
      status: isTarget ? intent.desiredStatus : release.status,
      ...(release.userFraction !== undefined ? { userFraction: release.userFraction } : {}),
      ...(release.releaseNotes !== undefined ? { releaseNotes: release.releaseNotes } : {}),
      ...(release.countryTargeting !== undefined
        ? { countryTargeting: release.countryTargeting }
        : {}),
      ...(release.inAppUpdatePriority !== undefined
        ? { inAppUpdatePriority: release.inAppUpdatePriority }
        : {}),
    };
  });
  if (matches === 0) {
    throw new ReleaseError(
      "TARGET_ROLLOUT_RELEASE_NOT_FOUND",
      "The status-control release was not found.",
      {
        externalStateUncertain: false,
      },
    );
  }
  if (matches > 1) {
    throw new ReleaseError(
      "TARGET_ROLLOUT_RELEASE_AMBIGUOUS",
      "The status-control release is ambiguous.",
      {
        externalStateUncertain: false,
      },
    );
  }
  return { track: track.track, releases };
}

function desiredTrackState(
  track: ReleaseTrackState,
  intent: ReleaseStatusControlIntent,
): ReleaseTrackState {
  const request = buildDesiredTrack(track, intent);
  return {
    track: request.track,
    releases: request.releases.map((release) => ({
      ...(release.name !== undefined ? { name: release.name } : {}),
      versionCodes: [...release.versionCodes],
      status: release.status,
      ...(release.userFraction !== undefined ? { userFraction: release.userFraction } : {}),
      ...(release.releaseNotes !== undefined ? { releaseNotes: release.releaseNotes } : {}),
      ...(release.countryTargeting !== undefined
        ? { countryTargeting: release.countryTargeting }
        : {}),
      ...(release.inAppUpdatePriority !== undefined
        ? { inAppUpdatePriority: release.inAppUpdatePriority }
        : {}),
    })),
  };
}

function validateOperationalEdit(
  value: unknown,
  packageName: string,
  nowSeconds: string,
): ReturnType<typeof parseGooglePlayEditSession> {
  let session: ReturnType<typeof parseGooglePlayEditSession>;
  try {
    session = parseGooglePlayEditSession(value, packageName);
  } catch (cause) {
    throw new ReleaseError(
      "STATUS_CONTROL_EDIT_RESPONSE_INVALID",
      "Status-control edit response is invalid.",
      {
        cause,
        externalStateUncertain: true,
      },
    );
  }
  if (
    session.expiryTimeSeconds === undefined ||
    compareEpochSeconds(nowSeconds, session.expiryTimeSeconds) >= 0
  ) {
    throw new ReleaseError(
      "STATUS_CONTROL_EDIT_RESPONSE_INVALID",
      "Status-control edit expiry is invalid or expired.",
      {
        externalStateUncertain: true,
      },
    );
  }
  return session;
}

async function deleteAndClearOperationalEdit(
  store: ReleaseEditSessionStore,
  gateway: ReleaseStatusControlGateway,
  session: ReturnType<typeof parseGooglePlayEditSession>,
): Promise<void> {
  await gateway.deleteEdit(session);
  await store.clear();
  if ((await store.load()) !== undefined) {
    throw new ReleaseError(
      "ROLLOUT_OPERATIONAL_CLEANUP_FAILED",
      "The status-control edit session remains after cleanup.",
      {
        externalStateUncertain: true,
      },
    );
  }
}

async function appendAudit(
  ledger: ReleaseStatusControlAuditLedger,
  intent: ReleaseStatusControlIntent,
  now: () => Date,
  status: "success" | "failure",
  metadata: Record<string, unknown>,
): Promise<void> {
  await ledger.append({
    type:
      status === "success" ? "release.status_control.completed" : "release.status_control.failed",
    actor: "agent",
    action:
      intent.operationKind === HALT_ROLLOUT_OPERATION_KIND
        ? HALT_ROLLOUT_TOOL_NAME
        : RESUME_ROLLOUT_TOOL_NAME,
    status,
    timestamp: now().toISOString(),
    metadata: {
      permission: "destructive",
      operationKind: intent.operationKind,
      targetTrack: intent.targetTrack,
      versionCode: intent.versionCode,
      releaseName: intent.releaseName,
      ...metadata,
    },
  });
}

function safeFailure(cause: unknown): ReleaseError {
  if (cause instanceof ReleaseError) return cause;
  return new ReleaseError(
    "STATUS_CONTROL_UPDATE_FAILED",
    "Status-control operation failed safely.",
    {
      cause,
      externalStateUncertain: false,
    },
  );
}

export function createReleaseStatusControlTool(
  options: ReleaseStatusControlToolOptions,
): ReleaseStatusControlTool {
  const { packageName, intent, gateway, sessionStore, auditLedger } = options;
  const cleanupJournal = options.cleanupJournal;
  const clock = options.now ?? (() => new Date());
  if (
    !cleanupJournal ||
    typeof cleanupJournal.record !== "function" ||
    typeof cleanupJournal.remove !== "function"
  ) {
    throw new ReleaseError(
      "INVALID_ARGUMENT",
      "Status-control verification cleanup journal is invalid.",
    );
  }
  const toolName =
    intent.operationKind === HALT_ROLLOUT_OPERATION_KIND
      ? HALT_ROLLOUT_TOOL_NAME
      : RESUME_ROLLOUT_TOOL_NAME;
  if (!intent || intent.packageName !== packageName) {
    throw new ReleaseError("INVALID_ARGUMENT", "Status-control intent package binding is invalid.");
  }
  const approval = createReleaseStatusControlApprovalBinding(intent);
  const description =
    intent.operationKind === HALT_ROLLOUT_OPERATION_KIND
      ? "DESTRUCTIVE HALT of the exact composition-bound inProgress staged release. It changes only status to halted, preserves the exact fraction, validates and commits once with ERROR_IF_IN_REVIEW, then performs bounded Phase 4.11 direct/deep verification. It never changes rollout percentage, completes, uploads, or retries mutations."
      : "DESTRUCTIVE RESUME of the exact composition-bound halted staged release. It changes only status to inProgress, preserves the exact fraction, validates and commits once with ERROR_IF_IN_REVIEW, then performs bounded Phase 4.11 direct/deep verification. It never changes rollout percentage, completes, uploads, or retries mutations.";

  const tool: ToolDefinition<Record<string, never>, StatusControlResult> = {
    name: toolName,
    description,
    permission: "destructive",
    inputSchema,
    outputSchema,
    async execute(input) {
      inputSchema.parse(input);
      let operationalSession: ReturnType<typeof parseGooglePlayEditSession> | undefined;
      let commitOutcome: "not_attempted" | "rejected" | "ambiguous" | "confirmed" = "not_attempted";
      try {
        try {
          await inspectDirectReleaseSummaryForIdentity(gateway, {
            targetTrack: intent.targetTrack,
            versionCode: intent.versionCode,
            expectedReleaseName: intent.releaseName,
          });
        } catch (cause) {
          if (cause instanceof ReleaseError && cause.code === "COMMITTED_RELEASE_NOT_OBSERVED") {
            throw new ReleaseError(
              "TARGET_ROLLOUT_RELEASE_NOT_FOUND",
              "The status-control release is not observed.",
              {
                externalStateUncertain: false,
              },
            );
          }
          if (cause instanceof ReleaseError && cause.code === "COMMITTED_RELEASE_AMBIGUOUS") {
            throw new ReleaseError(
              "TARGET_ROLLOUT_RELEASE_AMBIGUOUS",
              "The status-control release is ambiguous.",
              {
                externalStateUncertain: false,
              },
            );
          }
          throw cause;
        }
        if ((await sessionStore.load()) !== undefined) {
          throw new ReleaseError(
            "MANAGED_EDIT_ALREADY_OPEN",
            "A managed Play edit is already open.",
            {
              externalStateUncertain: false,
            },
          );
        }

        const nowSeconds = epochSecondsFromDate(clock);
        let created: unknown;
        try {
          created = await gateway.createEdit();
        } catch (cause) {
          throw new ReleaseError(
            "STATUS_CONTROL_EDIT_CREATE_FAILED",
            "Status-control edit creation failed; remote state may be uncertain.",
            {
              cause,
              externalStateUncertain: true,
            },
          );
        }
        operationalSession = validateOperationalEdit(created, packageName, nowSeconds);
        await sessionStore.save(
          createReleaseEditSession(operationalSession, clock().toISOString()),
        );
        const remoteEdit = await gateway.getEdit(operationalSession);
        ensureRemoteEditMatches(
          remoteEdit,
          operationalSession.editId,
          operationalSession.expiryTimeSeconds as string,
          nowSeconds,
        );

        const freshTrack = await gateway.getTrack(operationalSession, intent.targetTrack);
        const freshTarget = targetRelease(freshTrack, intent);
        if (freshTarget.status !== intent.expectedCurrentStatus) {
          throw new ReleaseError(
            "ROLLOUT_STATUS_NOT_ELIGIBLE",
            `Status-control requires current status ${intent.expectedCurrentStatus}.`,
            {
              externalStateUncertain: false,
            },
          );
        }
        if (!validFraction(freshTarget.userFraction)) {
          throw new ReleaseError(
            intent.expectedCurrentStatus === "halted"
              ? "HALTED_ROLLOUT_FRACTION_MISSING"
              : "INVALID_ROLLOUT_FRACTION",
            "Status-control requires a trustworthy fraction strictly between 0 and 1.",
            { externalStateUncertain: false },
          );
        }
        if (
          freshTarget.userFraction !== intent.expectedUserFraction ||
          !releaseTrackStatesEqual(freshTrack, intent.expectedTrackState)
        ) {
          throw new ReleaseError(
            "ROLLOUT_STATE_CHANGED",
            "The approved status-control state changed before mutation.",
            {
              externalStateUncertain: false,
            },
          );
        }
        assertStatusControlRoundTripSafe(freshTrack, intent.versionCode, intent.desiredStatus);
        verifyExactTrackState(freshTrack, {
          ...exactExpectation(freshTrack, intent),
          expectedStatus: intent.expectedCurrentStatus,
        });

        const desired = desiredTrackState(freshTrack, intent);
        let updateResponse: ReleaseTrackState;
        try {
          updateResponse = await gateway.updateTrack(
            operationalSession,
            intent.targetTrack,
            buildDesiredTrack(freshTrack, intent),
          );
        } catch (cause) {
          throw new ReleaseError(
            "STATUS_CONTROL_UPDATE_FAILED",
            "The status-control track update failed; remote edit state may be uncertain.",
            {
              cause,
              externalStateUncertain: true,
            },
          );
        }
        if (!releaseTrackStatesEqual(updateResponse, desired)) {
          throw new ReleaseError(
            "STATUS_CONTROL_UPDATE_RESPONSE_INVALID",
            "The status-control update response is not the exact desired state.",
            {
              externalStateUncertain: true,
            },
          );
        }
        const preCommit = await gateway.getTrack(operationalSession, intent.targetTrack);
        if (!releaseTrackStatesEqual(preCommit, desired)) {
          throw new ReleaseError(
            "STATUS_CONTROL_EDIT_VERIFICATION_FAILED",
            "The status-control edit read-back is not exact.",
            {
              externalStateUncertain: false,
            },
          );
        }
        verifyExactTrackState(preCommit, exactExpectation(preCommit, intent));

        try {
          const validation = await gateway.validateEdit(operationalSession);
          normalizeValidationResponse(validation, operationalSession.editId, nowSeconds);
        } catch (cause) {
          if (cause instanceof ReleaseError) {
            if (cause.externalStateUncertain === true) throw cause;
            throw new ReleaseError(cause.code, cause.message, {
              cause,
              externalStateUncertain: false,
            });
          }
          throw new ReleaseError(
            "EDIT_VALIDATION_FAILED",
            "Google Play status-control edit validation failed.",
            {
              cause,
              externalStateUncertain: false,
            },
          );
        }

        commitOutcome = "ambiguous";
        let commitResponse: unknown;
        try {
          commitResponse = await gateway.commitEdit(operationalSession, {
            changesInReviewBehavior: "ERROR_IF_IN_REVIEW",
            changesNotSentForReview: false,
          });
        } catch (cause) {
          if (
            cause instanceof ReleaseError &&
            (cause.code === "CHANGES_ALREADY_IN_REVIEW" || cause.code === "COMMIT_REJECTED") &&
            cause.externalStateUncertain === false
          ) {
            commitOutcome = "rejected";
            throw new ReleaseError(
              "STATUS_CONTROL_COMMIT_FAILED",
              "Google Play explicitly rejected the status-control commit.",
              {
                cause,
                externalStateUncertain: false,
              },
            );
          }
          throw new ReleaseError(
            "STATUS_CONTROL_COMMIT_FAILED",
            "The status-control commit outcome is uncertain and will not be retried.",
            {
              cause,
              externalStateUncertain: true,
            },
          );
        }
        if (
          !isRecord(commitResponse) ||
          commitResponse.id !== operationalSession.editId ||
          typeof commitResponse.expiryTimeSeconds !== "string" ||
          compareEpochSeconds(nowSeconds, commitResponse.expiryTimeSeconds) >= 0
        ) {
          throw new ReleaseError(
            "STATUS_CONTROL_COMMIT_FAILED",
            "Google Play returned an invalid status-control commit response.",
            {
              externalStateUncertain: true,
            },
          );
        }
        commitOutcome = "confirmed";
        await sessionStore.clear();
        if ((await sessionStore.load()) !== undefined) {
          throw new ReleaseError(
            "COMMIT_SESSION_CLEANUP_FAILED",
            "Status-control commit succeeded but the managed session remains.",
            {
              externalStateUncertain: true,
            },
          );
        }
        operationalSession = undefined;

        try {
          await inspectDirectReleaseSummaryForIdentity(gateway, {
            targetTrack: intent.targetTrack,
            versionCode: intent.versionCode,
            expectedReleaseName: intent.releaseName,
          });
        } catch (cause) {
          throw new ReleaseError(
            "STATUS_CONTROL_POST_COMMIT_NOT_OBSERVED",
            "The committed status-control release is not observed.",
            {
              cause,
              externalStateUncertain: true,
            },
          );
        }
        if ((await sessionStore.load()) !== undefined) {
          throw new ReleaseError(
            "STATUS_CONTROL_VERIFICATION_BLOCKED_BY_ACTIVE_EDIT",
            "Exact post-commit status verification is blocked by an active edit.",
            {
              externalStateUncertain: true,
            },
          );
        }

        let verificationEdit: ReturnType<typeof parseGooglePlayEditSession> | undefined;
        let verificationDeleteAttempted = false;
        let journalRecordWritten = false;
        try {
          let verificationCreated: unknown;
          try {
            verificationCreated = await gateway.createEdit();
          } catch (cause) {
            throw new ReleaseError(
              "STATUS_CONTROL_EDIT_CREATE_FAILED",
              "Status verification edit creation failed; remote state may be uncertain.",
              {
                cause,
                externalStateUncertain: true,
              },
            );
          }
          verificationEdit = validateOperationalEdit(
            verificationCreated,
            packageName,
            epochSecondsFromDate(clock),
          );
          // Phase 4.15 D6: persist the exact temporary edit id BEFORE any further
          // Google call, so a failed cleanup can never lose that identity.
          try {
            await cleanupJournal.record({
              editId: verificationEdit.editId,
              expiryTimeSeconds: verificationEdit.expiryTimeSeconds ?? "",
              source: "status_control_verification",
              createdAt: clock().toISOString(),
            });
            journalRecordWritten = true;
          } catch (cause) {
            // No trustworthy journal record: stop the normal workflow, do not read
            // the track, and attempt exactly one delete for this exact edit id.
            verificationDeleteAttempted = true;
            try {
              await gateway.deleteEdit(verificationEdit);
            } catch (deleteCause) {
              throw new ReleaseError(
                "STATUS_CONTROL_JOURNAL_WRITE_FAILED",
                "The status verification edit could not be journaled and its deletion could not be confirmed.",
                { cause: deleteCause, externalStateUncertain: true },
              );
            }
            verificationEdit = undefined;
            throw new ReleaseError(
              "STATUS_CONTROL_JOURNAL_WRITE_FAILED",
              "The status verification edit could not be journaled; the exact edit was deleted instead.",
              { cause, externalStateUncertain: false },
            );
          }
          const deployed = await gateway.getTrack(verificationEdit, intent.targetTrack);
          if (!releaseTrackStatesEqual(deployed, desired)) {
            throw new ReleaseError(
              "STATUS_CONTROL_POST_COMMIT_MISMATCH",
              "Post-commit status/fraction state does not match the intended state.",
              {
                externalStateUncertain: true,
              },
            );
          }
          verifyExactTrackState(deployed, exactExpectation(deployed, intent));
          verificationDeleteAttempted = true;
          try {
            await gateway.deleteEdit(verificationEdit);
          } catch (cleanupCause) {
            throw new ReleaseError(
              "STATUS_CONTROL_VERIFICATION_CLEANUP_FAILED",
              "Status verification edit cleanup failed.",
              { cause: cleanupCause, externalStateUncertain: true },
            );
          }
          // Clear the local handle first: a journal-removal failure must never
          // trigger a second delete attempt for an already-deleted edit.
          const deletedVerificationEditId = verificationEdit.editId;
          verificationEdit = undefined;
          try {
            await cleanupJournal.remove(deletedVerificationEditId);
          } catch (cause) {
            throw new ReleaseError(
              "STATUS_CONTROL_JOURNAL_REMOVE_FAILED",
              "The status verification edit was deleted, but its cleanup journal record could not be removed.",
              { cause, externalStateUncertain: false },
            );
          }
        } catch (cause) {
          if (verificationEdit !== undefined && !verificationDeleteAttempted) {
            try {
              verificationDeleteAttempted = true;
              await gateway.deleteEdit(verificationEdit);
            } catch (cleanupCause) {
              throw new ReleaseError(
                "STATUS_CONTROL_VERIFICATION_CLEANUP_FAILED",
                "Status verification edit cleanup failed.",
                {
                  cause: cleanupCause,
                  externalStateUncertain: true,
                },
              );
            }
            if (journalRecordWritten) {
              // The remote edit is gone; a stale journal record is safe (hygiene
              // inspection is report-only) and never masks the primary failure code.
              await cleanupJournal.remove(verificationEdit.editId).catch(() => undefined);
            }
          }
          if (cause instanceof ReleaseError) throw cause;
          throw new ReleaseError(
            "STATUS_CONTROL_POST_COMMIT_MISMATCH",
            "Post-commit status verification failed.",
            {
              cause,
              externalStateUncertain: true,
            },
          );
        }

        const result: StatusControlResult = Object.freeze({
          targetTrack: intent.targetTrack,
          versionCode: intent.versionCode,
          releaseName: intent.releaseName,
          previousStatus: intent.expectedCurrentStatus,
          status: intent.desiredStatus,
          userFraction: intent.expectedUserFraction,
          committed: true,
          liveRolloutStateVerified: true,
          servingPropagationVerified: false,
        });
        await appendAudit(auditLedger, intent, clock, "success", {
          previousStatus: result.previousStatus,
          status: result.status,
          userFraction: result.userFraction,
          committed: true,
          liveRolloutStateVerified: true,
          servingPropagationVerified: false,
          externalStateUncertain: false,
        });
        return result;
      } catch (cause) {
        const mapped = safeFailure(cause);
        if (
          operationalSession !== undefined &&
          (commitOutcome === "not_attempted" || (commitOutcome as string) === "rejected")
        ) {
          try {
            await deleteAndClearOperationalEdit(sessionStore, gateway, operationalSession);
            operationalSession = undefined;
          } catch (cleanupCause) {
            const cleanupFailure = new ReleaseError(
              "ROLLOUT_OPERATIONAL_CLEANUP_FAILED",
              "The status-control edit could not be cleaned up safely.",
              {
                cause: cleanupCause,
                externalStateUncertain: true,
              },
            );
            try {
              await appendAudit(auditLedger, intent, clock, "failure", {
                errorCode: cleanupFailure.code,
                externalStateUncertain: true,
                committed: false,
              });
            } catch (auditCause) {
              throw new ReleaseError(
                "STATUS_CONTROL_AUDIT_FAILED",
                "Status-control failure could not be recorded safely.",
                {
                  cause: auditCause,
                  externalStateUncertain: true,
                },
              );
            }
            throw cleanupFailure;
          }
        }
        try {
          await appendAudit(auditLedger, intent, clock, "failure", {
            errorCode: mapped.code,
            externalStateUncertain: mapped.externalStateUncertain === true,
            committed: commitOutcome === "confirmed",
          });
        } catch (auditCause) {
          throw new ReleaseError(
            "STATUS_CONTROL_AUDIT_FAILED",
            "Status-control failure could not be recorded safely.",
            {
              cause: auditCause,
              externalStateUncertain: commitOutcome !== "not_attempted",
            },
          );
        }
        throw mapped;
      }
    },
    async verify(_input, output) {
      try {
        const result = outputSchema.parse(output);
        return (
          result.targetTrack === intent.targetTrack &&
          result.versionCode === intent.versionCode &&
          result.releaseName === intent.releaseName &&
          result.previousStatus === intent.expectedCurrentStatus &&
          result.status === intent.desiredStatus &&
          result.userFraction === intent.expectedUserFraction &&
          result.committed === true &&
          result.liveRolloutStateVerified === true &&
          result.servingPropagationVerified === false
        );
      } catch {
        return false;
      }
    },
  };

  const binding: AgentToolBinding = {
    toolName,
    llm: {
      name: toolName,
      description,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    approval,
    serializeResult(output: unknown, verification: VerificationResult): string {
      if (
        verification.toolName !== toolName ||
        verification.permission !== "destructive" ||
        verification.required !== true ||
        verification.code !== "VERIFIED" ||
        verification.verified !== true
      ) {
        throw new ReleaseError(
          "STATUS_CONTROL_POST_COMMIT_MISMATCH",
          "Unverified status control cannot be reported as complete.",
        );
      }
      return JSON.stringify(outputSchema.parse(output));
    },
  };
  return Object.freeze({ tool, binding });
}

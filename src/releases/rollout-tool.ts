/**
 * Phase 4.12 — approval-gated staged-rollout advancement.
 *
 * One bounded workflow owns the complete lifecycle: direct deployed precheck,
 * destructive operational edit creation, fresh state checks, one track update,
 * pre-commit read-back, validation, one commit, managed-session closure, and
 * Phase 4.11-style post-commit direct/deep verification.
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
  type ReleaseCountryTargeting,
  type ReleaseState,
  type ReleaseTrackState,
  type ReleaseTrackReleaseUpdate,
  type ReleaseTrackUpdateRequest,
} from "./index.js";
import type { ReleaseEditSessionStore } from "./session-store.js";
import type { ReleaseRolloutGateway } from "./gateway.js";
import {
  createReleaseRolloutApprovalBinding,
  RELEASES_UPDATE_ROLLOUT_FRACTION_TOOL_NAME,
  type ReleaseRolloutIntent,
} from "./rollout-approval.js";
import {
  inspectDirectReleaseSummaryForIdentity,
  verifyExactTrackState,
  type ReleaseExactTrackExpectation,
} from "./readback.js";
import { ensureRemoteEditMatches, normalizeValidationResponse } from "./validate-edit-tool.js";
import type { ReleaseEditCleanupJournal } from "./cleanup-journal.js";

export { RELEASES_UPDATE_ROLLOUT_FRACTION_TOOL_NAME } from "./rollout-approval.js";

export interface StagedRolloutUpdateResult {
  readonly targetTrack: string;
  readonly versionCode: string;
  readonly releaseName: string;
  readonly previousFraction: number;
  readonly newFraction: number;
  readonly status: "inProgress";
  readonly rolloutCommitted: true;
  readonly liveRolloutVerified: true;
  readonly servingPropagationVerified: false;
}

export interface ReleaseRolloutAuditLedger {
  append(entry: NewAuditEntry): Promise<void>;
}

export interface ReleaseRolloutToolOptions {
  readonly packageName: string;
  readonly intent: ReleaseRolloutIntent;
  readonly gateway: ReleaseRolloutGateway;
  readonly sessionStore: ReleaseEditSessionStore;
  /**
   * Phase 4.15: durable journal that must persist the exact temporary
   * verification-edit id BEFORE any further Google call, and drop it after a
   * confirmed delete.
   */
  readonly cleanupJournal: ReleaseEditCleanupJournal;
  readonly auditLedger: ReleaseRolloutAuditLedger;
  readonly now?: () => Date;
}

export interface ReleaseRolloutTool {
  readonly tool: ToolDefinition<Record<string, never>, StagedRolloutUpdateResult>;
  readonly binding: AgentToolBinding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidRolloutFraction(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1;
}

const inputSchema: ToolSchema<Record<string, never>> = {
  parse(value: unknown): Record<string, never> {
    if (!isRecord(value) || Object.keys(value).length !== 0) {
      throw new ReleaseError("INVALID_ARGUMENT", "Rollout update input is invalid.");
    }
    return Object.freeze({});
  },
};

const outputSchema: ToolSchema<StagedRolloutUpdateResult> = {
  parse(value: unknown): StagedRolloutUpdateResult {
    if (!isRecord(value))
      throw new ReleaseError("ROLLOUT_POST_COMMIT_MISMATCH", "Rollout result is invalid.");
    const expected = [
      "liveRolloutVerified",
      "newFraction",
      "previousFraction",
      "releaseName",
      "rolloutCommitted",
      "servingPropagationVerified",
      "status",
      "targetTrack",
      "versionCode",
    ];
    const keys = Object.keys(value).sort();
    if (
      keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index]) ||
      typeof value.targetTrack !== "string" ||
      typeof value.versionCode !== "string" ||
      typeof value.releaseName !== "string" ||
      typeof value.previousFraction !== "number" ||
      typeof value.newFraction !== "number" ||
      value.status !== "inProgress" ||
      value.rolloutCommitted !== true ||
      value.liveRolloutVerified !== true ||
      value.servingPropagationVerified !== false
    ) {
      throw new ReleaseError("ROLLOUT_POST_COMMIT_MISMATCH", "Rollout result is invalid.");
    }
    return Object.freeze({
      targetTrack: value.targetTrack,
      versionCode: value.versionCode,
      releaseName: value.releaseName,
      previousFraction: value.previousFraction,
      newFraction: value.newFraction,
      status: "inProgress",
      rolloutCommitted: true,
      liveRolloutVerified: true,
      servingPropagationVerified: false,
    });
  },
};

function notesMap(
  notes: readonly { language: string; text: string }[] | undefined,
): Map<string, string> {
  return new Map((notes ?? []).map((note) => [note.language, note.text]));
}

function sameNotes(
  left: readonly { language: string; text: string }[] | undefined,
  right: readonly { language: string; text: string }[] | undefined,
): boolean {
  const a = notesMap(left);
  const b = notesMap(right);
  if (a.size !== b.size) return false;
  for (const [language, text] of a) if (b.get(language) !== text) return false;
  return true;
}

function sameVersionCodes(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sort = (values: readonly string[]) =>
    [...values].sort((a, b) => {
      const leftCode = BigInt(a);
      const rightCode = BigInt(b);
      return leftCode < rightCode ? -1 : leftCode > rightCode ? 1 : 0;
    });
  const a = sort(left);
  const b = sort(right);
  return a.every((value, index) => value === b[index]);
}

function sameCountryTargeting(
  left: ReleaseCountryTargeting | undefined,
  right: ReleaseCountryTargeting | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.includeRestOfWorld === right.includeRestOfWorld &&
    left.countries.length === right.countries.length &&
    left.countries.every((value, index) => value === right.countries[index])
  );
}

function sameRelease(left: ReleaseState, right: ReleaseState): boolean {
  return (
    left.name === right.name &&
    left.status === right.status &&
    left.userFraction === right.userFraction &&
    left.inAppUpdatePriority === right.inAppUpdatePriority &&
    sameVersionCodes(left.versionCodes, right.versionCodes) &&
    sameNotes(left.releaseNotes, right.releaseNotes) &&
    sameCountryTargeting(left.countryTargeting, right.countryTargeting)
  );
}

function sameTrack(left: ReleaseTrackState, right: ReleaseTrackState): boolean {
  return (
    left.track === right.track &&
    left.releases.length === right.releases.length &&
    left.releases.every((release, index) => {
      const other = right.releases[index];
      return other !== undefined && sameRelease(release, other);
    })
  );
}

/** Shared full normalized Track comparison for status-only Phase 4.13 control. */
export function releaseTrackStatesEqual(
  left: ReleaseTrackState,
  right: ReleaseTrackState,
): boolean {
  return sameTrack(left, right);
}

function targetRelease(track: ReleaseTrackState, intent: ReleaseRolloutIntent): ReleaseState {
  const matches = track.releases.filter((release) =>
    release.versionCodes.includes(intent.versionCode),
  );
  if (matches.length === 0) {
    throw new ReleaseError(
      "TARGET_ROLLOUT_RELEASE_NOT_FOUND",
      "The target rollout release is not present in the fresh track.",
      { externalStateUncertain: false },
    );
  }
  if (matches.length > 1) {
    throw new ReleaseError(
      "TARGET_ROLLOUT_RELEASE_AMBIGUOUS",
      "The target rollout version belongs to multiple releases.",
      { externalStateUncertain: false },
    );
  }
  const release = matches[0];
  if (!release || release.name !== intent.releaseName) {
    throw new ReleaseError(
      "TARGET_ROLLOUT_RELEASE_NOT_FOUND",
      "The fresh target release identity does not match the approved rollout.",
      { externalStateUncertain: false },
    );
  }
  return release;
}

function exactExpectation(
  track: ReleaseTrackState,
  intent: ReleaseRolloutIntent,
  fraction: number,
): ReleaseExactTrackExpectation {
  const release = targetRelease(track, intent);
  return {
    targetTrack: intent.targetTrack,
    versionCode: intent.versionCode,
    expectedReleaseName: intent.releaseName,
    expectedStatus: "inProgress",
    expectedUserFraction: fraction,
    expectedReleaseNotes: release.releaseNotes ?? [],
    expectedVersionCodes: release.versionCodes,
    expectedCountryTargeting: release.countryTargeting,
    expectedInAppUpdatePriority: release.inAppUpdatePriority,
  };
}

function updateTrackFraction(
  track: ReleaseTrackState,
  intent: ReleaseRolloutIntent,
): ReleaseTrackUpdateRequest {
  let matched = 0;
  const releases: ReleaseTrackReleaseUpdate[] = track.releases.map((release) => {
    const isTarget = release.versionCodes.includes(intent.versionCode);
    if (isTarget) matched += 1;
    return {
      ...(release.name !== undefined ? { name: release.name } : {}),
      versionCodes: [...release.versionCodes],
      status: release.status,
      ...(isTarget || release.userFraction !== undefined
        ? { userFraction: isTarget ? intent.newFraction : release.userFraction }
        : {}),
      ...(release.releaseNotes !== undefined ? { releaseNotes: release.releaseNotes } : {}),
      ...(release.countryTargeting !== undefined
        ? { countryTargeting: release.countryTargeting }
        : {}),
      ...(release.inAppUpdatePriority !== undefined
        ? { inAppUpdatePriority: release.inAppUpdatePriority }
        : {}),
    };
  });
  if (matched === 0) {
    throw new ReleaseError(
      "TARGET_ROLLOUT_RELEASE_NOT_FOUND",
      "The target rollout release is not present in the fresh track.",
      { externalStateUncertain: false },
    );
  }
  if (matched > 1) {
    throw new ReleaseError(
      "TARGET_ROLLOUT_RELEASE_AMBIGUOUS",
      "The target rollout version belongs to multiple releases.",
      { externalStateUncertain: false },
    );
  }
  return { track: track.track, releases };
}

function expectedUpdatedTrack(
  track: ReleaseTrackState,
  intent: ReleaseRolloutIntent,
): ReleaseTrackState {
  const request = updateTrackFraction(track, intent);
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
      "ROLLOUT_EDIT_RESPONSE_INVALID",
      "Operational rollout edit response is invalid.",
      { cause, externalStateUncertain: true },
    );
  }
  if (
    session.expiryTimeSeconds === undefined ||
    compareEpochSeconds(nowSeconds, session.expiryTimeSeconds) >= 0
  ) {
    throw new ReleaseError(
      "ROLLOUT_EDIT_RESPONSE_INVALID",
      "Operational rollout edit expiry is invalid or expired.",
      { externalStateUncertain: true },
    );
  }
  return session;
}

async function clearSessionAfterDelete(
  sessionStore: ReleaseEditSessionStore,
  gateway: ReleaseRolloutGateway,
  session: ReturnType<typeof parseGooglePlayEditSession>,
): Promise<void> {
  await gateway.deleteEdit(session);
  await sessionStore.clear();
  if ((await sessionStore.load()) !== undefined) {
    throw new ReleaseError(
      "ROLLOUT_OPERATIONAL_CLEANUP_FAILED",
      "The rollout edit was deleted but the local managed session remains.",
      { externalStateUncertain: true },
    );
  }
}

async function appendAudit(
  ledger: ReleaseRolloutAuditLedger,
  status: "success" | "failure",
  now: () => Date,
  metadata: Record<string, unknown>,
): Promise<void> {
  await ledger.append({
    type: status === "success" ? "release.rollout.completed" : "release.rollout.failed",
    actor: "agent",
    action: RELEASES_UPDATE_ROLLOUT_FRACTION_TOOL_NAME,
    status,
    timestamp: now().toISOString(),
    metadata: {
      permission: "destructive",
      operationKind: "increase_staged_rollout",
      ...metadata,
    },
  });
}

function mapFailure(cause: unknown): ReleaseError {
  if (cause instanceof ReleaseError) return cause;
  return new ReleaseError("ROLLOUT_UPDATE_FAILED", "Staged rollout update failed safely.", {
    cause,
    externalStateUncertain: false,
  });
}

export function createReleaseRolloutTool(options: ReleaseRolloutToolOptions): ReleaseRolloutTool {
  const packageName = options.packageName;
  const intent = options.intent;
  if (!intent || intent.packageName !== packageName) {
    throw new ReleaseError(
      "INVALID_ROLLOUT_FRACTION",
      "Rollout intent package binding is invalid.",
    );
  }
  const gateway = options.gateway;
  const sessionStore = options.sessionStore;
  const cleanupJournal = options.cleanupJournal;
  const auditLedger = options.auditLedger;
  const clock = options.now ?? (() => new Date());
  if (
    !cleanupJournal ||
    typeof cleanupJournal.record !== "function" ||
    typeof cleanupJournal.remove !== "function"
  ) {
    throw new ReleaseError("INVALID_ARGUMENT", "Rollout verification cleanup journal is invalid.");
  }
  if (!gateway || typeof gateway.listReleaseSummaries !== "function") {
    throw new ReleaseError("INVALID_ARGUMENT", "Rollout gateway is invalid.");
  }
  if (!sessionStore || typeof sessionStore.load !== "function") {
    throw new ReleaseError("INVALID_ARGUMENT", "Rollout edit session store is invalid.");
  }
  if (!auditLedger || typeof auditLedger.append !== "function") {
    throw new ReleaseError("INVALID_ARGUMENT", "Rollout audit ledger is invalid.");
  }

  const approval = createReleaseRolloutApprovalBinding(intent);
  const description =
    "DESTRUCTIVE staged-rollout advancement for the exact composition-bound inProgress release. It uses one approved operational edit, changes only userFraction upward, validates and commits once with ERROR_IF_IN_REVIEW, then performs bounded Phase 4.11 direct/deep read-back. It never halts, resumes, completes, creates a release, uploads a bundle, or retries commit.";

  const tool: ToolDefinition<Record<string, never>, StagedRolloutUpdateResult> = {
    name: RELEASES_UPDATE_ROLLOUT_FRACTION_TOOL_NAME,
    description,
    permission: "destructive",
    inputSchema,
    outputSchema,
    async execute(input) {
      inputSchema.parse(input);
      let operationalSession: ReturnType<typeof parseGooglePlayEditSession> | undefined;
      let commitOutcome: "not_attempted" | "rejected" | "ambiguous" | "confirmed" = "not_attempted";
      try {
        // Safe direct precheck before any edits.insert.
        try {
          await inspectDirectReleaseSummaryForIdentity(gateway, {
            targetTrack: intent.targetTrack,
            versionCode: intent.versionCode,
            expectedReleaseName: intent.releaseName,
          });
        } catch (cause) {
          if (cause instanceof ReleaseError) {
            if (cause.code === "COMMITTED_RELEASE_NOT_OBSERVED") {
              throw new ReleaseError(
                "TARGET_ROLLOUT_RELEASE_NOT_FOUND",
                "The committed rollout release is not observed on the target track.",
                { externalStateUncertain: false },
              );
            }
            if (cause.code === "COMMITTED_RELEASE_AMBIGUOUS") {
              throw new ReleaseError(
                "TARGET_ROLLOUT_RELEASE_AMBIGUOUS",
                "The committed rollout release is ambiguous on the target track.",
                { externalStateUncertain: false },
              );
            }
          }
          throw cause;
        }

        if ((await sessionStore.load()) !== undefined) {
          throw new ReleaseError(
            "MANAGED_EDIT_ALREADY_OPEN",
            "A managed Play edit is already open; rollout control will not create another edit.",
            { externalStateUncertain: false },
          );
        }

        const nowSeconds = epochSecondsFromDate(clock);
        let created: unknown;
        try {
          created = await gateway.createEdit();
        } catch (cause) {
          throw new ReleaseError(
            "ROLLOUT_EDIT_CREATE_FAILED",
            "Operational rollout edit creation failed; remote state may be uncertain.",
            { cause, externalStateUncertain: true },
          );
        }
        operationalSession = validateOperationalEdit(created, packageName, nowSeconds);
        const persisted = createReleaseEditSession(operationalSession, clock().toISOString());
        await sessionStore.save(persisted);

        const remoteEdit = await gateway.getEdit(operationalSession);
        ensureRemoteEditMatches(
          remoteEdit,
          operationalSession.editId,
          operationalSession.expiryTimeSeconds as string,
          nowSeconds,
        );

        const freshTrack = await gateway.getTrack(operationalSession, intent.targetTrack);
        const freshTarget = targetRelease(freshTrack, intent);
        if (freshTarget.status !== "inProgress") {
          throw new ReleaseError(
            "ROLLOUT_NOT_IN_PROGRESS",
            "Staged rollout advancement requires the fresh release to remain inProgress.",
            { externalStateUncertain: false },
          );
        }
        if (!isValidRolloutFraction(freshTarget.userFraction)) {
          throw new ReleaseError(
            "INVALID_ROLLOUT_FRACTION",
            "The fresh current rollout fraction must be strictly between 0 and 1.",
            { externalStateUncertain: false },
          );
        }
        if (freshTarget.userFraction !== intent.previousFraction) {
          throw new ReleaseError(
            "ROLLOUT_STATE_CHANGED",
            "The fresh rollout fraction changed before mutation; new approval is required.",
            { externalStateUncertain: false },
          );
        }
        if (!sameTrack(freshTrack, intent.expectedTrackState)) {
          throw new ReleaseError(
            "ROLLOUT_STATE_CHANGED",
            "The approved rollout state changed before mutation; new approval is required.",
            { externalStateUncertain: false },
          );
        }
        verifyExactTrackState(
          freshTrack,
          exactExpectation(freshTrack, intent, intent.previousFraction),
        );

        const updateRequest = updateTrackFraction(freshTrack, intent);
        let updateResponse: ReleaseTrackState;
        try {
          updateResponse = await gateway.updateTrack(
            operationalSession,
            intent.targetTrack,
            updateRequest,
          );
        } catch (cause) {
          throw new ReleaseError(
            cause instanceof ReleaseError && cause.code === "TRACK_UPDATE_RESPONSE_INVALID"
              ? "ROLLOUT_UPDATE_RESPONSE_INVALID"
              : "ROLLOUT_UPDATE_FAILED",
            "The rollout track update failed; the operational edit may be uncertain.",
            { cause, externalStateUncertain: true },
          );
        }
        if (!sameTrack(updateResponse, expectedUpdatedTrack(freshTrack, intent))) {
          throw new ReleaseError(
            "ROLLOUT_UPDATE_RESPONSE_INVALID",
            "The rollout update response does not match the exact intended state.",
            { externalStateUncertain: true },
          );
        }

        const preCommitTrack = await gateway.getTrack(operationalSession, intent.targetTrack);
        const expectedPreCommit = expectedUpdatedTrack(freshTrack, intent);
        if (!sameTrack(preCommitTrack, expectedPreCommit)) {
          throw new ReleaseError(
            "ROLLOUT_EDIT_VERIFICATION_FAILED",
            "The operational edit read-back does not match the exact intended rollout state.",
            { externalStateUncertain: false },
          );
        }
        verifyExactTrackState(
          preCommitTrack,
          exactExpectation(preCommitTrack, intent, intent.newFraction),
        );

        try {
          const validation = await gateway.validateEdit(operationalSession);
          normalizeValidationResponse(validation, operationalSession.editId, nowSeconds);
        } catch (cause) {
          if (cause instanceof ReleaseError) throw cause;
          throw new ReleaseError(
            "EDIT_VALIDATION_FAILED",
            "Google Play rollout edit validation failed.",
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
              "ROLLOUT_COMMIT_FAILED",
              "Google Play explicitly rejected the rollout commit.",
              { cause, externalStateUncertain: false },
            );
          }
          throw new ReleaseError(
            "ROLLOUT_COMMIT_FAILED",
            "The rollout commit outcome is uncertain and will not be retried.",
            { cause, externalStateUncertain: true },
          );
        }
        if (!isRecord(commitResponse) || commitResponse.id !== operationalSession.editId) {
          throw new ReleaseError(
            "ROLLOUT_COMMIT_FAILED",
            "Google Play returned an invalid rollout commit response.",
            { externalStateUncertain: true },
          );
        }
        if (
          typeof commitResponse.expiryTimeSeconds !== "string" ||
          compareEpochSeconds(nowSeconds, commitResponse.expiryTimeSeconds) >= 0
        ) {
          throw new ReleaseError(
            "ROLLOUT_COMMIT_FAILED",
            "Google Play returned an invalid rollout commit expiry.",
            { externalStateUncertain: true },
          );
        }
        commitOutcome = "confirmed";
        await sessionStore.clear();
        if ((await sessionStore.load()) !== undefined) {
          throw new ReleaseError(
            "COMMIT_SESSION_CLEANUP_FAILED",
            "Rollout commit succeeded, but the managed edit session remains.",
            { externalStateUncertain: true },
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
            "ROLLOUT_POST_COMMIT_NOT_OBSERVED",
            "The committed rollout release is not yet observed by the direct deployed-release summary.",
            { cause, externalStateUncertain: true },
          );
        }
        if ((await sessionStore.load()) !== undefined) {
          throw new ReleaseError(
            "ROLLOUT_VERIFICATION_BLOCKED_BY_ACTIVE_EDIT",
            "Post-commit exact rollout verification is blocked by an active managed edit.",
            { externalStateUncertain: true },
          );
        }

        let verificationEdit: ReturnType<typeof parseGooglePlayEditSession> | undefined;
        let journalRecordWritten = false;
        // Phase 6.5: at most ONE delete attempt per temporary verification identity.
        // The flag is set BEFORE each attempt, so no failure path can issue a second
        // workflow-level delete for the same edit (generated-client retry is already
        // disabled, but that alone does not bound the number of workflow calls).
        let deleteAttempted = false;
        try {
          verificationEdit = validateOperationalEdit(
            await gateway.createEdit(),
            packageName,
            epochSecondsFromDate(clock),
          );
          // Phase 4.15 D6: persist the exact temporary edit id BEFORE any further
          // Google call, so a failed cleanup can never lose that identity.
          try {
            await cleanupJournal.record({
              editId: verificationEdit.editId,
              expiryTimeSeconds: verificationEdit.expiryTimeSeconds ?? "",
              source: "rollout_verification",
              createdAt: clock().toISOString(),
            });
            journalRecordWritten = true;
          } catch (cause) {
            // No trustworthy journal record: stop the normal workflow, do not read
            // the track, and attempt exactly one delete for this exact edit id.
            deleteAttempted = true;
            try {
              await gateway.deleteEdit(verificationEdit);
            } catch (deleteCause) {
              throw new ReleaseError(
                "ROLLOUT_JOURNAL_WRITE_FAILED",
                "The post-commit verification edit could not be journaled and its deletion could not be confirmed.",
                { cause: deleteCause, externalStateUncertain: true },
              );
            }
            verificationEdit = undefined;
            throw new ReleaseError(
              "ROLLOUT_JOURNAL_WRITE_FAILED",
              "The post-commit verification edit could not be journaled; the exact edit was deleted instead.",
              { cause, externalStateUncertain: false },
            );
          }
          const deployedTrack = await gateway.getTrack(verificationEdit, intent.targetTrack);
          const expectedDeployed = expectedUpdatedTrack(freshTrack, intent);
          if (!sameTrack(deployedTrack, expectedDeployed)) {
            throw new ReleaseError(
              "ROLLOUT_POST_COMMIT_MISMATCH",
              "Post-commit exact rollout state does not match the intended fraction.",
              { externalStateUncertain: true },
            );
          }
          verifyExactTrackState(
            deployedTrack,
            exactExpectation(deployedTrack, intent, intent.newFraction),
          );
          // EXACTLY ONE delete attempt for this exact temporary identity (Phase 6.5).
          // The attempt is recorded before it is made, so the failure path below can
          // never issue a second workflow-level delete for the same edit.
          deleteAttempted = true;
          try {
            await gateway.deleteEdit(verificationEdit);
          } catch (cleanupCause) {
            throw new ReleaseError(
              "ROLLOUT_VERIFICATION_CLEANUP_FAILED",
              "Post-commit verification edit cleanup failed.",
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
              "ROLLOUT_JOURNAL_REMOVE_FAILED",
              "The post-commit verification edit was deleted, but its cleanup journal record could not be removed.",
              { cause, externalStateUncertain: false },
            );
          }
        } catch (cause) {
          if (verificationEdit !== undefined && !deleteAttempted) {
            deleteAttempted = true;
            try {
              await gateway.deleteEdit(verificationEdit);
            } catch (cleanupCause) {
              throw new ReleaseError(
                "ROLLOUT_VERIFICATION_CLEANUP_FAILED",
                "Post-commit verification edit cleanup failed.",
                { cause: cleanupCause, externalStateUncertain: true },
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
            "ROLLOUT_POST_COMMIT_MISMATCH",
            "Post-commit exact rollout verification failed.",
            { cause, externalStateUncertain: true },
          );
        }

        const result: StagedRolloutUpdateResult = Object.freeze({
          targetTrack: intent.targetTrack,
          versionCode: intent.versionCode,
          releaseName: intent.releaseName,
          previousFraction: intent.previousFraction,
          newFraction: intent.newFraction,
          status: "inProgress",
          rolloutCommitted: true,
          liveRolloutVerified: true,
          servingPropagationVerified: false,
        });
        await appendAudit(auditLedger, "success", clock, {
          targetTrack: result.targetTrack,
          versionCode: result.versionCode,
          releaseName: result.releaseName,
          previousFraction: result.previousFraction,
          newFraction: result.newFraction,
          status: result.status,
          rolloutCommitted: true,
          liveRolloutVerified: true,
          servingPropagationVerified: false,
          externalStateUncertain: false,
        });
        return result;
      } catch (cause) {
        const mapped = mapFailure(cause);
        if (
          operationalSession !== undefined &&
          (commitOutcome === "not_attempted" || (commitOutcome as string) === "rejected")
        ) {
          try {
            await clearSessionAfterDelete(sessionStore, gateway, operationalSession);
            operationalSession = undefined;
          } catch (cleanupCause) {
            const cleanupFailure = new ReleaseError(
              "ROLLOUT_OPERATIONAL_CLEANUP_FAILED",
              "The operational rollout edit could not be cleaned up safely.",
              { cause: cleanupCause, externalStateUncertain: true },
            );
            try {
              await appendAudit(auditLedger, "failure", clock, {
                targetTrack: intent.targetTrack,
                versionCode: intent.versionCode,
                releaseName: intent.releaseName,
                errorCode: cleanupFailure.code,
                externalStateUncertain: true,
                rolloutCommitted: false,
              });
            } catch (auditCause) {
              throw new ReleaseError(
                "ROLLOUT_AUDIT_FAILED",
                "Rollout failure could not be recorded safely.",
                { cause: auditCause, externalStateUncertain: true },
              );
            }
            throw cleanupFailure;
          }
        }
        try {
          await appendAudit(auditLedger, "failure", clock, {
            targetTrack: intent.targetTrack,
            versionCode: intent.versionCode,
            releaseName: intent.releaseName,
            errorCode: mapped.code,
            externalStateUncertain: mapped.externalStateUncertain === true,
            rolloutCommitted: commitOutcome === "confirmed",
          });
        } catch (auditCause) {
          throw new ReleaseError(
            "ROLLOUT_AUDIT_FAILED",
            "Rollout failure could not be recorded safely.",
            { cause: auditCause, externalStateUncertain: commitOutcome !== "not_attempted" },
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
          result.previousFraction === intent.previousFraction &&
          result.newFraction === intent.newFraction &&
          result.status === "inProgress" &&
          result.rolloutCommitted === true &&
          result.liveRolloutVerified === true &&
          result.servingPropagationVerified === false
        );
      } catch {
        return false;
      }
    },
  };

  const binding: AgentToolBinding = {
    toolName: RELEASES_UPDATE_ROLLOUT_FRACTION_TOOL_NAME,
    llm: {
      name: RELEASES_UPDATE_ROLLOUT_FRACTION_TOOL_NAME,
      description,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    approval,
    serializeResult(output: unknown, verification: VerificationResult): string {
      if (
        verification.toolName !== RELEASES_UPDATE_ROLLOUT_FRACTION_TOOL_NAME ||
        verification.permission !== "destructive" ||
        verification.required !== true ||
        verification.code !== "VERIFIED" ||
        verification.verified !== true
      ) {
        throw new ReleaseError(
          "ROLLOUT_POST_COMMIT_MISMATCH",
          "Unverified rollout cannot be reported as complete.",
        );
      }
      return JSON.stringify(outputSchema.parse(output));
    },
  };
  return Object.freeze({ tool, binding });
}

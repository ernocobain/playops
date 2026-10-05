/**
 * Phase 4.10 — the production Google Play commit boundary.
 *
 * This module is the only Phase 4.10 production path allowed to reach
 * `edits.commit`. It reuses the immutable Phase 4.9 intent and approval binding,
 * performs post-approval fresh state/validation checks, makes one non-retried
 * commit attempt, validates the AppEdit response, and closes the local session.
 * It deliberately does not perform Phase 4.11 live-release read-back.
 */
import type { NewAuditEntry } from "../audit/index.js";
import type { AgentToolBinding } from "../runtime/agent/index.js";
import type { ToolDefinition, ToolSchema } from "../runtime/tools/index.js";
import type { VerificationResult } from "../runtime/verification/index.js";
import {
  createReleaseCommitApprovalBinding,
  createReleaseCommitStateDigest,
  RELEASE_COMMIT_REVIEW_BEHAVIOR,
  type ReleaseCommitIntent,
} from "./commit-approval.js";
import {
  compareEpochSeconds,
  epochSecondsFromDate,
  isReleaseEditSessionExpired,
  parseReleaseEditSession,
  ReleaseError,
  toGooglePlayEditSession,
  validateReleasePackageName,
} from "./index.js";
import type { ReleaseCommitGateway } from "./gateway.js";
import { ensureRemoteEditMatches, normalizeValidationResponse } from "./validate-edit-tool.js";
import { loadReleaseEditSessionState, type ReleaseEditSessionStore } from "./session-store.js";
import {
  RELEASE_COMMIT_ATTEMPT_JOURNAL_VERSION,
  type ReleaseCommitAttemptJournal,
  type ReleaseCommitAttemptJournalRecord,
} from "./commit-attempt-journal.js";

export const RELEASES_COMMIT_EDIT_TOOL_NAME = "releases.commit_edit";

export interface ReleaseCommitResult {
  readonly committed: true;
  readonly commitAcknowledged: true;
  readonly targetTrack: string;
  readonly versionCode: string;
  readonly releaseStatus: ReleaseCommitIntent["releaseStatus"];
  readonly changesInReviewBehavior: "ERROR_IF_IN_REVIEW";
  /** Phase 4.11 owns independent live-release verification. */
  readonly liveReleaseVerified: false;
}

export interface ReleaseCommitAuditLedger {
  append(entry: NewAuditEntry): Promise<void>;
}

export interface ReleaseCommitToolOptions {
  readonly packageName: string;
  readonly intent: ReleaseCommitIntent;
  readonly gateway: ReleaseCommitGateway;
  readonly sessionStore: ReleaseEditSessionStore;
  readonly auditLedger: ReleaseCommitAuditLedger;
  readonly commitAttemptJournal: ReleaseCommitAttemptJournal;
  /**
   * Optional trusted pre-mutation snapshot digest, never note text. It is durable
   * diagnostic/recovery evidence only and is deliberately NOT part of the approval
   * digest, so it can never be sufficient on its own to prove NOT_COMMITTED.
   */
  readonly priorStateDigest?: string;
  readonly now?: () => Date;
}

export interface ReleaseCommitTool {
  readonly tool: ToolDefinition<Record<string, never>, ReleaseCommitResult>;
  readonly binding: AgentToolBinding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const inputSchema: ToolSchema<Record<string, never>> = {
  parse(value: unknown): Record<string, never> {
    if (!isRecord(value) || Object.keys(value).length !== 0) {
      throw new ReleaseError("INVALID_ARGUMENT", "Commit edit input is invalid.");
    }
    return Object.freeze({});
  },
};

function createOutputSchema(): ToolSchema<ReleaseCommitResult> {
  return {
    parse(value: unknown): ReleaseCommitResult {
      if (!isRecord(value)) {
        throw new ReleaseError("COMMIT_RESPONSE_INVALID", "Commit result is invalid.");
      }
      const keys = Object.keys(value).sort();
      const expected = [
        "changesInReviewBehavior",
        "commitAcknowledged",
        "committed",
        "liveReleaseVerified",
        "releaseStatus",
        "targetTrack",
        "versionCode",
      ];
      if (
        keys.length !== expected.length ||
        keys.some((key, index) => key !== expected[index]) ||
        value.committed !== true ||
        value.commitAcknowledged !== true ||
        value.liveReleaseVerified !== false ||
        value.changesInReviewBehavior !== RELEASE_COMMIT_REVIEW_BEHAVIOR ||
        typeof value.targetTrack !== "string" ||
        typeof value.versionCode !== "string" ||
        typeof value.releaseStatus !== "string"
      ) {
        throw new ReleaseError("COMMIT_RESPONSE_INVALID", "Commit result is invalid.");
      }
      return Object.freeze({
        committed: true,
        commitAcknowledged: true,
        targetTrack: value.targetTrack,
        versionCode: value.versionCode,
        releaseStatus: value.releaseStatus as ReleaseCommitResult["releaseStatus"],
        changesInReviewBehavior: RELEASE_COMMIT_REVIEW_BEHAVIOR,
        liveReleaseVerified: false,
      });
    },
  };
}

function preCommitFailure(cause: unknown): ReleaseError {
  if (cause instanceof ReleaseError) {
    return new ReleaseError(cause.code, cause.message, { cause, externalStateUncertain: false });
  }
  return new ReleaseError("COMMIT_FAILED", "Commit preflight could not be completed safely.", {
    cause,
    externalStateUncertain: false,
  });
}

function attemptedCommitFailure(cause: unknown): ReleaseError {
  if (cause instanceof ReleaseError) {
    if (cause.code === "CHANGES_ALREADY_IN_REVIEW" || cause.code === "COMMIT_REJECTED") {
      return new ReleaseError(cause.code, cause.message, {
        cause,
        externalStateUncertain: false,
      });
    }
    if (
      cause.code === "COMMIT_ATTEMPT_JOURNAL_INVALID" ||
      cause.code === "COMMIT_RESPONSE_INVALID" ||
      cause.code === "COMMIT_FAILED" ||
      cause.code === "COMMIT_SESSION_CLEANUP_FAILED" ||
      cause.code === "COMMIT_AUDIT_FAILED"
    ) {
      return new ReleaseError(cause.code, cause.message, {
        cause,
        externalStateUncertain: true,
      });
    }
    if (cause.externalStateUncertain !== undefined) return cause;
  }
  return new ReleaseError("COMMIT_FAILED", "Google Play commit outcome is uncertain.", {
    cause,
    externalStateUncertain: true,
  });
}

function commitResponse(response: unknown, editId: string, nowSeconds: string): string {
  if (!isRecord(response) || response.id !== editId) {
    throw new ReleaseError(
      "COMMIT_RESPONSE_INVALID",
      "Google Play returned a different edit from the commit request.",
      { externalStateUncertain: true },
    );
  }
  if (
    typeof response.expiryTimeSeconds !== "string" ||
    !/^\d+$/u.test(response.expiryTimeSeconds) ||
    compareEpochSeconds(nowSeconds, response.expiryTimeSeconds) >= 0
  ) {
    throw new ReleaseError(
      "COMMIT_RESPONSE_INVALID",
      "Google Play returned an invalid or expired commit response.",
      { externalStateUncertain: true },
    );
  }
  return response.expiryTimeSeconds;
}

async function appendCommitAudit(
  ledger: ReleaseCommitAuditLedger,
  status: "success" | "failure",
  now: () => Date,
  metadata: Record<string, unknown>,
  commitAttempted: boolean,
  externalStateUncertainOnAuditFailure = commitAttempted,
): Promise<void> {
  try {
    await ledger.append({
      type: status === "success" ? "release.commit.completed" : "release.commit.failed",
      actor: "agent",
      action: RELEASES_COMMIT_EDIT_TOOL_NAME,
      status,
      timestamp: now().toISOString(),
      metadata: {
        permission: "publish",
        commitAttempted,
        ...metadata,
      },
    });
  } catch (cause) {
    throw new ReleaseError(
      "COMMIT_AUDIT_FAILED",
      "Commit result could not be recorded safely in the audit log.",
      { cause, externalStateUncertain: externalStateUncertainOnAuditFailure },
    );
  }
}

async function assertApprovedTrackState(
  gateway: ReleaseCommitGateway,
  session: Parameters<ReleaseCommitGateway["getTrack"]>[0],
  intent: ReleaseCommitIntent,
): Promise<void> {
  const currentTrack = await gateway.getTrack(session, intent.targetTrack);
  if (currentTrack.track !== intent.targetTrack) {
    throw new ReleaseError(
      "TRACK_MISMATCH",
      "Google Play returned a different target track than the approved intent.",
    );
  }
  if (createReleaseCommitStateDigest(currentTrack) !== intent.stateDigest) {
    throw new ReleaseError(
      "COMMIT_STATE_CHANGED",
      "The approved release state changed before commit; new approval is required.",
    );
  }
}

/** Create the approval-gated production commit tool for one trusted intent. */
export function createReleaseCommitTool(options: ReleaseCommitToolOptions): ReleaseCommitTool {
  const packageName = validateReleasePackageName(options?.packageName);
  const intent = options?.intent;
  if (!intent || intent.packageName !== packageName) {
    throw new ReleaseError("INVALID_COMMIT_INTENT", "Commit intent package binding is invalid.");
  }
  if (intent.changesInReviewBehavior !== RELEASE_COMMIT_REVIEW_BEHAVIOR) {
    throw new ReleaseError("COMMIT_POLICY_UNSUPPORTED", "Phase 4.10 requires ERROR_IF_IN_REVIEW.");
  }
  if (intent.changesNotSentForReview !== false) {
    throw new ReleaseError(
      "COMMIT_POLICY_UNSUPPORTED",
      "Phase 4.10 requires changesNotSentForReview=false.",
    );
  }
  const gateway = options?.gateway;
  const sessionStore = options?.sessionStore;
  const auditLedger = options?.auditLedger;
  const journal = options?.commitAttemptJournal;
  const clock = options?.now ?? (() => new Date());
  if (
    !gateway ||
    typeof gateway.getEdit !== "function" ||
    typeof gateway.getTrack !== "function" ||
    typeof gateway.validateEdit !== "function" ||
    typeof gateway.commitEdit !== "function"
  ) {
    throw new ReleaseError("INVALID_ARGUMENT", "Commit gateway is invalid.");
  }
  if (
    !sessionStore ||
    typeof sessionStore.load !== "function" ||
    typeof sessionStore.clear !== "function"
  ) {
    throw new ReleaseError("INVALID_ARGUMENT", "Commit session store is invalid.");
  }
  if (!auditLedger || typeof auditLedger.append !== "function") {
    throw new ReleaseError("INVALID_ARGUMENT", "Commit audit ledger is invalid.");
  }

  if (
    !journal ||
    typeof journal.prepare !== "function" ||
    typeof journal.transition !== "function" ||
    typeof journal.list !== "function"
  ) {
    throw new ReleaseError(
      "COMMIT_ATTEMPT_JOURNAL_INVALID",
      "Commit requires an explicitly configured durable commit-attempt journal.",
      { externalStateUncertain: false },
    );
  }
  const approvalBinding = createReleaseCommitApprovalBinding(intent);
  const requestDigest = approvalBinding.createRequestDigest({});
  if (requestDigest !== intent.requestDigest) {
    throw new ReleaseError(
      "INVALID_COMMIT_INTENT",
      "Commit request digest does not match the approved intent.",
      { externalStateUncertain: false },
    );
  }
  const outputSchema = createOutputSchema();
  const description =
    "PUBLISH the exact approved Google Play edit for the configured app. This applies the edit to the application, is not merely draft-state work, and requires exact human approval. Google may invalidate other active edits for the application when this edit is committed. PlayOps uses ERROR_IF_IN_REVIEW and fails rather than cancelling an existing review. Phase 4.10 verifies the commit boundary and closes the local session; live release propagation remains unverified until Phase 4.11.";

  const tool: ToolDefinition<Record<string, never>, ReleaseCommitResult> = {
    name: RELEASES_COMMIT_EDIT_TOOL_NAME,
    description,
    permission: "publish",
    inputSchema,
    outputSchema,
    async execute(input) {
      inputSchema.parse(input);
      let commitAttempted = false;
      let commitAcknowledged = false;
      let attempt: ReleaseCommitAttemptJournalRecord | undefined;
      try {
        const nowSeconds = epochSecondsFromDate(clock);
        const state = await loadReleaseEditSessionState(sessionStore, nowSeconds);
        if (state.status === "none") {
          throw new ReleaseError(
            "EDIT_SESSION_REQUIRED",
            "No tracked Play edit session exists for the approved commit.",
          );
        }
        if (state.status === "expired") {
          throw new ReleaseError(
            "EDIT_SESSION_EXPIRED",
            "The tracked Play edit session expired before commit.",
          );
        }
        const session = parseReleaseEditSession(state.session, packageName);
        if (
          session.editId !== intent.editId ||
          compareEpochSeconds(session.expiryTimeSeconds, intent.validationExpiryTimeSeconds) !== 0
        ) {
          throw new ReleaseError(
            "EDIT_SESSION_INVALID",
            "The tracked edit session no longer matches the approved commit intent.",
          );
        }
        if (isReleaseEditSessionExpired(session, nowSeconds)) {
          throw new ReleaseError(
            "EDIT_SESSION_EXPIRED",
            "The tracked Play edit session expired before commit.",
          );
        }
        const googleSession = toGooglePlayEditSession(session);
        const remoteEdit = await gateway.getEdit(googleSession);
        ensureRemoteEditMatches(remoteEdit, session.editId, session.expiryTimeSeconds, nowSeconds);

        await assertApprovedTrackState(gateway, googleSession, intent);
        const preparedAt = clock().toISOString();
        attempt = await journal.prepare({
          version: RELEASE_COMMIT_ATTEMPT_JOURNAL_VERSION,
          packageName,
          editId: session.editId,
          expiryTimeSeconds: session.expiryTimeSeconds,
          targetTrack: intent.targetTrack,
          versionCode: intent.versionCode,
          releaseName: intent.releaseName,
          releaseStatus: intent.releaseStatus,
          expectedStateDigest: intent.stateDigest,
          ...(options.priorStateDigest === undefined
            ? {}
            : { priorStateDigest: options.priorStateDigest }),
          validationExpiryTimeSeconds: intent.validationExpiryTimeSeconds,
          requestDigest,
          attemptedAtUtc: preparedAt,
          updatedAtUtc: preparedAt,
        });

        let validationResponse: unknown;
        try {
          validationResponse = await gateway.validateEdit(googleSession);
        } catch (cause) {
          if (cause instanceof ReleaseError) throw cause;
          throw new ReleaseError("EDIT_VALIDATION_FAILED", "Google Play edit validation failed.", {
            cause,
            externalStateUncertain: false,
          });
        }
        const validation = normalizeValidationResponse(
          validationResponse,
          session.editId,
          nowSeconds,
        );
        if (
          compareEpochSeconds(validation.expiryTimeSeconds, intent.validationExpiryTimeSeconds) !==
          0
        ) {
          throw new ReleaseError(
            "COMMIT_VALIDATION_EXPIRY_MISMATCH",
            "Fresh validation expiry does not match the approved commit intent; new approval is required.",
            { externalStateUncertain: false },
          );
        }

        // A fresh observation, not an atomic/CAS guarantee. No remote operation
        // may be inserted between this final track check and commit transport.
        await assertApprovedTrackState(gateway, googleSession, intent);
        if (isReleaseEditSessionExpired(session, epochSecondsFromDate(clock))) {
          throw new ReleaseError(
            "EDIT_SESSION_EXPIRED",
            "The approved edit expired before commit transport.",
            { externalStateUncertain: false },
          );
        }
        // This durable claim is intentionally before transport. A crash after
        // the claim but before sending is conservatively reconciled, never retried.
        attempt = await journal.transition(
          attempt.attemptId,
          "PREPARED",
          "TRANSPORT_ATTEMPTED",
          clock().toISOString(),
        );
        commitAttempted = true;
        const commitResponseValue = await gateway.commitEdit(googleSession, {
          changesInReviewBehavior: RELEASE_COMMIT_REVIEW_BEHAVIOR,
          changesNotSentForReview: false,
        });
        commitResponse(commitResponseValue, session.editId, epochSecondsFromDate(clock));
        commitAcknowledged = true;
        // Persist acknowledgement before clearing the ordinary managed session.
        // ACKNOWLEDGED survives local/audit failure and is NOT remote verification.
        attempt = await journal.transition(
          attempt.attemptId,
          "TRANSPORT_ATTEMPTED",
          "ACKNOWLEDGED",
          clock().toISOString(),
          // Historical fact that survives every later journal state.
          { acknowledgedAtUtc: clock().toISOString() },
        );

        try {
          await sessionStore.clear();
          const remaining = await sessionStore.load();
          if (remaining !== undefined) {
            throw new Error("tracked session remains after clear");
          }
        } catch (cause) {
          throw new ReleaseError(
            "COMMIT_SESSION_CLEANUP_FAILED",
            "Google Play commit succeeded, but the local managed session could not be closed safely.",
            { cause, externalStateUncertain: true },
          );
        }

        const result = Object.freeze({
          committed: true as const,
          commitAcknowledged: true as const,
          targetTrack: intent.targetTrack,
          versionCode: intent.versionCode,
          releaseStatus: intent.releaseStatus,
          changesInReviewBehavior: RELEASE_COMMIT_REVIEW_BEHAVIOR,
          liveReleaseVerified: false as const,
        });
        await appendCommitAudit(
          auditLedger,
          "success",
          clock,
          {
            requestDigest: intent.requestDigest,
            committed: true,
            commitAcknowledged: true,
            targetTrack: result.targetTrack,
            versionCode: result.versionCode,
            releaseStatus: result.releaseStatus,
            changesInReviewBehavior: result.changesInReviewBehavior,
            liveReleaseVerified: false,
            externalStateUncertain: false,
          },
          commitAttempted,
        );
        return result;
      } catch (cause) {
        let mapped = commitAttempted ? attemptedCommitFailure(cause) : preCommitFailure(cause);
        if (commitAttempted && attempt?.state === "TRANSPORT_ATTEMPTED") {
          try {
            attempt = await journal.transition(
              attempt.attemptId,
              "TRANSPORT_ATTEMPTED",
              mapped.externalStateUncertain === false ? "RECONCILED_NOT_COMMITTED" : "AMBIGUOUS",
              clock().toISOString(),
            );
          } catch (journalCause) {
            // Never retry transport or erase the older durable recovery handle.
            mapped = new ReleaseError(
              "COMMIT_ATTEMPT_JOURNAL_INVALID",
              "Commit outcome could not be durably recorded; the recovery handle is retained.",
              {
                cause: journalCause,
                externalStateUncertain:
                  mapped.externalStateUncertain === true || commitAcknowledged,
              },
            );
          }
        }
        await appendCommitAudit(
          auditLedger,
          "failure",
          clock,
          {
            requestDigest,
            commitAcknowledged,
            liveReleaseVerified: false,
            errorCode: mapped.code,
            externalStateUncertain: mapped.externalStateUncertain === true,
          },
          commitAttempted,
          mapped.externalStateUncertain === true,
        );
        throw mapped;
      }
    },
    async verify(_input, output) {
      try {
        const result = outputSchema.parse(output);
        const remaining = await sessionStore.load();
        return (
          result.committed === true &&
          result.commitAcknowledged === true &&
          result.targetTrack === intent.targetTrack &&
          result.versionCode === intent.versionCode &&
          result.releaseStatus === intent.releaseStatus &&
          result.changesInReviewBehavior === RELEASE_COMMIT_REVIEW_BEHAVIOR &&
          result.liveReleaseVerified === false &&
          remaining === undefined
        );
      } catch {
        return false;
      }
    },
  };

  const binding: AgentToolBinding = {
    toolName: RELEASES_COMMIT_EDIT_TOOL_NAME,
    llm: {
      name: RELEASES_COMMIT_EDIT_TOOL_NAME,
      description,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    approval: approvalBinding,
    serializeResult(output: unknown, verification: VerificationResult): string {
      if (
        verification.toolName !== RELEASES_COMMIT_EDIT_TOOL_NAME ||
        verification.permission !== "publish" ||
        verification.required !== true ||
        verification.code !== "VERIFIED" ||
        verification.verified !== true
      ) {
        throw new ReleaseError(
          "COMMIT_RESPONSE_INVALID",
          "Unverified commit cannot be reported as committed.",
        );
      }
      const result = outputSchema.parse(output);
      return JSON.stringify({
        committed: result.committed,
        commitAcknowledged: result.commitAcknowledged,
        targetTrack: result.targetTrack,
        versionCode: result.versionCode,
        releaseStatus: result.releaseStatus,
        changesInReviewBehavior: result.changesInReviewBehavior,
        liveReleaseVerified: result.liveReleaseVerified,
      });
    },
  };

  return Object.freeze({ tool, binding });
}

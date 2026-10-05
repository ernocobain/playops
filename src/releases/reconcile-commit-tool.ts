/**
 * Recovery of one durable commit attempt; never another commit.
 * The immutable mode is read-only probe OR separately approved destructive expired
 * verification. Journal claims precede insert/delete transport; a claimed attempt
 * is never replayed, even when it may have failed before sending bytes. Recovery
 * cleans the exact persisted temporary handle before using durable track proof.
 * Missing proof stays unknown: cleanup is not evidence that a release is live.
 * Uses the existing single-operator store contract, not distributed locking/CAS.
 */
import { createHash } from "node:crypto";
import type { NewAuditEntry } from "../audit/index.js";
import type { AgentToolBinding } from "../runtime/agent/index.js";
import type { ToolDefinition, ToolSchema } from "../runtime/tools/index.js";
import type { VerificationResult } from "../runtime/verification/index.js";
import {
  parseReleaseCommitAttemptJournalRecord,
  RELEASE_COMMIT_ATTEMPT_STATES,
  type ReleaseCommitAttemptJournal,
  type ReleaseCommitAttemptJournalRecord,
  type ReleaseCommitAttemptState,
  type ReleaseCommitAttemptVerificationPatch,
} from "./commit-attempt-journal.js";
import { createReleaseCommitStateDigest } from "./commit-approval.js";
import { classifyReleaseEditCleanupRecordLocally } from "./cleanup-journal.js";
import { classifyPostDeleteEditRead } from "./post-delete-verification.js";
import { EDIT_DELETE_POLICY } from "../googleplay/publisher/index.js";
import type { ReleaseGooglePlayGateway } from "./gateway.js";
import type { ReleaseEditSessionStore } from "./session-store.js";
import {
  compareEpochSeconds,
  epochSecondsFromDate,
  parseGooglePlayEditSession,
  parseReleaseEditSession,
  ReleaseError,
  validateReleasePackageName,
} from "./index.js";

export const RELEASES_RECONCILE_COMMIT_TOOL_NAME = "releases.reconcile_commit";
export type ReleaseCommitReconciliationMode = "probe" | "verify_expired";
export const RELEASE_COMMIT_RECONCILIATION_BASES = Object.freeze([
  "ORIGINAL_EDIT_ACTIVE",
  "ORIGINAL_READ_UNAVAILABLE",
  "ORIGINAL_IDENTITY_MISMATCH",
  "EXPECTED_STATE_OBSERVED",
  "LOCAL_EXPIRY_NOT_ESTABLISHED",
  "DESTRUCTIVE_APPROVAL_REQUIRED",
  "VERIFICATION_PROOF_UNAVAILABLE",
  "VERIFICATION_CLEANUP_PENDING",
  "VERIFICATION_IDENTITY_UNAVAILABLE",
  "LOCAL_SESSION_CHANGED",
  "JOURNAL_UNAVAILABLE",
  "PRIOR_STATE_OBSERVED",
  "COMMIT_TRANSPORT_NOT_ATTEMPTED",
  "UNRELATED_STATE_OBSERVED",
  "KNOWN_NEGATIVE_COMMIT_OUTCOME",
] as const);
export type ReleaseCommitReconciliationBasis = (typeof RELEASE_COMMIT_RECONCILIATION_BASES)[number];
export interface ReleaseCommitReconciliationResult {
  readonly case: "CASE_1" | "CASE_2" | "CASE_3";
  readonly basis: ReleaseCommitReconciliationBasis;
  readonly externalStateUncertain: boolean;
  readonly pendingCleanup: boolean;
  /**
   * Historical fact: a durable Google commit acknowledgement for this exact
   * attempt is recoverable. Independent of liveReleaseVerified, and preserved
   * across later journal states because the journal records the acknowledgement.
   */
  readonly commitAcknowledged: boolean;
  readonly liveReleaseVerified: boolean;
  readonly servingPropagationVerified: false;
  readonly attemptState: ReleaseCommitAttemptState;
  /** Internal exact approval/snapshot binding; not serialized to the model. */
  readonly reconciliationRequestDigest: string;
}
export interface ReleaseCommitReconciliationToolOptions {
  readonly packageName: string;
  /** Trusted snapshot loaded from the journal, not reconstructed by a model. */
  readonly candidate: ReleaseCommitAttemptJournalRecord;
  readonly mode: ReleaseCommitReconciliationMode;
  readonly gateway: Pick<
    ReleaseGooglePlayGateway,
    "getEdit" | "createEdit" | "getTrack" | "deleteEdit"
  >;
  readonly sessionStore: ReleaseEditSessionStore;
  readonly journal: ReleaseCommitAttemptJournal;
  readonly auditLedger: { append(entry: NewAuditEntry): Promise<void> };
  readonly now?: () => Date;
}
export interface ReleaseCommitReconciliationTool {
  readonly tool: ToolDefinition<Record<string, never>, ReleaseCommitReconciliationResult>;
  readonly binding: AgentToolBinding;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const inputSchema: ToolSchema<Record<string, never>> = {
  parse(value) {
    if (!object(value) || Object.keys(value).length !== 0) {
      throw new ReleaseError("INVALID_ARGUMENT", "Commit reconciliation accepts empty input only.");
    }
    return Object.freeze({});
  },
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function createReleaseCommitReconciliationRequestDigest(
  packageName: string,
  candidate: ReleaseCommitAttemptJournalRecord,
  mode: ReleaseCommitReconciliationMode,
): string {
  const record = parseReleaseCommitAttemptJournalRecord(
    candidate,
    validateReleasePackageName(packageName),
  );
  if (mode !== "probe" && mode !== "verify_expired")
    throw new ReleaseError("INVALID_ARGUMENT", "Commit reconciliation mode is invalid.");
  return createHash("sha256")
    .update(
      canonical({
        version: 1,
        toolName: RELEASES_RECONCILE_COMMIT_TOOL_NAME,
        mode,
        candidate: record,
      }),
    )
    .digest("hex");
}
function parseResult(value: unknown): ReleaseCommitReconciliationResult {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "case",
          "basis",
          "externalStateUncertain",
          "pendingCleanup",
          "commitAcknowledged",
          "liveReleaseVerified",
          "servingPropagationVerified",
          "attemptState",
          "reconciliationRequestDigest",
        ].includes(key),
    ) ||
    (value.case !== "CASE_1" && value.case !== "CASE_2" && value.case !== "CASE_3") ||
    !RELEASE_COMMIT_RECONCILIATION_BASES.some((basis) => basis === value.basis) ||
    !RELEASE_COMMIT_ATTEMPT_STATES.some((state) => state === value.attemptState) ||
    typeof value.externalStateUncertain !== "boolean" ||
    typeof value.pendingCleanup !== "boolean" ||
    typeof value.commitAcknowledged !== "boolean" ||
    typeof value.liveReleaseVerified !== "boolean" ||
    value.servingPropagationVerified !== false ||
    typeof value.reconciliationRequestDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.reconciliationRequestDigest)
  ) {
    throw new ReleaseError(
      "VERIFICATION_STATE_MISMATCH",
      "Commit reconciliation result is invalid.",
    );
  }
  if (
    (value.case === "CASE_1" &&
      (value.basis !== "EXPECTED_STATE_OBSERVED" ||
        value.attemptState !== "RECONCILED_COMMITTED" ||
        value.liveReleaseVerified !== true ||
        value.externalStateUncertain !== false ||
        value.pendingCleanup !== false)) ||
    (value.case !== "CASE_1" && value.liveReleaseVerified !== false) ||
    (value.case === "CASE_3" &&
      (value.externalStateUncertain !== true ||
        [
          "EXPECTED_STATE_OBSERVED",
          "ORIGINAL_EDIT_ACTIVE",
          "COMMIT_TRANSPORT_NOT_ATTEMPTED",
          "KNOWN_NEGATIVE_COMMIT_OUTCOME",
        ].includes(String(value.basis)))) ||
    (value.case === "CASE_2" &&
      (value.pendingCleanup !== false ||
        ![
          "ORIGINAL_EDIT_ACTIVE",
          "COMMIT_TRANSPORT_NOT_ATTEMPTED",
          "KNOWN_NEGATIVE_COMMIT_OUTCOME",
        ].includes(String(value.basis)) ||
        value.externalStateUncertain !== false ||
        value.attemptState !== "RECONCILED_NOT_COMMITTED" ||
        value.commitAcknowledged !== false))
  ) {
    throw new ReleaseError(
      "VERIFICATION_STATE_MISMATCH",
      "Commit reconciliation evidence is contradictory.",
    );
  }
  return Object.freeze({ ...value }) as unknown as ReleaseCommitReconciliationResult;
}

function postDeleteFailureFields(cause: unknown): {
  code?: string;
  status?: number;
  googleStatus?: string;
  googleReasons?: readonly string[];
} {
  if (!(cause instanceof ReleaseError)) return {};
  return {
    ...(cause.publisherCode === undefined ? {} : { code: cause.publisherCode }),
    ...(cause.status === undefined ? {} : { status: cause.status }),
    ...(cause.googleStatus === undefined ? {} : { googleStatus: cause.googleStatus }),
    ...(cause.googleReasons === undefined ? {} : { googleReasons: cause.googleReasons }),
  };
}
/** This tuple permits an expired probe only; without contextual delete it proves nothing. */
function observedReadFailure(cause: unknown): boolean {
  return (
    cause instanceof ReleaseError &&
    cause.transportCode === undefined &&
    cause.publisherCode === "API_REQUEST_FAILED" &&
    cause.status === 400 &&
    cause.googleStatus === "FAILED_PRECONDITION" &&
    cause.googleReasons?.includes("failedPrecondition") === true
  );
}

export function createReleaseCommitReconciliationTool(
  options: ReleaseCommitReconciliationToolOptions,
): ReleaseCommitReconciliationTool {
  const packageName = validateReleasePackageName(options?.packageName);
  const candidate = parseReleaseCommitAttemptJournalRecord(options?.candidate, packageName);
  const mode = options?.mode;
  const digest = createReleaseCommitReconciliationRequestDigest(packageName, candidate, mode);
  const { gateway, journal, sessionStore, auditLedger } = options;
  const clock = options.now ?? (() => new Date());
  if (
    !gateway ||
    [gateway.getEdit, gateway.createEdit, gateway.getTrack, gateway.deleteEdit].some(
      (method) => typeof method !== "function",
    ) ||
    !journal ||
    [journal.list, journal.transition, journal.updateVerification].some(
      (method) => typeof method !== "function",
    ) ||
    !sessionStore ||
    typeof sessionStore.load !== "function" ||
    typeof sessionStore.clear !== "function" ||
    !auditLedger ||
    typeof auditLedger.append !== "function" ||
    typeof clock !== "function"
  ) {
    throw new ReleaseError("INVALID_ARGUMENT", "Commit reconciliation dependencies are invalid.");
  }
  const permission = mode === "probe" ? "read" : "destructive";
  const original = parseGooglePlayEditSession(
    { packageName, editId: candidate.editId, expiryTimeSeconds: candidate.expiryTimeSeconds },
    packageName,
  );
  const description =
    "Reconcile one exact durable commit attempt. Always probes the original edit first. Probe mode never inserts or deletes. Approved expired verification can create one temporary edit and delete only that exact temporary edit, never the original. No commit, upload, update, or serving/device propagation claim.";
  let receipt: ReleaseCommitReconciliationResult | undefined;
  let receiptRecord: ReleaseCommitAttemptJournalRecord | undefined;
  const load = async () => {
    try {
      const matches = (await journal.list()).filter(
        (record) => record.attemptId === candidate.attemptId,
      );
      if (matches.length !== 1)
        throw new ReleaseError(
          "COMMIT_STATE_CHANGED",
          "The approved commit attempt no longer matches the journal.",
          { externalStateUncertain: true },
        );
      return parseReleaseCommitAttemptJournalRecord(matches[0], packageName);
    } catch (cause) {
      if (cause instanceof ReleaseError && cause.code === "COMMIT_STATE_CHANGED") throw cause;
      throw new ReleaseError(
        "COMMIT_ATTEMPT_JOURNAL_INVALID",
        "Durable commit recovery evidence could not be read safely.",
        { cause, externalStateUncertain: true },
      );
    }
  };
  const tool: ToolDefinition<Record<string, never>, ReleaseCommitReconciliationResult> = {
    name: RELEASES_RECONCILE_COMMIT_TOOL_NAME,
    description,
    permission,
    inputSchema,
    outputSchema: { parse: parseResult },
    async execute(input) {
      inputSchema.parse(input);
      receipt = undefined;
      let record = await load();
      if (canonical(record) !== canonical(candidate))
        throw new ReleaseError(
          "COMMIT_STATE_CHANGED",
          "The approved commit attempt snapshot changed.",
          { externalStateUncertain: true },
        );
      let remote: unknown;
      let originalFailure: unknown;
      try {
        remote = await gateway.getEdit(original);
      } catch (cause) {
        originalFailure = cause;
      }
      const finish = async (
        outcome: "CASE_1" | "CASE_2" | "CASE_3",
        reason: ReleaseCommitReconciliationBasis,
      ) => {
        const result = parseResult({
          case: outcome,
          basis: reason,
          externalStateUncertain: outcome === "CASE_3",
          pendingCleanup:
            record.verificationInsertAttempted === true &&
            record.verificationCleanupVerified !== true,
          commitAcknowledged: candidate.acknowledgedAtUtc !== undefined,
          liveReleaseVerified: outcome === "CASE_1",
          servingPropagationVerified: false,
          attemptState: record.state,
          reconciliationRequestDigest: digest,
        });
        try {
          await auditLedger.append({
            type: "release.commit.reconciliation.completed",
            actor: "agent",
            action: RELEASES_RECONCILE_COMMIT_TOOL_NAME,
            status: result.externalStateUncertain ? "failure" : "success",
            timestamp: clock().toISOString(),
            metadata: {
              permission,
              case: result.case,
              basis: result.basis,
              externalStateUncertain: result.externalStateUncertain,
              pendingCleanup: result.pendingCleanup,
              commitAcknowledged: result.commitAcknowledged,
              liveReleaseVerified: result.liveReleaseVerified,
              servingPropagationVerified: false,
            },
          });
        } catch (cause) {
          throw new ReleaseError(
            "VERIFICATION_AUDIT_FAILED",
            "Commit reconciliation could not be audited.",
            { cause, externalStateUncertain: result.externalStateUncertain },
          );
        }
        receipt = result;
        receiptRecord = record;
        return result;
      };
      const update = async (patch: ReleaseCommitAttemptVerificationPatch) => {
        if (canonical(await load()) !== canonical(record))
          throw new ReleaseError("COMMIT_STATE_CHANGED", "Commit recovery evidence changed.");
        record = await journal.updateVerification(
          record.attemptId,
          record.state,
          clock().toISOString(),
          patch,
        );
      };
      const transition = async (state: ReleaseCommitAttemptState) => {
        if (canonical(await load()) !== canonical(record))
          throw new ReleaseError("COMMIT_STATE_CHANGED", "Commit recovery evidence changed.");
        record = await journal.transition(
          record.attemptId,
          record.state,
          state,
          clock().toISOString(),
        );
      };
      let managed;
      try {
        const loaded = await sessionStore.load();
        managed = loaded === undefined ? undefined : parseReleaseEditSession(loaded, packageName);
        if (
          managed !== undefined &&
          (managed.packageName !== packageName ||
            managed.editId !== candidate.editId ||
            managed.expiryTimeSeconds !== candidate.expiryTimeSeconds)
        )
          return await finish("CASE_3", "LOCAL_SESSION_CHANGED");
      } catch {
        return finish("CASE_3", "LOCAL_SESSION_CHANGED");
      }
      const exact =
        object(remote) &&
        remote.id === candidate.editId &&
        remote.expiryTimeSeconds === candidate.expiryTimeSeconds;
      const originalReadEligible = exact || observedReadFailure(originalFailure);
      if (!originalReadEligible)
        return finish(
          "CASE_3",
          originalFailure === undefined
            ? "ORIGINAL_IDENTITY_MISMATCH"
            : "ORIGINAL_READ_UNAVAILABLE",
        );
      const nowSeconds = epochSecondsFromDate(clock);
      if (exact && compareEpochSeconds(nowSeconds, candidate.expiryTimeSeconds) < 0) {
        if (record.verificationInsertAttempted === true)
          return finish("CASE_3", "ORIGINAL_IDENTITY_MISMATCH");
        if (
          !["PREPARED", "TRANSPORT_ATTEMPTED", "AMBIGUOUS", "RECONCILED_NOT_COMMITTED"].includes(
            record.state,
          )
        )
          return finish("CASE_3", "ORIGINAL_IDENTITY_MISMATCH");
        try {
          if (record.state !== "RECONCILED_NOT_COMMITTED")
            await transition("RECONCILED_NOT_COMMITTED");
        } catch {
          return finish("CASE_3", "JOURNAL_UNAVAILABLE");
        }
        return finish("CASE_2", "ORIGINAL_EDIT_ACTIVE");
      }
      if (
        record.state === "RECONCILED_NOT_COMMITTED" &&
        (record.verificationInsertAttempted !== true || record.verificationCleanupVerified === true)
      )
        return finish("CASE_2", "KNOWN_NEGATIVE_COMMIT_OUTCOME");
      if (record.state === "PREPARED" && record.verificationInsertAttempted !== true) {
        try {
          await transition("RECONCILED_NOT_COMMITTED");
        } catch {
          return finish("CASE_3", "JOURNAL_UNAVAILABLE");
        }
        return finish("CASE_2", "COMMIT_TRANSPORT_NOT_ATTEMPTED");
      }
      if (classifyReleaseEditCleanupRecordLocally(record, nowSeconds) !== "expired")
        return finish("CASE_3", "LOCAL_EXPIRY_NOT_ESTABLISHED");
      if (mode !== "verify_expired") return finish("CASE_3", "DESTRUCTIVE_APPROVAL_REQUIRED");
      const cleanup = async () => {
        if (record.verificationCleanupVerified === true) return true;
        const temporary = parseGooglePlayEditSession(
          {
            packageName,
            editId: record.verificationEditId,
            expiryTimeSeconds: record.verificationEditExpiryTimeSeconds,
          },
          packageName,
        );
        if (temporary.editId === original.editId)
          throw new ReleaseError(
            "VERIFICATION_EDIT_RESPONSE_INVALID",
            "Original edit deletion is forbidden.",
          );
        if (record.verificationDeleteAttempted !== true) {
          const before = await gateway.getEdit(temporary);
          if (
            before.id !== temporary.editId ||
            before.expiryTimeSeconds !== temporary.expiryTimeSeconds
          )
            return false;
          await update({ verificationPreDeleteReadVerified: true });
          await update({ verificationDeleteAttempted: true });
          await gateway.deleteEdit(temporary);
          await update({ verificationDeleteAcknowledged: true });
        }
        if (
          record.verificationDeleteAcknowledged !== true ||
          record.verificationPreDeleteReadVerified !== true
        )
          return false;
        let post;
        try {
          await gateway.getEdit(temporary);
          post = { packageName, editId: temporary.editId, failed: false };
        } catch (cause) {
          post = {
            packageName,
            editId: temporary.editId,
            failed: true,
            ...postDeleteFailureFields(cause),
          };
        }
        const verdict = classifyPostDeleteEditRead({
          preDeleteRead: {
            packageName,
            editId: temporary.editId,
            succeeded: record.verificationPreDeleteReadVerified,
          },
          delete: {
            packageName,
            editId: temporary.editId,
            acknowledged: record.verificationDeleteAcknowledged,
            attempts: 1,
            retryDisabled: EDIT_DELETE_POLICY.retry === false,
          },
          postDeleteRead: post,
        });
        if (verdict.verdict !== "REMOTE_INACTIVE") return false;
        await update({ verificationCleanupVerified: true });
        return true;
      };
      const closeVerified = async () => {
        if (
          record.verificationObservedStateDigest !== candidate.expectedStateDigest ||
          record.verificationCleanupVerified !== true
        )
          return finish("CASE_3", "VERIFICATION_PROOF_UNAVAILABLE");
        if (["TRANSPORT_ATTEMPTED", "ACKNOWLEDGED", "AMBIGUOUS"].includes(record.state))
          await transition("REMOTE_VERIFIED");
        if (record.state !== "REMOTE_VERIFIED" && record.state !== "RECONCILED_COMMITTED")
          return finish("CASE_3", "VERIFICATION_PROOF_UNAVAILABLE");
        const loaded = await sessionStore.load();
        const current =
          loaded === undefined ? undefined : parseReleaseEditSession(loaded, packageName);
        if (current !== undefined) {
          if (
            current.packageName !== packageName ||
            current.editId !== candidate.editId ||
            current.expiryTimeSeconds !== candidate.expiryTimeSeconds
          )
            return finish("CASE_3", "LOCAL_SESSION_CHANGED");
          await sessionStore.clear();
        }
        if ((await sessionStore.load()) !== undefined)
          return finish("CASE_3", "LOCAL_SESSION_CHANGED");
        if (record.state !== "RECONCILED_COMMITTED") await transition("RECONCILED_COMMITTED");
        return finish("CASE_1", "EXPECTED_STATE_OBSERVED");
      };
      try {
        if (record.verificationInsertAttempted === true) {
          if (record.verificationEditId === undefined)
            return finish("CASE_3", "VERIFICATION_IDENTITY_UNAVAILABLE");
          if (!(await cleanup())) return finish("CASE_3", "VERIFICATION_CLEANUP_PENDING");
          if (record.verificationObservedStateDigest === candidate.expectedStateDigest)
            return await closeVerified();
          if (record.verificationObservedStateDigest !== undefined) {
            if (record.state === "TRANSPORT_ATTEMPTED") await transition("AMBIGUOUS");
            return record.verificationObservedStateDigest === candidate.priorStateDigest
              ? finish("CASE_3", "PRIOR_STATE_OBSERVED")
              : finish("CASE_3", "UNRELATED_STATE_OBSERVED");
          }
          return finish("CASE_3", "VERIFICATION_PROOF_UNAVAILABLE");
        }
        // A claimed insert may be unknowable if Google accepted createEdit but the
        // response was lost: there is no edits.list, so the id can never be
        // guessed. Stay ambiguous and pending cleanup instead of inventing one.
        await update({ verificationInsertAttempted: true });
        const temporary = parseGooglePlayEditSession(await gateway.createEdit(), packageName);
        if (
          temporary.editId === original.editId ||
          temporary.expiryTimeSeconds === undefined ||
          compareEpochSeconds(epochSecondsFromDate(clock), temporary.expiryTimeSeconds) >= 0
        )
          return finish("CASE_3", "VERIFICATION_IDENTITY_UNAVAILABLE");
        await update({
          verificationEditId: temporary.editId,
          verificationEditExpiryTimeSeconds: temporary.expiryTimeSeconds,
        });
        const track = await gateway.getTrack(temporary, candidate.targetTrack);
        if (track.track !== candidate.targetTrack) {
          if (!(await cleanup())) return finish("CASE_3", "VERIFICATION_CLEANUP_PENDING");
          return finish("CASE_3", "VERIFICATION_PROOF_UNAVAILABLE");
        }
        const observed = createReleaseCommitStateDigest(track);
        await update({
          verificationObservedStateDigest: observed,
          verificationObservedAtUtc: clock().toISOString(),
        });
        if (observed !== candidate.expectedStateDigest) {
          if (record.state === "TRANSPORT_ATTEMPTED") await transition("AMBIGUOUS");
          if (!(await cleanup())) return finish("CASE_3", "VERIFICATION_CLEANUP_PENDING");
          // priorStateDigest is not approval-bound, so equal-as-prior is still
          // reported as unresolved rather than as a certain "not committed".
          return observed === candidate.priorStateDigest
            ? finish("CASE_3", "PRIOR_STATE_OBSERVED")
            : finish("CASE_3", "UNRELATED_STATE_OBSERVED");
        }
        await transition("REMOTE_VERIFIED");
        if (!(await cleanup())) return finish("CASE_3", "VERIFICATION_CLEANUP_PENDING");
        return await closeVerified();
      } catch {
        return finish(
          "CASE_3",
          record.verificationEditId
            ? "VERIFICATION_CLEANUP_PENDING"
            : "VERIFICATION_IDENTITY_UNAVAILABLE",
        );
      }
    },
    ...(permission === "destructive"
      ? {
          async verify(_input: Record<string, never>, output: ReleaseCommitReconciliationResult) {
            try {
              return (
                !!receipt &&
                !output.externalStateUncertain &&
                canonical(parseResult(output)) === canonical(receipt) &&
                canonical(await load()) === canonical(receiptRecord) &&
                (output.case !== "CASE_1" || (await sessionStore.load()) === undefined)
              );
            } catch {
              return false;
            }
          },
        }
      : {}),
  };
  const binding: AgentToolBinding = {
    toolName: RELEASES_RECONCILE_COMMIT_TOOL_NAME,
    llm: {
      name: RELEASES_RECONCILE_COMMIT_TOOL_NAME,
      description,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    ...(permission === "destructive"
      ? {
          approval: {
            createRequestDigest: () => digest,
            createSafeSummary: () =>
              `DESTRUCTIVE verification of one expired commit attempt for ${packageName}. One temporary insert may invalidate other edits owned by this API user. Deletes only the exact verification edit once with retries disabled. Never deletes the original, never commits. Bound attempt: ${candidate.attemptId}.`,
          },
        }
      : {}),
    serializeResult(output: unknown, verification: VerificationResult) {
      if (
        verification.toolName !== RELEASES_RECONCILE_COMMIT_TOOL_NAME ||
        verification.permission !== permission ||
        (permission === "destructive"
          ? verification.required !== true ||
            verification.code !== "VERIFIED" ||
            !verification.verified
          : verification.required !== false ||
            !["VERIFIED", "VERIFICATION_SKIPPED"].includes(verification.code))
      ) {
        throw new ReleaseError(
          "VERIFICATION_STATE_MISMATCH",
          "Commit reconciliation was not verified.",
        );
      }
      const result = parseResult(output);
      if (result.reconciliationRequestDigest !== digest)
        throw new ReleaseError(
          "VERIFICATION_STATE_MISMATCH",
          "Commit reconciliation binding changed.",
        );
      const { reconciliationRequestDigest: _internal, ...safe } = result;
      return JSON.stringify({
        ...safe,
        targetTrack: candidate.targetTrack,
        versionCode: candidate.versionCode,
      });
    },
  };
  return Object.freeze({ tool, binding });
}

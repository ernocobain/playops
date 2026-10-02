/**
 * Phase 4.11 Layer B — destructive exact TrackRelease verification.
 *
 * The direct Layer A summary GET runs first. Only after it observes the expected
 * release does this tool create one temporary edit, read the exact Track state,
 * and delete that temporary edit exactly once. It never commits or changes a
 * release/track.
 */
import type { NewAuditEntry } from "../audit/index.js";
import type { AgentToolBinding } from "../runtime/agent/index.js";
import type { ToolDefinition, ToolSchema } from "../runtime/tools/index.js";
import type { VerificationResult } from "../runtime/verification/index.js";
import {
  compareEpochSeconds,
  epochSecondsFromDate,
  parseGooglePlayEditSession,
  ReleaseError,
  type ReleaseStatus,
} from "./index.js";
import type { ReleaseEditSessionStore } from "./session-store.js";
import type { ReleaseSummaryGateway, ReleaseTemporaryEditVerificationGateway } from "./gateway.js";
import type { ReleaseEditCleanupJournal } from "./cleanup-journal.js";
import {
  createReleaseVerificationApprovalBinding,
  createReleaseVerificationRequestDigest,
  type ReleaseVerificationIntent,
  RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME,
} from "./readback-approval.js";
import {
  inspectDirectReleaseSummary,
  verifyExactTrackState,
  type DirectReleaseSummaryEvidence,
} from "./readback.js";

export { RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME } from "./readback-approval.js";

export interface ExactReleaseVerificationResult {
  readonly targetTrack: string;
  readonly versionCode: string;
  readonly releaseName: string;
  readonly status: ReleaseStatus;
  readonly userFraction?: number;
  readonly releaseLifecycleState: string;
  readonly releaseObserved: true;
  readonly exactTrackStateVerified: true;
  readonly liveReleaseVerified: true;
  readonly servingPropagationVerified: false;
  /** Internal evidence consumed by the Phase 2 verifier; omitted by serialization. */
  readonly temporaryEditCleanupSucceeded: true;
  /** Internal trusted-state binding; omitted by serialization. */
  readonly verificationRequestDigest: string;
}

export interface ReleaseExactVerificationAuditLedger {
  append(entry: NewAuditEntry): Promise<void>;
}

export interface ReleaseExactVerificationToolOptions {
  readonly packageName: string;
  readonly intent: ReleaseVerificationIntent;
  readonly summaryGateway: ReleaseSummaryGateway;
  readonly temporaryEditGateway: ReleaseTemporaryEditVerificationGateway;
  readonly sessionStore: ReleaseEditSessionStore;
  /**
   * Phase 4.15: durable journal that must persist the exact temporary edit id
   * BEFORE any further Google call, and drop it after a confirmed delete.
   */
  readonly cleanupJournal: ReleaseEditCleanupJournal;
  readonly auditLedger: ReleaseExactVerificationAuditLedger;
  readonly now?: () => Date;
}

export interface ReleaseExactVerificationTool {
  readonly tool: ToolDefinition<Record<string, never>, ExactReleaseVerificationResult>;
  readonly binding: AgentToolBinding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const inputSchema: ToolSchema<Record<string, never>> = {
  parse(value: unknown): Record<string, never> {
    if (!isRecord(value) || Object.keys(value).length !== 0) {
      throw new ReleaseError(
        "INVALID_ARGUMENT",
        "Committed release verification input is invalid.",
      );
    }
    return Object.freeze({});
  },
};

function parseFraction(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new ReleaseError(
      "VERIFICATION_STATE_MISMATCH",
      "Exact rollout fraction evidence is invalid.",
    );
  }
  return value;
}

function parseResult(value: unknown): ExactReleaseVerificationResult {
  if (!isRecord(value)) {
    throw new ReleaseError(
      "VERIFICATION_STATE_MISMATCH",
      "Exact release verification result is invalid.",
    );
  }
  const allowed = new Set([
    "exactTrackStateVerified",
    "liveReleaseVerified",
    "releaseLifecycleState",
    "releaseName",
    "releaseObserved",
    "servingPropagationVerified",
    "status",
    "targetTrack",
    "temporaryEditCleanupSucceeded",
    "verificationRequestDigest",
    "userFraction",
    "versionCode",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ReleaseError(
      "VERIFICATION_STATE_MISMATCH",
      "Exact release verification result is invalid.",
    );
  }
  if (
    value.targetTrack === undefined ||
    typeof value.targetTrack !== "string" ||
    typeof value.versionCode !== "string" ||
    typeof value.releaseName !== "string" ||
    typeof value.status !== "string" ||
    typeof value.releaseLifecycleState !== "string" ||
    value.releaseObserved !== true ||
    value.exactTrackStateVerified !== true ||
    value.liveReleaseVerified !== true ||
    value.servingPropagationVerified !== false ||
    value.temporaryEditCleanupSucceeded !== true ||
    typeof value.verificationRequestDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.verificationRequestDigest)
  ) {
    throw new ReleaseError(
      "VERIFICATION_STATE_MISMATCH",
      "Exact release verification result is invalid.",
    );
  }
  const userFraction = parseFraction(value.userFraction);
  return Object.freeze({
    targetTrack: value.targetTrack,
    versionCode: value.versionCode,
    releaseName: value.releaseName,
    status: value.status as ReleaseStatus,
    ...(userFraction !== undefined ? { userFraction } : {}),
    releaseLifecycleState: value.releaseLifecycleState,
    releaseObserved: true,
    exactTrackStateVerified: true,
    liveReleaseVerified: true,
    servingPropagationVerified: false,
    temporaryEditCleanupSucceeded: true,
    verificationRequestDigest: value.verificationRequestDigest,
  });
}

async function appendAudit(
  ledger: ReleaseExactVerificationAuditLedger,
  status: "success" | "failure",
  now: () => Date,
  metadata: Record<string, unknown>,
): Promise<void> {
  await ledger.append({
    type:
      status === "success" ? "release.readback.exact.completed" : "release.readback.exact.failed",
    actor: "agent",
    action: RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME,
    status,
    timestamp: now().toISOString(),
    metadata: {
      permission: "destructive",
      layer: "B",
      ...metadata,
    },
  });
}

function auditFailure(cause: unknown): ReleaseError {
  return new ReleaseError(
    "VERIFICATION_AUDIT_FAILED",
    "Release verification result could not be recorded safely in the audit log.",
    { cause, externalStateUncertain: false },
  );
}

function mapFailure(cause: unknown): ReleaseError {
  if (cause instanceof ReleaseError) {
    if (
      cause.code === "COMMITTED_RELEASE_NOT_OBSERVED" ||
      cause.code === "COMMITTED_RELEASE_AMBIGUOUS" ||
      cause.code === "MANAGED_EDIT_ALREADY_OPEN" ||
      cause.code === "VERIFICATION_STATE_MISMATCH" ||
      cause.code === "RELEASE_SUMMARY_READ_FAILED" ||
      cause.code === "RELEASE_SUMMARY_RESPONSE_INVALID"
    ) {
      return cause;
    }
    if (
      cause.code === "VERIFICATION_EDIT_CLEANUP_FAILED" ||
      cause.code === "VERIFICATION_EDIT_CREATE_FAILED" ||
      cause.code === "VERIFICATION_EDIT_RESPONSE_INVALID" ||
      cause.code === "VERIFICATION_TRACK_READ_FAILED" ||
      cause.code === "VERIFICATION_JOURNAL_WRITE_FAILED" ||
      cause.code === "VERIFICATION_JOURNAL_REMOVE_FAILED"
    ) {
      return cause;
    }
    return new ReleaseError("VERIFICATION_TRACK_READ_FAILED", cause.message, {
      cause,
      externalStateUncertain: cause.externalStateUncertain === true,
    });
  }
  return new ReleaseError(
    "VERIFICATION_TRACK_READ_FAILED",
    "The exact temporary-edit track could not be verified.",
    { cause, externalStateUncertain: false },
  );
}

function validateTemporaryEdit(
  value: unknown,
  packageName: string,
  nowSeconds: string,
): ReturnType<typeof parseGooglePlayEditSession> {
  let session: ReturnType<typeof parseGooglePlayEditSession>;
  try {
    session = parseGooglePlayEditSession(value, packageName);
  } catch (cause) {
    throw new ReleaseError(
      "VERIFICATION_EDIT_RESPONSE_INVALID",
      "Temporary verification edit response is invalid.",
      { cause, externalStateUncertain: true },
    );
  }
  if (
    typeof session.expiryTimeSeconds !== "string" ||
    compareEpochSeconds(nowSeconds, session.expiryTimeSeconds) >= 0
  ) {
    throw new ReleaseError(
      "VERIFICATION_EDIT_RESPONSE_INVALID",
      "Temporary verification edit expiry is invalid or expired.",
      { externalStateUncertain: true },
    );
  }
  return session;
}

export function createReleaseExactVerificationTool(
  options: ReleaseExactVerificationToolOptions,
): ReleaseExactVerificationTool {
  const packageName = options.packageName;
  const intent = options.intent;
  if (!intent || intent.packageName !== packageName) {
    throw new ReleaseError(
      "INVALID_COMMIT_INTENT",
      "Exact verification intent package binding is invalid.",
    );
  }
  const summaryGateway = options.summaryGateway;
  const temporaryEditGateway = options.temporaryEditGateway;
  const sessionStore = options.sessionStore;
  const cleanupJournal = options.cleanupJournal;
  const auditLedger = options.auditLedger;
  const clock = options.now ?? (() => new Date());
  if (!summaryGateway || typeof summaryGateway.listReleaseSummaries !== "function") {
    throw new ReleaseError("INVALID_ARGUMENT", "Release summary gateway is invalid.");
  }
  if (
    !temporaryEditGateway ||
    typeof temporaryEditGateway.createEdit !== "function" ||
    typeof temporaryEditGateway.getTrack !== "function" ||
    typeof temporaryEditGateway.deleteEdit !== "function"
  ) {
    throw new ReleaseError("INVALID_ARGUMENT", "Temporary verification gateway is invalid.");
  }
  if (!sessionStore || typeof sessionStore.load !== "function") {
    throw new ReleaseError("INVALID_ARGUMENT", "Release edit session store is invalid.");
  }
  if (!auditLedger || typeof auditLedger.append !== "function") {
    throw new ReleaseError("INVALID_ARGUMENT", "Release verification audit ledger is invalid.");
  }
  if (
    !cleanupJournal ||
    typeof cleanupJournal.record !== "function" ||
    typeof cleanupJournal.remove !== "function"
  ) {
    throw new ReleaseError("INVALID_ARGUMENT", "Release verification cleanup journal is invalid.");
  }

  const approval = createReleaseVerificationApprovalBinding(intent);
  const description =
    "DESTRUCTIVE exact post-commit read-back verification. First reads the direct deployed-release summary; only when it observes the expected release does it create one temporary Google Play edit, read the exact TrackRelease state, and delete that temporary edit once. Creating the temporary edit may invalidate another active edit owned by this API user. It never commits, uploads, updates, patches, creates a track, or replies to reviews. Exact status, rollout fraction, and trusted release notes are checked; serving/device propagation is not claimed.";

  const tool: ToolDefinition<Record<string, never>, ExactReleaseVerificationResult> = {
    name: RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME,
    description,
    permission: "destructive",
    inputSchema,
    outputSchema: { parse: parseResult },
    async execute(input) {
      inputSchema.parse(input);
      let summary: DirectReleaseSummaryEvidence | undefined;
      let temporaryEdit: ReturnType<typeof parseGooglePlayEditSession> | undefined;
      let cleanupAttempted = false;
      try {
        // Layer A is mandatory and always precedes any destructive operation.
        summary = await inspectDirectReleaseSummary(summaryGateway, intent);

        const localSession = await sessionStore.load();
        if (localSession !== undefined) {
          throw new ReleaseError(
            "MANAGED_EDIT_ALREADY_OPEN",
            "A normal managed Play edit session is already open; exact verification will not create a temporary edit.",
            { externalStateUncertain: false },
          );
        }

        const nowSeconds = epochSecondsFromDate(clock);
        let created: unknown;
        try {
          created = await temporaryEditGateway.createEdit();
        } catch (cause) {
          throw new ReleaseError(
            "VERIFICATION_EDIT_CREATE_FAILED",
            "Temporary verification edit creation failed; remote state may be uncertain.",
            { cause, externalStateUncertain: true },
          );
        }
        temporaryEdit = validateTemporaryEdit(created, packageName, nowSeconds);

        // Phase 4.15 D6: the exact temporary edit id must be durably journalled
        // BEFORE any further Google call, so a failed cleanup can never lose it.
        try {
          await cleanupJournal.record({
            editId: temporaryEdit.editId,
            expiryTimeSeconds: temporaryEdit.expiryTimeSeconds ?? "",
            source: "exact_release_verification",
            createdAt: clock().toISOString(),
          });
        } catch (cause) {
          // No trustworthy journal record: stop the normal workflow, do not read
          // the track, and attempt exactly one delete for this exact edit id.
          cleanupAttempted = true;
          try {
            await temporaryEditGateway.deleteEdit(temporaryEdit);
          } catch (deleteCause) {
            throw new ReleaseError(
              "VERIFICATION_JOURNAL_WRITE_FAILED",
              "The temporary verification edit could not be journaled and its deletion could not be confirmed; remote state may be uncertain.",
              { cause: deleteCause, externalStateUncertain: true },
            );
          }
          throw new ReleaseError(
            "VERIFICATION_JOURNAL_WRITE_FAILED",
            "The temporary verification edit could not be journaled; the exact edit was deleted instead.",
            { cause, externalStateUncertain: false },
          );
        }

        let track;
        try {
          track = await temporaryEditGateway.getTrack(temporaryEdit, intent.targetTrack);
        } catch (cause) {
          throw new ReleaseError(
            "VERIFICATION_TRACK_READ_FAILED",
            "The exact temporary-edit track could not be read.",
            { cause, externalStateUncertain: false },
          );
        }
        const exact = verifyExactTrackState(track, intent);

        cleanupAttempted = true;
        try {
          await temporaryEditGateway.deleteEdit(temporaryEdit);
        } catch (cause) {
          throw new ReleaseError(
            "VERIFICATION_EDIT_CLEANUP_FAILED",
            "Exact release verification succeeded, but the temporary edit could not be deleted.",
            { cause, externalStateUncertain: true },
          );
        }
        try {
          await cleanupJournal.remove(temporaryEdit.editId);
        } catch (cause) {
          throw new ReleaseError(
            "VERIFICATION_JOURNAL_REMOVE_FAILED",
            "The temporary verification edit was deleted, but its cleanup journal record could not be removed.",
            { cause, externalStateUncertain: false },
          );
        }

        const result: ExactReleaseVerificationResult = Object.freeze({
          targetTrack: intent.targetTrack,
          versionCode: intent.versionCode,
          releaseName: intent.expectedReleaseName,
          status: exact.release.status,
          ...(exact.release.userFraction !== undefined
            ? { userFraction: exact.release.userFraction }
            : {}),
          releaseLifecycleState: summary.releaseLifecycleState,
          releaseObserved: true,
          exactTrackStateVerified: true,
          liveReleaseVerified: true,
          servingPropagationVerified: false,
          temporaryEditCleanupSucceeded: true,
          verificationRequestDigest: createReleaseVerificationRequestDigest(intent),
        });
        try {
          await appendAudit(auditLedger, "success", clock, {
            targetTrack: result.targetTrack,
            versionCode: result.versionCode,
            releaseName: result.releaseName,
            status: result.status,
            ...(result.userFraction !== undefined ? { userFraction: result.userFraction } : {}),
            releaseLifecycleState: result.releaseLifecycleState,
            releaseObserved: true,
            exactTrackStateVerified: true,
            liveReleaseVerified: true,
            servingPropagationVerified: false,
            temporaryEditCreated: true,
            temporaryEditCleanupSucceeded: true,
            cleanupAttempted,
          });
        } catch (cause) {
          throw auditFailure(cause);
        }
        return result;
      } catch (cause) {
        const mapped = mapFailure(cause);
        // A trustworthy temporary edit is deleted exactly once after every
        // deterministic deep-read failure. Never guess an id after ambiguity.
        if (temporaryEdit !== undefined && !cleanupAttempted) {
          cleanupAttempted = true;
          try {
            await temporaryEditGateway.deleteEdit(temporaryEdit);
          } catch (cleanupCause) {
            const cleanupFailure = new ReleaseError(
              "VERIFICATION_EDIT_CLEANUP_FAILED",
              "Temporary verification edit cleanup failed; external state may be uncertain.",
              { cause: cleanupCause, externalStateUncertain: true },
            );
            try {
              await appendAudit(auditLedger, "failure", clock, {
                targetTrack: intent.targetTrack,
                versionCode: intent.versionCode,
                releaseObserved: summary !== undefined,
                exactTrackStateVerified: false,
                errorCode: cleanupFailure.code,
                externalStateUncertain: true,
                temporaryEditCreated: true,
                temporaryEditCleanupSucceeded: false,
                cleanupAttempted: true,
              });
            } catch (auditCause) {
              throw auditFailure(auditCause);
            }
            throw cleanupFailure;
          }
          // The remote edit is gone; a stale journal record is safe (hygiene
          // inspection is report-only) and never masks the primary failure code.
          await cleanupJournal.remove(temporaryEdit.editId).catch(() => undefined);
        }
        try {
          await appendAudit(auditLedger, "failure", clock, {
            targetTrack: intent.targetTrack,
            versionCode: intent.versionCode,
            releaseObserved: summary !== undefined,
            exactTrackStateVerified: false,
            errorCode: mapped.code,
            externalStateUncertain: mapped.externalStateUncertain === true,
            temporaryEditCreated: temporaryEdit !== undefined,
            temporaryEditCleanupSucceeded: temporaryEdit === undefined ? false : cleanupAttempted,
            cleanupAttempted,
          });
        } catch (auditCause) {
          throw auditFailure(auditCause);
        }
        throw mapped;
      }
    },
    async verify(_input, output) {
      try {
        const result = parseResult(output);
        return (
          result.targetTrack === intent.targetTrack &&
          result.versionCode === intent.versionCode &&
          result.releaseName === intent.expectedReleaseName &&
          result.status === intent.expectedStatus &&
          (intent.expectedUserFraction === undefined
            ? result.userFraction === undefined
            : result.userFraction === intent.expectedUserFraction) &&
          result.releaseObserved === true &&
          result.exactTrackStateVerified === true &&
          result.liveReleaseVerified === true &&
          result.servingPropagationVerified === false &&
          result.temporaryEditCleanupSucceeded === true &&
          result.verificationRequestDigest === createReleaseVerificationRequestDigest(intent)
        );
      } catch {
        return false;
      }
    },
  };

  const binding: AgentToolBinding = {
    toolName: RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME,
    llm: {
      name: RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME,
      description,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    approval,
    serializeResult(output: unknown, verification: VerificationResult): string {
      if (
        verification.toolName !== RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME ||
        verification.permission !== "destructive" ||
        verification.required !== true ||
        verification.code !== "VERIFIED" ||
        verification.verified !== true
      ) {
        throw new ReleaseError(
          "VERIFICATION_STATE_MISMATCH",
          "Exact release verification was not verified.",
        );
      }
      const result = parseResult(output);
      return JSON.stringify({
        targetTrack: result.targetTrack,
        versionCode: result.versionCode,
        releaseName: result.releaseName,
        status: result.status,
        ...(result.userFraction !== undefined ? { userFraction: result.userFraction } : {}),
        releaseLifecycleState: result.releaseLifecycleState,
        releaseObserved: result.releaseObserved,
        exactTrackStateVerified: result.exactTrackStateVerified,
        liveReleaseVerified: result.liveReleaseVerified,
        servingPropagationVerified: result.servingPropagationVerified,
      });
    },
  };
  return Object.freeze({ tool, binding });
}

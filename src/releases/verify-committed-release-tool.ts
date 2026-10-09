/**
 * Phase 4.11 Layer B — destructive exact committed-state verification.
 *
 * The direct Layer A summary GET runs first. Only after it observes the expected
 * release does this tool create one temporary edit, read the exact Track state,
 * and delete that temporary edit exactly once. It never commits or changes a
 * release/track.
 *
 * Stage 3E.1: the decisive proof is the durable commit-state digest —
 * `createReleaseCommitStateDigest(observedTrack) === intent.expectedStateDigest`.
 * Release-note and rollout-fraction field comparison was removed because that
 * expectation is not durably stored after an acknowledged commit, while the
 * digest already covers the whole normalized track (release notes, name, status,
 * rollout fraction, version codes, country targeting, update priority).
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
  type ReleaseState,
  type ReleaseStatus,
  type ReleaseTrackState,
} from "./index.js";
import type { ReleaseEditSessionStore } from "./session-store.js";
import type { ReleaseSummaryGateway, ReleaseTemporaryEditVerificationGateway } from "./gateway.js";
import type { ReleaseEditCleanupJournal } from "./cleanup-journal.js";
import {
  ReleaseVerificationEvidencePersistenceError,
  type ReleaseVerificationEvidenceEvent,
  type ReleaseVerificationEvidenceSink,
} from "./verification-evidence.js";
import { createReleaseCommitStateDigest } from "./commit-approval.js";
import {
  createReleaseStateVerificationApprovalBinding,
  createReleaseStateVerificationRequestDigest,
  type ReleaseStateVerificationIntent,
  RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME,
} from "./readback-approval.js";
import {
  inspectDirectReleaseSummaryForIdentity,
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
  /**
   * The commit-state digest actually observed through the temporary edit. Stage
   * 3E consumes it directly as the commit-attempt journal's
   * `verificationObservedStateDigest` — same helper, same domain, no conversion.
   */
  readonly observedStateDigest: string;
  /** Internal evidence consumed by the Phase 2 verifier; omitted by serialization. */
  readonly temporaryEditCleanupSucceeded: true;
  /** Durable cleanup proof; the commit-attempt journal field of the same name. */
  readonly verificationCleanupVerified: true;
  /** Internal trusted-state binding; omitted by serialization. */
  readonly verificationRequestDigest: string;
}

export interface ReleaseExactVerificationAuditLedger {
  append(entry: NewAuditEntry): Promise<void>;
}

export interface ReleaseExactVerificationToolOptions {
  readonly packageName: string;
  readonly intent: ReleaseStateVerificationIntent;
  readonly summaryGateway: ReleaseSummaryGateway;
  readonly temporaryEditGateway: ReleaseTemporaryEditVerificationGateway;
  readonly sessionStore: ReleaseEditSessionStore;
  /**
   * Phase 4.15: durable journal that must persist the exact temporary edit id
   * BEFORE any further Google call, and drop it after a confirmed delete.
   */
  readonly cleanupJournal: ReleaseEditCleanupJournal;
  readonly auditLedger: ReleaseExactVerificationAuditLedger;
  /** Trusted internal lifecycle consumer; never supplied through tool input. */
  readonly evidenceSink?: ReleaseVerificationEvidenceSink;
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
    "observedStateDigest",
    "releaseLifecycleState",
    "releaseName",
    "releaseObserved",
    "servingPropagationVerified",
    "status",
    "targetTrack",
    "temporaryEditCleanupSucceeded",
    "verificationCleanupVerified",
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
    typeof value.observedStateDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.observedStateDigest) ||
    value.temporaryEditCleanupSucceeded !== true ||
    value.verificationCleanupVerified !== true ||
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
    observedStateDigest: value.observedStateDigest,
    temporaryEditCleanupSucceeded: true,
    verificationCleanupVerified: true,
    verificationRequestDigest: value.verificationRequestDigest,
  });
}

/**
 * The single observed release carrying the verified versionCode, used only for
 * reporting status and rollout fraction. Unreachable after a successful digest
 * match (the expected state contained exactly one such release), but it fails
 * closed instead of guessing.
 */
function observedRelease(track: ReleaseTrackState, versionCode: string): ReleaseState {
  const matches = track.releases.filter((release) => release.versionCodes.includes(versionCode));
  const release = matches.length === 1 ? matches[0] : undefined;
  if (!release) {
    throw new ReleaseError(
      "VERIFICATION_STATE_MISMATCH",
      "The observed committed track does not expose exactly one release for the verified version.",
      { externalStateUncertain: false },
    );
  }
  return release;
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
  if (cause instanceof ReleaseVerificationEvidencePersistenceError) return cause;
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
): ReturnType<typeof parseGooglePlayEditSession> & { readonly expiryTimeSeconds: string } {
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
  return Object.freeze({ ...session, expiryTimeSeconds: session.expiryTimeSeconds });
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
  const evidenceSink = options.evidenceSink;
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
  if (evidenceSink !== undefined && (!evidenceSink || typeof evidenceSink.record !== "function")) {
    throw new ReleaseError("INVALID_ARGUMENT", "Release verification evidence sink is invalid.");
  }
  if (
    !cleanupJournal ||
    typeof cleanupJournal.record !== "function" ||
    typeof cleanupJournal.remove !== "function"
  ) {
    throw new ReleaseError("INVALID_ARGUMENT", "Release verification cleanup journal is invalid.");
  }

  const approval = createReleaseStateVerificationApprovalBinding(intent);
  const description =
    "DESTRUCTIVE exact post-commit read-back verification of the committed release state. First reads the direct deployed-release summary; only when it observes the expected release does it create one temporary Google Play edit, read the exact Track state, and delete that temporary edit once. Creating the temporary edit may invalidate another active edit owned by this API user. It never commits, uploads, updates, patches, creates a track, or replies to reviews. Success requires the observed track to canonicalize to the approved durable commit-state digest; serving/device propagation is not claimed.";

  const tool: ToolDefinition<Record<string, never>, ExactReleaseVerificationResult> = {
    name: RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME,
    description,
    permission: "destructive",
    inputSchema,
    outputSchema: { parse: parseResult },
    async execute(input) {
      inputSchema.parse(input);
      let summary: DirectReleaseSummaryEvidence | undefined;
      let temporaryEdit: ReturnType<typeof validateTemporaryEdit> | undefined;
      let cleanupAttempted = false;
      let temporaryEditCleanupSucceeded = false;
      let journalRemovalAttempted = false;
      let verificationCleanupVerified = false;
      let committedStateObserved = false;
      const recordEvidence = async (event: ReleaseVerificationEvidenceEvent): Promise<void> => {
        if (evidenceSink === undefined) return;
        try {
          await evidenceSink.record(Object.freeze(event));
        } catch (cause) {
          throw new ReleaseVerificationEvidencePersistenceError(event.type, {
            cause,
            committedStateObserved,
            temporaryEditCleanupSucceeded,
            verificationCleanupVerified,
            externalStateUncertain: temporaryEdit !== undefined && !temporaryEditCleanupSucceeded,
          });
        }
      };
      try {
        // Layer A is mandatory and always precedes any destructive operation.
        summary = await inspectDirectReleaseSummaryForIdentity(summaryGateway, intent);

        const localSession = await sessionStore.load();
        if (localSession !== undefined) {
          throw new ReleaseError(
            "MANAGED_EDIT_ALREADY_OPEN",
            "A normal managed Play edit session is already open; exact verification will not create a temporary edit.",
            { externalStateUncertain: false },
          );
        }

        const nowSeconds = epochSecondsFromDate(clock);
        // The awaited attempt evidence must precede destructive insert transport.
        await recordEvidence({ type: "verification_insert_attempted" });
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
            expiryTimeSeconds: temporaryEdit.expiryTimeSeconds,
            source: "exact_release_verification",
            createdAt: clock().toISOString(),
          });
        } catch (cause) {
          // No trustworthy journal record: stop the normal workflow, do not read
          // the track, and attempt exactly one delete for this exact edit id.
          cleanupAttempted = true;
          try {
            await temporaryEditGateway.deleteEdit(temporaryEdit);
            temporaryEditCleanupSucceeded = true;
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

        await recordEvidence({
          type: "verification_edit_identified",
          editId: temporaryEdit.editId,
          expiryTimeSeconds: temporaryEdit.expiryTimeSeconds,
        });

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
        // Stage 3E.1 decisive proof: the observed committed track state must
        // canonicalize to the durable expected commit-state digest. There is no
        // alternate equality path, no field-level fallback, and a track that
        // cannot be canonicalized fails closed rather than degrading.
        let observedStateDigest: string;
        try {
          observedStateDigest = createReleaseCommitStateDigest(track);
        } catch (cause) {
          throw new ReleaseError(
            "VERIFICATION_STATE_MISMATCH",
            "The observed temporary-edit track state cannot be canonicalized into the durable commit-state domain.",
            { cause, externalStateUncertain: false },
          );
        }
        if (observedStateDigest !== intent.expectedStateDigest) {
          throw new ReleaseError(
            "VERIFICATION_STATE_MISMATCH",
            "The observed committed track state differs from the approved expected committed state.",
            { externalStateUncertain: false },
          );
        }
        const observed = observedRelease(track, intent.versionCode);
        committedStateObserved = true;

        if (evidenceSink !== undefined) {
          await recordEvidence({
            type: "verification_state_observed",
            observedStateDigest,
            observedAtUtc: clock().toISOString(),
          });
        }
        await recordEvidence({ type: "verification_pre_delete_read_verified" });
        await recordEvidence({ type: "verification_delete_attempted" });

        cleanupAttempted = true;
        try {
          await temporaryEditGateway.deleteEdit(temporaryEdit);
          temporaryEditCleanupSucceeded = true;
        } catch (cause) {
          throw new ReleaseError(
            "VERIFICATION_EDIT_CLEANUP_FAILED",
            "Exact release verification succeeded, but the temporary edit could not be deleted.",
            { cause, externalStateUncertain: true },
          );
        }
        await recordEvidence({ type: "verification_delete_acknowledged" });
        journalRemovalAttempted = true;
        try {
          await cleanupJournal.remove(temporaryEdit.editId);
          verificationCleanupVerified = true;
        } catch (cause) {
          throw new ReleaseError(
            "VERIFICATION_JOURNAL_REMOVE_FAILED",
            "The temporary verification edit was deleted, but its cleanup journal record could not be removed.",
            { cause, externalStateUncertain: false },
          );
        }

        await recordEvidence({ type: "verification_cleanup_verified" });

        const result: ExactReleaseVerificationResult = Object.freeze({
          targetTrack: intent.targetTrack,
          versionCode: intent.versionCode,
          releaseName: intent.expectedReleaseName,
          status: observed.status,
          ...(observed.userFraction !== undefined ? { userFraction: observed.userFraction } : {}),
          releaseLifecycleState: summary.releaseLifecycleState,
          releaseObserved: true,
          exactTrackStateVerified: true,
          liveReleaseVerified: true,
          servingPropagationVerified: false,
          observedStateDigest,
          temporaryEditCleanupSucceeded: true,
          verificationCleanupVerified: true,
          verificationRequestDigest: createReleaseStateVerificationRequestDigest(intent),
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
            observedStateDigest: result.observedStateDigest,
            temporaryEditCreated: true,
            temporaryEditCleanupSucceeded: true,
            verificationCleanupVerified: true,
            cleanupAttempted,
          });
        } catch (cause) {
          throw auditFailure(cause);
        }
        return result;
      } catch (cause) {
        let mapped = mapFailure(cause);
        // A trustworthy temporary edit is deleted exactly once after every
        // deterministic deep-read failure. Never guess an id after ambiguity.
        if (temporaryEdit !== undefined && !cleanupAttempted) {
          cleanupAttempted = true;
          try {
            await temporaryEditGateway.deleteEdit(temporaryEdit);
            temporaryEditCleanupSucceeded = true;
          } catch (cleanupCause) {
            // Preserve LOCAL evidence failure as the primary classification;
            // the final snapshot separately exposes an uncertain exact delete.
            if (!(mapped instanceof ReleaseVerificationEvidencePersistenceError)) {
              mapped = new ReleaseError(
                "VERIFICATION_EDIT_CLEANUP_FAILED",
                "Temporary verification edit cleanup failed; external state may be uncertain.",
                { cause: cleanupCause, externalStateUncertain: true },
              );
            }
          }
        }
        if (
          temporaryEdit !== undefined &&
          temporaryEditCleanupSucceeded &&
          !journalRemovalAttempted
        ) {
          // The remote edit is gone; a stale journal record is safe (hygiene
          // inspection is report-only). Never mask the primary failure, but keep
          // truthful cleanup proof if removal fails. This also covers a sink
          // failure after delete acknowledgement without deleting a second time.
          await cleanupJournal.remove(temporaryEdit.editId).then(
            () => {
              verificationCleanupVerified = true;
            },
            () => {
              verificationCleanupVerified = false;
            },
          );
        }
        if (mapped instanceof ReleaseVerificationEvidencePersistenceError) {
          mapped = new ReleaseVerificationEvidencePersistenceError(mapped.failedEvent, {
            cause: mapped.cause,
            committedStateObserved,
            temporaryEditCleanupSucceeded,
            verificationCleanupVerified,
            externalStateUncertain: temporaryEdit !== undefined && !temporaryEditCleanupSucceeded,
          });
        }
        try {
          await appendAudit(auditLedger, "failure", clock, {
            targetTrack: intent.targetTrack,
            versionCode: intent.versionCode,
            releaseObserved: summary !== undefined,
            exactTrackStateVerified:
              mapped instanceof ReleaseVerificationEvidencePersistenceError &&
              committedStateObserved,
            errorCode: mapped.code,
            externalStateUncertain: mapped.externalStateUncertain === true,
            temporaryEditCreated: temporaryEdit !== undefined,
            temporaryEditCleanupSucceeded,
            cleanupAttempted,
          });
        } catch (auditCause) {
          if (mapped instanceof ReleaseVerificationEvidencePersistenceError) {
            throw new ReleaseVerificationEvidencePersistenceError(mapped.failedEvent, {
              cause: mapped.cause,
              committedStateObserved,
              temporaryEditCleanupSucceeded,
              verificationCleanupVerified,
              externalStateUncertain: mapped.externalStateUncertain === true,
              auditPersistenceFailed: true,
            });
          }
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
          result.observedStateDigest === intent.expectedStateDigest &&
          result.releaseObserved === true &&
          result.exactTrackStateVerified === true &&
          result.liveReleaseVerified === true &&
          result.servingPropagationVerified === false &&
          result.temporaryEditCleanupSucceeded === true &&
          result.verificationCleanupVerified === true &&
          result.verificationRequestDigest === createReleaseStateVerificationRequestDigest(intent)
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
        observedStateDigest: result.observedStateDigest,
        verificationCleanupVerified: result.verificationCleanupVerified,
      });
    },
  };
  return Object.freeze({ tool, binding });
}

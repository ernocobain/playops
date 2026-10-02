/**
 * Phase 4.15 — `releases.cleanup_known_edit`.
 *
 * Abandons ONE exact, composition-bound, already-known edit record. There is no
 * bulk cleanup, no "clean all", no wildcard, and no model-selected edit id.
 *
 * WHAT THIS BUILD ACTUALLY DOES:
 *   1. It validates the exact bound local lifecycle record (managed session or
 *      cleanup-journal entry) and refuses when that record is missing or changed.
 *   2. LOCAL-EXPIRY PATH — if trusted local expiry evidence already proves the
 *      edit inactive (`now >= expiryTimeSeconds`), it performs NO Google call,
 *      issues NO remote delete, and reconciles ONLY its own exact local record,
 *      then reads that state back to confirm removal.
 *   3. ACTIVE PATH — otherwise it performs one read-only exact-identity `edits.get`
 *      confirmation, then ONE `edits.delete` attempt with retries disabled, then one
 *      more read-only exact-identity `edits.get`. The edit is treated as verified
 *      inactive ONLY when the narrow contextual classifier
 *      (`classifyPostDeleteEditRead`) returns REMOTE_INACTIVE for that complete
 *      confirmed-delete context. Only then is the exact local record reconciled.
 *   4. Any other outcome — inactive not proven, delete not acknowledged, or the
 *      post-delete read unexpectedly succeeding — retains the record, issues NO
 *      second delete, and reports external state as uncertain.
 *
 * WHY THE CLASSIFIER IS CONTEXTUAL: one controlled live observation on
 * `com.dhikrama.driver` (2026-10-02) showed a deleted edit failing `edits.get` with
 * HTTP 400 / `FAILED_PRECONDITION` / `failedPrecondition`. That is evidence, not a
 * Google contract — 400/FAILED_PRECONDITION is generic — so a bare tuple NEVER
 * proves inactivity here. Standalone hygiene inspection therefore still reports
 * such a failure as UNKNOWN (see `hygiene-tool.ts`).
 *
 * Permission is `destructive` with an exact human approval, because deleting an
 * active Google Play edit permanently discards uncommitted edit state.
 */
import { createHash } from "node:crypto";
import type { AgentToolBinding } from "../runtime/agent/index.js";
import type { ToolDefinition, ToolSchema } from "../runtime/tools/index.js";
import type { VerificationResult } from "../runtime/verification/index.js";
import { EDIT_DELETE_POLICY } from "../googleplay/publisher/index.js";
import {
  compareEpochSeconds,
  epochSecondsFromDate,
  parseGooglePlayEditSession,
  parseReleaseEditSession,
  ReleaseError,
  validateReleasePackageName,
} from "./index.js";
import type { ReleaseEditCleanupGateway } from "./gateway.js";
import {
  classifyReleaseEditCleanupRecordLocally,
  type ReleaseEditCleanupJournal,
} from "./cleanup-journal.js";
import {
  classifyPostDeleteEditRead,
  type AcknowledgedEditDeleteEvidence,
  type PostDeleteEditReadEvidence,
  type PreDeleteEditReadEvidence,
} from "./post-delete-verification.js";
import type { ReleaseEditSessionStore } from "./session-store.js";

export const RELEASES_CLEANUP_KNOWN_EDIT_TOOL_NAME = "releases.cleanup_known_edit";

export const RELEASE_EDIT_CLEANUP_RECORD_SOURCES = Object.freeze([
  "managed_session",
  "cleanup_journal",
] as const);
export type ReleaseEditCleanupRecordSource = (typeof RELEASE_EDIT_CLEANUP_RECORD_SOURCES)[number];

/** How the exact known record was abandoned. Closed enum; never free-form. */
export const RELEASE_EDIT_CLEANUP_OUTCOMES = Object.freeze([
  "LOCAL_EXPIRY_RECONCILED",
  "REMOTE_DELETE_VERIFIED",
] as const);
export type ReleaseEditCleanupOutcome = (typeof RELEASE_EDIT_CLEANUP_OUTCOMES)[number];

/** Exact known record selected by trusted composition; never model-supplied. */
export interface ReleaseEditCleanupCandidate {
  readonly recordSource: ReleaseEditCleanupRecordSource;
  readonly editId: string;
  readonly expiryTimeSeconds: string;
}

export interface ReleaseEditCleanupResult {
  readonly recordSource: ReleaseEditCleanupRecordSource;
  readonly outcome: ReleaseEditCleanupOutcome;
  readonly localRecordReconciled: true;
  /** Only the verified active path issues a remote delete. */
  readonly remoteDeleteAttempted: boolean;
  /** The verified remote-delete capability exists in this build. */
  readonly remoteDeleteSupported: true;
  /** True only when the narrow contextual classifier verified post-delete inactivity. */
  readonly remoteInactivityProven: boolean;
}

export interface ReleaseEditCleanupToolOptions {
  readonly packageName: string;
  readonly candidate: ReleaseEditCleanupCandidate;
  readonly gateway: ReleaseEditCleanupGateway;
  readonly sessionStore: ReleaseEditSessionStore;
  readonly cleanupJournal: ReleaseEditCleanupJournal;
  /** Injectable clock; expiry decisions must not depend on wall-clock internals. */
  readonly now?: () => Date;
}

export interface ReleaseEditCleanupTool {
  readonly tool: ToolDefinition<Record<string, never>, ReleaseEditCleanupResult>;
  readonly binding: AgentToolBinding;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidArgument(message = "Edit cleanup input is invalid."): ReleaseError {
  return new ReleaseError("INVALID_ARGUMENT", message);
}

const inputSchema: ToolSchema<Record<string, never>> = {
  parse(value: unknown): Record<string, never> {
    if (!isRecordValue(value) || Object.keys(value).length !== 0) throw invalidArgument();
    return Object.freeze({});
  },
};

function isCandidate(value: unknown): value is ReleaseEditCleanupCandidate {
  if (!isRecordValue(value)) return false;
  const allowed = new Set(["recordSource", "editId", "expiryTimeSeconds"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (value.recordSource !== "managed_session" && value.recordSource !== "cleanup_journal") {
    return false;
  }
  if (typeof value.editId !== "string" || value.editId.trim() === "") return false;
  return typeof value.expiryTimeSeconds === "string" && /^\d+$/u.test(value.expiryTimeSeconds);
}

function invalidResult(): ReleaseError {
  return new ReleaseError("EDIT_CLEANUP_RECONCILE_FAILED", "Edit cleanup result is invalid.");
}

function createOutputSchema(): ToolSchema<ReleaseEditCleanupResult> {
  return {
    parse(value: unknown): ReleaseEditCleanupResult {
      if (!isRecordValue(value)) throw invalidResult();
      const allowed = new Set([
        "recordSource",
        "outcome",
        "localRecordReconciled",
        "remoteDeleteAttempted",
        "remoteDeleteSupported",
        "remoteInactivityProven",
      ]);
      if (Object.keys(value).some((key) => !allowed.has(key))) throw invalidResult();
      const recordSource = value.recordSource;
      const outcome = value.outcome;
      if (
        (recordSource !== "managed_session" && recordSource !== "cleanup_journal") ||
        (outcome !== "LOCAL_EXPIRY_RECONCILED" && outcome !== "REMOTE_DELETE_VERIFIED") ||
        value.localRecordReconciled !== true ||
        value.remoteDeleteSupported !== true ||
        typeof value.remoteDeleteAttempted !== "boolean" ||
        typeof value.remoteInactivityProven !== "boolean"
      ) {
        throw invalidResult();
      }
      // A locally expired record is reconciled with no delete and no inactivity
      // proof; a verified remote delete requires both. No hybrid shape exists.
      if (outcome === "LOCAL_EXPIRY_RECONCILED") {
        if (value.remoteDeleteAttempted !== false || value.remoteInactivityProven !== false) {
          throw invalidResult();
        }
      } else if (value.remoteDeleteAttempted !== true || value.remoteInactivityProven !== true) {
        throw invalidResult();
      }
      return Object.freeze({
        recordSource,
        outcome,
        localRecordReconciled: true,
        remoteDeleteAttempted: value.remoteDeleteAttempted,
        remoteDeleteSupported: true,
        remoteInactivityProven: value.remoteInactivityProven,
      });
    },
  };
}

function sameExpiry(left: string, right: string): boolean {
  try {
    return compareEpochSeconds(left, right) === 0;
  } catch {
    return false;
  }
}

/**
 * Allowlisted failure fields for the post-delete read. Only PlayOps-typed
 * ReleaseError fields are read; no Google SDK/Gaxios object, raw message,
 * header, config, URL, or response body is ever touched.
 */
function postDeleteFailureFields(cause: unknown): {
  code?: string;
  status?: number;
  googleStatus?: string;
  googleReasons?: readonly string[];
} {
  if (!(cause instanceof ReleaseError)) return {};
  return {
    ...(cause.publisherCode !== undefined ? { code: cause.publisherCode } : {}),
    ...(cause.status !== undefined ? { status: cause.status } : {}),
    ...(cause.googleStatus !== undefined ? { googleStatus: cause.googleStatus } : {}),
    ...(cause.googleReasons !== undefined ? { googleReasons: cause.googleReasons } : {}),
  };
}

/**
 * Deterministic SHA-256 request digest over the exact bound record identity. No
 * credential, token, or raw Google value is included.
 */
export function createReleaseEditCleanupDigest(
  packageName: string,
  candidate: ReleaseEditCleanupCandidate,
): string {
  const canonical = JSON.stringify({
    version: 1,
    toolName: RELEASES_CLEANUP_KNOWN_EDIT_TOOL_NAME,
    packageName: validateReleasePackageName(packageName),
    recordSource: candidate.recordSource,
    editId: candidate.editId,
    expiryTimeSeconds: candidate.expiryTimeSeconds,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Exact human-facing summary for the approval prompt. Never contains secrets. */
export function createReleaseEditCleanupSummary(
  packageName: string,
  candidate: ReleaseEditCleanupCandidate,
): string {
  const source =
    candidate.recordSource === "managed_session"
      ? "the managed Google Play edit session record"
      : "a journalled temporary verification edit record";
  return [
    `Abandon ONE known Google Play edit record for ${validateReleasePackageName(packageName)} (${source}).`,
    "",
    "Local-expiry path: when trusted local expiry evidence already proves that edit inactive, PlayOps removes ONLY its own local lifecycle record. It does NOT call Google and does NOT delete any remote edit.",
    "",
    "Active path: PlayOps performs one read-only check of that exact edit, then exactly ONE `edits.delete` attempt with retries disabled, then one read-only check of that same exact edit. Only when that acknowledged delete is followed by the exact structured post-delete signal for the same identity (HTTP 400 with Google status FAILED_PRECONDITION and reason failedPrecondition) does PlayOps treat the edit as verified inactive and remove its own local record.",
    "",
    "If the edit is not confirmed active, or if post-delete inactivity is not verified, PlayOps retains the record, reports it, and issues NO further delete. Deleting an active Google Play edit permanently discards uncommitted edit state, which is why this needs your explicit approval.",
    "",
    "Only this exact known record is covered: no bulk cleanup, no wildcard, and no model-selected edit id.",
  ].join("\n");
}

/** Runtime tool: exact-record abandonment with contextual post-delete verification. */
export function createReleaseEditCleanupTool(
  options: ReleaseEditCleanupToolOptions,
): ReleaseEditCleanupTool {
  const packageName = validateReleasePackageName(options?.packageName);
  const candidate = options?.candidate;
  const gateway = options?.gateway;
  const sessionStore = options?.sessionStore;
  const cleanupJournal = options?.cleanupJournal;
  const clock = options?.now ?? (() => new Date());
  if (!isCandidate(candidate)) {
    throw invalidArgument("Edit cleanup candidate is invalid.");
  }
  const boundCandidate: ReleaseEditCleanupCandidate = Object.freeze({
    recordSource: candidate.recordSource,
    editId: parseGooglePlayEditSession(
      {
        packageName,
        editId: candidate.editId,
        expiryTimeSeconds: candidate.expiryTimeSeconds,
      },
      packageName,
    ).editId,
    expiryTimeSeconds: candidate.expiryTimeSeconds,
  });
  if (
    !gateway ||
    typeof gateway.getEdit !== "function" ||
    typeof gateway.deleteEdit !== "function"
  ) {
    throw invalidArgument("Edit cleanup gateway is invalid.");
  }
  if (!sessionStore || typeof sessionStore.load !== "function") {
    throw invalidArgument("Edit cleanup session store is invalid.");
  }
  if (!cleanupJournal || typeof cleanupJournal.list !== "function") {
    throw invalidArgument("Edit cleanup journal is invalid.");
  }

  const description =
    "Abandon exactly one known Google Play edit record for this package (the managed edit session record or one journalled temporary verification edit record). DESTRUCTIVE and approval-gated. When trusted local expiry already proves the edit inactive it removes only its own exact local record and confirms that removal. Otherwise it reads that exact edit, issues exactly ONE `edits.delete` with retries disabled, reads that same exact edit again, and treats it as verified inactive ONLY for the narrow contextual post-delete signal — same package, same exact edit identity, successful pre-delete read, acknowledged single retry-disabled delete, and a post-delete read failing with HTTP 400 plus Google status FAILED_PRECONDITION and reason failedPrecondition. Any other outcome retains the record and issues no further delete. It never creates, updates, validates, commits, uploads, or changes a track, never lists remote edits, and accepts no model-selected or wildcard candidate.";
  const outputSchema = createOutputSchema();

  /** Confirms the bound local record still exists exactly as approved. */
  const loadBoundRecord = async (): Promise<{ readonly expiryTimeSeconds: string }> => {
    if (boundCandidate.recordSource === "managed_session") {
      let session;
      try {
        session = await sessionStore.load();
      } catch (cause) {
        throw new ReleaseError(
          "EDIT_CLEANUP_RECORD_NOT_FOUND",
          "The bound managed edit record could not be read.",
          { cause },
        );
      }
      if (session === undefined) {
        throw new ReleaseError(
          "EDIT_CLEANUP_RECORD_NOT_FOUND",
          "The bound managed edit record no longer exists.",
        );
      }
      const parsed = parseReleaseEditSession(session, packageName);
      if (parsed.editId !== boundCandidate.editId) {
        throw new ReleaseError(
          "EDIT_CLEANUP_RECORD_CHANGED",
          "The bound managed edit record no longer matches the approved record.",
        );
      }
      return { expiryTimeSeconds: parsed.expiryTimeSeconds };
    }
    const entries = await cleanupJournal.list();
    const match = entries.find((entry) => entry.editId === boundCandidate.editId);
    if (!match) {
      throw new ReleaseError(
        "EDIT_CLEANUP_RECORD_NOT_FOUND",
        "The bound journalled edit record no longer exists.",
      );
    }
    return { expiryTimeSeconds: match.expiryTimeSeconds };
  };

  const reconcileLocalRecord = async (): Promise<void> => {
    try {
      if (boundCandidate.recordSource === "managed_session") {
        await sessionStore.clear();
        const remaining = await sessionStore.load();
        if (remaining !== undefined) {
          throw new ReleaseError(
            "EDIT_CLEANUP_RECONCILE_FAILED",
            "The bound managed edit record could not be removed locally.",
          );
        }
        return;
      }
      await cleanupJournal.remove(boundCandidate.editId);
      const entries = await cleanupJournal.list();
      if (entries.some((entry) => entry.editId === boundCandidate.editId)) {
        throw new ReleaseError(
          "EDIT_CLEANUP_RECONCILE_FAILED",
          "The bound journalled edit record could not be removed locally.",
        );
      }
    } catch (cause) {
      if (cause instanceof ReleaseError && cause.code === "EDIT_CLEANUP_RECONCILE_FAILED") {
        throw cause;
      }
      throw new ReleaseError(
        "EDIT_CLEANUP_RECONCILE_FAILED",
        "The bound local edit record could not be reconciled.",
        { cause },
      );
    }
  };

  const tool: ToolDefinition<Record<string, never>, ReleaseEditCleanupResult> = {
    name: RELEASES_CLEANUP_KNOWN_EDIT_TOOL_NAME,
    description,
    permission: "destructive",
    inputSchema,
    outputSchema,
    async execute() {
      // Step 1 — the exact approved local record must still be present and equal.
      const record = await loadBoundRecord();
      if (record.expiryTimeSeconds !== boundCandidate.expiryTimeSeconds) {
        throw new ReleaseError(
          "EDIT_CLEANUP_RECORD_CHANGED",
          "The bound edit record no longer matches the approved record.",
        );
      }

      // Step 2 — trusted local expiry is sufficient proof on its own.
      const nowSeconds = epochSecondsFromDate(clock);
      if (classifyReleaseEditCleanupRecordLocally(record, nowSeconds) === "expired") {
        await reconcileLocalRecord();
        return Object.freeze({
          recordSource: boundCandidate.recordSource,
          outcome: "LOCAL_EXPIRY_RECONCILED" as const,
          localRecordReconciled: true as const,
          remoteDeleteAttempted: false as const,
          remoteDeleteSupported: true as const,
          remoteInactivityProven: false as const,
        });
      }

      const session = parseGooglePlayEditSession(
        {
          packageName,
          editId: boundCandidate.editId,
          expiryTimeSeconds: boundCandidate.expiryTimeSeconds,
        },
        packageName,
      );

      // Step 3 — one fresh exact pre-delete read; the edit must still be the approved one.
      let remote: unknown;
      try {
        remote = await gateway.getEdit(session);
      } catch (cause) {
        throw new ReleaseError(
          "EDIT_CLEANUP_STATE_UNKNOWN",
          "The bound edit's remote state could not be established safely; the record is retained and no delete was attempted.",
          { cause, externalStateUncertain: false },
        );
      }
      if (
        !isRecordValue(remote) ||
        remote.id !== boundCandidate.editId ||
        typeof remote.expiryTimeSeconds !== "string" ||
        !sameExpiry(remote.expiryTimeSeconds, boundCandidate.expiryTimeSeconds)
      ) {
        throw new ReleaseError(
          "EDIT_CLEANUP_RECORD_CHANGED",
          "The bound edit no longer matches the approved record; the record is retained.",
          { externalStateUncertain: false },
        );
      }
      const preDeleteRead: PreDeleteEditReadEvidence = Object.freeze({
        packageName,
        editId: boundCandidate.editId,
        succeeded: true,
      });

      // Step 4 — EXACTLY ONE delete attempt: a single linear call (no loop, no
      // PlayOps read retry) over a wrapper whose generated-client retry is disabled.
      let deleteAttempts = 0;
      try {
        deleteAttempts += 1;
        await gateway.deleteEdit(session);
      } catch (cause) {
        throw new ReleaseError(
          "EDIT_CLEANUP_REMOTE_DELETE_FAILED",
          "The remote edit delete was not acknowledged; the record is retained and no second delete is attempted.",
          { cause, externalStateUncertain: true },
        );
      }
      const deleteEvidence: AcknowledgedEditDeleteEvidence = Object.freeze({
        packageName,
        editId: boundCandidate.editId,
        acknowledged: true,
        attempts: deleteAttempts,
        retryDisabled: EDIT_DELETE_POLICY.retry === false,
      });

      // Step 5 — the post-delete read for the SAME exact identity. A failure here
      // is the only source of an inactivity signal; the raw error never escapes.
      let postDeleteRead: PostDeleteEditReadEvidence;
      try {
        await gateway.getEdit(session);
        postDeleteRead = Object.freeze({
          packageName,
          editId: boundCandidate.editId,
          failed: false,
        });
      } catch (cause) {
        postDeleteRead = Object.freeze({
          packageName,
          editId: boundCandidate.editId,
          failed: true,
          ...postDeleteFailureFields(cause),
        });
      }

      // Step 6 — the NARROW contextual verdict. Never a global rule, and never
      // derived from a human-readable message.
      const verdict = classifyPostDeleteEditRead({
        preDeleteRead,
        delete: deleteEvidence,
        postDeleteRead,
      });
      if (verdict.verdict !== "REMOTE_INACTIVE") {
        throw new ReleaseError(
          "EDIT_CLEANUP_REMOTE_INACTIVE_UNVERIFIED",
          `The remote edit delete was acknowledged, but post-delete inactivity was not verified (${verdict.reason}); the record is retained and no second delete is attempted.`,
          { externalStateUncertain: true },
        );
      }

      // Step 7 — only now reconcile exactly this local record, then read it back.
      await reconcileLocalRecord();
      return Object.freeze({
        recordSource: boundCandidate.recordSource,
        outcome: "REMOTE_DELETE_VERIFIED" as const,
        localRecordReconciled: true as const,
        remoteDeleteAttempted: true as const,
        remoteDeleteSupported: true as const,
        remoteInactivityProven: true as const,
      });
    },
    async verify(_input, output) {
      let result: ReleaseEditCleanupResult;
      try {
        result = outputSchema.parse(output);
      } catch {
        return false;
      }
      if (result.recordSource !== boundCandidate.recordSource) return false;
      try {
        if (boundCandidate.recordSource === "managed_session") {
          const remaining = await sessionStore.load();
          return remaining === undefined;
        }
        const entries = await cleanupJournal.list();
        return !entries.some((entry) => entry.editId === boundCandidate.editId);
      } catch {
        return false;
      }
    },
  };

  const approvalBinding: AgentToolBinding = {
    toolName: RELEASES_CLEANUP_KNOWN_EDIT_TOOL_NAME,
    llm: {
      name: RELEASES_CLEANUP_KNOWN_EDIT_TOOL_NAME,
      description,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    approval: {
      createRequestDigest: () => createReleaseEditCleanupDigest(packageName, boundCandidate),
      createSafeSummary: () => createReleaseEditCleanupSummary(packageName, boundCandidate),
    },
    serializeResult(output: unknown, verification: VerificationResult): string {
      const result = outputSchema.parse(output);
      if (
        !verification ||
        verification.permission !== "destructive" ||
        verification.required !== true ||
        verification.verified !== true
      ) {
        throw new ReleaseError("EDIT_CLEANUP_RECONCILE_FAILED", "Edit cleanup was not verified.");
      }
      // No raw edit id, credential, token, or upstream error text reaches the model.
      return JSON.stringify({
        tool: RELEASES_CLEANUP_KNOWN_EDIT_TOOL_NAME,
        packageName,
        recordSource: result.recordSource,
        outcome: result.outcome,
        localRecordReconciled: true,
        remoteDeleteAttempted: result.remoteDeleteAttempted,
        remoteDeleteSupported: true,
        remoteInactivityProven: result.remoteInactivityProven,
      });
    },
  };

  return Object.freeze({ tool, binding: approvalBinding });
}

/**
 * Phase 4.15 — `releases.inspect_edit_hygiene`: read-only hygiene report over the
 * edit lifecycle records PlayOps actually possesses.
 *
 * SCOPE (locked D1–D6, see docs/phase-4.15-plan.md):
 *   - Reports every KNOWN record: the managed Play edit session and every durable
 *     cleanup-journal entry (temporary verification edits).
 *   - Classifies each record as `expired` | `active` | `unknown`.
 *   - REPORT ONLY: it never deletes, clears, reconciles, creates, commits, or
 *     mutates anything, locally or remotely.
 *
 * CLASSIFICATION HONESTY: `active` is only reported when a read-only `edits.get`
 * actually succeeded for that exact id (evidence-backed). A failed read is NOT
 * evidence of inactivity — Google documents that `get` fails for deleted,
 * superseded, or expired edits but does not document a structured signal that
 * distinguishes those from transport/auth/5xx failures — so any failure is
 * reported as `unknown`.
 *
 * Google exposes no "list my active edits" operation, so an edit whose identity
 * PlayOps never persisted is OUTSIDE PlayOps' discoverable universe. This tool
 * never scans remote edits.
 *
 * Permission is `read` and no verifier is declared (no fake verifier is invented);
 * Phase 2.4 verification is legitimately SKIPPED.
 */
import type { AgentToolBinding } from "../runtime/agent/index.js";
import type { ToolDefinition, ToolSchema } from "../runtime/tools/index.js";
import type { VerificationResult } from "../runtime/verification/index.js";
import {
  compareEpochSeconds,
  epochSecondsFromDate,
  parseReleaseEditSession,
  ReleaseError,
  validateReleasePackageName,
  type ReleaseEditSession,
} from "./index.js";
import type { ReleaseEditHygieneGateway } from "./gateway.js";
import {
  classifyReleaseEditCleanupRecordLocally,
  type ReleaseEditCleanupJournal,
  type ReleaseEditCleanupJournalSource,
} from "./cleanup-journal.js";
import { loadReleaseEditSessionState, type ReleaseEditSessionStore } from "./session-store.js";

export const RELEASES_INSPECT_EDIT_HYGIENE_TOOL_NAME = "releases.inspect_edit_hygiene";

export const RELEASE_EDIT_HYGIENE_STATES = Object.freeze(["expired", "active", "unknown"] as const);
export type ReleaseEditHygieneState = (typeof RELEASE_EDIT_HYGIENE_STATES)[number];

export const RELEASE_EDIT_HYGIENE_RECORD_KINDS = Object.freeze([
  "managed_session",
  "verification_edit",
] as const);
export type ReleaseEditHygieneRecordKind = (typeof RELEASE_EDIT_HYGIENE_RECORD_KINDS)[number];

/** Closed reason enum; never free-form upstream error text. */
export const RELEASE_EDIT_HYGIENE_REASONS = Object.freeze([
  "local_expiry_elapsed",
  "remote_edit_confirmed_active",
  "remote_record_mismatch",
  "remote_state_undecidable",
  "session_record_unreadable",
  "session_record_invalid",
  "journal_unreadable",
  "journal_package_mismatch",
  "journal_entry_invalid",
] as const);
export type ReleaseEditHygieneReason = (typeof RELEASE_EDIT_HYGIENE_REASONS)[number];

export interface ReleaseEditHygieneRecord {
  readonly kind: ReleaseEditHygieneRecordKind;
  /** Journal purpose; present only for a journalled verification edit. */
  readonly purpose?: ReleaseEditCleanupJournalSource;
  readonly state: ReleaseEditHygieneState;
  readonly reason: ReleaseEditHygieneReason;
  readonly expiryTimeSeconds?: string;
}

export interface ReleaseEditHygieneResult {
  readonly packageName: string;
  readonly records: readonly ReleaseEditHygieneRecord[];
  readonly counts: Readonly<{ expired: number; active: number; unknown: number }>;
  /** Honest capability statement: Google exposes no active-edit listing. */
  readonly remoteEditEnumerationSupported: false;
  readonly remoteDeleteSupported: false;
  readonly deletionsPerformed: 0;
  readonly localRecordsChanged: 0;
}

export interface ReleaseEditHygieneToolOptions {
  readonly packageName: string;
  readonly gateway: ReleaseEditHygieneGateway;
  readonly store: ReleaseEditSessionStore;
  readonly cleanupJournal: ReleaseEditCleanupJournal;
  /** Injectable clock; expiry decisions must not depend on wall-clock internals. */
  readonly now?: () => Date;
}

export interface ReleaseEditHygieneTool {
  readonly tool: ToolDefinition<Record<string, never>, ReleaseEditHygieneResult>;
  readonly binding: AgentToolBinding;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidArgument(): ReleaseError {
  return new ReleaseError("INVALID_ARGUMENT", "Edit hygiene inspection input is invalid.");
}

const inputSchema: ToolSchema<Record<string, never>> = {
  parse(value: unknown): Record<string, never> {
    if (!isRecordValue(value) || Object.keys(value).length !== 0) throw invalidArgument();
    return Object.freeze({});
  },
};

function invalidResult(): ReleaseError {
  return new ReleaseError("EDIT_HYGIENE_STATE_INVALID", "Edit hygiene result is invalid.");
}

function isHygieneState(value: unknown): value is ReleaseEditHygieneState {
  return RELEASE_EDIT_HYGIENE_STATES.some((state) => state === value);
}

function isHygieneReason(value: unknown): value is ReleaseEditHygieneReason {
  return RELEASE_EDIT_HYGIENE_REASONS.some((reason) => reason === value);
}

function isJournalSourceValue(value: unknown): value is ReleaseEditCleanupJournalSource {
  return (
    value === "exact_release_verification" ||
    value === "rollout_verification" ||
    value === "status_control_verification"
  );
}

function createOutputSchema(packageName: string): ToolSchema<ReleaseEditHygieneResult> {
  return {
    parse(value: unknown): ReleaseEditHygieneResult {
      if (!isRecordValue(value)) throw invalidResult();
      const allowed = new Set([
        "packageName",
        "records",
        "counts",
        "remoteEditEnumerationSupported",
        "remoteDeleteSupported",
        "deletionsPerformed",
        "localRecordsChanged",
      ]);
      if (Object.keys(value).some((key) => !allowed.has(key))) throw invalidResult();
      if (value.packageName !== packageName) throw invalidResult();
      if (!Array.isArray(value.records)) throw invalidResult();
      const records = value.records.map((entry: unknown) => {
        if (!isRecordValue(entry)) throw invalidResult();
        const entryKeys = new Set(["kind", "purpose", "state", "reason", "expiryTimeSeconds"]);
        if (Object.keys(entry).some((key) => !entryKeys.has(key))) throw invalidResult();
        if (entry.kind !== "managed_session" && entry.kind !== "verification_edit") {
          throw invalidResult();
        }
        if (!isHygieneState(entry.state) || !isHygieneReason(entry.reason)) throw invalidResult();
        if (entry.purpose !== undefined && !isJournalSourceValue(entry.purpose))
          throw invalidResult();
        if (entry.expiryTimeSeconds !== undefined) {
          if (
            typeof entry.expiryTimeSeconds !== "string" ||
            !/^\d+$/u.test(entry.expiryTimeSeconds)
          ) {
            throw invalidResult();
          }
        }
        return Object.freeze({
          kind: entry.kind as ReleaseEditHygieneRecordKind,
          ...(entry.purpose !== undefined ? { purpose: entry.purpose } : {}),
          state: entry.state,
          reason: entry.reason,
          ...(entry.expiryTimeSeconds !== undefined
            ? { expiryTimeSeconds: entry.expiryTimeSeconds as string }
            : {}),
        });
      });
      if (
        !isRecordValue(value.counts) ||
        typeof value.counts.expired !== "number" ||
        typeof value.counts.active !== "number" ||
        typeof value.counts.unknown !== "number" ||
        value.remoteEditEnumerationSupported !== false ||
        value.remoteDeleteSupported !== false ||
        value.deletionsPerformed !== 0 ||
        value.localRecordsChanged !== 0
      ) {
        throw invalidResult();
      }
      const [first] = records;
      void first;
      return Object.freeze({
        packageName,
        records: Object.freeze(records),
        counts: Object.freeze({
          expired: records.filter((record) => record.state === "expired").length,
          active: records.filter((record) => record.state === "active").length,
          unknown: records.filter((record) => record.state === "unknown").length,
        }),
        remoteEditEnumerationSupported: false,
        remoteDeleteSupported: false,
        deletionsPerformed: 0,
        localRecordsChanged: 0,
      });
    },
  };
}

/**
 * Read-only classification of one exact edit: a successful `edits.get` proves the
 * edit is active; every other outcome is undecidable and stays `unknown`.
 */
async function classifyRemote(
  gateway: ReleaseEditHygieneGateway,
  expected: {
    readonly packageName: string;
    readonly editId: string;
    readonly expiryTimeSeconds: string;
  },
): Promise<{ readonly state: ReleaseEditHygieneState; readonly reason: ReleaseEditHygieneReason }> {
  let remote: unknown;
  try {
    remote = await gateway.getEdit({
      packageName: expected.packageName,
      editId: expected.editId,
      expiryTimeSeconds: expected.expiryTimeSeconds,
    });
  } catch {
    // A failed read is not evidence of inactivity (D4). No raw error text is kept.
    return { state: "unknown", reason: "remote_state_undecidable" };
  }
  if (!isRecordValue(remote) || remote.id !== expected.editId) {
    return { state: "unknown", reason: "remote_record_mismatch" };
  }
  if (typeof remote.expiryTimeSeconds !== "string") {
    return { state: "unknown", reason: "remote_state_undecidable" };
  }
  try {
    if (compareEpochSeconds(remote.expiryTimeSeconds, expected.expiryTimeSeconds) !== 0) {
      return { state: "unknown", reason: "remote_record_mismatch" };
    }
  } catch {
    return { state: "unknown", reason: "remote_state_undecidable" };
  }
  return { state: "active", reason: "remote_edit_confirmed_active" };
}

function sortRecords(records: readonly ReleaseEditHygieneRecord[]): ReleaseEditHygieneRecord[] {
  return [...records].sort((left, right) => {
    const leftExpiry = left.expiryTimeSeconds;
    const rightExpiry = right.expiryTimeSeconds;
    if (leftExpiry !== undefined && rightExpiry !== undefined) {
      const comparison = compareEpochSeconds(leftExpiry, rightExpiry);
      if (comparison !== 0) return comparison;
    } else if (leftExpiry !== undefined) {
      return -1;
    } else if (rightExpiry !== undefined) {
      return 1;
    }
    return left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0;
  });
}

async function classifyManagedSession(
  options: {
    readonly gateway: ReleaseEditHygieneGateway;
    readonly store: ReleaseEditSessionStore;
    readonly packageName: string;
  },
  nowSeconds: string,
): Promise<readonly ReleaseEditHygieneRecord[]> {
  let state: Awaited<ReturnType<typeof loadReleaseEditSessionState>>;
  try {
    state = await loadReleaseEditSessionState(options.store, nowSeconds);
  } catch (cause) {
    const reason: ReleaseEditHygieneReason =
      cause instanceof ReleaseError && cause.code === "EDIT_SESSION_STORE_INVALID"
        ? "session_record_invalid"
        : "session_record_unreadable";
    return Object.freeze([
      Object.freeze({ kind: "managed_session" as const, state: "unknown" as const, reason }),
    ]);
  }
  if (state.status === "none") return Object.freeze([]);
  const session: ReleaseEditSession = state.session;
  try {
    parseReleaseEditSession(session, options.packageName);
  } catch {
    return Object.freeze([
      Object.freeze({
        kind: "managed_session" as const,
        state: "unknown" as const,
        reason: "session_record_invalid" as const,
      }),
    ]);
  }
  if (state.status === "expired") {
    return Object.freeze([
      Object.freeze({
        kind: "managed_session" as const,
        state: "expired" as const,
        reason: "local_expiry_elapsed" as const,
        expiryTimeSeconds: session.expiryTimeSeconds,
      }),
    ]);
  }
  const remote = await classifyRemote(options.gateway, session);
  return Object.freeze([
    Object.freeze({
      kind: "managed_session" as const,
      state: remote.state,
      reason: remote.reason,
      expiryTimeSeconds: session.expiryTimeSeconds,
    }),
  ]);
}

async function classifyJournal(
  options: {
    readonly gateway: ReleaseEditHygieneGateway;
    readonly cleanupJournal: ReleaseEditCleanupJournal;
    readonly packageName: string;
  },
  nowSeconds: string,
): Promise<readonly ReleaseEditHygieneRecord[]> {
  let entries;
  try {
    entries = await options.cleanupJournal.list();
  } catch (cause) {
    const reason: ReleaseEditHygieneReason =
      cause instanceof ReleaseError && cause.code === "EDIT_CLEANUP_JOURNAL_PACKAGE_MISMATCH"
        ? "journal_package_mismatch"
        : cause instanceof ReleaseError && cause.code === "EDIT_CLEANUP_JOURNAL_INVALID"
          ? "journal_entry_invalid"
          : "journal_unreadable";
    return Object.freeze([
      Object.freeze({ kind: "verification_edit" as const, state: "unknown" as const, reason }),
    ]);
  }
  const records: ReleaseEditHygieneRecord[] = [];
  for (const entry of entries) {
    if (classifyReleaseEditCleanupRecordLocally(entry, nowSeconds) === "expired") {
      records.push(
        Object.freeze({
          kind: "verification_edit" as const,
          purpose: entry.source,
          state: "expired" as const,
          reason: "local_expiry_elapsed" as const,
          expiryTimeSeconds: entry.expiryTimeSeconds,
        }),
      );
      continue;
    }
    const remote = await classifyRemote(options.gateway, entry);
    records.push(
      Object.freeze({
        kind: "verification_edit" as const,
        purpose: entry.source,
        state: remote.state,
        reason: remote.reason,
        expiryTimeSeconds: entry.expiryTimeSeconds,
      }),
    );
  }
  return Object.freeze(records);
}

/** Runtime tool: read-only hygiene report over every known edit record. */
export function createReleaseEditHygieneTool(
  options: ReleaseEditHygieneToolOptions,
): ReleaseEditHygieneTool {
  const packageName = validateReleasePackageName(options?.packageName);
  const gateway = options?.gateway;
  const store = options?.store;
  const cleanupJournal = options?.cleanupJournal;
  const clock = options?.now ?? (() => new Date());
  if (!gateway || typeof gateway.getEdit !== "function") {
    throw new ReleaseError("INVALID_ARGUMENT", "Edit hygiene gateway is invalid.");
  }
  if (!store || typeof store.load !== "function") {
    throw new ReleaseError("INVALID_ARGUMENT", "Edit hygiene session store is invalid.");
  }
  if (!cleanupJournal || typeof cleanupJournal.list !== "function") {
    throw new ReleaseError("INVALID_ARGUMENT", "Edit hygiene cleanup journal is invalid.");
  }

  const description =
    "Report the lifecycle state of every Google Play edit record PlayOps knows about for this package: the managed edit session and every durable cleanup-journal entry created for temporary verification edits. Read-only and REPORT ONLY: it never creates, updates, commits, deletes, clears, or reconciles anything, and Google exposes no active-edit listing so it never scans remote edits. A record is 'active' only when a read of that exact edit succeeded; any failed or mismatched read is reported as 'unknown' rather than assumed inactive. An edit whose identity PlayOps never persisted cannot be discovered at all.";
  const outputSchema = createOutputSchema(packageName);

  const tool: ToolDefinition<Record<string, never>, ReleaseEditHygieneResult> = {
    name: RELEASES_INSPECT_EDIT_HYGIENE_TOOL_NAME,
    description,
    permission: "read",
    inputSchema,
    outputSchema,
    async execute() {
      const nowSeconds = epochSecondsFromDate(clock);
      const managed = await classifyManagedSession({ gateway, store, packageName }, nowSeconds);
      const journalled = await classifyJournal(
        { gateway, cleanupJournal, packageName },
        nowSeconds,
      );
      const records = sortRecords([...managed, ...journalled]);
      return Object.freeze({
        packageName,
        records: Object.freeze(records),
        counts: Object.freeze({
          expired: records.filter((record) => record.state === "expired").length,
          active: records.filter((record) => record.state === "active").length,
          unknown: records.filter((record) => record.state === "unknown").length,
        }),
        remoteEditEnumerationSupported: false as const,
        remoteDeleteSupported: false as const,
        deletionsPerformed: 0 as const,
        localRecordsChanged: 0 as const,
      });
    },
  };

  const binding: AgentToolBinding = {
    toolName: RELEASES_INSPECT_EDIT_HYGIENE_TOOL_NAME,
    llm: {
      name: RELEASES_INSPECT_EDIT_HYGIENE_TOOL_NAME,
      description,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    serializeResult(output: unknown, verification: VerificationResult): string {
      const result = outputSchema.parse(output);
      if (!verification || verification.permission !== "read") {
        throw new ReleaseError(
          "EDIT_HYGIENE_STATE_INVALID",
          "Edit hygiene result is not serializable.",
        );
      }
      // No raw edit id, credential, token, or upstream error text reaches the model.
      return JSON.stringify({
        tool: RELEASES_INSPECT_EDIT_HYGIENE_TOOL_NAME,
        packageName: result.packageName,
        records: result.records,
        counts: result.counts,
        remoteEditEnumerationSupported: false,
        remoteDeleteSupported: false,
        deletionsPerformed: 0,
        localRecordsChanged: 0,
      });
    },
  };
  return Object.freeze({ tool, binding });
}

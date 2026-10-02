/**
 * Phase 4.2 — `releases.inspect`: read-only inspection of a tracked Play edit session.
 *
 * Safety refactor from Phase 4.1: this tool used to create its own temporary
 * inspection edit. Google documents that creating a new edit invalidates any other
 * active edit for the same application and API user, so a read command must never
 * perform `edits.insert`. Inspection now requires a session that an operator opened
 * explicitly via `releases.open_edit`, and it never creates, validates, deletes, or
 * commits an edit.
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
  normalizeReleaseTracks,
  parseReleaseEditSession,
  ReleaseError,
  toGooglePlayEditSession,
  validateReleasePackageName,
  type ReleaseEditSession,
  type ReleaseTrackState,
} from "./index.js";
import type { ReleaseInspectionGateway } from "./gateway.js";
import { loadReleaseEditSessionState, type ReleaseEditSessionStore } from "./session-store.js";

export const RELEASES_INSPECT_TOOL_NAME = "releases.inspect";

export interface ReleaseInspectionResult {
  readonly session: ReleaseEditSession;
  readonly tracks: readonly ReleaseTrackState[];
}

export interface ReleaseInspectionToolOptions {
  readonly packageName: string;
  readonly gateway: ReleaseInspectionGateway;
  readonly store: ReleaseEditSessionStore;
  /** Injectable clock; expiry decisions must not depend on wall-clock internals. */
  readonly now?: () => Date;
}

export interface ReleaseInspectionTool {
  readonly tool: ToolDefinition<Record<string, never>, ReleaseInspectionResult>;
  readonly binding: AgentToolBinding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidArgument(): ReleaseError {
  return new ReleaseError("INVALID_ARGUMENT", "Release inspection input is invalid.");
}

const inputSchema: ToolSchema<Record<string, never>> = {
  parse(value: unknown): Record<string, never> {
    if (!isRecord(value) || Object.keys(value).length !== 0) throw invalidArgument();
    return Object.freeze({});
  },
};

function createOutputSchema(packageName: string): ToolSchema<ReleaseInspectionResult> {
  return {
    parse(value: unknown): ReleaseInspectionResult {
      if (!isRecord(value)) {
        throw new ReleaseError("REMOTE_DATA_INVALID", "Release inspection result is invalid.");
      }
      const keys = Object.keys(value).sort();
      if (keys.length !== 2 || keys[0] !== "session" || keys[1] !== "tracks") {
        throw new ReleaseError("REMOTE_DATA_INVALID", "Release inspection result is invalid.");
      }
      const session = parseReleaseEditSession(value.session, packageName);
      const tracks = normalizeReleaseTracks(value.tracks);
      return Object.freeze({ session, tracks });
    },
  };
}

function asOperationError(
  cause: unknown,
  code: "TRACK_LIST_FAILED",
  message: string,
): ReleaseError {
  if (cause instanceof ReleaseError) return cause;
  return new ReleaseError(code, message, { cause });
}

/** Runtime tool: read-only inspection of an already-tracked edit session. */
export function createReleaseInspectionTool(
  options: ReleaseInspectionToolOptions,
): ReleaseInspectionTool {
  const packageName = validateReleasePackageName(options?.packageName);
  const gateway = options?.gateway;
  const store = options?.store;
  const clock = options?.now ?? (() => new Date());
  if (
    !gateway ||
    typeof gateway.listTracks !== "function" ||
    typeof gateway.getEdit !== "function"
  ) {
    throw new ReleaseError("INVALID_ARGUMENT", "Release edit gateway is invalid.");
  }
  if (!store || typeof store.load !== "function") {
    throw new ReleaseError("INVALID_ARGUMENT", "Release edit session store is invalid.");
  }

  const description =
    "Inspect current Google Play tracks and releases for the already-tracked edit session. Read-only: it never creates, updates, validates, deletes, or commits an edit, and never changes a track or release. Requires an edit session previously opened with releases.open_edit; when none is tracked, or the tracked session has expired or can no longer be read back, it fails safely instead of opening a new edit.";
  const outputSchema = createOutputSchema(packageName);

  const tool: ToolDefinition<Record<string, never>, ReleaseInspectionResult> = {
    name: RELEASES_INSPECT_TOOL_NAME,
    description,
    permission: "read",
    inputSchema,
    outputSchema,
    async execute() {
      const state = await loadReleaseEditSessionState(store, epochSecondsFromDate(clock));
      if (state.status === "none") {
        throw new ReleaseError(
          "EDIT_SESSION_REQUIRED",
          "No tracked Play edit session exists for this package; run releases.open_edit first.",
        );
      }
      if (state.status === "expired") {
        throw new ReleaseError(
          "EDIT_SESSION_EXPIRED",
          "The tracked Play edit session has expired; run releases.open_edit to open a new edit explicitly.",
        );
      }
      const session = state.session;

      // Read-validate the tracked edit before listing. A session that can no longer
      // be confirmed is reported as invalid; nothing is replaced or cleared here.
      let remote;
      try {
        remote = await gateway.getEdit(toGooglePlayEditSession(session));
      } catch (cause) {
        throw new ReleaseError(
          "EDIT_SESSION_INVALID",
          "The tracked Play edit session could not be confirmed remotely; open a new edit explicitly if it was invalidated.",
          { cause },
        );
      }
      if (!isRecord(remote) || remote.id !== session.editId) {
        throw new ReleaseError(
          "EDIT_SESSION_INVALID",
          "The tracked Play edit session no longer matches the remote edit; open a new edit explicitly.",
        );
      }
      if (
        typeof remote.expiryTimeSeconds !== "string" ||
        compareEpochSeconds(remote.expiryTimeSeconds, session.expiryTimeSeconds) !== 0
      ) {
        throw new ReleaseError(
          "EDIT_SESSION_INVALID",
          "The tracked Play edit session no longer matches the remote edit; open a new edit explicitly.",
        );
      }

      let remoteTracks: readonly unknown[];
      try {
        remoteTracks = await gateway.listTracks(toGooglePlayEditSession(session));
      } catch (cause) {
        throw asOperationError(cause, "TRACK_LIST_FAILED", "Release tracks could not be read.");
      }
      const tracks = normalizeReleaseTracks(remoteTracks);
      return Object.freeze({ session, tracks });
    },
  };

  const binding: AgentToolBinding = {
    toolName: RELEASES_INSPECT_TOOL_NAME,
    llm: {
      name: RELEASES_INSPECT_TOOL_NAME,
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
        throw new ReleaseError("EDIT_INVALID", "Release inspection result is not serializable.");
      }
      // Project only domain state: the tracked edit id never reaches the model.
      return JSON.stringify({ tracks: result.tracks });
    },
  };
  return Object.freeze({ tool, binding });
}

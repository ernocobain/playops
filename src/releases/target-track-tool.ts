/**
 * Phase 4.5 — read-only inspection of one operator-bound target track.
 *
 * The tool reuses the managed Phase 4.2 edit session, confirms that edit with
 * `edits.get`, reads exactly one operator-selected track with `edits.tracks.get`,
 * and returns only a normalized target-track snapshot. It never creates an edit,
 * uploads, changes a track, validates, commits, or publishes.
 */
import type { AgentToolBinding } from "../runtime/agent/index.js";
import type { ToolDefinition, ToolSchema } from "../runtime/tools/index.js";
import type { VerificationResult } from "../runtime/verification/index.js";
import {
  compareEpochSeconds,
  epochSecondsFromDate,
  isReleaseEditSessionExpired,
  normalizeReleaseTracks,
  parseReleaseEditSession,
  ReleaseError,
  toGooglePlayEditSession,
  validateReleasePackageName,
  validateReleaseTargetTrack,
  type ReleaseEditSession,
  type ReleaseState,
} from "./index.js";
import type { ReleaseTargetTrackInspectionGateway } from "./gateway.js";
import { loadReleaseEditSessionState, type ReleaseEditSessionStore } from "./session-store.js";

export const RELEASES_INSPECT_TARGET_TRACK_TOOL_NAME = "releases.inspect_target_track";

export interface ReleaseTargetTrackInspectionResult {
  readonly targetTrack: string;
  readonly confirmed: true;
  readonly releases: readonly ReleaseState[];
}

export interface ReleaseTargetTrackInspectionToolOptions {
  readonly packageName: string;
  /** Exact operator/workflow-bound track identifier; never accepted from the model. */
  readonly targetTrack: string;
  readonly sessionStore: ReleaseEditSessionStore;
  readonly gateway: ReleaseTargetTrackInspectionGateway;
  readonly now?: () => Date;
}

export interface ReleaseTargetTrackInspectionTool {
  readonly tool: ToolDefinition<Record<string, never>, ReleaseTargetTrackInspectionResult>;
  readonly binding: AgentToolBinding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidInput(): ReleaseError {
  return new ReleaseError("INVALID_ARGUMENT", "Target-track inspection input is invalid.");
}

function invalidOutput(cause?: unknown): ReleaseError {
  return new ReleaseError("REMOTE_DATA_INVALID", "Target-track inspection result is invalid.", {
    ...(cause !== undefined ? { cause } : {}),
  });
}

const inputSchema: ToolSchema<Record<string, never>> = {
  parse(value: unknown): Record<string, never> {
    if (!isRecord(value) || Object.keys(value).length !== 0) throw invalidInput();
    return Object.freeze({});
  },
};

function createOutputSchema(targetTrack: string): ToolSchema<ReleaseTargetTrackInspectionResult> {
  return {
    parse(value: unknown): ReleaseTargetTrackInspectionResult {
      if (!isRecord(value)) throw invalidOutput();
      const keys = Object.keys(value).sort();
      const expected = ["confirmed", "releases", "targetTrack"];
      if (
        keys.length !== expected.length ||
        keys.some((key, index) => key !== expected[index]) ||
        value.targetTrack !== targetTrack ||
        value.confirmed !== true
      ) {
        throw invalidOutput();
      }
      try {
        const [normalized] = normalizeReleaseTracks([
          { track: targetTrack, releases: value.releases },
        ]);
        if (!normalized) throw invalidOutput();
        return Object.freeze({
          targetTrack,
          confirmed: true,
          releases: normalized.releases,
        });
      } catch (cause) {
        if (cause instanceof ReleaseError) throw cause;
        throw invalidOutput(cause);
      }
    },
  };
}

function sessionInvalid(cause?: unknown): ReleaseError {
  return new ReleaseError(
    "EDIT_SESSION_INVALID",
    "The tracked Google Play edit session could not be confirmed; no new edit was opened.",
    { ...(cause !== undefined ? { cause } : {}) },
  );
}

function trackMismatch(cause?: unknown): ReleaseError {
  return new ReleaseError(
    "TRACK_MISMATCH",
    "Google Play returned a different or invalid track than the operator-selected target.",
    { ...(cause !== undefined ? { cause } : {}) },
  );
}

function trackReadFailed(cause?: unknown): ReleaseError {
  return new ReleaseError("TRACK_READ_FAILED", "The configured Play track could not be read.", {
    ...(cause !== undefined ? { cause } : {}),
  });
}

function ensureSessionUnexpired(session: ReleaseEditSession, clock: () => Date): void {
  if (isReleaseEditSessionExpired(session, epochSecondsFromDate(clock))) {
    throw new ReleaseError(
      "EDIT_SESSION_EXPIRED",
      "The tracked Play edit session expired during target-track inspection; no changes were made.",
    );
  }
}

function normalizeReturnedTrack(
  value: unknown,
  targetTrack: string,
): ReleaseTargetTrackInspectionResult {
  try {
    const [track] = normalizeReleaseTracks([value]);
    if (!track || track.track !== targetTrack) throw trackMismatch();
    return Object.freeze({
      targetTrack,
      confirmed: true,
      releases: track.releases,
    });
  } catch (cause) {
    if (cause instanceof ReleaseError && cause.code === "TRACK_MISMATCH") throw cause;
    if (cause instanceof ReleaseError && cause.code === "TRACK_INVALID") {
      throw trackMismatch(cause);
    }
    if (cause instanceof ReleaseError) throw cause;
    throw invalidOutput(cause);
  }
}

/** Create the read-only, composition-bound Phase 4.5 target-track tool. */
export function createReleaseTargetTrackInspectionTool(
  options: ReleaseTargetTrackInspectionToolOptions,
): ReleaseTargetTrackInspectionTool {
  const packageName = validateReleasePackageName(options?.packageName);
  const targetTrack = validateReleaseTargetTrack(options?.targetTrack);
  const store = options?.sessionStore;
  const gateway = options?.gateway;
  const clock = options?.now ?? (() => new Date());
  if (!store || typeof store.load !== "function") {
    throw new ReleaseError("INVALID_ARGUMENT", "Release edit session store is invalid.");
  }
  if (!gateway || typeof gateway.getEdit !== "function" || typeof gateway.getTrack !== "function") {
    throw new ReleaseError("INVALID_ARGUMENT", "Target-track inspection gateway is invalid.");
  }

  const description =
    "Inspect the exact operator-selected Google Play target track in the already-tracked edit session. Read-only: it confirms the managed edit, reads only that track, normalizes its active release state, and never creates or changes an edit, uploads, changes a track, validates, commits, or publishes.";
  const outputSchema = createOutputSchema(targetTrack);

  const tool: ToolDefinition<Record<string, never>, ReleaseTargetTrackInspectionResult> = {
    name: RELEASES_INSPECT_TARGET_TRACK_TOOL_NAME,
    description,
    permission: "read",
    inputSchema,
    outputSchema,
    async execute(input) {
      inputSchema.parse(input);
      const state = await loadReleaseEditSessionState(store, epochSecondsFromDate(clock));
      if (state.status === "none") {
        throw new ReleaseError(
          "EDIT_SESSION_REQUIRED",
          "No tracked Play edit session exists for this package; run releases.open_edit explicitly first.",
        );
      }
      if (state.status === "expired") {
        throw new ReleaseError(
          "EDIT_SESSION_EXPIRED",
          "The tracked Play edit session has expired; open a new edit explicitly before inspection.",
        );
      }
      const session = parseReleaseEditSession(state.session, packageName);
      const googleSession = toGooglePlayEditSession(session);

      let remoteEdit: unknown;
      try {
        remoteEdit = await gateway.getEdit(googleSession);
      } catch (cause) {
        throw sessionInvalid(cause);
      }
      try {
        if (
          !isRecord(remoteEdit) ||
          remoteEdit.id !== session.editId ||
          typeof remoteEdit.expiryTimeSeconds !== "string" ||
          compareEpochSeconds(remoteEdit.expiryTimeSeconds, session.expiryTimeSeconds) !== 0
        ) {
          throw sessionInvalid();
        }
      } catch (cause) {
        if (cause instanceof ReleaseError && cause.code === "EDIT_SESSION_INVALID") throw cause;
        throw sessionInvalid(cause);
      }

      ensureSessionUnexpired(session, clock);
      let remoteTrack: unknown;
      try {
        remoteTrack = await gateway.getTrack(googleSession, targetTrack);
      } catch (cause) {
        if (cause instanceof ReleaseError && cause.code === "TRACK_INVALID") {
          throw trackMismatch(cause);
        }
        if (cause instanceof ReleaseError) throw cause;
        throw trackReadFailed(cause);
      }
      return normalizeReturnedTrack(remoteTrack, targetTrack);
    },
  };

  const binding: AgentToolBinding = {
    toolName: RELEASES_INSPECT_TARGET_TRACK_TOOL_NAME,
    llm: {
      name: RELEASES_INSPECT_TARGET_TRACK_TOOL_NAME,
      description,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    serializeResult(output: unknown, verification: VerificationResult): string {
      const result = outputSchema.parse(output);
      if (
        !verification ||
        verification.toolName !== RELEASES_INSPECT_TARGET_TRACK_TOOL_NAME ||
        verification.permission !== "read" ||
        verification.required !== false ||
        verification.status !== "skipped" ||
        verification.code !== "VERIFICATION_SKIPPED" ||
        verification.verified !== false
      ) {
        throw invalidOutput();
      }
      return JSON.stringify({
        targetTrack: result.targetTrack,
        confirmed: true,
        releases: result.releases,
      });
    },
  };
  return Object.freeze({ tool, binding });
}

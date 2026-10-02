/**
 * Phase 4.6 — configure one operator-bound release inside the managed edit.
 *
 * The tool performs a fresh read preflight, exactly one `edits.tracks.update`
 * attempt with no mutation retry, and a real target-track read-back verifier.
 * It configures only name, versionCodes, status, and the initial userFraction
 * when the status is `inProgress`; release notes, country targeting, priority,
 * validation, commit, and publication belong to later phases.
 */
import type { AgentToolBinding } from "../runtime/agent/index.js";
import type { ToolDefinition, ToolSchema } from "../runtime/tools/index.js";
import type { VerificationResult } from "../runtime/verification/index.js";
import {
  compareEpochSeconds,
  compareVersionCodeAgainstTrack,
  epochSecondsFromDate,
  isReleaseEditSessionExpired,
  normalizeReleaseBundle,
  normalizeReleaseTracks,
  normalizeReleaseVersionCode,
  parseReleaseEditSession,
  RELEASE_CONFIGURATION_STATUSES,
  ReleaseError,
  toGooglePlayEditSession,
  validateReleasePackageName,
  validateReleaseTargetTrack,
  type ReleaseBundle,
  type ReleaseConfigurationRelease,
  type ReleaseConfigurationStatus,
  type ReleaseEditSession,
  type ReleaseTrackState,
  type ReleaseTrackUpdateRequest,
} from "./index.js";
import type { ReleaseConfigurationGateway } from "./gateway.js";
import { loadReleaseEditSessionState, type ReleaseEditSessionStore } from "./session-store.js";

export const RELEASES_CONFIGURE_RELEASE_TOOL_NAME = "releases.configure_release";

export interface ReleaseConfigurationResult {
  readonly targetTrack: string;
  readonly releaseName: string;
  readonly status: ReleaseConfigurationStatus;
  readonly versionCodes: readonly string[];
  readonly userFraction?: number;
}

export interface ReleaseConfigureReleaseToolOptions {
  readonly packageName: string;
  /** Exact operator/workflow-bound target; never accepted from the model. */
  readonly targetTrack: string;
  /** Operator/workflow release intent; never accepted from the model. */
  readonly releaseName: string;
  readonly releaseStatus: ReleaseConfigurationStatus;
  readonly initialRolloutFraction?: number;
  /** Verified Phase 4.3 bundle identity; only versionCode/SHA-256 are used. */
  readonly uploadedBundle: ReleaseBundle;
  /** Explicit prior version codes to retain; never inferred or model-supplied. */
  readonly retainVersionCodes?: readonly string[];
  readonly sessionStore: ReleaseEditSessionStore;
  readonly gateway: ReleaseConfigurationGateway;
  readonly now?: () => Date;
}

export interface ReleaseConfigureReleaseTool {
  readonly tool: ToolDefinition<Record<string, never>, ReleaseConfigurationResult>;
  readonly binding: AgentToolBinding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidConfiguration(message = "Release configuration is invalid."): ReleaseError {
  return new ReleaseError("INVALID_RELEASE_CONFIGURATION", message);
}

function invalidOutput(cause?: unknown): ReleaseError {
  return new ReleaseError(
    "TRACK_UPDATE_RESPONSE_INVALID",
    "Release configuration result is invalid.",
    {
      ...(cause !== undefined ? { cause } : {}),
    },
  );
}

function isConfigurationStatus(value: unknown): value is ReleaseConfigurationStatus {
  return RELEASE_CONFIGURATION_STATUSES.some((candidate) => candidate === value);
}

function validateReleaseName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidConfiguration("Release name must be a non-blank string.");
  }
  return value.trim();
}

function validateInitialRolloutFraction(
  status: ReleaseConfigurationStatus,
  value: unknown,
): number | undefined {
  if (status !== "inProgress") {
    if (value !== undefined) {
      throw invalidConfiguration(
        "Initial rollout fraction is allowed only for an inProgress release.",
      );
    }
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
    throw invalidConfiguration(
      "An inProgress release requires an initial rollout fraction strictly between 0 and 1.",
    );
  }
  return value;
}

function canonicalVersionCodeSet(values: readonly unknown[]): readonly string[] {
  const normalized = values.map((value) => normalizeReleaseVersionCode(value));
  const unique = [...new Set(normalized)];
  unique.sort((left, right) => {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return Object.freeze(unique);
}

function currentVersionCodeSet(track: ReleaseTrackState): ReadonlySet<string> {
  return new Set(track.releases.flatMap((release) => release.versionCodes));
}

function sessionInvalid(cause?: unknown): ReleaseError {
  return new ReleaseError(
    "EDIT_SESSION_INVALID",
    "The tracked Google Play edit session could not be confirmed; no release was changed.",
    { ...(cause !== undefined ? { cause } : {}) },
  );
}

function ensureSessionUnexpired(session: ReleaseEditSession, clock: () => Date): void {
  if (isReleaseEditSessionExpired(session, epochSecondsFromDate(clock))) {
    throw new ReleaseError(
      "EDIT_SESSION_EXPIRED",
      "The tracked Play edit session expired before release configuration; no changes were made.",
    );
  }
}

function normalizeTargetTrack(value: unknown, targetTrack: string): ReleaseTrackState {
  try {
    const [track] = normalizeReleaseTracks([value]);
    if (!track || track.track !== targetTrack) {
      throw new ReleaseError(
        "TRACK_MISMATCH",
        "Google Play returned a different track than the operator-selected target.",
      );
    }
    return track;
  } catch (cause) {
    if (cause instanceof ReleaseError) throw cause;
    throw new ReleaseError("TRACK_READ_FAILED", "The configured Play track could not be read.", {
      cause,
    });
  }
}

function normalizeUpdateResponse(value: unknown, targetTrack: string): ReleaseTrackState {
  try {
    const [track] = normalizeReleaseTracks([value]);
    if (!track || track.track !== targetTrack) throw invalidOutput();
    return track;
  } catch (cause) {
    if (cause instanceof ReleaseError && cause.code === "TRACK_UPDATE_RESPONSE_INVALID") {
      throw cause;
    }
    throw new ReleaseError(
      "TRACK_UPDATE_RESPONSE_INVALID",
      "Google Play returned an invalid track-update response; remote state may be uncertain.",
      { cause },
    );
  }
}

function createOutputSchema(
  targetTrack: string,
  releaseName: string,
  status: ReleaseConfigurationStatus,
  versionCodes: readonly string[],
  userFraction: number | undefined,
): ToolSchema<ReleaseConfigurationResult> {
  const expectedKeys = [
    "releaseName",
    "status",
    "targetTrack",
    "versionCodes",
    ...(userFraction !== undefined ? ["userFraction"] : []),
  ].sort();
  return {
    parse(value: unknown): ReleaseConfigurationResult {
      if (!isRecord(value)) throw invalidOutput();
      const keys = Object.keys(value).sort();
      if (
        keys.length !== expectedKeys.length ||
        keys.some((key, index) => key !== expectedKeys[index]) ||
        value.targetTrack !== targetTrack ||
        value.releaseName !== releaseName ||
        value.status !== status
      ) {
        throw invalidOutput();
      }
      if (!Array.isArray(value.versionCodes)) throw invalidOutput();
      let actualCodes: readonly string[];
      try {
        actualCodes = canonicalVersionCodeSet(value.versionCodes);
      } catch (cause) {
        throw invalidOutput(cause);
      }
      if (
        actualCodes.length !== versionCodes.length ||
        actualCodes.some((code, index) => code !== versionCodes[index])
      ) {
        throw invalidOutput();
      }
      if (userFraction !== undefined) {
        if (value.userFraction !== userFraction) throw invalidOutput();
        return Object.freeze({
          targetTrack,
          releaseName,
          status,
          versionCodes,
          userFraction,
        });
      }
      return Object.freeze({ targetTrack, releaseName, status, versionCodes });
    },
  };
}

function requestBody(
  targetTrack: string,
  releaseName: string,
  status: ReleaseConfigurationStatus,
  versionCodes: readonly string[],
  userFraction: number | undefined,
): ReleaseTrackUpdateRequest {
  const release: ReleaseConfigurationRelease = {
    name: releaseName,
    versionCodes,
    status,
    ...(userFraction !== undefined ? { userFraction } : {}),
  };
  return Object.freeze({ track: targetTrack, releases: Object.freeze([Object.freeze(release)]) });
}

function resultFromIntent(
  targetTrack: string,
  releaseName: string,
  status: ReleaseConfigurationStatus,
  versionCodes: readonly string[],
  userFraction: number | undefined,
): ReleaseConfigurationResult {
  return Object.freeze({
    targetTrack,
    releaseName,
    status,
    versionCodes,
    ...(userFraction !== undefined ? { userFraction } : {}),
  });
}

/** Create the write-only-through-the-active-edit Phase 4.6 tool. */
export function createReleaseConfigureReleaseTool(
  options: ReleaseConfigureReleaseToolOptions,
): ReleaseConfigureReleaseTool {
  const packageName = validateReleasePackageName(options?.packageName);
  const targetTrack = validateReleaseTargetTrack(options?.targetTrack);
  const releaseName = validateReleaseName(options?.releaseName);
  if (!isConfigurationStatus(options?.releaseStatus)) {
    throw invalidConfiguration("Release status must be draft, inProgress, or completed.");
  }
  const releaseStatus = options.releaseStatus;
  const initialRolloutFraction = validateInitialRolloutFraction(
    releaseStatus,
    options?.initialRolloutFraction,
  );
  let uploadedBundle: ReleaseBundle;
  try {
    uploadedBundle = normalizeReleaseBundle(options?.uploadedBundle);
  } catch {
    throw invalidConfiguration("The verified uploaded bundle identity is invalid.");
  }
  let retainVersionCodes: readonly string[] = Object.freeze([]);
  if (options?.retainVersionCodes !== undefined) {
    if (!Array.isArray(options.retainVersionCodes)) {
      throw invalidConfiguration("Retained version codes must be an array.");
    }
    try {
      retainVersionCodes = canonicalVersionCodeSet(options.retainVersionCodes);
    } catch {
      throw invalidConfiguration("Retained version codes are invalid.");
    }
  }
  const store = options?.sessionStore;
  const gateway = options?.gateway;
  const clock = options?.now ?? (() => new Date());
  if (!store || typeof store.load !== "function") {
    throw new ReleaseError("INVALID_ARGUMENT", "Release edit session store is invalid.");
  }
  if (
    !gateway ||
    typeof gateway.getEdit !== "function" ||
    typeof gateway.listBundles !== "function" ||
    typeof gateway.getTrack !== "function" ||
    typeof gateway.updateTrack !== "function"
  ) {
    throw new ReleaseError("INVALID_ARGUMENT", "Release configuration gateway is invalid.");
  }

  const description =
    "Configure exactly one operator-bound release inside the already-tracked Google Play edit. This is a write to draft edit state only: it performs fresh session, bundle, target-track, and versionCode checks, calls edits.tracks.update once with retry disabled, and verifies the exact release by a fresh tracks.get. It never validates, commits, publishes, uploads, opens another edit, attaches release notes, changes rollout after this initial setting, or halts/resumes a release.";
  const canonicalIntentCodes = [...new Set([uploadedBundle.versionCode, ...retainVersionCodes])];
  canonicalIntentCodes.sort((left, right) => {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const versionCodes = Object.freeze(canonicalIntentCodes);
  const outputSchema = createOutputSchema(
    targetTrack,
    releaseName,
    releaseStatus,
    versionCodes,
    initialRolloutFraction,
  );
  const inputSchema: ToolSchema<Record<string, never>> = {
    parse(value: unknown): Record<string, never> {
      if (!isRecord(value) || Object.keys(value).length !== 0) {
        throw invalidConfiguration("Release configuration input is invalid.");
      }
      return Object.freeze({});
    },
  };

  const tool: ToolDefinition<Record<string, never>, ReleaseConfigurationResult> = {
    name: RELEASES_CONFIGURE_RELEASE_TOOL_NAME,
    description,
    permission: "write",
    inputSchema,
    outputSchema,
    async execute(input) {
      inputSchema.parse(input);
      let mutationAttempted = false;
      try {
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
            "The tracked Play edit session has expired; open a new edit explicitly before configuration.",
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

        let remoteBundles: readonly ReleaseBundle[];
        try {
          remoteBundles = await gateway.listBundles(googleSession);
        } catch (cause) {
          if (cause instanceof ReleaseError) throw cause;
          throw new ReleaseError(
            "BUNDLE_LIST_FAILED",
            "Google Play bundle metadata could not be read for identity verification.",
            { cause },
          );
        }
        if (!Array.isArray(remoteBundles)) {
          throw new ReleaseError(
            "BUNDLE_LIST_FAILED",
            "Google Play bundle metadata could not be read for identity verification.",
          );
        }
        let normalizedBundles: readonly ReleaseBundle[];
        try {
          normalizedBundles = Object.freeze(
            remoteBundles.map((bundle) => normalizeReleaseBundle(bundle)),
          );
        } catch (cause) {
          throw new ReleaseError(
            "BUNDLE_LIST_FAILED",
            "Google Play bundle metadata could not be read for identity verification.",
            { cause },
          );
        }
        if (
          !normalizedBundles.some(
            (bundle) =>
              bundle.versionCode === uploadedBundle.versionCode &&
              bundle.sha256 === uploadedBundle.sha256,
          )
        ) {
          throw new ReleaseError(
            "UPLOADED_BUNDLE_NOT_FOUND",
            "The exact verified uploaded bundle identity is not present in the tracked edit.",
          );
        }
        ensureSessionUnexpired(session, clock);

        let remoteTrack: unknown;
        try {
          remoteTrack = await gateway.getTrack(googleSession, targetTrack);
        } catch (cause) {
          if (cause instanceof ReleaseError) throw cause;
          throw new ReleaseError(
            "TRACK_READ_FAILED",
            "The configured Play track could not be read.",
            {
              cause,
            },
          );
        }
        const track = normalizeTargetTrack(remoteTrack, targetTrack);
        const comparison = compareVersionCodeAgainstTrack(uploadedBundle.versionCode, track);
        if (comparison.relation !== "greater" && comparison.relation !== "no-current-version") {
          throw new ReleaseError(
            "VERSION_CODE_NOT_GREATER",
            "The uploaded versionCode must be strictly greater than every versionCode on the target track.",
          );
        }
        if (
          track.releases.some(
            (release) =>
              release.status === "draft" ||
              release.status === "inProgress" ||
              release.status === "halted",
          )
        ) {
          throw new ReleaseError(
            "OUTSTANDING_RELEASE_EXISTS",
            "The target track already has an outstanding release; PlayOps will not replace it.",
          );
        }
        if (releaseStatus === "inProgress" && comparison.relation === "no-current-version") {
          throw new ReleaseError(
            "STAGED_ROLLOUT_REQUIRES_EXISTING_RELEASE",
            "An inProgress staged rollout requires an existing target-track version.",
          );
        }
        const existingCodes = currentVersionCodeSet(track);
        for (const retained of retainVersionCodes) {
          if (!existingCodes.has(retained)) {
            throw invalidConfiguration(
              "Every retained versionCode must already exist on the fresh target track.",
            );
          }
        }
        ensureSessionUnexpired(session, clock);

        const request = requestBody(
          targetTrack,
          releaseName,
          releaseStatus,
          versionCodes,
          initialRolloutFraction,
        );
        let updateResponse: unknown;
        mutationAttempted = true;
        try {
          updateResponse = await gateway.updateTrack(googleSession, targetTrack, request);
        } catch (cause) {
          if (
            cause instanceof ReleaseError &&
            (cause.code === "TRACK_UPDATE_FAILED" || cause.code === "TRACK_UPDATE_RESPONSE_INVALID")
          ) {
            throw cause;
          }
          throw new ReleaseError(
            "TRACK_UPDATE_FAILED",
            "Google Play track update failed; remote edit state may be uncertain.",
            { cause },
          );
        }
        normalizeUpdateResponse(updateResponse, targetTrack);
        return resultFromIntent(
          targetTrack,
          releaseName,
          releaseStatus,
          versionCodes,
          initialRolloutFraction,
        );
      } catch (cause) {
        if (!mutationAttempted && cause instanceof ReleaseError) {
          throw new ReleaseError(cause.code, cause.message, {
            cause,
            externalStateUncertain: false,
          });
        }
        throw cause;
      }
    },
    async verify(_input, output) {
      let result: ReleaseConfigurationResult;
      try {
        result = outputSchema.parse(output);
      } catch {
        return false;
      }
      let state: Awaited<ReturnType<typeof loadReleaseEditSessionState>>;
      try {
        state = await loadReleaseEditSessionState(store, epochSecondsFromDate(clock));
      } catch {
        return false;
      }
      if (state.status !== "active") return false;
      let session: ReleaseEditSession;
      try {
        session = parseReleaseEditSession(state.session, packageName);
      } catch {
        return false;
      }
      let remoteTrack: unknown;
      try {
        remoteTrack = await gateway.getTrack(toGooglePlayEditSession(session), targetTrack);
      } catch {
        return false;
      }
      let track: ReleaseTrackState;
      try {
        track = normalizeTargetTrack(remoteTrack, targetTrack);
      } catch {
        return false;
      }
      const candidates = track.releases.filter((release) =>
        release.versionCodes.includes(uploadedBundle.versionCode),
      );
      if (candidates.length !== 1) return false;
      const [configured] = candidates;
      if (
        !configured ||
        configured.name !== result.releaseName ||
        configured.status !== result.status
      ) {
        return false;
      }
      try {
        const actualCodes = canonicalVersionCodeSet(configured.versionCodes);
        if (
          actualCodes.length !== result.versionCodes.length ||
          actualCodes.some((code, index) => code !== result.versionCodes[index])
        ) {
          return false;
        }
      } catch {
        return false;
      }
      if (result.status === "inProgress") {
        return configured.userFraction === result.userFraction;
      }
      return configured.userFraction === undefined;
    },
  };

  const binding: AgentToolBinding = {
    toolName: RELEASES_CONFIGURE_RELEASE_TOOL_NAME,
    llm: {
      name: RELEASES_CONFIGURE_RELEASE_TOOL_NAME,
      description,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    serializeResult(output: unknown, verification: VerificationResult): string {
      const result = outputSchema.parse(output);
      if (
        !verification ||
        verification.toolName !== RELEASES_CONFIGURE_RELEASE_TOOL_NAME ||
        verification.permission !== "write" ||
        verification.required !== true ||
        verification.status !== "passed" ||
        verification.code !== "VERIFIED" ||
        verification.verified !== true
      ) {
        throw invalidOutput();
      }
      return JSON.stringify({
        targetTrack: result.targetTrack,
        releaseName: result.releaseName,
        status: result.status,
        versionCodes: result.versionCodes,
        ...(result.userFraction !== undefined ? { userFraction: result.userFraction } : {}),
      });
    },
  };
  return Object.freeze({ tool, binding });
}

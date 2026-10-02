/**
 * Phase 4.4 — read-only versionCode safety gate for one operator-bound track.
 *
 * The uploaded bundle identity and target track are factory-bound, never model
 * input. The tool reconfirms the Phase 4.3 versionCode+SHA-256 pair in the
 * tracked edit before reading that one track. It never creates or mutates state.
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
  ReleaseError,
  toGooglePlayEditSession,
  validateReleasePackageName,
  type ReleaseBundle,
  type ReleaseEditSession,
  type ReleaseTrackState,
} from "./index.js";
import type { ReleaseVersionCodeVerificationGateway } from "./gateway.js";
import { loadReleaseEditSessionState, type ReleaseEditSessionStore } from "./session-store.js";

export const RELEASES_VERIFY_VERSION_CODE_TOOL_NAME = "releases.verify_version_code";

export type ReleaseVersionCodeVerificationComparison = "greater" | "no-current-version";

export interface ReleaseVersionCodeVerificationResult {
  readonly targetTrack: string;
  readonly uploadedVersionCode: string;
  readonly currentMaxVersionCode: string | null;
  readonly comparison: ReleaseVersionCodeVerificationComparison;
  readonly verified: true;
}

export interface ReleaseVersionCodeVerificationToolOptions {
  readonly packageName: string;
  /** Exact operator/workflow-bound track name; never accepted from the model. */
  readonly targetTrack: string;
  /** ReleaseBundleUploadResult from the verified Phase 4.3 upload; only its identity is retained. */
  readonly uploadedBundle: ReleaseBundle;
  readonly sessionStore: ReleaseEditSessionStore;
  readonly gateway: ReleaseVersionCodeVerificationGateway;
  readonly now?: () => Date;
}

export interface ReleaseVersionCodeVerificationTool {
  readonly tool: ToolDefinition<Record<string, never>, ReleaseVersionCodeVerificationResult>;
  readonly binding: AgentToolBinding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidInput(): ReleaseError {
  return new ReleaseError("INVALID_ARGUMENT", "Version-code verification input is invalid.");
}

function invalidOutput(cause?: unknown): ReleaseError {
  return new ReleaseError("REMOTE_DATA_INVALID", "Version-code verification result is invalid.", {
    ...(cause !== undefined ? { cause } : {}),
  });
}

function validateTargetTrack(value: unknown): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value !== value.trim() ||
    /\s/u.test(value) ||
    // eslint-disable-next-line no-control-regex -- reject controls in an operator-selected track id
    /[\x00-\x1f\x7f]/u.test(value)
  ) {
    throw invalidInput();
  }
  return value;
}

function inputSchema(): ToolSchema<Record<string, never>> {
  return {
    parse(value: unknown): Record<string, never> {
      if (!isRecord(value) || Object.keys(value).length !== 0) throw invalidInput();
      return Object.freeze({});
    },
  };
}

function createOutputSchema(
  targetTrack: string,
  uploadedVersionCode: string,
): ToolSchema<ReleaseVersionCodeVerificationResult> {
  return {
    parse(value: unknown): ReleaseVersionCodeVerificationResult {
      if (!isRecord(value)) throw invalidOutput();
      const keys = Object.keys(value).sort();
      const expected = [
        "comparison",
        "currentMaxVersionCode",
        "targetTrack",
        "uploadedVersionCode",
        "verified",
      ];
      if (
        keys.length !== expected.length ||
        keys.some((key, index) => key !== expected[index]) ||
        value.targetTrack !== targetTrack ||
        value.uploadedVersionCode !== uploadedVersionCode ||
        value.verified !== true
      ) {
        throw invalidOutput();
      }

      if (value.comparison === "no-current-version") {
        if (value.currentMaxVersionCode !== null) throw invalidOutput();
        return Object.freeze({
          targetTrack,
          uploadedVersionCode,
          currentMaxVersionCode: null,
          comparison: "no-current-version",
          verified: true,
        });
      }
      if (value.comparison !== "greater" || typeof value.currentMaxVersionCode !== "string") {
        throw invalidOutput();
      }
      let currentMaxVersionCode: string;
      try {
        currentMaxVersionCode = normalizeReleaseVersionCode(value.currentMaxVersionCode);
      } catch (cause) {
        throw invalidOutput(cause);
      }
      if (
        currentMaxVersionCode !== value.currentMaxVersionCode ||
        BigInt(uploadedVersionCode) <= BigInt(currentMaxVersionCode)
      ) {
        throw invalidOutput();
      }
      return Object.freeze({
        targetTrack,
        uploadedVersionCode,
        currentMaxVersionCode,
        comparison: "greater",
        verified: true,
      });
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

function ensureSessionUnexpired(session: ReleaseEditSession, clock: () => Date): void {
  if (isReleaseEditSessionExpired(session, epochSecondsFromDate(clock))) {
    throw new ReleaseError(
      "EDIT_SESSION_EXPIRED",
      "The tracked Play edit session expired during version-code verification; no changes were made.",
    );
  }
}

function bundleListFailed(cause?: unknown): ReleaseError {
  return new ReleaseError(
    "BUNDLE_LIST_FAILED",
    "Google Play bundle metadata could not be read for identity verification.",
    { ...(cause !== undefined ? { cause } : {}) },
  );
}

function trackReadFailed(cause?: unknown): ReleaseError {
  return new ReleaseError("TRACK_READ_FAILED", "The configured Play track could not be read.", {
    ...(cause !== undefined ? { cause } : {}),
  });
}

/** Create the read-only, composition-bound Phase 4.4 runtime tool. */
export function createReleaseVersionCodeVerificationTool(
  options: ReleaseVersionCodeVerificationToolOptions,
): ReleaseVersionCodeVerificationTool {
  const packageName = validateReleasePackageName(options?.packageName);
  const targetTrack = validateTargetTrack(options?.targetTrack);
  const normalizedUploadedBundle = normalizeReleaseBundle(options?.uploadedBundle);
  const uploadedBundle: ReleaseBundle = Object.freeze({
    versionCode: normalizedUploadedBundle.versionCode,
    sha256: normalizedUploadedBundle.sha256,
  });
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
    typeof gateway.getTrack !== "function"
  ) {
    throw new ReleaseError("INVALID_ARGUMENT", "Version-code verification gateway is invalid.");
  }

  const description =
    "Verify that the already-verified uploaded bundle has a versionCode strictly greater than every versionCode returned for the operator-bound target track. Read-only: it confirms the tracked edit, reconfirms the exact bundle versionCode+SHA-256 pair, reads only that one track, and never uploads, opens an edit, changes a track, validates, commits, or publishes. This is a target-track check, not a scan of every version ever used by the app.";
  const authoritativeInputSchema = inputSchema();
  const outputSchema = createOutputSchema(targetTrack, uploadedBundle.versionCode);

  const tool: ToolDefinition<Record<string, never>, ReleaseVersionCodeVerificationResult> = {
    name: RELEASES_VERIFY_VERSION_CODE_TOOL_NAME,
    description,
    permission: "read",
    inputSchema: authoritativeInputSchema,
    outputSchema,
    async execute(input) {
      authoritativeInputSchema.parse(input);
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
          "The tracked Play edit session has expired; open a new edit explicitly before verification.",
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
        if (cause instanceof ReleaseError && cause.code === "BUNDLE_LIST_FAILED") throw cause;
        throw bundleListFailed(cause);
      }
      if (!Array.isArray(remoteBundles)) throw bundleListFailed();
      let normalizedBundles: ReleaseBundle[];
      try {
        normalizedBundles = remoteBundles.map((bundle) => normalizeReleaseBundle(bundle));
      } catch (cause) {
        throw bundleListFailed(cause);
      }
      const uploadedIdentityPresent = normalizedBundles.some(
        (bundle) =>
          bundle.versionCode === uploadedBundle.versionCode &&
          bundle.sha256 === uploadedBundle.sha256,
      );
      if (!uploadedIdentityPresent) {
        throw new ReleaseError(
          "UPLOADED_BUNDLE_NOT_FOUND",
          "The exact Phase 4.3 uploaded bundle identity is not present in the tracked edit.",
        );
      }

      ensureSessionUnexpired(session, clock);
      let remoteTrack: ReleaseTrackState;
      try {
        remoteTrack = await gateway.getTrack(googleSession, targetTrack);
      } catch (cause) {
        if (cause instanceof ReleaseError) throw cause;
        throw trackReadFailed(cause);
      }
      const [track] = normalizeReleaseTracks([remoteTrack]);
      if (!track) {
        throw new ReleaseError("TRACK_INVALID", "Remote release track is invalid.");
      }
      if (track.track !== targetTrack) {
        throw new ReleaseError(
          "TRACK_MISMATCH",
          "Google Play returned a different track than the operator-selected target.",
        );
      }

      const comparison = compareVersionCodeAgainstTrack(uploadedBundle.versionCode, track);
      if (comparison.relation !== "greater" && comparison.relation !== "no-current-version") {
        throw new ReleaseError(
          "VERSION_CODE_NOT_GREATER",
          "The uploaded versionCode must be strictly greater than every versionCode on the target track.",
        );
      }
      return Object.freeze({
        targetTrack,
        uploadedVersionCode: comparison.uploadedVersionCode,
        currentMaxVersionCode: comparison.currentMaxVersionCode,
        comparison: comparison.relation,
        verified: true,
      });
    },
  };

  const binding: AgentToolBinding = {
    toolName: RELEASES_VERIFY_VERSION_CODE_TOOL_NAME,
    llm: {
      name: RELEASES_VERIFY_VERSION_CODE_TOOL_NAME,
      description,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    serializeResult(output: unknown, verification: VerificationResult): string {
      const result = outputSchema.parse(output);
      if (
        !verification ||
        verification.toolName !== RELEASES_VERIFY_VERSION_CODE_TOOL_NAME ||
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
        uploadedVersionCode: result.uploadedVersionCode,
        currentMaxVersionCode: result.currentMaxVersionCode,
        comparison: result.comparison,
        verified: true,
      });
    },
  };
  return Object.freeze({ tool, binding });
}

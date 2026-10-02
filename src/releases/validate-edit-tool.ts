/**
 * Phase 4.8 — validate the currently tracked Google Play edit.
 *
 * `edits.validate` is an HTTP POST but is semantically read-only: Google checks
 * whether the active edit is committable at this moment and does not apply it
 * to the live app. This tool therefore uses permission `read`, has no verifier,
 * emits no approval request, and never writes the local session.
 */
import type { AgentToolBinding } from "../runtime/agent/index.js";
import type { ToolDefinition, ToolSchema } from "../runtime/tools/index.js";
import type { VerificationResult } from "../runtime/verification/index.js";
import {
  compareEpochSeconds,
  epochSecondsFromDate,
  isReleaseEditSessionExpired,
  parseReleaseEditSession,
  ReleaseError,
  toGooglePlayEditSession,
  validateReleasePackageName,
} from "./index.js";
import type { ReleaseEditValidationGateway } from "./gateway.js";
import { loadReleaseEditSessionState, type ReleaseEditSessionStore } from "./session-store.js";

export const RELEASES_VALIDATE_EDIT_TOOL_NAME = "releases.validate_edit";

export interface EditValidationResult {
  readonly valid: true;
  readonly expiryTimeSeconds: string;
}

export interface EditValidationToolOptions {
  readonly packageName: string;
  readonly gateway: ReleaseEditValidationGateway;
  readonly sessionStore: ReleaseEditSessionStore;
  readonly now?: () => Date;
}

export interface EditValidationTool {
  readonly tool: ToolDefinition<Record<string, never>, EditValidationResult>;
  readonly binding: AgentToolBinding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidOutput(): ReleaseError {
  return new ReleaseError("VALIDATION_RESPONSE_INVALID", "Edit validation result is invalid.");
}

const inputSchema: ToolSchema<Record<string, never>> = {
  parse(value: unknown): Record<string, never> {
    if (!isRecord(value) || Object.keys(value).length !== 0) {
      throw new ReleaseError("INVALID_ARGUMENT", "Edit validation input is invalid.");
    }
    return Object.freeze({});
  },
};

function createOutputSchema(): ToolSchema<EditValidationResult> {
  return {
    parse(value: unknown): EditValidationResult {
      if (!isRecord(value)) throw invalidOutput();
      const keys = Object.keys(value).sort();
      if (
        keys.length !== 2 ||
        keys[0] !== "expiryTimeSeconds" ||
        keys[1] !== "valid" ||
        value.valid !== true ||
        typeof value.expiryTimeSeconds !== "string" ||
        !/^\d+$/u.test(value.expiryTimeSeconds)
      ) {
        throw invalidOutput();
      }
      return Object.freeze({ valid: true, expiryTimeSeconds: value.expiryTimeSeconds });
    },
  };
}

function asSafePreflightFailure(cause: unknown): ReleaseError {
  if (cause instanceof ReleaseError) {
    if (cause.externalStateUncertain === false) return cause;
    return new ReleaseError(cause.code, cause.message, {
      cause,
      externalStateUncertain: false,
    });
  }
  return new ReleaseError(
    "EDIT_VALIDATION_FAILED",
    "Google Play edit validation could not be completed safely.",
    { cause, externalStateUncertain: false },
  );
}

export function ensureRemoteEditMatches(
  remote: unknown,
  editId: string,
  trackedExpiryTimeSeconds: string,
  nowSeconds: string,
): string {
  if (!isRecord(remote) || remote.id !== editId) {
    throw new ReleaseError(
      "EDIT_SESSION_INVALID",
      "The tracked Play edit session no longer matches the remote edit.",
    );
  }
  if (
    typeof remote.expiryTimeSeconds !== "string" ||
    compareEpochSeconds(remote.expiryTimeSeconds, trackedExpiryTimeSeconds) !== 0
  ) {
    throw new ReleaseError(
      "EDIT_SESSION_INVALID",
      "The tracked Play edit session no longer matches the remote edit.",
    );
  }
  if (compareEpochSeconds(nowSeconds, remote.expiryTimeSeconds) >= 0) {
    throw new ReleaseError(
      "EDIT_SESSION_INVALID",
      "The tracked Play edit session is expired remotely.",
    );
  }
  return remote.expiryTimeSeconds;
}

export function normalizeValidationResponse(
  response: unknown,
  editId: string,
  nowSeconds: string,
): EditValidationResult {
  if (!isRecord(response) || response.id !== editId) {
    throw new ReleaseError(
      "VALIDATION_RESPONSE_MISMATCH",
      "Google Play returned a different edit from the validation request.",
    );
  }
  if (
    typeof response.expiryTimeSeconds !== "string" ||
    !/^\d+$/u.test(response.expiryTimeSeconds)
  ) {
    throw new ReleaseError(
      "VALIDATION_RESPONSE_INVALID",
      "Google Play returned an invalid edit-validation response.",
    );
  }
  if (compareEpochSeconds(nowSeconds, response.expiryTimeSeconds) >= 0) {
    throw new ReleaseError(
      "EDIT_VALIDATION_EXPIRED",
      "Google Play returned an expired edit-validation result.",
    );
  }
  return Object.freeze({ valid: true, expiryTimeSeconds: response.expiryTimeSeconds });
}

/** Create the read-only, no-approval Phase 4.8 validation gate. */
export function createReleaseEditValidationTool(
  options: EditValidationToolOptions,
): EditValidationTool {
  const packageName = validateReleasePackageName(options?.packageName);
  const gateway = options?.gateway;
  const sessionStore = options?.sessionStore;
  const clock = options?.now ?? (() => new Date());
  if (
    !gateway ||
    typeof gateway.getEdit !== "function" ||
    typeof gateway.validateEdit !== "function"
  ) {
    throw new ReleaseError("INVALID_ARGUMENT", "Edit validation gateway is invalid.");
  }
  if (!sessionStore || typeof sessionStore.load !== "function") {
    throw new ReleaseError("INVALID_ARGUMENT", "Edit session store is invalid.");
  }

  const description =
    "Validate the already-tracked Google Play edit with edits.validate. Read-only semantic effect despite the HTTP POST: Google checks whether the edit is committable at this moment but does not apply changes to the live app. Requires the exact unexpired managed session and exact remote edit read-back. It never creates, uploads, updates, deletes, commits, publishes, changes a track, or requests human approval. Successful validation is not durable approval and does not guarantee a later commit.";
  const outputSchema = createOutputSchema();

  const tool: ToolDefinition<Record<string, never>, EditValidationResult> = {
    name: RELEASES_VALIDATE_EDIT_TOOL_NAME,
    description,
    permission: "read",
    inputSchema,
    outputSchema,
    async execute(input) {
      inputSchema.parse(input);
      try {
        const nowSeconds = epochSecondsFromDate(clock);
        const state = await loadReleaseEditSessionState(sessionStore, nowSeconds);
        if (state.status === "none") {
          throw new ReleaseError(
            "EDIT_SESSION_REQUIRED",
            "No tracked Play edit session exists for this package; run releases.open_edit first.",
          );
        }
        if (state.status === "expired") {
          throw new ReleaseError(
            "EDIT_SESSION_EXPIRED",
            "The tracked Play edit session has expired; open a new edit explicitly before validation.",
          );
        }
        const session = parseReleaseEditSession(state.session, packageName);
        if (isReleaseEditSessionExpired(session, nowSeconds)) {
          throw new ReleaseError(
            "EDIT_SESSION_EXPIRED",
            "The tracked Play edit session has expired; open a new edit explicitly before validation.",
          );
        }
        const googleSession = toGooglePlayEditSession(session);
        let remote: unknown;
        try {
          remote = await gateway.getEdit(googleSession);
        } catch (cause) {
          if (cause instanceof ReleaseError && cause.code === "EDIT_INVALID") {
            throw new ReleaseError(
              "EDIT_SESSION_INVALID",
              "The tracked Play edit session could not be confirmed remotely.",
              { cause },
            );
          }
          throw cause;
        }
        ensureRemoteEditMatches(remote, session.editId, session.expiryTimeSeconds, nowSeconds);
        const validation = await gateway.validateEdit(googleSession);
        return normalizeValidationResponse(validation, session.editId, nowSeconds);
      } catch (cause) {
        throw asSafePreflightFailure(cause);
      }
    },
  };

  const binding: AgentToolBinding = {
    toolName: RELEASES_VALIDATE_EDIT_TOOL_NAME,
    llm: {
      name: RELEASES_VALIDATE_EDIT_TOOL_NAME,
      description,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    serializeResult(output: unknown, verification: VerificationResult): string {
      const result = outputSchema.parse(output);
      if (
        !verification ||
        verification.toolName !== RELEASES_VALIDATE_EDIT_TOOL_NAME ||
        verification.permission !== "read" ||
        verification.required !== false ||
        verification.status !== "skipped" ||
        verification.code !== "VERIFICATION_SKIPPED" ||
        verification.verified !== false
      ) {
        throw new ReleaseError(
          "VALIDATION_RESPONSE_INVALID",
          "Edit validation result is not serializable.",
        );
      }
      return JSON.stringify({ valid: result.valid, expiryTimeSeconds: result.expiryTimeSeconds });
    },
  };

  return Object.freeze({ tool, binding });
}

/**
 * Phase 4.2 — `releases.open_edit`: the explicit, approval-gated edit session.
 *
 * SAFETY RATIONALE (Google's documented concurrency semantics):
 *   - each API user may have only ONE active edit per application;
 *   - creating a new edit invalidates any active edit the same user has for that app;
 *   - Play Console changes and another user's commit also invalidate open edits.
 * So `edits.insert` can discard uncommitted work and is therefore permission
 * `destructive` here — NOT `write`, and NOT `publish` (an uncommitted edit is not live).
 *
 * This tool never commits, uploads, validates, or mutates a track, and never retries.
 */
import { createHash } from "node:crypto";
import type { AgentToolBinding } from "../runtime/agent/index.js";
import type { ToolDefinition, ToolSchema } from "../runtime/tools/index.js";
import type { VerificationResult } from "../runtime/verification/index.js";
import {
  createReleaseEditSession,
  compareEpochSeconds,
  epochSecondsFromDate,
  parseGooglePlayEditSession,
  parseReleaseEditSession,
  ReleaseError,
  toGooglePlayEditSession,
  validateReleasePackageName,
  type ReleaseEditSession,
} from "./index.js";
import type { ReleaseEditGateway } from "./gateway.js";
import { loadReleaseEditSessionState, type ReleaseEditSessionStore } from "./session-store.js";

export const RELEASES_OPEN_EDIT_TOOL_NAME = "releases.open_edit";

export interface ReleaseEditOpenResult {
  readonly session: ReleaseEditSession;
}

export interface ReleaseEditOpenToolOptions {
  readonly packageName: string;
  readonly gateway: ReleaseEditGateway;
  readonly store: ReleaseEditSessionStore;
  /** Injectable clock; expiry decisions must not depend on wall-clock internals. */
  readonly now?: () => Date;
}

export interface ReleaseEditOpenTool {
  readonly tool: ToolDefinition<Record<string, never>, ReleaseEditOpenResult>;
  readonly binding: AgentToolBinding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const inputSchema: ToolSchema<Record<string, never>> = {
  parse(value: unknown): Record<string, never> {
    if (!isRecord(value) || Object.keys(value).length !== 0) {
      throw new ReleaseError("INVALID_ARGUMENT", "Play edit open input is invalid.");
    }
    return Object.freeze({});
  },
};

function createOutputSchema(packageName: string): ToolSchema<ReleaseEditOpenResult> {
  return {
    parse(value: unknown): ReleaseEditOpenResult {
      if (!isRecord(value) || Object.keys(value).length !== 1) {
        throw new ReleaseError("EDIT_SESSION_STORE_INVALID", "Play edit open result is invalid.");
      }
      return Object.freeze({ session: parseReleaseEditSession(value.session, packageName) });
    },
  };
}

function asOpenError(cause: unknown): ReleaseError {
  if (cause instanceof ReleaseError) return cause;
  return new ReleaseError(
    "EDIT_CREATE_FAILED",
    "Play edit creation failed; remote state may be uncertain.",
    { cause },
  );
}

/**
 * Deterministic SHA-256 request digest. Binds operation identity, the
 * composition-bound package, and the fact that this approval expects NO tracked
 * local session. No credential, token, or raw Google value is ever included.
 */
export function createReleaseEditOpenDigest(packageName: string): string {
  const canonical = JSON.stringify({
    version: 1,
    toolName: RELEASES_OPEN_EDIT_TOOL_NAME,
    packageName: validateReleasePackageName(packageName),
    expectedLocalSession: "none",
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Exact human-facing summary for the approval prompt. Never contains secrets. */
export function createReleaseEditOpenSummary(packageName: string): string {
  return [
    `Open a new Google Play edit for ${validateReleasePackageName(packageName)}.`,
    "",
    "WARNING: Google may invalidate another active edit owned by this API user for the same application. Any uncommitted changes in that edit would be lost.",
    "",
    "This action does NOT publish or commit a release.",
  ].join("\n");
}

export function createReleaseEditOpenTool(
  options: ReleaseEditOpenToolOptions,
): ReleaseEditOpenTool {
  const packageName = validateReleasePackageName(options?.packageName);
  const gateway = options?.gateway;
  const store = options?.store;
  const clock = options?.now ?? (() => new Date());
  if (
    !gateway ||
    typeof gateway.createEdit !== "function" ||
    typeof gateway.getEdit !== "function" ||
    typeof gateway.listTracks !== "function"
  ) {
    throw new ReleaseError("INVALID_ARGUMENT", "Release edit gateway is invalid.");
  }
  if (!store || typeof store.load !== "function" || typeof store.save !== "function") {
    throw new ReleaseError("INVALID_ARGUMENT", "Release edit session store is invalid.");
  }

  const description =
    "Open one new Google Play edit session for the bound package and track its edit id locally. DESTRUCTIVE: Google allows only one active edit per application and API user, so creating this edit may invalidate another edit that is currently open (including uncommitted work), and Play Console activity can invalidate edits too. It does NOT publish, commit, upload, or change any track. Requires explicit human approval. Refuses when a tracked unexpired session already exists.";
  const outputSchema = createOutputSchema(packageName);

  const tool: ToolDefinition<Record<string, never>, ReleaseEditOpenResult> = {
    name: RELEASES_OPEN_EDIT_TOOL_NAME,
    description,
    permission: "destructive",
    inputSchema,
    outputSchema,
    async execute() {
      // Re-check local state AFTER approval: an approval never overrides local
      // concurrency protection and is never an instruction to replace a session.
      const state = await loadReleaseEditSessionState(store, epochSecondsFromDate(clock));
      if (state.status === "active") {
        throw new ReleaseError(
          "EDIT_SESSION_ALREADY_OPEN",
          "A tracked Play edit session is already open for this package; use the existing session instead of creating another edit.",
        );
      }

      let edit;
      try {
        edit = parseGooglePlayEditSession(await gateway.createEdit(), packageName);
      } catch (cause) {
        // Malformed or failed mutation response: never retried, never compensated
        // by creating a second edit; the agent loop marks mutation state uncertain.
        throw asOpenError(cause);
      }

      const session = createReleaseEditSession(edit, clock().toISOString());
      try {
        await store.save(session);
      } catch (cause) {
        throw new ReleaseError(
          "EDIT_SESSION_WRITE_FAILED",
          "The Play edit was created but its local session could not be recorded; remote state may be uncertain.",
          { cause },
        );
      }
      return Object.freeze({ session });
    },
    async verify(_input, output) {
      const session = parseReleaseEditSession(output.session, packageName);
      let remote;
      try {
        remote = await gateway.getEdit(toGooglePlayEditSession(session));
      } catch {
        // A tracked edit that cannot be read back is not verified; the failure
        // itself is recorded by Phase 2.4 and never triggers another insert.
        return false;
      }
      if (!isRecord(remote) || remote.id !== session.editId) return false;
      if (typeof remote.expiryTimeSeconds !== "string") return false;
      try {
        if (compareEpochSeconds(remote.expiryTimeSeconds, session.expiryTimeSeconds) !== 0) {
          return false;
        }
      } catch {
        return false;
      }
      // Phase 4.2 acceptance requires the edit id to be tracked LOCALLY, so the
      // remote read-back alone is not sufficient evidence.
      let local;
      try {
        local = await store.load();
      } catch {
        return false;
      }
      if (!local) return false;
      return (
        local.packageName === session.packageName &&
        local.editId === session.editId &&
        local.expiryTimeSeconds === session.expiryTimeSeconds
      );
    },
  };

  const binding: AgentToolBinding = {
    toolName: RELEASES_OPEN_EDIT_TOOL_NAME,
    llm: {
      name: RELEASES_OPEN_EDIT_TOOL_NAME,
      description,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    approval: {
      createRequestDigest: () => createReleaseEditOpenDigest(packageName),
      createSafeSummary: () => createReleaseEditOpenSummary(packageName),
    },
    serializeResult(output: unknown, verification: VerificationResult): string {
      const result = outputSchema.parse(output);
      if (
        !verification ||
        verification.permission !== "destructive" ||
        verification.required !== true ||
        verification.verified !== true
      ) {
        throw new ReleaseError("EDIT_INVALID", "Play edit open was not verified.");
      }
      // No raw Google payload, credential, or approval material reaches the model.
      return JSON.stringify({
        tool: RELEASES_OPEN_EDIT_TOOL_NAME,
        packageName: result.session.packageName,
        editId: result.session.editId,
        expiryTimeSeconds: result.session.expiryTimeSeconds,
        published: false,
      });
    },
  };

  return Object.freeze({ tool, binding });
}

/**
 * Phase 4.11 Layer A — safe direct deployed-release summary inspection.
 *
 * Uses applications.tracks.releases.list only. This tool is read-only, does not
 * require approval, never creates an edit, and cannot prove TrackRelease.status,
 * userFraction, or releaseNotes because ReleaseSummary does not expose them.
 */
import type { NewAuditEntry } from "../audit/index.js";
import type { AgentToolBinding } from "../runtime/agent/index.js";
import type { ToolDefinition, ToolSchema } from "../runtime/tools/index.js";
import type { VerificationResult } from "../runtime/verification/index.js";
import { ReleaseError, validateReleasePackageName } from "./index.js";
import type { ReleaseSummaryGateway } from "./gateway.js";
import type { ReleaseVerificationIntent } from "./readback-approval.js";
import { inspectDirectReleaseSummary, type DirectReleaseSummaryEvidence } from "./readback.js";

export const RELEASES_INSPECT_COMMITTED_RELEASE_TOOL_NAME = "releases.inspect_committed_release";

export interface ReleaseSummaryInspectionAuditLedger {
  append(entry: NewAuditEntry): Promise<void>;
}

export interface ReleaseSummaryInspectionToolOptions {
  readonly packageName: string;
  readonly intent: ReleaseVerificationIntent;
  readonly gateway: ReleaseSummaryGateway;
  readonly auditLedger: ReleaseSummaryInspectionAuditLedger;
  readonly now?: () => Date;
}

export interface ReleaseSummaryInspectionTool {
  readonly tool: ToolDefinition<Record<string, never>, DirectReleaseSummaryEvidence>;
  readonly binding: AgentToolBinding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const inputSchema: ToolSchema<Record<string, never>> = {
  parse(value: unknown): Record<string, never> {
    if (!isRecord(value) || Object.keys(value).length !== 0) {
      throw new ReleaseError("INVALID_ARGUMENT", "Committed release summary input is invalid.");
    }
    return Object.freeze({});
  },
};

const outputSchema: ToolSchema<DirectReleaseSummaryEvidence> = {
  parse(value: unknown): DirectReleaseSummaryEvidence {
    if (!isRecord(value)) {
      throw new ReleaseError(
        "RELEASE_SUMMARY_RESPONSE_INVALID",
        "Release summary result is invalid.",
      );
    }
    const expectedKeys = [
      "exactTrackStateVerified",
      "releaseLifecycleState",
      "releaseName",
      "releaseObserved",
      "targetTrack",
      "versionCode",
    ];
    const keys = Object.keys(value).sort();
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index]) ||
      value.releaseObserved !== true ||
      value.exactTrackStateVerified !== false ||
      typeof value.targetTrack !== "string" ||
      typeof value.versionCode !== "string" ||
      typeof value.releaseName !== "string" ||
      typeof value.releaseLifecycleState !== "string"
    ) {
      throw new ReleaseError(
        "RELEASE_SUMMARY_RESPONSE_INVALID",
        "Release summary result is invalid.",
      );
    }
    return Object.freeze({
      targetTrack: value.targetTrack,
      versionCode: value.versionCode,
      releaseName: value.releaseName,
      releaseLifecycleState: value.releaseLifecycleState,
      releaseObserved: true,
      exactTrackStateVerified: false,
    });
  },
};

async function appendAudit(
  ledger: ReleaseSummaryInspectionAuditLedger,
  status: "success" | "failure",
  now: () => Date,
  metadata: Record<string, unknown>,
): Promise<void> {
  await ledger.append({
    type:
      status === "success"
        ? "release.readback.summary.completed"
        : "release.readback.summary.failed",
    actor: "agent",
    action: RELEASES_INSPECT_COMMITTED_RELEASE_TOOL_NAME,
    status,
    timestamp: now().toISOString(),
    metadata: {
      permission: "read",
      layer: "A",
      ...metadata,
    },
  });
}

function auditFailure(cause: unknown): ReleaseError {
  return new ReleaseError(
    "VERIFICATION_AUDIT_FAILED",
    "Release summary verification result could not be recorded safely in the audit log.",
    { cause, externalStateUncertain: false },
  );
}

export function createReleaseSummaryInspectionTool(
  options: ReleaseSummaryInspectionToolOptions,
): ReleaseSummaryInspectionTool {
  const packageName = validateReleasePackageName(options?.packageName);
  const intent = options?.intent;
  if (!intent || intent.packageName !== packageName) {
    throw new ReleaseError(
      "INVALID_COMMIT_INTENT",
      "Release summary intent package binding is invalid.",
    );
  }
  const gateway = options?.gateway;
  const auditLedger = options?.auditLedger;
  const clock = options?.now ?? (() => new Date());
  if (!gateway || typeof gateway.listReleaseSummaries !== "function") {
    throw new ReleaseError("INVALID_ARGUMENT", "Release summary gateway is invalid.");
  }
  if (!auditLedger || typeof auditLedger.append !== "function") {
    throw new ReleaseError("INVALID_ARGUMENT", "Release summary audit ledger is invalid.");
  }

  const description =
    "Read the current deployed release summary for the composition-bound app and track using applications.tracks.releases.list. Read-only: no approval, edit creation, track mutation, commit, or deletion. This proves release identity, active versionCode, and coarse lifecycle only; ReleaseSummary does not prove exact TrackRelease status, rollout fraction, halt state, or release notes.";

  const tool: ToolDefinition<Record<string, never>, DirectReleaseSummaryEvidence> = {
    name: RELEASES_INSPECT_COMMITTED_RELEASE_TOOL_NAME,
    description,
    permission: "read",
    inputSchema,
    outputSchema,
    async execute(input) {
      inputSchema.parse(input);
      try {
        const result = await inspectDirectReleaseSummary(gateway, intent);
        try {
          await appendAudit(auditLedger, "success", clock, {
            targetTrack: result.targetTrack,
            versionCode: result.versionCode,
            releaseName: result.releaseName,
            releaseLifecycleState: result.releaseLifecycleState,
            releaseObserved: true,
            exactTrackStateVerified: false,
          });
        } catch (cause) {
          throw auditFailure(cause);
        }
        return result;
      } catch (cause) {
        const mapped =
          cause instanceof ReleaseError
            ? cause
            : new ReleaseError(
                "RELEASE_SUMMARY_READ_FAILED",
                "The direct deployed-release summary could not be read.",
                { cause, externalStateUncertain: false },
              );
        try {
          await appendAudit(auditLedger, "failure", clock, {
            targetTrack: intent.targetTrack,
            versionCode: intent.versionCode,
            releaseName: intent.expectedReleaseName,
            releaseObserved: false,
            exactTrackStateVerified: false,
            errorCode: mapped.code,
            externalStateUncertain: mapped.externalStateUncertain === true,
          });
        } catch (auditCause) {
          throw auditFailure(auditCause);
        }
        throw mapped;
      }
    },
  };

  const binding: AgentToolBinding = {
    toolName: RELEASES_INSPECT_COMMITTED_RELEASE_TOOL_NAME,
    llm: {
      name: RELEASES_INSPECT_COMMITTED_RELEASE_TOOL_NAME,
      description,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    serializeResult(output: unknown, verification: VerificationResult): string {
      if (
        verification.toolName !== RELEASES_INSPECT_COMMITTED_RELEASE_TOOL_NAME ||
        verification.permission !== "read"
      ) {
        throw new ReleaseError(
          "RELEASE_SUMMARY_RESPONSE_INVALID",
          "Release summary read was not safe.",
        );
      }
      const result = outputSchema.parse(output);
      return JSON.stringify(result);
    },
  };
  return Object.freeze({ tool, binding });
}

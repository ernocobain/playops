/**
 * Phase 4.14 — pure, shared Release Agent dry-run planning.
 *
 * This module has no Publisher, credential, network, browser, approval, audit,
 * or session-store dependency. It describes the same trusted operation intents
 * used by real Release Agent tools without executing any tool or API call.
 */
import {
  normalizeReleaseBundle,
  normalizeReleaseVersionCode,
  validateReleasePackageName,
  validateReleaseTargetTrack,
  type ReleaseBundle,
  type ReleaseState,
  type ReleaseTrackState,
} from "./index.js";
import type { ReleaseBundleUploadToolOptions } from "./bundle-upload-tool.js";
import type { ReleaseConfigureReleaseToolOptions } from "./configure-release-tool.js";
import type { ReleaseNotesAttachmentToolOptions } from "./release-notes-tool.js";
import { normalizeReleaseNotesIntent } from "./release-notes-tool.js";
import type { ReleaseCommitIntent } from "./commit-approval.js";
import type { ReleaseVerificationIntent } from "./readback-approval.js";
import type { ReleaseRolloutIntent } from "./rollout-approval.js";
import type { ReleaseStatusControlIntent } from "./status-control-approval.js";

export const MUTATING_RELEASE_TOOL_NAMES = Object.freeze([
  "releases.open_edit",
  "releases.upload_bundle",
  "releases.configure_release",
  "releases.attach_release_notes",
  "releases.commit_edit",
  "releases.verify_committed_release",
  "releases.update_rollout_fraction",
  "releases.halt_rollout",
  "releases.resume_rollout",
  "releases.cleanup_known_edit",
] as const);

export type MutatingReleaseToolName = (typeof MUTATING_RELEASE_TOOL_NAMES)[number];

export interface DryRunResultReference {
  readonly kind: "result";
  readonly step: number;
  readonly field: string;
  readonly label: string;
}

export interface DryRunSymbolicReference {
  readonly kind: "symbolic";
  readonly ref: string;
  readonly label: string;
}

export type DryRunValue =
  | null
  | boolean
  | number
  | string
  | DryRunResultReference
  | DryRunSymbolicReference
  | readonly DryRunValue[]
  | { readonly [key: string]: DryRunValue };

export interface PlannedApiCall {
  readonly sequence: number;
  readonly operation: string;
  readonly httpMethod: "GET" | "POST" | "PUT" | "DELETE";
  readonly resource: string;
  readonly pathParams: Readonly<Record<string, DryRunValue>>;
  readonly query?: Readonly<Record<string, DryRunValue>>;
  readonly bodyShape?: DryRunValue;
  readonly media?: Readonly<Record<string, DryRunValue>>;
  readonly retryPolicy: "bounded-read" | "retry:false";
  readonly mutation: boolean;
  readonly condition?: string;
  readonly resultBinding?: DryRunResultReference;
}

export interface PlannedLocalAction {
  readonly sequence: number;
  readonly action: string;
  readonly condition?: string;
}

export interface DryRunExecutionEvidence {
  readonly apiCalls: 0;
  readonly networkCalls: 0;
  readonly browserCalls: 0;
  readonly approvalRequests: 0;
  readonly approvalTokensConsumed: 0;
  readonly sessionSaves: 0;
  readonly sessionClears: 0;
  readonly auditWrites: 0;
}

export interface ReleaseDryRunPlan {
  readonly version: 1;
  readonly toolName: MutatingReleaseToolName;
  readonly realPermission: "write" | "destructive" | "publish";
  readonly approvalRequiredForRealRun: boolean;
  readonly apiCalls: readonly PlannedApiCall[];
  readonly localActions: readonly PlannedLocalAction[];
  readonly remotePreconditions: readonly string[];
  readonly sideEffectsExecuted: false;
  readonly executionEvidence: DryRunExecutionEvidence;
}

export type ReleaseDryRunRequest =
  | { readonly kind: "open_edit"; readonly packageName: string }
  | ({ readonly kind: "upload_bundle" } & Pick<
      ReleaseBundleUploadToolOptions,
      "packageName" | "artifactPath"
    >)
  | ({ readonly kind: "configure_release" } & Pick<
      ReleaseConfigureReleaseToolOptions,
      | "packageName"
      | "targetTrack"
      | "releaseName"
      | "releaseStatus"
      | "initialRolloutFraction"
      | "uploadedBundle"
      | "retainVersionCodes"
    >)
  | ({ readonly kind: "attach_release_notes" } & Pick<
      ReleaseNotesAttachmentToolOptions,
      | "packageName"
      | "targetTrack"
      | "configuredRelease"
      | "uploadedBundle"
      | "localizedReleaseNotes"
    >)
  | { readonly kind: "commit_edit"; readonly intent: ReleaseCommitIntent }
  | { readonly kind: "verify_committed_release"; readonly intent: ReleaseVerificationIntent }
  | { readonly kind: "update_rollout_fraction"; readonly intent: ReleaseRolloutIntent }
  | { readonly kind: "halt_rollout"; readonly intent: ReleaseStatusControlIntent }
  | { readonly kind: "resume_rollout"; readonly intent: ReleaseStatusControlIntent }
  | {
      readonly kind: "cleanup_known_edit";
      readonly packageName: string;
      readonly candidate: {
        readonly recordSource: "managed_session" | "cleanup_journal";
        readonly editId: string;
        readonly expiryTimeSeconds: string;
      };
    };

const executionEvidence: DryRunExecutionEvidence = Object.freeze({
  apiCalls: 0,
  networkCalls: 0,
  browserCalls: 0,
  approvalRequests: 0,
  approvalTokensConsumed: 0,
  sessionSaves: 0,
  sessionClears: 0,
  auditWrites: 0,
});

function result(step: number, field: string, label: string): DryRunResultReference {
  return Object.freeze({ kind: "result", step, field, label });
}

function symbolic(ref: string, label: string): DryRunSymbolicReference {
  return Object.freeze({ kind: "symbolic", ref, label });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function safeNoteShape(
  notes: readonly { readonly language: string; readonly text: string }[] | undefined,
): DryRunValue {
  if (notes === undefined) return "<absent>";
  return notes.map((note) => ({
    language: note.language,
    text: "<operator-bound text redacted>",
    codePoints: Array.from(note.text).length,
  }));
}

function safeReleaseShape(
  release: ReleaseState,
  overrides: Partial<Pick<ReleaseState, "status" | "userFraction">> = {},
): DryRunValue {
  return {
    ...(release.name !== undefined ? { name: release.name } : {}),
    versionCodes: [...release.versionCodes],
    status: overrides.status ?? release.status,
    ...(overrides.userFraction !== undefined
      ? { userFraction: overrides.userFraction }
      : release.userFraction !== undefined
        ? { userFraction: release.userFraction }
        : {}),
    releaseNotes: safeNoteShape(release.releaseNotes),
    ...(release.countryTargeting !== undefined
      ? {
          countryTargeting: {
            countries: [...release.countryTargeting.countries],
            includeRestOfWorld: release.countryTargeting.includeRestOfWorld,
          },
        }
      : {}),
    ...(release.inAppUpdatePriority !== undefined
      ? { inAppUpdatePriority: release.inAppUpdatePriority }
      : {}),
  };
}

function safeTrackShape(
  track: ReleaseTrackState,
  targetVersionCode?: string,
  targetOverrides?: Partial<Pick<ReleaseState, "status" | "userFraction">>,
): DryRunValue {
  return {
    track: track.track,
    releases: track.releases.map((release) =>
      targetVersionCode !== undefined && release.versionCodes.includes(targetVersionCode)
        ? safeReleaseShape(release, targetOverrides)
        : safeReleaseShape(release),
    ),
  };
}

function addCall(calls: PlannedApiCall[], input: Omit<PlannedApiCall, "sequence">): number {
  const sequence = calls.length + 1;
  calls.push({ sequence, ...input });
  return sequence;
}

function addLocal(actions: PlannedLocalAction[], action: string, condition?: string): void {
  actions.push({ sequence: actions.length + 1, action, ...(condition ? { condition } : {}) });
}

function basePlan(
  toolName: MutatingReleaseToolName,
  realPermission: "write" | "destructive" | "publish",
  apiCalls: PlannedApiCall[],
  localActions: PlannedLocalAction[],
  remotePreconditions: string[],
): ReleaseDryRunPlan {
  return deepFreeze({
    version: 1 as const,
    toolName,
    realPermission,
    approvalRequiredForRealRun: realPermission === "destructive" || realPermission === "publish",
    apiCalls: [...apiCalls],
    localActions: [...localActions],
    remotePreconditions: [...remotePreconditions],
    sideEffectsExecuted: false as const,
    executionEvidence,
  });
}

function planOpenEdit(
  request: Extract<ReleaseDryRunRequest, { kind: "open_edit" }>,
): ReleaseDryRunPlan {
  const packageName = validateReleasePackageName(request.packageName);
  const calls: PlannedApiCall[] = [];
  const locals: PlannedLocalAction[] = [];
  addLocal(locals, "read the trusted local managed-session state; do not save or clear it");
  addCall(calls, {
    operation: "edits.insert",
    httpMethod: "POST",
    resource: "/androidpublisher/v3/applications/{packageName}/edits",
    pathParams: { packageName },
    bodyShape: { kind: "empty" },
    retryPolicy: "retry:false",
    mutation: true,
    resultBinding: result(1, "id", "operational edit"),
  });
  return basePlan("releases.open_edit", "destructive", calls, locals, [
    "the local managed session is empty",
    "the real run would require explicit destructive human approval",
    "Google may invalidate another active edit owned by the same API user",
  ]);
}

function managedEditRef(): DryRunSymbolicReference {
  return symbolic("managedSession.editId", "managed edit id");
}

function planUpload(
  request: Extract<ReleaseDryRunRequest, { kind: "upload_bundle" }>,
): ReleaseDryRunPlan {
  const packageName = validateReleasePackageName(request.packageName);
  const calls: PlannedApiCall[] = [];
  const locals: PlannedLocalAction[] = [];
  const editId = managedEditRef();
  addLocal(
    locals,
    "validate and hash the operator-bound existing .aab locally; path and bytes are omitted",
  );
  addCall(calls, {
    operation: "edits.get",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}",
    pathParams: { packageName, editId },
    retryPolicy: "bounded-read",
    mutation: false,
  });
  addCall(calls, {
    operation: "edits.bundles.upload",
    httpMethod: "POST",
    resource: "/upload/androidpublisher/v3/applications/{packageName}/edits/{editId}/bundles",
    pathParams: { packageName, editId },
    bodyShape: { kind: "media-upload", fields: "no JSON request body" },
    media: {
      contentType: "application/octet-stream",
      source: "operator-bound existing .aab",
      pathShown: false,
      bytesShown: false,
      timeoutMs: 120000,
    },
    retryPolicy: "retry:false",
    mutation: true,
    resultBinding: result(2, "versionCode", "uploaded bundle"),
  });
  addCall(calls, {
    operation: "edits.bundles.list",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}/bundles",
    pathParams: { packageName, editId },
    retryPolicy: "bounded-read",
    mutation: false,
    resultBinding: result(3, "bundles", "verified bundle list"),
  });
  return basePlan("releases.upload_bundle", "write", calls, locals, [
    "a valid non-expired managed edit exists",
    "the exact operator-bound artifact is readable and remains unchanged",
    "the upload response and bundles.list read-back match the local artifact identity",
  ]);
}

function canonicalVersionCodes(
  bundle: ReleaseBundle,
  retained: readonly string[] | undefined,
): readonly string[] {
  const codes = [
    ...new Set([
      bundle.versionCode,
      ...(retained ?? []).map((code) => normalizeReleaseVersionCode(code)),
    ]),
  ];
  codes.sort((left, right) =>
    BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0,
  );
  return codes;
}

function planConfigure(
  request: Extract<ReleaseDryRunRequest, { kind: "configure_release" }>,
): ReleaseDryRunPlan {
  const packageName = validateReleasePackageName(request.packageName);
  const targetTrack = validateReleaseTargetTrack(request.targetTrack);
  const bundle = normalizeReleaseBundle(request.uploadedBundle);
  const versionCodes = canonicalVersionCodes(bundle, request.retainVersionCodes);
  const editId = managedEditRef();
  const calls: PlannedApiCall[] = [];
  const locals: PlannedLocalAction[] = [];
  addLocal(
    locals,
    "read-only validate the composition-bound release intent and retained version codes",
  );
  addCall(calls, {
    operation: "edits.get",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}",
    pathParams: { packageName, editId },
    retryPolicy: "bounded-read",
    mutation: false,
  });
  addCall(calls, {
    operation: "edits.bundles.list",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}/bundles",
    pathParams: { packageName, editId },
    retryPolicy: "bounded-read",
    mutation: false,
  });
  addCall(calls, {
    operation: "edits.tracks.get",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}/tracks/{track}",
    pathParams: { packageName, editId, track: targetTrack },
    retryPolicy: "bounded-read",
    mutation: false,
  });
  const body: Record<string, DryRunValue> = {
    track: targetTrack,
    releases: [
      {
        name: request.releaseName.trim(),
        versionCodes: [...versionCodes],
        status: request.releaseStatus,
        ...(request.initialRolloutFraction !== undefined
          ? { userFraction: request.initialRolloutFraction }
          : {}),
      },
    ],
    omittedFields: ["releaseNotes", "countryTargeting", "inAppUpdatePriority"],
  };
  addCall(calls, {
    operation: "edits.tracks.update",
    httpMethod: "PUT",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}/tracks/{track}",
    pathParams: { packageName, editId, track: targetTrack },
    bodyShape: body,
    retryPolicy: "retry:false",
    mutation: true,
  });
  addCall(calls, {
    operation: "edits.tracks.get",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}/tracks/{track}",
    pathParams: { packageName, editId, track: targetTrack },
    retryPolicy: "bounded-read",
    mutation: false,
    resultBinding: result(5, "track", "configured track read-back"),
  });
  return basePlan("releases.configure_release", "write", calls, locals, [
    "a valid non-expired managed edit exists",
    "the exact uploaded bundle is present in the edit",
    "the uploaded versionCode is greater than the fresh target-track maximum",
    "the fresh track has no outstanding draft, inProgress, or halted release",
    "the real run's fresh read-back must match the configured release exactly",
  ]);
}

function planNotes(
  request: Extract<ReleaseDryRunRequest, { kind: "attach_release_notes" }>,
): ReleaseDryRunPlan {
  const packageName = validateReleasePackageName(request.packageName);
  const targetTrack = validateReleaseTargetTrack(request.targetTrack);
  const bundle = normalizeReleaseBundle(request.uploadedBundle);
  const notes = normalizeReleaseNotesIntent(request.localizedReleaseNotes);
  const editId = managedEditRef();
  const calls: PlannedApiCall[] = [];
  const locals: PlannedLocalAction[] = [];
  addLocal(
    locals,
    "validate/canonicalize operator-bound BCP-47 notes locally; text remains redacted in the plan",
  );
  addCall(calls, {
    operation: "edits.get",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}",
    pathParams: { packageName, editId },
    retryPolicy: "bounded-read",
    mutation: false,
  });
  addCall(calls, {
    operation: "edits.bundles.list",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}/bundles",
    pathParams: { packageName, editId },
    retryPolicy: "bounded-read",
    mutation: false,
  });
  addCall(calls, {
    operation: "edits.tracks.get",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}/tracks/{track}",
    pathParams: { packageName, editId, track: targetTrack },
    retryPolicy: "bounded-read",
    mutation: false,
  });
  addCall(calls, {
    operation: "edits.tracks.update",
    httpMethod: "PUT",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}/tracks/{track}",
    pathParams: { packageName, editId, track: targetTrack },
    bodyShape: {
      track: targetTrack,
      releases: "<fresh normalized active releases in original order>",
      targetRelease: {
        versionCode: bundle.versionCode,
        onlyIntendedDifference: "releaseNotes",
        releaseNotes: safeNoteShape(notes),
      },
    },
    retryPolicy: "retry:false",
    mutation: true,
  });
  addCall(calls, {
    operation: "edits.tracks.get",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}/tracks/{track}",
    pathParams: { packageName, editId, track: targetTrack },
    retryPolicy: "bounded-read",
    mutation: false,
    resultBinding: result(5, "track", "release-notes read-back"),
  });
  return basePlan("releases.attach_release_notes", "write", calls, locals, [
    "a valid non-expired managed edit exists",
    "the exact configured release and uploaded bundle identity are present",
    "only the target release's releaseNotes differ in the desired Track",
  ]);
}

function planCommit(
  request: Extract<ReleaseDryRunRequest, { kind: "commit_edit" }>,
): ReleaseDryRunPlan {
  const intent = request.intent;
  const packageName = validateReleasePackageName(intent.packageName);
  const editId = managedEditRef();
  const calls: PlannedApiCall[] = [];
  const locals: PlannedLocalAction[] = [];
  addLocal(
    locals,
    "read-only compare the managed session, approved state digest, and validation evidence",
  );
  addCall(calls, {
    operation: "edits.get",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}",
    pathParams: { packageName, editId },
    retryPolicy: "bounded-read",
    mutation: false,
  });
  addCall(calls, {
    operation: "edits.tracks.get",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}/tracks/{track}",
    pathParams: { packageName, editId, track: intent.targetTrack },
    retryPolicy: "bounded-read",
    mutation: false,
  });
  addCall(calls, {
    operation: "edits.validate",
    httpMethod: "POST",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}:validate",
    pathParams: { packageName, editId },
    bodyShape: { kind: "empty" },
    retryPolicy: "bounded-read",
    mutation: false,
  });
  addCall(calls, {
    operation: "edits.commit",
    httpMethod: "POST",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}:commit",
    pathParams: { packageName, editId },
    query: { changesInReviewBehavior: "ERROR_IF_IN_REVIEW", changesNotSentForReview: false },
    bodyShape: { kind: "empty" },
    retryPolicy: "retry:false",
    mutation: true,
  });
  addLocal(locals, "clear managed session after confirmed commit and read it back empty");
  return basePlan("releases.commit_edit", "publish", calls, locals, [
    "the real run would require exact publish approval",
    "the managed edit still matches the approved edit/state/validation intent",
    "edits.validate succeeds immediately before commit",
  ]);
}

function planVerify(
  request: Extract<ReleaseDryRunRequest, { kind: "verify_committed_release" }>,
): ReleaseDryRunPlan {
  const intent = request.intent;
  const packageName = validateReleasePackageName(intent.packageName);
  const calls: PlannedApiCall[] = [];
  const locals: PlannedLocalAction[] = [];
  const summary = addCall(calls, {
    operation: "applications.tracks.releases.list",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/tracks/{track}/releases",
    pathParams: { packageName, track: intent.targetTrack },
    retryPolicy: "bounded-read",
    mutation: false,
    resultBinding: result(1, "release", "direct release summary"),
  });
  const insert = addCall(calls, {
    operation: "edits.insert",
    httpMethod: "POST",
    resource: "/androidpublisher/v3/applications/{packageName}/edits",
    pathParams: { packageName },
    bodyShape: { kind: "empty" },
    retryPolicy: "retry:false",
    mutation: true,
    condition: "only if the expected release is observed and the local managed session is empty",
    resultBinding: result(2, "id", "temporary verification edit"),
  });
  addCall(calls, {
    operation: "edits.tracks.get",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}/tracks/{track}",
    pathParams: {
      packageName,
      editId: result(insert, "id", "temporary verification edit"),
      track: intent.targetTrack,
    },
    retryPolicy: "bounded-read",
    mutation: false,
    condition: "only if the direct release summary observed the expected release",
  });
  addCall(calls, {
    operation: "edits.delete",
    httpMethod: "DELETE",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}",
    pathParams: { packageName, editId: result(insert, "id", "temporary verification edit") },
    retryPolicy: "retry:false",
    mutation: true,
    condition: "after a trustworthy temporary edit is created and exact read-back completes",
  });
  void summary;
  addLocal(
    locals,
    "do not persist the temporary verification edit in the normal managed session store",
  );
  return basePlan("releases.verify_committed_release", "destructive", calls, locals, [
    "the real run would require separate destructive verification approval",
    "direct ReleaseSummary observes exactly one expected release",
    "the local managed session is empty before temporary edit creation",
  ]);
}

function planRollout(
  request: Extract<ReleaseDryRunRequest, { kind: "update_rollout_fraction" }>,
): ReleaseDryRunPlan {
  const intent = request.intent;
  const packageName = validateReleasePackageName(intent.packageName);
  const editId = symbolic("operationalEdit.id", "operational edit id");
  const calls: PlannedApiCall[] = [];
  const locals: PlannedLocalAction[] = [];
  addCall(calls, {
    operation: "applications.tracks.releases.list",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/tracks/{track}/releases",
    pathParams: { packageName, track: intent.targetTrack },
    retryPolicy: "bounded-read",
    mutation: false,
    resultBinding: result(1, "release", "direct release summary"),
  });
  addCall(calls, {
    operation: "edits.insert",
    httpMethod: "POST",
    resource: "/androidpublisher/v3/applications/{packageName}/edits",
    pathParams: { packageName },
    bodyShape: { kind: "empty" },
    retryPolicy: "retry:false",
    mutation: true,
    condition: "only if the expected release is observed and all preconditions pass",
    resultBinding: result(2, "id", "operational edit"),
  });
  addCall(calls, {
    operation: "edits.get",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}",
    pathParams: { packageName, editId },
    retryPolicy: "bounded-read",
    mutation: false,
    condition: "after operational edit creation",
  });
  addCall(calls, {
    operation: "edits.tracks.get",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}/tracks/{track}",
    pathParams: { packageName, editId, track: intent.targetTrack },
    retryPolicy: "bounded-read",
    mutation: false,
  });
  addCall(calls, {
    operation: "edits.tracks.update",
    httpMethod: "PUT",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}/tracks/{track}",
    pathParams: { packageName, editId, track: intent.targetTrack },
    bodyShape: {
      track: intent.targetTrack,
      releases: safeTrackShape(intent.expectedTrackState, intent.versionCode, {
        userFraction: intent.newFraction,
      }),
      onlyIntendedDifference: "target release userFraction",
      currentFraction: intent.previousFraction,
      requestedFraction: intent.newFraction,
    },
    retryPolicy: "retry:false",
    mutation: true,
  });
  addCall(calls, {
    operation: "edits.tracks.get",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}/tracks/{track}",
    pathParams: { packageName, editId, track: intent.targetTrack },
    retryPolicy: "bounded-read",
    mutation: false,
    resultBinding: result(6, "track", "pre-commit track read-back"),
  });
  addCall(calls, {
    operation: "edits.validate",
    httpMethod: "POST",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}:validate",
    pathParams: { packageName, editId },
    bodyShape: { kind: "empty" },
    retryPolicy: "bounded-read",
    mutation: false,
  });
  addCall(calls, {
    operation: "edits.commit",
    httpMethod: "POST",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}:commit",
    pathParams: { packageName, editId },
    query: { changesInReviewBehavior: "ERROR_IF_IN_REVIEW", changesNotSentForReview: false },
    bodyShape: { kind: "empty" },
    retryPolicy: "retry:false",
    mutation: true,
  });
  addCall(calls, {
    operation: "applications.tracks.releases.list",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/tracks/{track}/releases",
    pathParams: { packageName, track: intent.targetTrack },
    retryPolicy: "bounded-read",
    mutation: false,
    condition: "after confirmed commit",
  });
  const verifyInsert = addCall(calls, {
    operation: "edits.insert",
    httpMethod: "POST",
    resource: "/androidpublisher/v3/applications/{packageName}/edits",
    pathParams: { packageName },
    bodyShape: { kind: "empty" },
    retryPolicy: "retry:false",
    mutation: true,
    condition: "only if the post-commit direct summary observes the expected release",
    resultBinding: result(10, "id", "temporary verification edit"),
  });
  addCall(calls, {
    operation: "edits.tracks.get",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}/tracks/{track}",
    pathParams: {
      packageName,
      editId: result(verifyInsert, "id", "temporary verification edit"),
      track: intent.targetTrack,
    },
    retryPolicy: "bounded-read",
    mutation: false,
    condition: "only if post-commit direct observation succeeds",
  });
  addCall(calls, {
    operation: "edits.delete",
    httpMethod: "DELETE",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}",
    pathParams: { packageName, editId: result(verifyInsert, "id", "temporary verification edit") },
    retryPolicy: "retry:false",
    mutation: true,
    condition: "after trustworthy temporary verification edit cleanup",
  });
  addLocal(
    locals,
    "persist operational edit state during the real run only",
    "not executed in dry-run",
  );
  addLocal(locals, "clear managed session after confirmed commit", "not executed in dry-run");
  return basePlan("releases.update_rollout_fraction", "destructive", calls, locals, [
    "the real run would require exact increase-fraction approval",
    "newFraction > currentFraction",
    "0 < currentFraction < requestedFraction < 1",
    "the expected inProgress release and full Track state are still current",
    "the local managed session is empty before operational edit creation",
  ]);
}

function planStatus(
  request: Extract<ReleaseDryRunRequest, { kind: "halt_rollout" | "resume_rollout" }>,
): ReleaseDryRunPlan {
  const intent = request.intent;
  const packageName = validateReleasePackageName(intent.packageName);
  const editId = symbolic("operationalEdit.id", "operational edit id");
  const calls: PlannedApiCall[] = [];
  const locals: PlannedLocalAction[] = [];
  addCall(calls, {
    operation: "applications.tracks.releases.list",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/tracks/{track}/releases",
    pathParams: { packageName, track: intent.targetTrack },
    retryPolicy: "bounded-read",
    mutation: false,
    resultBinding: result(1, "release", "direct release summary"),
  });
  addCall(calls, {
    operation: "edits.insert",
    httpMethod: "POST",
    resource: "/androidpublisher/v3/applications/{packageName}/edits",
    pathParams: { packageName },
    bodyShape: { kind: "empty" },
    retryPolicy: "retry:false",
    mutation: true,
    condition: "only if the expected release is observed and all preconditions pass",
    resultBinding: result(2, "id", "operational edit"),
  });
  addCall(calls, {
    operation: "edits.get",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}",
    pathParams: { packageName, editId },
    retryPolicy: "bounded-read",
    mutation: false,
    condition: "after operational edit creation",
  });
  addCall(calls, {
    operation: "edits.tracks.get",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}/tracks/{track}",
    pathParams: { packageName, editId, track: intent.targetTrack },
    retryPolicy: "bounded-read",
    mutation: false,
  });
  addCall(calls, {
    operation: "edits.tracks.update",
    httpMethod: "PUT",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}/tracks/{track}",
    pathParams: { packageName, editId, track: intent.targetTrack },
    bodyShape: {
      track: intent.targetTrack,
      releases: safeTrackShape(intent.expectedTrackState, intent.versionCode, {
        status: intent.desiredStatus,
        userFraction: intent.expectedUserFraction,
      }),
      onlyIntendedDifference: "target release status",
      previousStatus: intent.expectedCurrentStatus,
      desiredStatus: intent.desiredStatus,
      userFraction: intent.expectedUserFraction,
    },
    retryPolicy: "retry:false",
    mutation: true,
  });
  addCall(calls, {
    operation: "edits.tracks.get",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}/tracks/{track}",
    pathParams: { packageName, editId, track: intent.targetTrack },
    retryPolicy: "bounded-read",
    mutation: false,
    resultBinding: result(6, "track", "pre-commit track read-back"),
  });
  addCall(calls, {
    operation: "edits.validate",
    httpMethod: "POST",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}:validate",
    pathParams: { packageName, editId },
    bodyShape: { kind: "empty" },
    retryPolicy: "bounded-read",
    mutation: false,
  });
  addCall(calls, {
    operation: "edits.commit",
    httpMethod: "POST",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}:commit",
    pathParams: { packageName, editId },
    query: { changesInReviewBehavior: "ERROR_IF_IN_REVIEW", changesNotSentForReview: false },
    bodyShape: { kind: "empty" },
    retryPolicy: "retry:false",
    mutation: true,
  });
  addCall(calls, {
    operation: "applications.tracks.releases.list",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/tracks/{track}/releases",
    pathParams: { packageName, track: intent.targetTrack },
    retryPolicy: "bounded-read",
    mutation: false,
    condition: "after confirmed commit",
  });
  const verificationInsert = addCall(calls, {
    operation: "edits.insert",
    httpMethod: "POST",
    resource: "/androidpublisher/v3/applications/{packageName}/edits",
    pathParams: { packageName },
    bodyShape: { kind: "empty" },
    retryPolicy: "retry:false",
    mutation: true,
    condition: "only if the post-commit direct summary observes the expected release",
    resultBinding: result(10, "id", "temporary verification edit"),
  });
  addCall(calls, {
    operation: "edits.tracks.get",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}/tracks/{track}",
    pathParams: {
      packageName,
      editId: result(verificationInsert, "id", "temporary verification edit"),
      track: intent.targetTrack,
    },
    retryPolicy: "bounded-read",
    mutation: false,
    condition: "only if post-commit direct observation succeeds",
  });
  addCall(calls, {
    operation: "edits.delete",
    httpMethod: "DELETE",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}",
    pathParams: {
      packageName,
      editId: result(verificationInsert, "id", "temporary verification edit"),
    },
    retryPolicy: "retry:false",
    mutation: true,
    condition: "after trustworthy temporary verification edit cleanup",
  });
  addLocal(
    locals,
    "persist and clear the normal managed operational session in a real run only",
    "not executed in dry-run",
  );
  const isHalt = request.kind === "halt_rollout";
  return basePlan(
    isHalt ? "releases.halt_rollout" : "releases.resume_rollout",
    "destructive",
    calls,
    locals,
    [
      "the real run would require separate status-control approval",
      `${intent.expectedCurrentStatus} is the fresh current status and ${intent.desiredStatus} is the only intended status change`,
      "userFraction remains unchanged exactly",
      "countryTargeting must be safely round-trippable for the desired status",
      "the local managed session is empty before operational edit creation",
    ],
  );
}

/**
 * Phase 4.15: exact known-record abandonment. The plan describes the real
 * verified path: a fresh exact state check, a conditional single retry-disabled
 * `edits.delete`, a post-delete exact `edits.get`, the narrow contextual
 * inactive verdict, and a conditional local reconciliation. Nothing here is
 * executed in dry-run.
 */
function planCleanupKnownEdit(
  request: Extract<ReleaseDryRunRequest, { kind: "cleanup_known_edit" }>,
): ReleaseDryRunPlan {
  const packageName = validateReleasePackageName(request.packageName);
  const candidate = request.candidate;
  const boundRecord = symbolic("boundRecord.id", "exact bound known edit id");
  const calls: PlannedApiCall[] = [];
  const locals: PlannedLocalAction[] = [];
  addLocal(
    locals,
    `read and validate the exact bound local ${
      candidate.recordSource === "managed_session"
        ? "managed edit session record"
        : "cleanup-journal entry"
    }; the candidate is composition-bound and never model-selected`,
  );
  addLocal(
    locals,
    "when trusted local expiry already proves the edit inactive: remove ONLY the exact bound local record and read that local state back to confirm removal, with no Google call at all",
    "now >= expiryTimeSeconds",
  );
  addCall(calls, {
    operation: "edits.get",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}",
    pathParams: { packageName, editId: boundRecord },
    retryPolicy: "bounded-read",
    mutation: false,
    condition:
      "only when trusted local expiry does not already prove the edit inactive (now < expiryTimeSeconds)",
  });
  addLocal(
    locals,
    "when that pre-delete read fails, or returns a different edit identity or expiry: report, retain the exact bound record, and issue no delete",
    "pre-delete read is not a confirmed exact-identity match",
  );
  addCall(calls, {
    operation: "edits.delete",
    httpMethod: "DELETE",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}",
    pathParams: { packageName, editId: boundRecord },
    retryPolicy: "retry:false",
    mutation: true,
    condition:
      "only after the exact pre-delete read confirmed the approved active edit; exactly ONE attempt with retries disabled",
  });
  addCall(calls, {
    operation: "edits.get",
    httpMethod: "GET",
    resource: "/androidpublisher/v3/applications/{packageName}/edits/{editId}",
    pathParams: { packageName, editId: boundRecord },
    retryPolicy: "bounded-read",
    mutation: false,
    condition:
      "post-delete verification of the SAME exact identity, and only when the delete was acknowledged",
  });
  addLocal(
    locals,
    "narrow contextual verification: treat the edit as verified inactive ONLY when the same package and exact edit identity was read successfully before the delete, the delete was acknowledged with exactly one retry-disabled attempt, and the post-delete read of that same identity failed with HTTP 400 plus Google status FAILED_PRECONDITION and reason failedPrecondition",
    "complete confirmed-delete context",
  );
  addLocal(
    locals,
    "only for that verified verdict: remove ONLY the exact bound local record and read that local state back to confirm removal",
    "verified post-delete inactivity",
  );
  addLocal(
    locals,
    "for every other outcome (edit not confirmed active, delete not acknowledged, or inactivity unverified): report, retain the exact bound record, attempt no second delete, and clear nothing",
    "otherwise",
  );
  return basePlan("releases.cleanup_known_edit", "destructive", calls, locals, [
    "the real run would require separate destructive cleanup approval bound to the exact known record",
    "the bound local record still exists and matches the approved identity exactly",
    "trusted local expiry alone proves inactivity for the local-expiry path",
    "a remote delete is verified as inactive ONLY by the complete confirmed-delete context, never by HTTP 400, FAILED_PRECONDITION, or failedPrecondition alone",
  ]);
}

export function createReleaseDryRunPlan(request: ReleaseDryRunRequest): ReleaseDryRunPlan {
  switch (request.kind) {
    case "open_edit":
      return planOpenEdit(request);
    case "upload_bundle":
      return planUpload(request);
    case "configure_release":
      return planConfigure(request);
    case "attach_release_notes":
      return planNotes(request);
    case "commit_edit":
      return planCommit(request);
    case "verify_committed_release":
      return planVerify(request);
    case "update_rollout_fraction":
      return planRollout(request);
    case "halt_rollout":
    case "resume_rollout":
      return planStatus(request);
    case "cleanup_known_edit":
      return planCleanupKnownEdit(request);
  }
}

function formatValue(value: DryRunValue, indent = 0): string {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "kind" in value &&
    (value.kind === "result" || value.kind === "symbolic")
  ) {
    if (value.kind === "result") return `<step ${value.step}: ${value.field}>`;
    return `<${value.label}>`;
  }
  return JSON.stringify(value, null, indent) ?? "null";
}

export function renderReleaseDryRunPlan(plan: ReleaseDryRunPlan): string {
  const lines = [
    "DRY RUN — NO API CALLS EXECUTED",
    "",
    `Tool: ${plan.toolName}`,
    `Real permission: ${plan.realPermission}`,
    `Approval required for real run: ${plan.approvalRequiredForRealRun ? "yes" : "no"}`,
    `Side effects executed: ${plan.sideEffectsExecuted ? "yes" : "no"}`,
    "",
    "Planned API calls:",
  ];
  for (const call of plan.apiCalls) {
    lines.push(`${call.sequence}. ${call.httpMethod} ${call.operation}`);
    lines.push(`   resource: ${call.resource}`);
    lines.push(`   pathParams: ${formatValue(call.pathParams)}`);
    if (call.query !== undefined) lines.push(`   query: ${formatValue(call.query)}`);
    if (call.bodyShape !== undefined) lines.push(`   bodyShape: ${formatValue(call.bodyShape)}`);
    if (call.media !== undefined) lines.push(`   media: ${formatValue(call.media)}`);
    lines.push(`   retry: ${call.retryPolicy}`);
    lines.push(`   mutation: ${call.mutation ? "yes" : "no"}`);
    if (call.condition !== undefined) lines.push(`   condition: ${call.condition}`);
  }
  lines.push("", "Local actions that WOULD occur:");
  for (const action of plan.localActions) {
    lines.push(`- ${action.action}${action.condition ? ` (${action.condition})` : ""}`);
  }
  lines.push("", "Remote preconditions NOT checked in dry-run:");
  for (const condition of plan.remotePreconditions) lines.push(`- ${condition}`);
  lines.push("", "NO API CALLS WERE EXECUTED.");
  return lines.join("\n");
}

/**
 * Stage 3C — `attach_notes` daemon operation.
 *
 * Ordering, end to end:
 *
 *   managed edit (required, never created here)
 *     -> fresh target read + trusted bundle lookup      (exclusive target derivation)
 *     -> prior/expected state via the SHARED notes semantics + notes digests
 *     -> durable write-intent PREPARED                  (O_EXCL, one per managed edit)
 *     -> fresh re-read must still equal priorTrackDigest
 *     -> executeOneTool -> runAgent -> production releases.attach_release_notes
 *          -> wrapped updateTrack: durable PREPARED -> TRANSPORT_ATTEMPTED
 *             THEN exactly one real tracks.update
 *     -> production verifier (full-snapshot read-back)
 *     -> daemon trusted read-back settled with the SHARED canonical semantics
 *     -> durable terminal settlement + gate release
 *
 * Everything semantic about release notes comes from
 * `src/releases/release-notes-canonical.ts`. This module deliberately contains NO
 * note merge, NO track equality and NO canonical projection of its own.
 *
 * Transport safety: the ONLY added layer over the production path is the
 * transparent `ReleaseTrackUpdateGateway` wrapper, which makes the durable
 * TRANSPORT_ATTEMPTED write strictly precede the real update call.
 */
import {
  createExpectedReleaseNotesTrack,
  createReleaseNotesTrackStateDigest,
  normalizeReleaseNotesIntent,
  sameReleaseNotesTrackState,
} from "../releases/release-notes-canonical.js";
import { createReleaseNotesAttachmentTool } from "../releases/release-notes-tool.js";
import {
  RELEASE_CONFIGURATION_STATUSES,
  normalizeReleaseTracks,
  toGooglePlayEditSession,
  type LocalizedReleaseNote,
  type ReleaseBundle,
  type ReleaseEditSession,
  type ReleaseTrackState,
} from "../releases/index.js";
import type { ReleaseConfigurationResult } from "../releases/configure-release-tool.js";
import type { ReleaseTrackUpdateGateway } from "../releases/gateway.js";
import {
  releaseWriteIntentNoteDigest,
  type ReleaseWriteIntentGate,
  type ReleaseWriteIntentState,
  type ReleaseWriteIntentStore,
} from "../releases/release-write-intent-store.js";
import type { ReleaseEditSessionStore } from "../releases/session-store.js";
import { executeOneTool } from "../runtime/agent/execute-one-tool.js";
import type { AgentLedger } from "../runtime/agent/index.js";
import { ToolRegistry } from "../runtime/tools/index.js";
import type { VerificationLedger } from "../runtime/verification/index.js";
import {
  PACKAGE_OPERATION_BUSY_CODE,
  type PackageOperationCoordinator,
} from "./package-operation-singleflight.js";
import {
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
  type DaemonResponseEnvelope,
  type DaemonResponseOutcome,
} from "./protocol.js";

export interface DaemonAttachNotesRequest {
  readonly track: string;
  readonly versionCode: string;
  readonly locale: string;
  readonly noteText: string;
}

export interface DaemonAttachNotesDependencies {
  readonly packageName: string;
  readonly managedSessionStore: ReleaseEditSessionStore;
  readonly releaseGateway: ReleaseTrackUpdateGateway;
  readonly writeIntentStore: ReleaseWriteIntentStore;
  readonly ledger: AgentLedger;
  readonly verificationLedger: VerificationLedger;
  readonly now?: () => Date;
}

function envelope(
  correlationId: string,
  outcome: DaemonResponseOutcome,
  extra: Omit<
    Partial<DaemonResponseEnvelope>,
    "protocolVersion" | "correlationId" | "outcome"
  > = {},
): DaemonResponseEnvelope {
  return Object.freeze({
    protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
    correlationId,
    outcome,
    ...extra,
  });
}

function failure(
  correlationId: string,
  outcome: DaemonResponseOutcome,
  code: string,
  message: string,
): DaemonResponseEnvelope {
  return envelope(correlationId, outcome, { error: { code, message } });
}

/** Trusted normalized target track: the SAME normalizer the production tool uses. */
function normalizeTargetTrack(value: unknown, targetTrack: string): ReleaseTrackState {
  const [track] = normalizeReleaseTracks([value]);
  if (track === undefined || track.track !== targetTrack) {
    throw new Error("Google Play returned a different track than the requested target.");
  }
  return track;
}

interface DerivedTarget {
  readonly priorTrack: ReleaseTrackState;
  readonly expectedTrack: ReleaseTrackState;
  readonly configuredRelease: ReleaseConfigurationResult;
  readonly uploadedBundle: ReleaseBundle;
  readonly localizedNotes: readonly LocalizedReleaseNote[];
  readonly priorTrackDigest: string;
  readonly expectedTrackDigest: string;
}

type Derivation =
  | { readonly ok: true; readonly target: DerivedTarget }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Exact target derivation. Selects by CONTAINMENT on the release and by EQUALITY
 * on the bundle, and fails closed on every ambiguous or unsupported shape. No
 * first/last/latest/largest/"completed by default" heuristic exists.
 */
async function deriveTarget(
  deps: DaemonAttachNotesDependencies,
  session: ReleaseEditSession,
  request: DaemonAttachNotesRequest,
): Promise<Derivation> {
  const googleSession = toGooglePlayEditSession(session);
  const rawTrack: unknown = await deps.releaseGateway.getTrack(googleSession, request.track);
  const priorTrack = normalizeTargetTrack(rawTrack, request.track);

  const matching = priorTrack.releases
    .map((release, index) => ({ release, index }))
    .filter(({ release }) => release.versionCodes.includes(request.versionCode));
  if (matching.length === 0) {
    return {
      ok: false,
      code: "TARGET_RELEASE_NOT_FOUND",
      message: "No release on the fresh target track contains the requested versionCode.",
    };
  }
  if (matching.length > 1) {
    return {
      ok: false,
      code: "TARGET_RELEASE_AMBIGUOUS",
      message: "More than one release contains the requested versionCode.",
    };
  }
  const match = matching[0];
  if (match === undefined) {
    return { ok: false, code: "TARGET_RELEASE_NOT_FOUND", message: "Target release is missing." };
  }
  const release = match.release;

  if (release.name === undefined) {
    return {
      ok: false,
      code: "TARGET_RELEASE_NAME_ABSENT",
      message: "The matched release has no name, so no configured release identity exists.",
    };
  }
  // `halted` and `statusUnspecified` are outside RELEASE_CONFIGURATION_STATUSES,
  // so they fail closed here along with any other unsupported status.
  if (!RELEASE_CONFIGURATION_STATUSES.some((status) => status === release.status)) {
    return {
      ok: false,
      code: "TARGET_RELEASE_STATUS_UNSUPPORTED",
      message: `Release status "${release.status}" is not a supported configuration status.`,
    };
  }

  const bundles = await deps.releaseGateway.listBundles(googleSession);
  const bundleMatches = bundles.filter((bundle) => bundle.versionCode === request.versionCode);
  if (bundleMatches.length === 0) {
    return {
      ok: false,
      code: "TARGET_BUNDLE_NOT_FOUND",
      message: "No normalized bundle carries the requested versionCode.",
    };
  }
  if (bundleMatches.length > 1) {
    return {
      ok: false,
      code: "TARGET_BUNDLE_AMBIGUOUS",
      message: "More than one bundle carries the requested versionCode.",
    };
  }
  const uploadedBundle = bundleMatches[0];
  if (uploadedBundle === undefined) {
    return { ok: false, code: "TARGET_BUNDLE_NOT_FOUND", message: "Target bundle is missing." };
  }

  // The production tool treats `localizedReleaseNotes` as the COMPLETE desired
  // note set for the target release, so the requested locale must be composed
  // with that release's existing locales: added when absent, replacing exactly
  // that locale when present. The composition is canonicalized by the same shared
  // rule the tool uses, and never hand-rolled into a second note model.
  let requestedNote: LocalizedReleaseNote;
  try {
    const requested = normalizeReleaseNotesIntent([
      { language: request.locale, text: request.noteText },
    ]);
    const first = requested[0];
    if (first === undefined) throw new Error("empty release-note intent");
    requestedNote = first;
  } catch {
    return {
      ok: false,
      code: "INVALID_RELEASE_NOTES",
      message: "The requested locale or note text is not a valid release note.",
    };
  }

  const existingNotes = release.releaseNotes ?? [];
  let localizedNotes: readonly LocalizedReleaseNote[];
  try {
    localizedNotes = normalizeReleaseNotesIntent([
      ...existingNotes.filter((note) => note.language !== requestedNote.language),
      requestedNote,
    ]);
  } catch {
    // Includes an existing non-canonical language that collides with the
    // canonicalized request: fail closed rather than send a duplicate-language set.
    return {
      ok: false,
      code: "INVALID_RELEASE_NOTES",
      message: "The release's existing note locales cannot be composed with the requested locale.",
    };
  }

  const configuredRelease: ReleaseConfigurationResult = Object.freeze({
    targetTrack: request.track,
    releaseName: release.name,
    status: release.status as ReleaseConfigurationResult["status"],
    // The COMPLETE set of that release, never just the requested code.
    versionCodes: release.versionCodes,
    ...(release.userFraction === undefined ? {} : { userFraction: release.userFraction }),
  });

  const expectedTrack = createExpectedReleaseNotesTrack(priorTrack, match.index, localizedNotes);
  let priorTrackDigest: string;
  let expectedTrackDigest: string;
  try {
    // Prior first, so a state that cannot be represented exactly is reported as
    // non-round-trippable rather than as an invalid note request.
    priorTrackDigest = createReleaseNotesTrackStateDigest(priorTrack);
    expectedTrackDigest = createReleaseNotesTrackStateDigest(expectedTrack);
  } catch {
    // Deliberately not total: a state whose notes cannot be round-tripped is
    // never represented by a weakened digest, and never by a write intent.
    return {
      ok: false,
      code: "TRACK_STATE_NOT_ROUNDTRIPPABLE",
      message:
        "The fresh target-track notes state cannot be represented exactly; no mutation was attempted.",
    };
  }

  return {
    ok: true,
    target: {
      priorTrack,
      expectedTrack,
      configuredRelease,
      uploadedBundle,
      localizedNotes,
      priorTrackDigest,
      expectedTrackDigest,
    },
  };
}

/** Fresh trusted read-back. `unavailable` means the exact state could not be established. */
type Readback =
  | { readonly status: "ok"; readonly digest: string; readonly track: ReleaseTrackState }
  | { readonly status: "unavailable" };

async function readTrackDigest(
  deps: DaemonAttachNotesDependencies,
  session: ReleaseEditSession,
  track: string,
): Promise<Readback> {
  try {
    const raw: unknown = await deps.releaseGateway.getTrack(
      toGooglePlayEditSession(session),
      track,
    );
    const normalized = normalizeTargetTrack(raw, track);
    return {
      status: "ok",
      digest: createReleaseNotesTrackStateDigest(normalized),
      track: normalized,
    };
  } catch {
    // Includes non-round-trippable remote state: nothing can be established.
    return { status: "unavailable" };
  }
}

/**
 * The transparent transport-safety wrapper.
 *
 * Every method except `updateTrack` delegates with no semantic change. Before the
 * real update transport starts, the durable PREPARED -> TRANSPORT_ATTEMPTED
 * transition must complete. If it fails, the underlying update is never called.
 */
function createGuardedGateway(options: {
  readonly gateway: ReleaseTrackUpdateGateway;
  readonly beforeUpdateTrack: () => Promise<void>;
  readonly markTransportAttempted: () => void;
}): ReleaseTrackUpdateGateway {
  // Annotated rather than frozen inline: `Object.freeze` around an object literal
  // breaks contextual typing of the method parameters.
  const wrapper: ReleaseTrackUpdateGateway = {
    getEdit: (session) => options.gateway.getEdit(session),
    listBundles: (session) => options.gateway.listBundles(session),
    getTrack: (session, targetTrack) => options.gateway.getTrack(session, targetTrack),
    async updateTrack(session, targetTrack, request) {
      // Durable marker FIRST. Only a completed durable transition may unlock the
      // real transport; a failure here means the update is never attempted.
      await options.beforeUpdateTrack();
      options.markTransportAttempted();
      return options.gateway.updateTrack(session, targetTrack, request);
    },
  };
  return Object.freeze(wrapper);
}

function heldGateResponse(
  correlationId: string,
  gate: Extract<ReleaseWriteIntentGate, { status: "held" }>,
): DaemonResponseEnvelope {
  return failure(
    correlationId,
    gate.outcome,
    `WRITE_INTENT_${gate.state}`,
    "A durable release write gate is held for this managed edit; operator recovery is required.",
  );
}

async function tryTransition(
  store: ReleaseWriteIntentStore,
  scope: { packageName: string; editId: string },
  from: ReleaseWriteIntentState,
  to: ReleaseWriteIntentState,
): Promise<boolean> {
  try {
    await store.transition({ ...scope, from, to });
    return true;
  } catch {
    return false;
  }
}

async function tryRelease(
  store: ReleaseWriteIntentStore,
  scope: { packageName: string; editId: string },
  expectedState: ReleaseWriteIntentState,
): Promise<boolean> {
  try {
    await store.release({ ...scope, expectedState });
    return true;
  } catch {
    return false;
  }
}

type Verdict = "expected" | "prior" | "neither" | "invariant";

/**
 * §18: the exact full-track semantics and the notes digest must agree. A
 * round-trippable state where they disagree is an invariant violation, not a
 * result to interpret.
 */
function classify(
  settled: { digest: string; track: ReleaseTrackState },
  target: DerivedTarget,
): Verdict {
  const equalsExpected = sameReleaseNotesTrackState(settled.track, target.expectedTrack);
  const equalsPrior = sameReleaseNotesTrackState(settled.track, target.priorTrack);
  const digestsExpected = settled.digest === target.expectedTrackDigest;
  const digestsPrior = settled.digest === target.priorTrackDigest;
  if (equalsExpected !== digestsExpected || equalsPrior !== digestsPrior) return "invariant";
  if (digestsExpected) return "expected";
  if (digestsPrior) return "prior";
  return "neither";
}

export async function attachNotes(
  deps: DaemonAttachNotesDependencies,
  packageOperations: PackageOperationCoordinator,
  correlationId: string,
  request: DaemonAttachNotesRequest,
): Promise<DaemonResponseEnvelope> {
  // ---------- one mutating execution per package (Stage 3E.2D) ----------
  // Acquired BEFORE the authoritative managed-session read and BEFORE the
  // write-intent gate, because acquiring it afterwards leaves the Stage-3E.2C
  // attach-vs-commit window open: a committed edit is loaded here and updated
  // remotely while another operation is validating or committing the same edit.
  const acquisition = packageOperations.tryAcquirePackageOperation(deps.packageName);
  if (!acquisition.acquired) {
    return failure(
      correlationId,
      "operation_in_progress",
      PACKAGE_OPERATION_BUSY_CODE,
      "Another mutating execution is in progress for this package; no release notes were changed.",
    );
  }
  const lease = acquisition.lease;
  try {
    return await performAttachNotes(deps, correlationId, request);
  } finally {
    // Released only after the write-intent gate has been released or legally
    // retained, the transport barrier, the read-back and the response settlement.
    packageOperations.releasePackageOperation(lease);
  }
}

/**
 * The post-lease attach-notes lifecycle. Extracted unchanged from `attachNotes`
 * so the package lease can wrap it without altering any ordering, write-intent,
 * transport-barrier or settlement behaviour.
 */
async function performAttachNotes(
  deps: DaemonAttachNotesDependencies,
  correlationId: string,
  request: DaemonAttachNotesRequest,
): Promise<DaemonResponseEnvelope> {
  // ---------- managed edit is required; never create one ----------
  let session: ReleaseEditSession;
  try {
    const loaded = await deps.managedSessionStore.load();
    if (loaded === undefined) {
      return failure(
        correlationId,
        "local_state_failure",
        "NO_MANAGED_EDIT",
        "No managed Google Play edit is tracked; no release notes were changed.",
      );
    }
    session = loaded;
  } catch {
    return failure(
      correlationId,
      "local_state_failure",
      "MANAGED_EDIT_UNREADABLE",
      "The tracked Google Play edit could not be read; no release notes were changed.",
    );
  }

  // ---------- exclusive target derivation (zero mutation) ----------
  let derivation: Derivation;
  try {
    derivation = await deriveTarget(deps, session, request);
  } catch {
    return failure(
      correlationId,
      "local_state_failure",
      "TARGET_DERIVATION_FAILED",
      "Trusted target state could not be read; no release notes were changed.",
    );
  }
  if (!derivation.ok) {
    return failure(correlationId, "local_state_failure", derivation.code, derivation.message);
  }
  const target = derivation.target;

  // ---------- durable write gate (one per managed edit) ----------
  const scope = { packageName: deps.packageName, editId: session.editId };
  const gate = await deps.writeIntentStore.inspect(scope);
  if (gate.status === "held") return heldGateResponse(correlationId, gate);

  try {
    await deps.writeIntentStore.acquire({
      ...scope,
      track: request.track,
      versionCode: request.versionCode,
      // The canonicalized language the production tool will actually use.
      locale: target.localizedNotes[0]?.language ?? request.locale,
      noteDigest: releaseWriteIntentNoteDigest(request.noteText),
      priorTrackDigest: target.priorTrackDigest,
      expectedTrackDigest: target.expectedTrackDigest,
    });
  } catch {
    const recheck = await deps.writeIntentStore.inspect(scope);
    if (recheck.status === "held") return heldGateResponse(correlationId, recheck);
    return failure(
      correlationId,
      "local_state_failure",
      "WRITE_INTENT_NOT_ACQUIRED",
      "The durable release write gate could not be acquired; no release notes were changed.",
    );
  }

  // ---------- post-acquisition recheck: the prepared target must not have drifted ----------
  const rechecked = await readTrackDigest(deps, session, request.track);
  if (rechecked.status !== "ok" || rechecked.digest !== target.priorTrackDigest) {
    // The intent is not rewritten under this attemptId and is not reacquired.
    return failure(
      correlationId,
      "operation_in_progress",
      "WRITE_INTENT_TARGET_DRIFT",
      "Trusted target state changed after the write gate was acquired; the gate is retained.",
    );
  }

  // ---------- execute through the authoritative path ----------
  let transportAttempted = false;
  let transportTransitionFailed = false;
  const guardedGateway = createGuardedGateway({
    gateway: deps.releaseGateway,
    beforeUpdateTrack: async (): Promise<void> => {
      const moved = await tryTransition(
        deps.writeIntentStore,
        scope,
        "PREPARED",
        "TRANSPORT_ATTEMPTED",
      );
      if (!moved) {
        transportTransitionFailed = true;
        throw new Error("The durable transport marker could not be written.");
      }
    },
    markTransportAttempted: (): void => {
      transportAttempted = true;
    },
  });

  const built = createReleaseNotesAttachmentTool({
    packageName: deps.packageName,
    targetTrack: request.track,
    configuredRelease: target.configuredRelease,
    uploadedBundle: target.uploadedBundle,
    localizedReleaseNotes: target.localizedNotes,
    sessionStore: deps.managedSessionStore,
    gateway: guardedGateway,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  const registry = new ToolRegistry();
  registry.register(built.tool);

  const execution = await executeOneTool({
    registry,
    binding: built.binding,
    input: {},
    ledger: deps.ledger,
    verificationLedger: deps.verificationLedger,
  });
  // The tool's own verdict is never the settlement authority; it is only used to
  // make an unresolved outcome reportable.
  const toolCode = execution.result.code;

  // ---------- settlement from trusted read-back, using the shared semantics ----------
  const settled = await readTrackDigest(deps, session, request.track);
  if (settled.status === "unavailable") {
    if (transportAttempted) {
      // A remote effect may exist and cannot be resolved: fail closed, keep the gate.
      await tryTransition(deps.writeIntentStore, scope, "TRANSPORT_ATTEMPTED", "AMBIGUOUS");
      return failure(
        correlationId,
        "external_state_ambiguous",
        "READBACK_UNAVAILABLE",
        "A release-note update was attempted and its result cannot be verified; operator recovery is required.",
      );
    }
    if (transportTransitionFailed) {
      return failure(
        correlationId,
        "local_state_failure",
        "TRANSPORT_MARKER_FAILED",
        "The durable transport marker could not be written; no remote update was attempted.",
      );
    }
    return failure(
      correlationId,
      "local_state_failure",
      "READBACK_UNAVAILABLE",
      "The release-notes state could not be verified and no remote update was attempted; the gate is retained.",
    );
  }

  const verdict = classify(settled, target);
  if (verdict === "invariant") {
    // §18: never interpret a disagreement between the exact semantics and the digest.
    if (transportAttempted) {
      await tryTransition(deps.writeIntentStore, scope, "TRANSPORT_ATTEMPTED", "AMBIGUOUS");
    }
    return failure(
      correlationId,
      transportAttempted ? "external_state_ambiguous" : "local_state_failure",
      "CANONICAL_INVARIANT_VIOLATION",
      "The exact track semantics and the notes digest disagree; the gate is retained for operator recovery.",
    );
  }

  if (verdict === "expected") {
    if (transportAttempted) {
      const moved = await tryTransition(
        deps.writeIntentStore,
        scope,
        "TRANSPORT_ATTEMPTED",
        "VERIFIED_EXPECTED",
      );
      if (!moved) {
        return failure(
          correlationId,
          "cleanup_pending",
          "TERMINAL_TRANSITION_FAILED",
          "The expected release-notes state is proven, but the durable gate could not be settled.",
        );
      }
      if (!(await tryRelease(deps.writeIntentStore, scope, "VERIFIED_EXPECTED"))) {
        return failure(
          correlationId,
          "cleanup_pending",
          "GATE_RELEASE_FAILED",
          "The expected release-notes state is proven, but the durable gate could not be released.",
        );
      }
      return envelope(correlationId, "success", {
        summary: "Release notes attached and verified.",
      });
    }
    // No transport happened. The only truthful terminal label is VERIFIED_PRIOR,
    // and it is accurate only when the prior state already carried the note.
    if (target.priorTrackDigest !== target.expectedTrackDigest) {
      return failure(
        correlationId,
        "operation_in_progress",
        "WRITE_INTENT_TARGET_DRIFT",
        "The requested state appeared without a transport attempt; the gate is retained.",
      );
    }
    const moved = await tryTransition(deps.writeIntentStore, scope, "PREPARED", "VERIFIED_PRIOR");
    if (!moved) {
      return failure(
        correlationId,
        "cleanup_pending",
        "TERMINAL_TRANSITION_FAILED",
        "The release-notes state is already correct, but the durable gate could not be settled.",
      );
    }
    if (!(await tryRelease(deps.writeIntentStore, scope, "VERIFIED_PRIOR"))) {
      return failure(
        correlationId,
        "cleanup_pending",
        "GATE_RELEASE_FAILED",
        "The release-notes state is already correct, but the durable gate could not be released.",
      );
    }
    return envelope(correlationId, "success", {
      summary: "Release notes already match the requested state; no update was needed.",
    });
  }

  if (verdict === "prior") {
    const from: ReleaseWriteIntentState = transportAttempted ? "TRANSPORT_ATTEMPTED" : "PREPARED";
    const moved = await tryTransition(deps.writeIntentStore, scope, from, "VERIFIED_PRIOR");
    if (!moved) {
      return failure(
        correlationId,
        "cleanup_pending",
        "TERMINAL_TRANSITION_FAILED",
        "The prior release-notes state is proven, but the durable gate could not be settled.",
      );
    }
    const released = await tryRelease(deps.writeIntentStore, scope, "VERIFIED_PRIOR");
    const message = transportAttempted
      ? `The release-note update did not apply; the previous state is unchanged (${toolCode}).`
      : `No release-note update was attempted and the previous state is unchanged (${toolCode}).`;
    if (!released) {
      return failure(correlationId, "cleanup_pending", "GATE_RELEASE_FAILED", message);
    }
    return failure(
      correlationId,
      transportAttempted ? "remote_failure" : "local_state_failure",
      transportAttempted
        ? "TRACK_UPDATE_NOT_APPLIED"
        : transportTransitionFailed
          ? "TRANSPORT_MARKER_FAILED"
          : "NO_MUTATION_ATTEMPTED",
      message,
    );
  }

  // Neither exact state. Only a transport attempt can be ambiguous.
  if (transportAttempted) {
    await tryTransition(deps.writeIntentStore, scope, "TRANSPORT_ATTEMPTED", "AMBIGUOUS");
    return failure(
      correlationId,
      "external_state_ambiguous",
      "TRACK_STATE_AMBIGUOUS",
      "The release-notes state matches neither the prior nor the expected state; operator recovery is required.",
    );
  }
  // Nothing was sent, so no AMBIGUOUS edge is legal: retain PREPARED and fail closed.
  return failure(
    correlationId,
    "local_state_failure",
    "TARGET_STATE_UNRESOLVED",
    "The trusted target state could not be resolved after a local failure; the gate is retained.",
  );
}

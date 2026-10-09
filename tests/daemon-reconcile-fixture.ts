/** Stage 3F.2/3F.3: real stores/runtime/crypto; only the injected Google gateway is fake. */
import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createDaemonOperations } from "../src/daemon/operations.js";
import type { DaemonReconcileCommitDependencies } from "../src/daemon/reconcile-commit-operations.js";
import { createPackageOperationSingleFlightCoordinator } from "../src/daemon/package-operation-singleflight.js";
import {
  createFilePendingOperationStore,
  type PendingOperationStore,
  type PendingState,
} from "../src/daemon/pending-store.js";
import { approvalPayloadFor } from "../src/daemon/pending-view.js";
import { parseDaemonRequest, type DaemonRequest } from "../src/daemon/protocol.js";
import { requestClaimPath } from "../src/daemon/request-claim.js";
import {
  createFileReleaseCommitAttemptJournal,
  type ReleaseCommitAttemptJournal,
  type ReleaseCommitAttemptState,
} from "../src/releases/commit-attempt-journal.js";
import { createReleaseCommitStateDigest } from "../src/releases/commit-approval.js";
import { createFileReleaseEditCleanupJournal } from "../src/releases/cleanup-journal.js";
import {
  ReleaseError,
  type GooglePlayEditSession,
  type ReleaseTrackState,
  type ReleaseTrackUpdateRequest,
} from "../src/releases/index.js";
import { createReleaseEditOpenTool } from "../src/releases/open-tool.js";
import { createFileReleaseWriteIntentStore } from "../src/releases/release-write-intent-store.js";
import { createFileReleaseEditSessionStore } from "../src/releases/session-store.js";
import { createFileAgentLedger } from "../src/runtime/agent/index.js";
import { createFileApprovalLedger } from "../src/runtime/approvals/index.js";
import {
  createOperatorApprovalVerifier,
  encodeOperatorApprovalPayload,
} from "../src/runtime/approvals/operator-signature.js";
import { ToolRegistry } from "../src/runtime/tools/index.js";
import { createFileVerificationLedger } from "../src/runtime/verification/index.js";
import { readAuditEntries } from "../src/audit/index.js";

export const PACKAGE = "com.example.reconcile";
export const AT = "2026-10-09T00:00:00.000Z";
export const ORIGINAL = "PRIVATE-ORIGINAL-EDIT";
export const TEMPORARY = "PRIVATE-VERIFICATION-EDIT";
export const TEMP_EXPIRY = "4102444900";
export const TRACK = "internal";
export const VERSION = "42";
export const track = (): ReleaseTrackState => ({
  track: TRACK,
  releases: [{ name: "Candidate", status: "completed", versionCodes: [VERSION] }],
});
export const priorTrack = (): ReleaseTrackState => ({
  track: TRACK,
  releases: [{ name: "Prior", status: "completed", versionCodes: ["41"] }],
});
export const unrelatedTrack = (): ReleaseTrackState => ({
  track: TRACK,
  releases: [{ name: "Other", status: "draft", versionCodes: ["7"] }],
});
export const expectedDigest = createReleaseCommitStateDigest(track());
export const priorDigest = createReleaseCommitStateDigest(priorTrack());
/** A durable third state: neither the expected state nor the persisted prior one. */
export const unrelatedDigest = createReleaseCommitStateDigest(unrelatedTrack());
export function inactiveRead(): ReleaseError {
  return new ReleaseError("EDIT_INVALID", "PRIVATE-UPSTREAM", {
    classification: {
      publisherCode: "API_REQUEST_FAILED",
      status: 400,
      googleStatus: "FAILED_PRECONDITION",
      googleReasons: ["failedPrecondition"],
    },
  });
}
export function latch() {
  let release: () => void = () => {
    throw new Error("Uninitialized latch");
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const dirs: string[] = [];
export function cleanupFixtures() {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}
export interface ReconcileFixtureOptions {
  state?: ReleaseCommitAttemptState | "none";
  prefix?: number;
  /** Which digest a seeded observation patch durably persists. */
  observed?: "expected" | "prior" | "unrelated";
  activeOriginal?: boolean;
  packageName?: string;
  coordinator?: ReturnType<typeof createPackageOperationSingleFlightCoordinator>;
  wrapJournal?: (journal: ReleaseCommitAttemptJournal) => ReleaseCommitAttemptJournal;
}
export async function fixture(options: ReconcileFixtureOptions = {}) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-reconcile-"));
  chmodSync(root, 0o700);
  dirs.push(root);
  const packageName = options.packageName ?? PACKAGE;
  const originalExpiry = options.activeOriginal ? TEMP_EXPIRY : "1";
  const pendingRoot = join(root, "pending");
  mkdirSync(pendingRoot, { mode: 0o700 });
  const clock = () => new Date(AT);
  const realPendingStore = createFilePendingOperationStore(pendingRoot, { now: clock });
  // The durable pending store stays real; only named state transitions can be
  // failed, so a settlement-persistence test never fakes the store itself.
  const failTransitions = new Set<string>();
  const pendingStore: PendingOperationStore = {
    prepare: (input) => realPendingStore.prepare(input),
    load: (requestId) => realPendingStore.load(requestId),
    list: () => realPendingStore.list(),
    state: (requestId) => realPendingStore.state(requestId),
    async transition(requestId: string, from: PendingState, to: PendingState) {
      if (failTransitions.has(`${from}->${to}`))
        throw new Error(`Injected ${from}->${to} pending persistence failure`);
      return realPendingStore.transition(requestId, from, to);
    },
  };
  const claimRoot = join(root, "claims");
  const journalPath = join(root, "attempts.json");
  const rawJournal = () =>
    createFileReleaseCommitAttemptJournal(journalPath, { expectedPackageName: packageName });
  const openJournal = () =>
    options.wrapJournal ? options.wrapJournal(rawJournal()) : rawJournal();
  const sessionStore = createFileReleaseEditSessionStore(join(root, "session.json"), {
    expectedPackageName: packageName,
  });
  const cleanupJournal = createFileReleaseEditCleanupJournal(join(root, "cleanup.json"), {
    expectedPackageName: packageName,
  });
  const writeIntentStore = createFileReleaseWriteIntentStore(join(root, "write-intents"));
  const calls = {
    getEdit: 0,
    createEdit: 0,
    getTrack: 0,
    deleteEdit: 0,
    commitEdit: 0,
    updateTrack: 0,
    uploadBundle: 0,
    listBundles: 0,
    listReleaseSummaries: 0,
    validateEdit: 0,
  };
  const events: string[] = [];
  const faults: {
    originalHold?: Promise<void>;
    insertHold?: Promise<void>;
    trackHold?: Promise<void>;
    deleteHold?: Promise<void>;
    auditHold?: Promise<void>;
    observedTrack?: ReleaseTrackState;
    deleteFailure?: boolean;
    originalFailure?: Error;
    postDeleteActive?: boolean;
    auditFailure?: boolean;
    localAuditFailure?: boolean;
  } = {};
  // A seeded delete ACK represents an already-deleted temporary edit in this
  // FAKE gateway. Recovery must only confirm it, not replay that delete.
  let deleted = (options.prefix ?? 0) >= 6;
  const gateway = {
    async getEdit(session: GooglePlayEditSession) {
      calls.getEdit++;
      events.push(
        session.editId === ORIGINAL
          ? "getEdit.original"
          : deleted
            ? "getEdit.postDelete"
            : "getEdit.preDelete",
      );
      if (session.editId === ORIGINAL) {
        if (faults.originalHold) await faults.originalHold;
        if (faults.originalFailure) throw faults.originalFailure;
      } else if (deleted && !faults.postDeleteActive) throw inactiveRead();
      return { id: session.editId, expiryTimeSeconds: session.expiryTimeSeconds };
    },
    async createEdit() {
      calls.createEdit++;
      events.push("createEdit");
      if (faults.insertHold) await faults.insertHold;
      return { packageName, editId: TEMPORARY, expiryTimeSeconds: TEMP_EXPIRY };
    },
    async getTrack() {
      calls.getTrack++;
      events.push("getTrack");
      if (faults.trackHold) await faults.trackHold;
      return structuredClone(faults.observedTrack ?? track());
    },
    async deleteEdit(session: GooglePlayEditSession) {
      calls.deleteEdit++;
      events.push("deleteEdit");
      if (session.editId === ORIGINAL) throw new Error("ORIGINAL DELETION FORBIDDEN");
      if (faults.deleteHold) await faults.deleteHold;
      if (faults.deleteFailure) throw new Error("PRIVATE-DELETE-UNCERTAIN");
      deleted = true;
    },
    async commitEdit() {
      calls.commitEdit++;
      return { id: ORIGINAL, expiryTimeSeconds: originalExpiry };
    },
    async updateTrack(
      _session: GooglePlayEditSession,
      target: string,
      request: ReleaseTrackUpdateRequest,
    ) {
      calls.updateTrack++;
      return { track: target, releases: structuredClone(request.releases) };
    },
    async uploadBundle() {
      calls.uploadBundle++;
      throw new Error("UPLOAD FORBIDDEN");
    },
    async listTracks() {
      return [track()];
    },
    async listBundles() {
      calls.listBundles++;
      return [];
    },
    async validateEdit() {
      calls.validateEdit++;
      return { id: ORIGINAL, expiryTimeSeconds: originalExpiry };
    },
    async listReleaseSummaries() {
      calls.listReleaseSummaries++;
      return [
        {
          releaseName: "Candidate",
          track: TRACK,
          versionCodes: [VERSION],
          releaseLifecycleState: "completed" as const,
        },
      ];
    },
  };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const operatorVerifier = createOperatorApprovalVerifier(publicKey, "ephemeral-fixture");
  const ledger = createFileAgentLedger(join(root, "agent.jsonl"));
  const approvalPath = join(root, "approval.jsonl");
  const approvalLedger = createFileApprovalLedger(approvalPath);
  const verificationLedger = createFileVerificationLedger(join(root, "verification.jsonl"));
  const remoteAuditPath = join(root, "reconcile-audit.jsonl");
  const localAuditPath = join(root, "finalize-audit.jsonl");
  const remoteWriter = createFileAgentLedger(remoteAuditPath);
  const localWriter = createFileAgentLedger(localAuditPath);
  const reconcileAuditLedger = {
    async append(entry: Parameters<typeof ledger.append>[0]) {
      if (faults.auditHold) await faults.auditHold;
      if (faults.auditFailure) throw new Error("PRIVATE-AUDIT-FAILURE");
      await remoteWriter.append(entry);
    },
  };
  const finalizationAuditLedger = {
    async append(entry: Parameters<typeof ledger.append>[0]) {
      if (faults.auditHold) await faults.auditHold;
      if (faults.localAuditFailure) throw new Error("PRIVATE-LOCAL-AUDIT-FAILURE");
      await localWriter.append(entry);
    },
  };
  const coordinator = options.coordinator ?? createPackageOperationSingleFlightCoordinator();
  const deps: DaemonReconcileCommitDependencies = {
    packageName,
    pendingStore,
    claimRoot,
    managedSessionStore: sessionStore,
    gateway,
    cleanupJournal,
    openCommitAttemptJournal: openJournal,
    reconcileAuditLedger,
    finalizationAuditLedger,
    operatorVerifier,
    ledger,
    approvalLedger,
    verificationLedger,
    now: clock,
  };
  const opened = createReleaseEditOpenTool({ packageName, gateway, store: sessionStore });
  const registry = new ToolRegistry();
  registry.register(opened.tool);
  const operations = createDaemonOperations({
    packageName,
    pendingStore,
    claimRoot,
    packageOperations: coordinator,
    registry,
    openEdit: { binding: opened.binding, input: {} },
    operatorVerifier,
    ledger,
    approvalLedger,
    verificationLedger,
    now: clock,
    reconcileCommit: deps,
    attachNotes: {
      packageName,
      managedSessionStore: sessionStore,
      releaseGateway: gateway,
      writeIntentStore,
      ledger,
      verificationLedger,
    },
    commit: {
      packageName,
      pendingStore,
      claimRoot,
      managedSessionStore: sessionStore,
      releaseGateway: gateway,
      writeIntentStore,
      commitAuditLedger: reconcileAuditLedger,
      openCommitAttemptJournal: openJournal,
      operatorVerifier,
      ledger,
      approvalLedger,
      verificationLedger,
      now: clock,
    },
    verifyCommitted: {
      packageName,
      pendingStore,
      claimRoot,
      managedSessionStore: sessionStore,
      summaryGateway: gateway,
      temporaryEditGateway: gateway,
      cleanupJournal,
      verifyAuditLedger: remoteWriter,
      openCommitAttemptJournal: openJournal,
      operatorVerifier,
      ledger,
      approvalLedger,
      verificationLedger,
      now: clock,
    },
    readStatusEvidence: async () => ({
      packageVersion: "0.2.0",
      managedSessionPresent: (await sessionStore.load()) !== undefined,
      pendingCleanup: (await cleanupJournal.list()).length > 0,
      unresolvedCommitRecovery: (await rawJournal().list()).some(
        (await import("../src/releases/commit-attempt-status.js")).isCommitAttemptUnresolved,
      ),
    }),
  });
  const seedInput = {
    version: 1 as const,
    packageName,
    editId: ORIGINAL,
    expiryTimeSeconds: originalExpiry,
    targetTrack: TRACK,
    versionCode: VERSION,
    releaseName: "Candidate",
    releaseStatus: "completed" as const,
    expectedStateDigest: expectedDigest,
    priorStateDigest: priorDigest,
    validationExpiryTimeSeconds: originalExpiry,
    requestDigest: "c".repeat(64),
    attemptedAtUtc: AT,
    updatedAtUtc: AT,
  };
  const wanted = options.state ?? "TRANSPORT_ATTEMPTED";
  let attemptId: string | undefined;
  if (wanted !== "none") {
    const journal = rawJournal();
    const p = await journal.prepare(seedInput);
    attemptId = p.attemptId;
    if (wanted !== "PREPARED")
      await journal.transition(attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", AT);
    const ack =
      wanted === "ACKNOWLEDGED" ||
      wanted === "REMOTE_VERIFIED" ||
      wanted === "RECONCILED_COMMITTED";
    if (ack)
      await journal.transition(attemptId, "TRANSPORT_ATTEMPTED", "ACKNOWLEDGED", AT, {
        acknowledgedAtUtc: AT,
      });
    if (wanted === "AMBIGUOUS")
      await journal.transition(attemptId, "TRANSPORT_ATTEMPTED", "AMBIGUOUS", AT);
    if (options.prefix !== undefined) {
      const state = ack
        ? "ACKNOWLEDGED"
        : wanted === "AMBIGUOUS"
          ? "AMBIGUOUS"
          : "TRANSPORT_ATTEMPTED";
      const observedDigest =
        options.observed === "prior"
          ? priorDigest
          : options.observed === "unrelated"
            ? unrelatedDigest
            : expectedDigest;
      const patches = [
        { verificationInsertAttempted: true as const },
        { verificationEditId: TEMPORARY, verificationEditExpiryTimeSeconds: TEMP_EXPIRY },
        { verificationObservedStateDigest: observedDigest, verificationObservedAtUtc: AT },
        { verificationPreDeleteReadVerified: true as const },
        { verificationDeleteAttempted: true as const },
        { verificationDeleteAcknowledged: true as const },
        { verificationCleanupVerified: true as const },
      ];
      for (const patch of patches.slice(0, options.prefix))
        await journal.updateVerification(attemptId, state, AT, patch);
    }
    if (wanted === "REMOTE_VERIFIED" || wanted === "RECONCILED_COMMITTED")
      await journal.transition(attemptId, "ACKNOWLEDGED", "REMOTE_VERIFIED", AT);
    if (wanted === "RECONCILED_COMMITTED")
      await journal.transition(attemptId, "REMOTE_VERIFIED", wanted, AT);
    if (wanted === "RECONCILED_NOT_COMMITTED")
      await journal.transition(attemptId, "TRANSPORT_ATTEMPTED", wanted, AT);
  }
  const call = (request: DaemonRequest) =>
    operations.handle(
      parseDaemonRequest({ protocolVersion: 4, correlationId: "reconcile-fixture", request }),
    );
  return {
    root,
    packageName,
    originalExpiry,
    pendingRoot,
    pendingStore,
    failTransitions,
    claimRoot,
    rawJournal,
    openJournal,
    journalPath,
    sessionStore,
    cleanupJournal,
    writeIntentStore,
    gateway,
    coordinator,
    operations,
    deps,
    faults,
    calls,
    events,
    attemptId,
    seedInput,
    localAuditPath,
    remoteAuditPath,
    approvalPath,
    call,
    prepare: () => call({ kind: "prepare_reconcile_commit" }),
    execute: (requestId: string, signature: string) =>
      call({ kind: "execute_reconcile_commit", requestId, signature }),
    signChallenge: (text: string) =>
      sign(null, Buffer.from(text), privateKey).toString("base64url"),
    async signRequest(requestId: string) {
      const pending = await pendingStore.load(requestId);
      if (!pending) throw new Error("Missing signed request");
      return sign(
        null,
        encodeOperatorApprovalPayload(approvalPayloadFor(pending)),
        privateKey,
      ).toString("base64url");
    },
    claimExists: (id: string) => existsSync(requestClaimPath(claimRoot, id)),
    consumptions: () =>
      readAuditEntries(approvalPath).filter((e) => e.type === "approval.consumed").length,
    journalBytes: () => (existsSync(journalPath) ? readFileSync(journalPath, "utf8") : ""),
    async saveOriginalSession() {
      await sessionStore.save({
        version: 1,
        packageName,
        editId: ORIGINAL,
        expiryTimeSeconds: originalExpiry,
        createdAt: AT,
      });
    },
  };
}

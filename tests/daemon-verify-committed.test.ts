/**
 * Stage 3E.3 — daemon `prepare_verify_committed` / `execute_verify_committed`.
 *
 * Real: the dispatcher, pending store (schema v2), exclusive O_EXCL claims,
 * operator Ed25519 verification, the operator_signature resolver,
 * executeOneTool/runAgent, the production `releases.verify_committed_release`
 * verifier, the real commit-attempt journal, the Stage-3E.2A evidence sink, the
 * Stage-3E.2B strict journal bridge, the durable temporary-edit cleanup journal,
 * the managed-session store, the release write-intent store, the production
 * open/attach/commit tools and the ONE shared package-operation coordinator.
 *
 * Fake: the Google gateway only. Offline throughout; no network, no real Google.
 *
 * Every failure injection below wraps a REAL durable store, so the assertions are
 * about actual on-disk state (journal bytes, pending state, claim files, cleanup
 * records, Google call counts) rather than about mocks agreeing with each other.
 */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAuditEntries } from "../src/audit/index.js";
import type { DaemonAttachNotesDependencies } from "../src/daemon/attach-notes.js";
import type { DaemonCommitDependencies } from "../src/daemon/commit-operations.js";
import { createDaemonOperations, type DaemonOperations } from "../src/daemon/operations.js";
import { createPackageOperationSingleFlightCoordinator } from "../src/daemon/package-operation-singleflight.js";
import {
  createFilePendingOperationStore,
  type PendingOperationStore,
} from "../src/daemon/pending-store.js";
import {
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
  parseDaemonRequest,
  type DaemonRequest,
  type DaemonResponseEnvelope,
} from "../src/daemon/protocol.js";
import { approvalPayloadFor } from "../src/daemon/pending-view.js";
import { requestClaimPath } from "../src/daemon/request-claim.js";
import {
  executeVerifyCommitted,
  prepareVerifyCommitted,
  selectVerificationAttempt,
  type DaemonVerifyCommittedDependencies,
} from "../src/daemon/verify-committed-operations.js";
import type { ReleaseCommitAttemptJournal } from "../src/releases/commit-attempt-journal.js";
import { createFileReleaseCommitAttemptJournal } from "../src/releases/commit-attempt-journal.js";
import { createReleaseCommitStateDigest } from "../src/releases/commit-approval.js";
import {
  createFileReleaseEditCleanupJournal,
  type ReleaseEditCleanupJournal,
} from "../src/releases/cleanup-journal.js";
import type {
  ReleaseCommitGateway,
  ReleaseEditGateway,
  ReleaseEditReadback,
  ReleaseSummaryGateway,
  ReleaseTemporaryEditVerificationGateway,
  ReleaseTrackUpdateGateway,
} from "../src/releases/gateway.js";
import {
  RELEASE_EDIT_SESSION_VERSION,
  type GooglePlayEditSession,
  type ReleaseBundle,
  type ReleaseSummaryState,
  type ReleaseTrackState,
  type ReleaseTrackUpdateRequest,
} from "../src/releases/index.js";
import { createReleaseEditOpenTool } from "../src/releases/open-tool.js";
import {
  createReleaseStateVerificationApprovalBinding,
  createReleaseStateVerificationIntent,
  createReleaseStateVerificationRequestDigest,
} from "../src/releases/readback-approval.js";
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

const PACKAGE = "com.example.app";
const OTHER_PACKAGE = "com.example.other";
const EDIT_ID = "edit-managed-1";
const TEMP_EDIT_ID = "edit-temp-verify-1";
const TRACK = "internal";
const VERSION_CODE = "42";
const RELEASE_NAME = "42 (1.0)";
const RELEASE_STATUS = "completed";
const EXPIRY = "1900000000";
const VALIDATION_EXPIRY = EXPIRY;
const AT = "2026-10-08T00:00:00.000Z";
const AT_LATER = "2026-10-08T00:05:00.000Z";
const COMMIT_REQUEST_DIGEST = "c".repeat(64);
const PRIOR_STATE_DIGEST = "b".repeat(64);
const CORRELATION = "verify-committed";
const COMMIT_TOOL_NAME = "releases.commit_edit";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-3e3-"));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  return dir;
}

/** The exact deployed track state the durable expectation must digest-match. */
function trackFixture(): ReleaseTrackState {
  return {
    track: TRACK,
    releases: [
      {
        name: RELEASE_NAME,
        status: RELEASE_STATUS as ReleaseTrackState["releases"][number]["status"],
        versionCodes: [VERSION_CODE],
      },
    ],
  };
}

const EXPECTED_DIGEST = createReleaseCommitStateDigest(trackFixture());

/**
 * Persist the complete Stage-3E verification prefix on an ACKNOWLEDGED record,
 * in the journal's own required order. The `REMOTE_VERIFIED` transition is
 * deliberately NOT performed: that is the crash window this stage resumes from.
 */
async function seedCompleteEvidence(
  journal: ReleaseCommitAttemptJournal,
  attemptId: string,
  at: string,
): Promise<void> {
  await journal.updateVerification(attemptId, "ACKNOWLEDGED", at, {
    verificationInsertAttempted: true,
  });
  await journal.updateVerification(attemptId, "ACKNOWLEDGED", at, {
    verificationEditId: TEMP_EDIT_ID,
    verificationEditExpiryTimeSeconds: EXPIRY,
  });
  await journal.updateVerification(attemptId, "ACKNOWLEDGED", at, {
    verificationObservedStateDigest: EXPECTED_DIGEST,
    verificationObservedAtUtc: at,
  });
  await journal.updateVerification(attemptId, "ACKNOWLEDGED", at, {
    verificationPreDeleteReadVerified: true,
  });
  await journal.updateVerification(attemptId, "ACKNOWLEDGED", at, {
    verificationDeleteAttempted: true,
  });
  await journal.updateVerification(attemptId, "ACKNOWLEDGED", at, {
    verificationDeleteAcknowledged: true,
  });
  await journal.updateVerification(attemptId, "ACKNOWLEDGED", at, {
    verificationCleanupVerified: true,
  });
}

function summaryFixture(): ReleaseSummaryState {
  return {
    releaseName: RELEASE_NAME,
    track: TRACK,
    versionCodes: [VERSION_CODE],
    releaseLifecycleState: "completed",
  };
}

interface Faults {
  summaryHold?: Promise<void>;
  createEditHold?: Promise<void>;
  getTrackHold?: Promise<void>;
  deleteEditHold?: Promise<void>;
  /** Deep read returns a state that does NOT digest-match the expectation. */
  mismatchedDeepRead?: boolean;
  /** Temporary edit deletion fails once (evidence: uncertain cleanup). */
  failDelete?: boolean;
}

interface Calls {
  listReleaseSummaries: number;
  createEdit: number;
  getEdit: number;
  getTrack: number;
  updateTrack: number;
  validateEdit: number;
  commitEdit: number;
  deleteEdit: number;
  listBundles: number;
}

interface Harness {
  readonly dir: string;
  readonly operations: DaemonOperations;
  readonly verifyDeps: DaemonVerifyCommittedDependencies;
  readonly journalPath: string;
  readonly cleanupJournal: ReleaseEditCleanupJournal;
  readonly pendingStore: PendingOperationStore;
  readonly claimRoot: string;
  readonly approvalPath: string;
  readonly privateKey: KeyObject;
  readonly faults: Faults;
  readonly calls: Calls;
  readonly coordinator: ReturnType<typeof createPackageOperationSingleFlightCoordinator>;
  call(request: DaemonRequest): Promise<DaemonResponseEnvelope>;
  prepareVerify(): Promise<DaemonResponseEnvelope>;
  prepareCommit(): Promise<DaemonResponseEnvelope>;
  prepareOpen(): Promise<DaemonResponseEnvelope>;
  prepareAttach(): Promise<DaemonResponseEnvelope>;
  /** Prepares a real commit approval record directly (no journal dependency). */
  seedCommitApproval(): Promise<string>;
  executeVerify(requestId: string, signature: string): Promise<DaemonResponseEnvelope>;
  executeCommit(requestId: string, signature: string): Promise<DaemonResponseEnvelope>;
  executeOpen(requestId: string, signature: string): Promise<DaemonResponseEnvelope>;
  executeAttach(): Promise<DaemonResponseEnvelope>;
  /** Signs the exact canonical payload of one server-owned pending record. */
  signRequest(requestId: string): Promise<string>;
  journalRecords(): Promise<readonly string[]>;
  approvalConsumptions(): number;
  claimExists(requestId: string): boolean;
  cleanupRecordIds(): Promise<readonly string[]>;
}

interface HarnessOptions {
  readonly packageName?: string;
  /** Seeds an active managed session, which destructive verification must refuse. */
  readonly managedSession?: boolean;
  /** Seeds one durable unresolved temporary-edit cleanup record. */
  readonly unresolvedCleanup?: boolean;
  /** Wraps the real journal, e.g. to fail one durable write for a recovery test. */
  readonly wrapJournal?: (journal: ReleaseCommitAttemptJournal) => ReleaseCommitAttemptJournal;
  /** Number of durable ACK attempts seeded (1 by default). */
  readonly ackAttempts?: number;
  /** Seeds the completed commit pending record that proves provenance. */
  readonly completedCommitProvenance?: boolean;
}

async function buildHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = tempDir();
  const packageName = options.packageName ?? PACKAGE;
  const pendingRoot = join(dir, "pending");
  mkdirSync(pendingRoot, { mode: 0o700 });
  const pendingStore = createFilePendingOperationStore(pendingRoot);
  const claimRoot = join(dir, "claims");
  const sessionStore = createFileReleaseEditSessionStore(join(dir, "edit-session.json"), {
    expectedPackageName: packageName,
  });
  if (options.managedSession === true) {
    await sessionStore.save({
      version: RELEASE_EDIT_SESSION_VERSION,
      packageName,
      editId: EDIT_ID,
      expiryTimeSeconds: EXPIRY,
      createdAt: AT,
    });
  }
  const cleanupJournal = createFileReleaseEditCleanupJournal(join(dir, "cleanup-journal.json"), {
    expectedPackageName: packageName,
  });
  if (options.unresolvedCleanup === true) {
    await cleanupJournal.record({
      editId: TEMP_EDIT_ID,
      expiryTimeSeconds: EXPIRY,
      source: "exact_release_verification",
      createdAt: AT,
    });
  }
  const writeIntentStore = createFileReleaseWriteIntentStore(join(dir, "write-intents"));
  const journalPath = join(dir, "commit-attempt-journal.json");
  const rawJournal = (): ReleaseCommitAttemptJournal =>
    createFileReleaseCommitAttemptJournal(journalPath, { expectedPackageName: packageName });
  const openJournal = (): ReleaseCommitAttemptJournal =>
    options.wrapJournal ? options.wrapJournal(rawJournal()) : rawJournal();

  const faults: Faults = {};
  const calls: Calls = {
    listReleaseSummaries: 0,
    createEdit: 0,
    getEdit: 0,
    getTrack: 0,
    updateTrack: 0,
    validateEdit: 0,
    commitEdit: 0,
    deleteEdit: 0,
    listBundles: 0,
  };

  const gateway = {
    async listReleaseSummaries(): Promise<readonly ReleaseSummaryState[]> {
      calls.listReleaseSummaries += 1;
      if (faults.summaryHold !== undefined) await faults.summaryHold;
      return [summaryFixture()];
    },
    async createEdit(): Promise<GooglePlayEditSession> {
      calls.createEdit += 1;
      if (faults.createEditHold !== undefined) await faults.createEditHold;
      return { packageName, editId: TEMP_EDIT_ID, expiryTimeSeconds: EXPIRY };
    },
    async getEdit(session: GooglePlayEditSession): Promise<ReleaseEditReadback> {
      calls.getEdit += 1;
      return { id: session.editId, expiryTimeSeconds: session.expiryTimeSeconds };
    },
    async listTracks(): Promise<readonly ReleaseTrackState[]> {
      return [trackFixture()];
    },
    async listBundles(): Promise<readonly ReleaseBundle[]> {
      calls.listBundles += 1;
      return [];
    },
    async getTrack(): Promise<ReleaseTrackState> {
      calls.getTrack += 1;
      if (faults.getTrackHold !== undefined) await faults.getTrackHold;
      if (faults.mismatchedDeepRead === true) {
        return {
          track: TRACK,
          releases: [{ status: "draft", versionCodes: [VERSION_CODE] }],
        };
      }
      return structuredClone(trackFixture());
    },
    async updateTrack(
      _session: GooglePlayEditSession,
      targetTrack: string,
      request: ReleaseTrackUpdateRequest,
    ): Promise<ReleaseTrackState> {
      calls.updateTrack += 1;
      return { track: targetTrack, releases: structuredClone(request.releases) };
    },
    async validateEdit(): Promise<ReleaseEditReadback> {
      calls.validateEdit += 1;
      return { id: EDIT_ID, expiryTimeSeconds: VALIDATION_EXPIRY };
    },
    async commitEdit(): Promise<ReleaseEditReadback> {
      calls.commitEdit += 1;
      return { id: EDIT_ID, expiryTimeSeconds: EXPIRY };
    },
    async deleteEdit(): Promise<void> {
      calls.deleteEdit += 1;
      if (faults.failDelete === true) throw new Error("temporary verification delete failed");
      if (faults.deleteEditHold !== undefined) await faults.deleteEditHold;
    },
  };
  const editGateway: ReleaseEditGateway = gateway;
  const trackGateway: ReleaseTrackUpdateGateway = gateway;
  const commitGateway: ReleaseCommitGateway = gateway;
  const summaryGateway: ReleaseSummaryGateway = gateway;
  const temporaryEditGateway: ReleaseTemporaryEditVerificationGateway = gateway;

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const verifier = createOperatorApprovalVerifier(publicKey, "verify-anchor");
  const ledger = createFileAgentLedger(join(dir, "agent.jsonl"));
  const verifyAuditLedger = createFileAgentLedger(join(dir, "verify-audit.jsonl"));
  const approvalPath = join(dir, "approval.jsonl");
  const approvalLedger = createFileApprovalLedger(approvalPath);
  const verificationLedger = createFileVerificationLedger(join(dir, "verification.jsonl"));

  const openBuilt = createReleaseEditOpenTool({
    packageName,
    gateway: editGateway,
    store: sessionStore,
  });
  const registry = new ToolRegistry();
  registry.register(openBuilt.tool);

  const attachDeps: DaemonAttachNotesDependencies = {
    packageName,
    managedSessionStore: sessionStore,
    releaseGateway: trackGateway,
    writeIntentStore,
    ledger,
    verificationLedger,
  };
  const commitDeps: DaemonCommitDependencies = {
    packageName,
    pendingStore,
    claimRoot,
    managedSessionStore: sessionStore,
    releaseGateway: commitGateway,
    writeIntentStore,
    commitAuditLedger: { append: async (): Promise<void> => undefined },
    openCommitAttemptJournal: openJournal,
    operatorVerifier: verifier,
    ledger,
    approvalLedger,
    verificationLedger,
  };
  const verifyDeps: DaemonVerifyCommittedDependencies = {
    packageName,
    pendingStore,
    claimRoot,
    managedSessionStore: sessionStore,
    summaryGateway,
    temporaryEditGateway,
    cleanupJournal,
    verifyAuditLedger,
    openCommitAttemptJournal: openJournal,
    operatorVerifier: verifier,
    ledger,
    approvalLedger,
    verificationLedger,
  };

  const coordinator = createPackageOperationSingleFlightCoordinator();
  const operations = createDaemonOperations({
    packageName,
    pendingStore,
    claimRoot,
    packageOperations: coordinator,
    registry,
    openEdit: { binding: openBuilt.binding, input: {} },
    attachNotes: attachDeps,
    commit: commitDeps,
    verifyCommitted: verifyDeps,
    operatorVerifier: verifier,
    ledger,
    approvalLedger,
    verificationLedger,
  });

  // ---------- durable seeds ----------
  const ackAttempts = options.ackAttempts ?? 1;
  for (let index = 0; index < ackAttempts; index += 1) {
    const journal = openJournal();
    const prepared = await journal.prepare({
      version: 1,
      packageName,
      editId: EDIT_ID,
      expiryTimeSeconds: EXPIRY,
      targetTrack: TRACK,
      versionCode: VERSION_CODE,
      releaseName: RELEASE_NAME,
      releaseStatus: RELEASE_STATUS as "completed",
      expectedStateDigest: EXPECTED_DIGEST,
      priorStateDigest: PRIOR_STATE_DIGEST,
      validationExpiryTimeSeconds: VALIDATION_EXPIRY,
      requestDigest: COMMIT_REQUEST_DIGEST,
      attemptedAtUtc: AT,
      updatedAtUtc: AT,
    });
    await journal.transition(prepared.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", AT_LATER);
    await journal.transition(prepared.attemptId, "TRANSPORT_ATTEMPTED", "ACKNOWLEDGED", AT_LATER, {
      acknowledgedAtUtc: AT_LATER,
    });
  }
  if (options.completedCommitProvenance !== false) {
    const commitRecord = await pendingStore.prepare({
      operation: "commit",
      toolName: COMMIT_TOOL_NAME,
      permission: "publish",
      packageName,
      requestDigest: COMMIT_REQUEST_DIGEST,
      intent: {
        kind: "commit",
        targetTrack: TRACK,
        versionCode: VERSION_CODE,
        editId: EDIT_ID,
        stateDigest: EXPECTED_DIGEST,
        validationExpiryTimeSeconds: VALIDATION_EXPIRY,
        releaseName: RELEASE_NAME,
        releaseStatus: RELEASE_STATUS,
      },
    });
    await pendingStore.transition(commitRecord.requestId, "PENDING", "CLAIMED");
    await pendingStore.transition(commitRecord.requestId, "CLAIMED", "CONSUMED");
    await pendingStore.transition(commitRecord.requestId, "CONSUMED", "COMPLETED");
  }

  const envelope = (request: unknown): ReturnType<typeof parseDaemonRequest> =>
    parseDaemonRequest({
      protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
      correlationId: CORRELATION,
      request,
    });

  return {
    dir,
    operations,
    verifyDeps,
    journalPath,
    cleanupJournal,
    pendingStore,
    claimRoot,
    approvalPath,
    privateKey,
    faults,
    calls,
    coordinator,
    call: (request) => operations.handle(envelope(request)),
    prepareVerify: async () =>
      operations.handle(
        envelope({ kind: "prepare_verify_committed", track: TRACK, versionCode: VERSION_CODE }),
      ),
    prepareCommit: async () =>
      operations.handle(
        envelope({ kind: "prepare_commit", track: TRACK, versionCode: VERSION_CODE }),
      ),
    prepareOpen: async () => operations.handle(envelope({ kind: "prepare_open_edit" })),
    prepareAttach: async () =>
      operations.handle(
        envelope({
          kind: "attach_notes",
          track: TRACK,
          versionCode: VERSION_CODE,
          locale: "en-US",
          noteText: "notes",
        }),
      ),
    executeVerify: (requestId, signature) =>
      operations.handle(envelope({ kind: "execute_verify_committed", requestId, signature })),
    executeCommit: (requestId, signature) =>
      operations.handle(envelope({ kind: "execute_commit", requestId, signature })),
    executeOpen: (requestId, signature) =>
      operations.handle(envelope({ kind: "execute_open_edit", requestId, signature })),
    executeAttach: () =>
      operations.handle(
        envelope({
          kind: "attach_notes",
          track: TRACK,
          versionCode: VERSION_CODE,
          locale: "en-US",
          noteText: "notes",
        }),
      ),
    seedCommitApproval: async () => {
      const record = await pendingStore.prepare({
        operation: "commit",
        toolName: COMMIT_TOOL_NAME,
        permission: "publish",
        packageName,
        requestDigest: "e".repeat(64),
        intent: {
          kind: "commit",
          targetTrack: TRACK,
          versionCode: VERSION_CODE,
          editId: EDIT_ID,
          stateDigest: EXPECTED_DIGEST,
          validationExpiryTimeSeconds: VALIDATION_EXPIRY,
          releaseName: RELEASE_NAME,
          releaseStatus: RELEASE_STATUS,
        },
      });
      return record.requestId;
    },
    signRequest: async (requestId) => {
      const record = await pendingStore.load(requestId);
      if (record === undefined) throw new Error("pending record missing");
      const canonicalPayload = encodeOperatorApprovalPayload(approvalPayloadFor(record)).toString(
        "utf8",
      );
      return sign(null, Buffer.from(canonicalPayload, "utf8"), privateKey).toString("base64url");
    },
    journalRecords: async () => (await openJournal().list()).map((record) => record.state),
    approvalConsumptions: () =>
      readAuditEntries(approvalPath).filter((entry) => entry.type === "approval.consumed").length,
    claimExists: (requestId) => existsSync(requestClaimPath(claimRoot, requestId)),
    cleanupRecordIds: async () => (await cleanupJournal.list()).map((record) => record.editId),
  };
}

describe("daemon verify_committed: prepare authority", () => {
  it("offers a destructive Stage-3E.1 challenge bound to the durable ACK attempt", async () => {
    const harness = await buildHarness();
    const response = await harness.prepareVerify();

    expect(response.outcome).toBe("approval_required");
    expect(response.approval?.permission).toBe("destructive");
    expect(response.approval?.toolName).toBe("releases.verify_committed_release");
    expect(response.approval?.packageName).toBe(PACKAGE);

    // The digest is the Stage-3E.1 Layer-B digest of the journal-derived intent.
    const intent = createReleaseStateVerificationIntent({
      packageName: PACKAGE,
      targetTrack: TRACK,
      versionCode: VERSION_CODE,
      expectedReleaseName: RELEASE_NAME,
      expectedStateDigest: EXPECTED_DIGEST,
    });
    expect(response.approval?.requestDigest).toBe(
      createReleaseStateVerificationRequestDigest(intent),
    );
    expect(response.approval?.requestDigest).toBe(
      createReleaseStateVerificationApprovalBinding(intent).createRequestDigest({}),
    );

    // Zero Google operations during preparation.
    expect(harness.calls).toEqual({
      listReleaseSummaries: 0,
      createEdit: 0,
      getEdit: 0,
      getTrack: 0,
      updateTrack: 0,
      validateEdit: 0,
      commitEdit: 0,
      deleteEdit: 0,
      listBundles: 0,
    });

    // The pending record is schema-v2, destructive, and carries only the three
    // approved intent fields (no edit id, no release name, no notes).
    const record = await harness.pendingStore.load(response.approval?.requestId ?? "");
    expect(record?.schemaVersion).toBe(2);
    expect(record?.operation).toBe("verify_committed");
    expect(record?.permission).toBe("destructive");
    expect(record?.intent).toEqual({
      kind: "verify_committed",
      targetTrack: TRACK,
      versionCode: VERSION_CODE,
      expectedStateDigest: EXPECTED_DIGEST,
    });

    // The challenge never leaks the temporary edit identity or internal digests
    // beyond the request digest.
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain(TEMP_EDIT_ID);
    expect(serialized).not.toContain("verificationEditId");
    expect(await harness.journalRecords()).toEqual(["ACKNOWLEDGED"]);
  });

  it("creates no challenge without an acknowledged attempt", async () => {
    const harness = await buildHarness({ ackAttempts: 0, completedCommitProvenance: false });
    const response = await harness.prepareVerify();
    expect(response.outcome).toBe("local_state_failure");
    expect(response.error?.code).toBe("VERIFICATION_NO_ACKNOWLEDGED_ATTEMPT");
    expect(response.approval).toBeUndefined();
    expect(harness.calls.createEdit).toBe(0);
  });

  it("requires durable completed-commit provenance", async () => {
    const harness = await buildHarness({ completedCommitProvenance: false });
    const response = await harness.prepareVerify();
    expect(response.outcome).toBe("local_state_failure");
    expect(response.error?.code).toBe("VERIFICATION_PROVENANCE_MISSING");
    expect(harness.calls.createEdit).toBe(0);
  });

  it("creates no challenge for a different release identity", async () => {
    const harness = await buildHarness();
    const response = await harness.call({
      kind: "prepare_verify_committed",
      track: TRACK,
      versionCode: "43",
    });
    expect(response.outcome).toBe("local_state_failure");
    expect(response.error?.code).toBe("VERIFICATION_NO_ACKNOWLEDGED_ATTEMPT");
    expect(harness.calls.createEdit).toBe(0);
  });
});

describe("daemon verify_committed: authority selection is invariant-based", () => {
  const identity = { packageName: PACKAGE, targetTrack: TRACK, versionCode: VERSION_CODE };
  const base = {
    version: 1 as const,
    attemptId: "a1",
    packageName: PACKAGE,
    editId: EDIT_ID,
    expiryTimeSeconds: EXPIRY,
    targetTrack: TRACK,
    versionCode: VERSION_CODE,
    releaseName: RELEASE_NAME,
    releaseStatus: RELEASE_STATUS as "completed",
    expectedStateDigest: EXPECTED_DIGEST,
    validationExpiryTimeSeconds: VALIDATION_EXPIRY,
    requestDigest: COMMIT_REQUEST_DIGEST,
    attemptedAtUtc: AT,
    updatedAtUtc: AT,
  };

  it("treats a fresh ACK with no verification evidence as the only fresh authority", () => {
    const result = selectVerificationAttempt([{ ...base, state: "ACKNOWLEDGED" }], identity);
    expect(result).toEqual({
      ok: true,
      mode: "fresh",
      record: expect.objectContaining({ attemptId: "a1" }),
    });
  });

  it("classifies any verification prefix as local continuation, never a fresh attempt", () => {
    const result = selectVerificationAttempt(
      [{ ...base, state: "ACKNOWLEDGED", verificationInsertAttempted: true }],
      identity,
    );
    expect(result).toEqual({
      ok: true,
      mode: "recover",
      record: expect.objectContaining({ attemptId: "a1" }),
    });
  });

  it("treats REMOTE_VERIFIED as already verified", () => {
    const result = selectVerificationAttempt([{ ...base, state: "REMOTE_VERIFIED" }], identity);
    expect(result).toEqual({
      ok: true,
      mode: "already_verified",
      record: expect.objectContaining({ attemptId: "a1" }),
    });
  });

  it("refuses to guess when more than one attempt is unresolved", () => {
    const result = selectVerificationAttempt(
      [
        { ...base, state: "ACKNOWLEDGED" },
        { ...base, attemptId: "a2", state: "ACKNOWLEDGED" },
      ],
      identity,
    );
    expect(result).toEqual({ ok: false, refusal: { kind: "ambiguous" } });
  });

  it("maps a prepared attempt through the shared journal verdict", () => {
    const result = selectVerificationAttempt([{ ...base, state: "PREPARED" }], identity);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.kind).toBe("blocked");
  });

  it("reports no attempt for a different release identity", () => {
    const result = selectVerificationAttempt([{ ...base, state: "ACKNOWLEDGED" }], {
      ...identity,
      versionCode: "43",
    });
    expect(result).toEqual({ ok: false, refusal: { kind: "no_attempt" } });
  });
});

describe("daemon verify_committed: local safety guards", () => {
  it("refuses while a managed Play edit session is tracked", async () => {
    const harness = await buildHarness({ managedSession: true });
    const prepared = await harness.prepareVerify();
    expect(prepared.outcome).toBe("approval_required");
    const signature = await harness.signRequest(prepared.approval?.requestId ?? "");
    const response = await harness.executeVerify(prepared.approval?.requestId ?? "", signature);

    expect(response.outcome).toBe("local_state_failure");
    expect(response.error?.code).toBe("MANAGED_EDIT_ALREADY_OPEN");
    expect(harness.calls.createEdit).toBe(0);
    expect(harness.calls.listReleaseSummaries).toBe(0);
    expect(harness.approvalConsumptions()).toBe(0);
    expect(await harness.pendingStore.state(prepared.approval?.requestId ?? "")).toBe("pending");
    expect(await harness.journalRecords()).toEqual(["ACKNOWLEDGED"]);
  });

  it("refuses to create a second temporary edit over unresolved cleanup", async () => {
    const harness = await buildHarness({ unresolvedCleanup: true });
    const prepared = await harness.prepareVerify();
    const signature = await harness.signRequest(prepared.approval?.requestId ?? "");
    const response = await harness.executeVerify(prepared.approval?.requestId ?? "", signature);

    expect(response.outcome).toBe("cleanup_pending");
    expect(response.error?.code).toBe("VERIFICATION_CLEANUP_UNRESOLVED");
    expect(harness.calls.createEdit).toBe(0);
    expect(harness.calls.deleteEdit).toBe(0);
    expect(await harness.cleanupRecordIds()).toEqual([TEMP_EDIT_ID]);
    expect(harness.approvalConsumptions()).toBe(0);
  });

  it("rejects a bad signature before the package lease or any Google call", async () => {
    const harness = await buildHarness();
    const prepared = await harness.prepareVerify();
    const requestId = prepared.approval?.requestId ?? "";
    const response = await harness.executeVerify(requestId, "AAAA");

    expect(response.outcome).toBe("approval_mismatch");
    expect(response.error?.code).toBe("SIGNATURE_INVALID");
    expect(harness.claimExists(requestId)).toBe(false);
    expect(harness.approvalConsumptions()).toBe(0);
    expect(harness.calls).toEqual({
      listReleaseSummaries: 0,
      createEdit: 0,
      getEdit: 0,
      getTrack: 0,
      updateTrack: 0,
      validateEdit: 0,
      commitEdit: 0,
      deleteEdit: 0,
      listBundles: 0,
    });
    expect(await harness.journalRecords()).toEqual(["ACKNOWLEDGED"]);
  });

  it("refuses a signed request whose operation is not a verification", async () => {
    const harness = await buildHarness();
    const commitRequestId = await harness.seedCommitApproval();
    const signature = await harness.signRequest(commitRequestId);
    const response = await harness.executeVerify(commitRequestId, signature);
    expect(response.outcome).toBe("approval_mismatch");
    expect(response.error?.code).toBe("OPERATION_MISMATCH");
    expect(harness.calls.createEdit).toBe(0);
  });
});

describe("daemon verify_committed: normal destructive lifecycle", () => {
  it("verifies once, proves the journal, and settles COMPLETED", async () => {
    const harness = await buildHarness();
    const prepared = await harness.prepareVerify();
    const requestId = prepared.approval?.requestId ?? "";
    const signature = await harness.signRequest(requestId);

    const response = await harness.executeVerify(requestId, signature);
    expect(response.outcome).toBe("success");
    expect(response.error).toBeUndefined();

    // Exactly one temporary edit, one deep read, one delete. Never a track
    // mutation, never a commit, never a bundle read.
    expect(harness.calls.listReleaseSummaries).toBe(1);
    expect(harness.calls.createEdit).toBe(1);
    expect(harness.calls.getTrack).toBe(1);
    expect(harness.calls.deleteEdit).toBe(1);
    expect(harness.calls.updateTrack).toBe(0);
    expect(harness.calls.commitEdit).toBe(0);
    expect(harness.calls.validateEdit).toBe(0);

    // Durable journal proof.
    const journal = createFileReleaseCommitAttemptJournal(harness.journalPath, {
      expectedPackageName: PACKAGE,
    });
    const [record] = await journal.list();
    expect(record?.state).toBe("REMOTE_VERIFIED");
    expect(record?.verificationObservedStateDigest).toBe(EXPECTED_DIGEST);
    expect(record?.verificationObservedStateDigest).toBe(record?.expectedStateDigest);
    expect(record?.verificationCleanupVerified).toBe(true);
    // Stage 3E.3 stops at REMOTE_VERIFIED: never reconciled here.
    expect(record?.state).not.toBe("RECONCILED_COMMITTED");

    // Daemon settlement.
    expect(await harness.pendingStore.state(requestId)).toBe("completed");
    expect(harness.approvalConsumptions()).toBe(1);
    expect(harness.claimExists(requestId)).toBe(false);
    expect(await harness.cleanupRecordIds()).toEqual([]);
    expect(harness.coordinator.heldPackageOperationCount()).toBe(0);
    // No write-intent artifacts: verification is not a release write.
    expect(
      existsSync(join(harness.dir, "write-intents"))
        ? readdirSync(join(harness.dir, "write-intents"))
        : [],
    ).toEqual([]);
  });

  it("keeps the temporary edit identity out of the response and audit surfaces", async () => {
    const harness = await buildHarness();
    const prepared = await harness.prepareVerify();
    const requestId = prepared.approval?.requestId ?? "";
    const signature = await harness.signRequest(requestId);
    const response = await harness.executeVerify(requestId, signature);

    expect(JSON.stringify(response)).not.toContain(TEMP_EDIT_ID);
    const approvalEntries = JSON.stringify(readAuditEntries(harness.approvalPath));
    expect(approvalEntries).not.toContain(TEMP_EDIT_ID);
    expect(approvalEntries).toContain("operator_signature");
  });

  it("never re-verifies an already REMOTE_VERIFIED attempt and never reconciles it", async () => {
    const harness = await buildHarness();
    const prepared = await harness.prepareVerify();
    const requestId = prepared.approval?.requestId ?? "";
    const signature = await harness.signRequest(requestId);
    expect((await harness.executeVerify(requestId, signature)).outcome).toBe("success");

    // A second prepared approval for the same (now verified) attempt cannot
    // authorize another destructive verification.
    const second = await harness.prepareVerify();
    expect(second.outcome).toBe("success");
    expect(second.approval).toBeUndefined();

    const journal = createFileReleaseCommitAttemptJournal(harness.journalPath, {
      expectedPackageName: PACKAGE,
    });
    expect((await journal.list()).map((record) => record.state)).toEqual(["REMOTE_VERIFIED"]);
    expect(harness.calls.createEdit).toBe(1);
  });

  it("retires an unused approval when the durable proof already exists", async () => {
    const harness = await buildHarness();
    // Local continuation first: complete durable evidence with an ACK state.
    const journal = createFileReleaseCommitAttemptJournal(harness.journalPath, {
      expectedPackageName: PACKAGE,
    });
    const [record] = await journal.list();
    const attemptId = record?.attemptId ?? "";
    await journal.updateVerification(attemptId, "ACKNOWLEDGED", AT_LATER, {
      verificationInsertAttempted: true,
    });
    await journal.updateVerification(attemptId, "ACKNOWLEDGED", AT_LATER, {
      verificationEditId: TEMP_EDIT_ID,
      verificationEditExpiryTimeSeconds: EXPIRY,
    });
    await journal.updateVerification(attemptId, "ACKNOWLEDGED", AT_LATER, {
      verificationObservedStateDigest: EXPECTED_DIGEST,
      verificationObservedAtUtc: AT_LATER,
    });
    await journal.updateVerification(attemptId, "ACKNOWLEDGED", AT_LATER, {
      verificationPreDeleteReadVerified: true,
    });
    await journal.updateVerification(attemptId, "ACKNOWLEDGED", AT_LATER, {
      verificationDeleteAttempted: true,
    });
    await journal.updateVerification(attemptId, "ACKNOWLEDGED", AT_LATER, {
      verificationDeleteAcknowledged: true,
    });
    await journal.updateVerification(attemptId, "ACKNOWLEDGED", AT_LATER, {
      verificationCleanupVerified: true,
    });

    // Preparation must continue this locally, with zero Google operations.
    const prepared = await harness.prepareVerify();
    expect(prepared.outcome).toBe("success");
    expect(prepared.approval).toBeUndefined();
    expect(harness.calls.createEdit).toBe(0);
    expect(harness.calls.listReleaseSummaries).toBe(0);
    expect((await journal.list())[0]?.state).toBe("REMOTE_VERIFIED");
  });
});

describe("daemon verify_committed: mismatch, evidence failure and cleanup uncertainty", () => {
  it("reports a definite committed-state mismatch without auto-retry", async () => {
    const harness = await buildHarness();
    harness.faults.mismatchedDeepRead = true;
    const prepared = await harness.prepareVerify();
    const requestId = prepared.approval?.requestId ?? "";
    const signature = await harness.signRequest(requestId);

    const response = await harness.executeVerify(requestId, signature);
    expect(response.outcome).toBe("remote_failure");
    expect(response.error?.code).toBe("VERIFICATION_STATE_MISMATCH");
    expect(harness.calls.createEdit).toBe(1);
    expect(harness.calls.deleteEdit).toBe(1);
    expect(await harness.pendingStore.state(requestId)).toBe("recovery_required");
    expect(harness.claimExists(requestId)).toBe(true);
    const journal = createFileReleaseCommitAttemptJournal(harness.journalPath, {
      expectedPackageName: PACKAGE,
    });
    const [record] = await journal.list();
    expect(record?.state).toBe("ACKNOWLEDGED");
    expect(record?.verificationObservedStateDigest).toBeUndefined();
  });

  it("treats an unconfirmed temporary-edit delete as ambiguous and never retries", async () => {
    const harness = await buildHarness();
    harness.faults.failDelete = true;
    const prepared = await harness.prepareVerify();
    const requestId = prepared.approval?.requestId ?? "";
    const signature = await harness.signRequest(requestId);

    const response = await harness.executeVerify(requestId, signature);
    expect(response.outcome).toBe("external_state_ambiguous");
    expect(response.error?.code).toBe("VERIFICATION_EDIT_CLEANUP_FAILED");
    expect(harness.calls.createEdit).toBe(1);
    expect(harness.calls.deleteEdit).toBe(1);
    expect(await harness.pendingStore.state(requestId)).toBe("recovery_required");
    // The cleanup journal keeps the exact identity: that record is the recovery
    // authority, so no second temporary edit may be created.
    expect(await harness.cleanupRecordIds()).toEqual([TEMP_EDIT_ID]);
  });

  it("recovers from a local evidence write that failed after the durable write", async () => {
    let failedOnce = false;
    const harness = await buildHarness({
      wrapJournal: (journal) => ({
        ...journal,
        updateVerification: async (attemptId, from, updatedAtUtc, patch) => {
          const result = await journal.updateVerification(attemptId, from, updatedAtUtc, patch);
          if (patch.verificationCleanupVerified === true && !failedOnce) {
            failedOnce = true;
            // The durable write happened; the response is lost.
            throw new Error("simulated response failure after durable write");
          }
          return result;
        },
      }),
    });
    const prepared = await harness.prepareVerify();
    const requestId = prepared.approval?.requestId ?? "";
    const signature = await harness.signRequest(requestId);

    const response = await harness.executeVerify(requestId, signature);
    expect(response.outcome).toBe("success");
    expect(harness.calls.createEdit).toBe(1);
    expect(harness.calls.deleteEdit).toBe(1);
    expect(await harness.pendingStore.state(requestId)).toBe("completed");
    const journal = createFileReleaseCommitAttemptJournal(harness.journalPath, {
      expectedPackageName: PACKAGE,
    });
    expect((await journal.list())[0]?.state).toBe("REMOTE_VERIFIED");
  });

  it("fails closed with a retained durable prefix when a durable write truly fails", async () => {
    const harness = await buildHarness({
      wrapJournal: (journal) => ({
        ...journal,
        updateVerification: async (attemptId, from, updatedAtUtc, patch) => {
          if (patch.verificationDeleteAcknowledged === true) {
            throw new Error("durable verification write failed");
          }
          return journal.updateVerification(attemptId, from, updatedAtUtc, patch);
        },
      }),
    });
    const prepared = await harness.prepareVerify();
    const requestId = prepared.approval?.requestId ?? "";
    const signature = await harness.signRequest(requestId);

    const response = await harness.executeVerify(requestId, signature);
    expect(response.outcome).toBe("local_state_failure");
    expect(response.error?.code).toBe("VERIFICATION_EVIDENCE_PERSISTENCE_FAILED");
    expect(harness.calls.createEdit).toBe(1);
    expect(await harness.pendingStore.state(requestId)).toBe("recovery_required");
    const journal = createFileReleaseCommitAttemptJournal(harness.journalPath, {
      expectedPackageName: PACKAGE,
    });
    const [record] = await journal.list();
    expect(record?.state).toBe("ACKNOWLEDGED");
    expect(record?.verificationInsertAttempted).toBe(true);
    expect(record?.verificationCleanupVerified).toBeUndefined();

    // A later request must NOT start a second Google verification: the durable
    // prefix is continued locally instead.
    const second = await harness.prepareVerify();
    expect(second.outcome).toBe("external_state_ambiguous");
    expect(second.error?.code).toBe("VERIFICATION_EVIDENCE_INCOMPLETE");
    expect(harness.calls.createEdit).toBe(1);
  });
});

describe("daemon verify_committed: concurrent destructive approval", () => {
  it("cannot hold a second temporary edit across the same package", async () => {
    const harness = await buildHarness();
    // Hold the first verification inside its temporary insert.
    let release = (): void => undefined;
    harness.faults.createEditHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = await harness.prepareVerify();
    const firstId = first.approval?.requestId ?? "";
    const firstSignature = await harness.signRequest(firstId);
    const inFlight = harness.executeVerify(firstId, firstSignature);

    // Wait until the destructive insert is genuinely in flight.
    for (let index = 0; index < 1000 && harness.calls.createEdit === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(harness.calls.createEdit).toBe(1);
    expect(harness.coordinator.isPackageOperationHeld(PACKAGE)).toBe(true);

    // No peer — not even another verification — can enter package execution.
    expect(harness.coordinator.tryAcquirePackageOperation(PACKAGE).acquired).toBe(false);

    release();
    const settled = await inFlight;
    expect(settled.outcome).toBe("success");
    expect(harness.calls.createEdit).toBe(1);
  });

  it("settles exactly one winner for two competing approvals of the same attempt", async () => {
    const harness = await buildHarness();
    let release = (): void => undefined;
    harness.faults.createEditHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = await harness.prepareVerify();
    const second = await harness.prepareVerify();
    const firstId = first.approval?.requestId ?? "";
    const secondId = second.approval?.requestId ?? "";
    const firstSignature = await harness.signRequest(firstId);
    const secondSignature = await harness.signRequest(secondId);

    const running = harness.executeVerify(firstId, firstSignature);
    for (let index = 0; index < 1000 && harness.calls.createEdit === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const loser = await harness.executeVerify(secondId, secondSignature);
    expect(loser.outcome).toBe("operation_in_progress");
    expect(loser.error?.code).toBe("PACKAGE_OPERATION_IN_PROGRESS");
    // Only the winner has consumed so far, and the loser took no claim at all.
    expect(harness.approvalConsumptions()).toBe(1);
    expect(harness.claimExists(secondId)).toBe(false);

    release();
    expect((await running).outcome).toBe("success");
    expect(harness.calls.createEdit).toBe(1);
    expect(harness.approvalConsumptions()).toBe(1);
    // The losing request was never consumed and is still durably pending.
    expect(await harness.pendingStore.state(secondId)).toBe("pending");
  });

  it("blocks every other mutating operation for the same package", async () => {
    const harness = await buildHarness();
    const held = harness.coordinator.tryAcquirePackageOperation(PACKAGE);
    expect(held.acquired).toBe(true);

    const open = await harness.prepareOpen();
    const commitRequestId = await harness.seedCommitApproval();
    const openAnswer = await harness.executeOpen(
      open.approval?.requestId ?? "",
      await harness.signRequest(open.approval?.requestId ?? ""),
    );
    const commitAnswer = await harness.executeCommit(
      commitRequestId,
      await harness.signRequest(commitRequestId),
    );
    const attachAnswer = await harness.executeAttach();
    const verifyPending = await harness.prepareVerify();
    const verifyAnswer = await harness.executeVerify(
      verifyPending.approval?.requestId ?? "",
      await harness.signRequest(verifyPending.approval?.requestId ?? ""),
    );

    for (const answer of [openAnswer, commitAnswer, attachAnswer, verifyAnswer]) {
      expect(answer.outcome).toBe("operation_in_progress");
      expect(answer.error?.code).toBe("PACKAGE_OPERATION_IN_PROGRESS");
    }
    expect(harness.calls.createEdit).toBe(0);
    expect(harness.calls.updateTrack).toBe(0);
    expect(harness.calls.commitEdit).toBe(0);
    expect(harness.calls.listReleaseSummaries).toBe(0);
    expect(harness.approvalConsumptions()).toBe(0);

    if (held.acquired) harness.coordinator.releasePackageOperation(held.lease);
    expect(harness.coordinator.heldPackageOperationCount()).toBe(0);
  });

  it("keeps different packages independent", async () => {
    const harness = await buildHarness();
    const other = await buildHarness({ packageName: OTHER_PACKAGE });
    const held = harness.coordinator.tryAcquirePackageOperation(PACKAGE);
    expect(held.acquired).toBe(true);
    const otherHeld = other.coordinator.tryAcquirePackageOperation(OTHER_PACKAGE);
    expect(otherHeld.acquired).toBe(true);
    expect(harness.coordinator.isPackageOperationHeld(OTHER_PACKAGE)).toBe(false);
    if (held.acquired) harness.coordinator.releasePackageOperation(held.lease);
    if (otherHeld.acquired) other.coordinator.releasePackageOperation(otherHeld.lease);
  });
});

describe("daemon verify_committed: approval drift", () => {
  it("refuses a stale approval whose digest no longer matches the journal", async () => {
    const harness = await buildHarness();
    // A stale approval: signed for a different expected digest than the durable
    // journal now holds.
    const staleDigest = "d".repeat(64);
    const staleIntent = createReleaseStateVerificationIntent({
      packageName: PACKAGE,
      targetTrack: TRACK,
      versionCode: VERSION_CODE,
      expectedReleaseName: RELEASE_NAME,
      expectedStateDigest: staleDigest,
    });
    const staleBinding = createReleaseStateVerificationApprovalBinding(staleIntent);
    const stale = await harness.pendingStore.prepare({
      operation: "verify_committed",
      toolName: "releases.verify_committed_release",
      permission: "destructive",
      packageName: PACKAGE,
      requestDigest: staleBinding.createRequestDigest({}),
      intent: {
        kind: "verify_committed",
        targetTrack: TRACK,
        versionCode: VERSION_CODE,
        expectedStateDigest: staleDigest,
      },
    });
    const signature = await harness.signRequest(stale.requestId);

    const response = await harness.executeVerify(stale.requestId, signature);
    expect(response.outcome).toBe("local_state_failure");
    expect(response.error?.code).toBe("VERIFICATION_INTENT_DRIFT_STATE_DIGEST");
    expect(harness.calls.createEdit).toBe(0);
    expect(harness.approvalConsumptions()).toBe(0);
    expect(harness.claimExists(stale.requestId)).toBe(false);
    expect(await harness.pendingStore.state(stale.requestId)).toBe("pending");
    expect(harness.coordinator.heldPackageOperationCount()).toBe(0);
  });

  it("does not start a new verification when REMOTE_VERIFIED appears after prepare", async () => {
    const harness = await buildHarness();
    const prepared = await harness.prepareVerify();
    const requestId = prepared.approval?.requestId ?? "";
    const signature = await harness.signRequest(requestId);

    // Another execution (or the local bridge) completed the proof meanwhile.
    const journal = createFileReleaseCommitAttemptJournal(harness.journalPath, {
      expectedPackageName: PACKAGE,
    });
    const [record] = await journal.list();
    const attemptId = record?.attemptId ?? "";
    await journal.updateVerification(attemptId, "ACKNOWLEDGED", AT_LATER, {
      verificationInsertAttempted: true,
    });
    await journal.updateVerification(attemptId, "ACKNOWLEDGED", AT_LATER, {
      verificationEditId: TEMP_EDIT_ID,
      verificationEditExpiryTimeSeconds: EXPIRY,
    });
    await journal.updateVerification(attemptId, "ACKNOWLEDGED", AT_LATER, {
      verificationObservedStateDigest: EXPECTED_DIGEST,
      verificationObservedAtUtc: AT_LATER,
    });
    await journal.updateVerification(attemptId, "ACKNOWLEDGED", AT_LATER, {
      verificationPreDeleteReadVerified: true,
    });
    await journal.updateVerification(attemptId, "ACKNOWLEDGED", AT_LATER, {
      verificationDeleteAttempted: true,
    });
    await journal.updateVerification(attemptId, "ACKNOWLEDGED", AT_LATER, {
      verificationDeleteAcknowledged: true,
    });
    await journal.updateVerification(attemptId, "ACKNOWLEDGED", AT_LATER, {
      verificationCleanupVerified: true,
    });

    const response = await harness.executeVerify(requestId, signature);
    expect(response.outcome).toBe("success");
    expect(harness.calls.createEdit).toBe(0);
    expect(harness.calls.listReleaseSummaries).toBe(0);
    expect(await harness.pendingStore.state(requestId)).toBe("recovery_required");
    expect(harness.approvalConsumptions()).toBe(0);
    expect((await journal.list())[0]?.state).toBe("REMOTE_VERIFIED");
  });
});

describe("daemon verify_committed: direct dependency entrypoints", () => {
  it("fails closed when a REMOTE_VERIFIED record lacks the complete proof", async () => {
    // The journal legally allows REMOTE_VERIFIED with an observed digest but no
    // confirmed cleanup. That must never be reported as success: the last guard
    // re-reads the record and refuses.
    const harness = await buildHarness({ ackAttempts: 0 });
    const journal = createFileReleaseCommitAttemptJournal(harness.journalPath, {
      expectedPackageName: PACKAGE,
    });
    const prepared = await journal.prepare({
      version: 1,
      packageName: PACKAGE,
      editId: EDIT_ID,
      expiryTimeSeconds: EXPIRY,
      targetTrack: TRACK,
      versionCode: VERSION_CODE,
      releaseName: RELEASE_NAME,
      releaseStatus: RELEASE_STATUS as "completed",
      expectedStateDigest: EXPECTED_DIGEST,
      validationExpiryTimeSeconds: VALIDATION_EXPIRY,
      requestDigest: COMMIT_REQUEST_DIGEST,
      attemptedAtUtc: AT,
      updatedAtUtc: AT,
    });
    await journal.transition(prepared.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", AT_LATER);
    await journal.transition(prepared.attemptId, "TRANSPORT_ATTEMPTED", "ACKNOWLEDGED", AT_LATER, {
      acknowledgedAtUtc: AT_LATER,
    });
    // The journal's own rules require the temporary identity before an observed
    // proof, and allow a remote-verified record with no confirmed cleanup.
    await journal.updateVerification(prepared.attemptId, "ACKNOWLEDGED", AT_LATER, {
      verificationInsertAttempted: true,
    });
    await journal.updateVerification(prepared.attemptId, "ACKNOWLEDGED", AT_LATER, {
      verificationEditId: TEMP_EDIT_ID,
      verificationEditExpiryTimeSeconds: EXPIRY,
    });
    await journal.updateVerification(prepared.attemptId, "ACKNOWLEDGED", AT_LATER, {
      verificationObservedStateDigest: EXPECTED_DIGEST,
      verificationObservedAtUtc: AT_LATER,
    });
    await journal.transition(prepared.attemptId, "ACKNOWLEDGED", "REMOTE_VERIFIED", AT_LATER);
    const [record] = await journal.list();
    expect(record?.state).toBe("REMOTE_VERIFIED");
    expect(record?.verificationCleanupVerified).toBeUndefined();

    const preparedAnswer = await harness.prepareVerify();
    expect(preparedAnswer.outcome).toBe("external_state_ambiguous");
    expect(preparedAnswer.error?.code).toBe("VERIFICATION_JOURNAL_NOT_CONFIRMED");
    expect(preparedAnswer.approval).toBeUndefined();

    // A stale approval for the same attempt must not turn it into success either.
    const stale = await harness.pendingStore.prepare({
      operation: "verify_committed",
      toolName: "releases.verify_committed_release",
      permission: "destructive",
      packageName: PACKAGE,
      requestDigest: createReleaseStateVerificationApprovalBinding(
        createReleaseStateVerificationIntent({
          packageName: PACKAGE,
          targetTrack: TRACK,
          versionCode: VERSION_CODE,
          expectedReleaseName: RELEASE_NAME,
          expectedStateDigest: EXPECTED_DIGEST,
        }),
      ).createRequestDigest({}),
      intent: {
        kind: "verify_committed",
        targetTrack: TRACK,
        versionCode: VERSION_CODE,
        expectedStateDigest: EXPECTED_DIGEST,
      },
    });
    const signature = await harness.signRequest(stale.requestId);
    const executed = await harness.executeVerify(stale.requestId, signature);
    expect(executed.outcome).toBe("external_state_ambiguous");
    expect(executed.error?.code).toBe("VERIFICATION_JOURNAL_NOT_CONFIRMED");
    expect(harness.calls.createEdit).toBe(0);
    expect(harness.calls.listReleaseSummaries).toBe(0);
    expect(harness.approvalConsumptions()).toBe(0);
    expect(await harness.pendingStore.state(stale.requestId)).toBe("pending");
    expect((await journal.list())[0]?.state).toBe("REMOTE_VERIFIED");
  });

  it("refuses local continuation from prepare while the package lease is held", async () => {
    const harness = await buildHarness();
    const journal = createFileReleaseCommitAttemptJournal(harness.journalPath, {
      expectedPackageName: PACKAGE,
    });
    const [seeded] = await journal.list();
    await seedCompleteEvidence(journal, seeded?.attemptId ?? "", AT_LATER);

    const held = harness.coordinator.tryAcquirePackageOperation(PACKAGE);
    expect(held.acquired).toBe(true);
    const blocked = await harness.prepareVerify();
    expect(blocked.outcome).toBe("operation_in_progress");
    expect(blocked.error?.code).toBe("PACKAGE_OPERATION_IN_PROGRESS");
    expect(blocked.approval).toBeUndefined();
    // Nothing was mutated while another execution owns the package.
    expect((await journal.list())[0]?.state).toBe("ACKNOWLEDGED");
    expect(harness.calls.createEdit).toBe(0);
    expect(harness.calls.listReleaseSummaries).toBe(0);

    if (held.acquired) harness.coordinator.releasePackageOperation(held.lease);
    const resumed = await harness.prepareVerify();
    expect(resumed.outcome).toBe("success");
    expect(harness.calls.createEdit).toBe(0);
    expect((await journal.list())[0]?.state).toBe("REMOTE_VERIFIED");
  });

  it("prepare and execute are reachable with the coordinator passed explicitly", async () => {
    const harness = await buildHarness();
    const coordinator = createPackageOperationSingleFlightCoordinator();
    const prepared = await prepareVerifyCommitted(harness.verifyDeps, coordinator, CORRELATION, {
      track: TRACK,
      versionCode: VERSION_CODE,
    });
    expect(prepared.outcome).toBe("approval_required");
    const requestId = prepared.approval?.requestId ?? "";
    const signature = await harness.signRequest(requestId);
    const executed = await executeVerifyCommitted(
      harness.verifyDeps,
      coordinator,
      CORRELATION,
      requestId,
      signature,
    );
    expect(executed.outcome).toBe("success");
    expect(coordinator.heldPackageOperationCount()).toBe(0);
  });
});

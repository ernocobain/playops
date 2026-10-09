/**
 * Stage 3E.2D — cross-operation package coordination.
 *
 * Real: the dispatcher, pending store (schema v2), exclusive O_EXCL request
 * claims, operator Ed25519 verification, the operator_signature resolver,
 * executeOneTool/runAgent, the production open/attach/commit tools with their
 * verifiers, the managed-session store, the release write-intent store, the
 * commit-attempt journal, the Stage-3B socket server and the ONE shared
 * package-operation coordinator.
 *
 * Fake: the Google gateway only. Offline throughout; no network, no real Google.
 *
 * The Stage-3E.2C audit found real cross-operation TOCTOU windows; every test
 * below closes one of them with a deterministic in-flight interleaving. No test
 * relies on Google-side edit invalidation as serialization proof.
 */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAuditEntries } from "../src/audit/index.js";
import type { ReleaseCommitAttemptJournal } from "../src/releases/commit-attempt-journal.js";
import { createFileReleaseCommitAttemptJournal } from "../src/releases/commit-attempt-journal.js";
import type { DaemonCommitDependencies } from "../src/daemon/commit-operations.js";
import type { DaemonAttachNotesDependencies } from "../src/daemon/attach-notes.js";
import { createDaemonOperations, type DaemonOperations } from "../src/daemon/operations.js";
import {
  createFilePendingOperationStore,
  type PendingOperationStore,
} from "../src/daemon/pending-store.js";
import { createPackageOperationSingleFlightCoordinator } from "../src/daemon/package-operation-singleflight.js";
import {
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
  encodeDaemonFrame,
  parseDaemonRequest,
  type DaemonRequest,
  type DaemonResponseEnvelope,
} from "../src/daemon/protocol.js";
import { requestClaimPath } from "../src/daemon/request-claim.js";
import { createDaemonServer, type DaemonServer } from "../src/daemon/server.js";
import type {
  ReleaseCommitGateway,
  ReleaseEditGateway,
  ReleaseEditReadback,
  ReleaseTrackUpdateGateway,
} from "../src/releases/gateway.js";
import {
  RELEASE_CONFIGURATION_STATUSES,
  RELEASE_EDIT_SESSION_VERSION,
  type GooglePlayEditSession,
  type ReleaseBundle,
  type ReleaseTrackState,
  type ReleaseTrackUpdateRequest,
} from "../src/releases/index.js";
import {
  createFileReleaseWriteIntentStore,
  releaseWriteIntentPath,
  type ReleaseWriteIntentStore,
} from "../src/releases/release-write-intent-store.js";
import {
  createFileReleaseEditSessionStore,
  type ReleaseEditSessionStore,
} from "../src/releases/session-store.js";
import { createReleaseEditOpenTool } from "../src/releases/open-tool.js";
import { createFileAgentLedger } from "../src/runtime/agent/index.js";
import { createFileApprovalLedger } from "../src/runtime/approvals/index.js";
import { createOperatorApprovalVerifier } from "../src/runtime/approvals/operator-signature.js";
import { ToolRegistry } from "../src/runtime/tools/index.js";
import { createFileVerificationLedger } from "../src/runtime/verification/index.js";
import { createConnection } from "node:net";

const PACKAGE = "com.example.coordinated";
const OTHER_PACKAGE = "com.example.coordinated.other";
const EDIT_A = "edit-alpha";
const TRACK = "internal";
const VERSION_CODE = "42";
const EXPIRY = "1900000000";
const VALIDATION_EXPIRY = EXPIRY;
const EXPIRED = "1700000000";
const LOCALE = "en-US";
const NOTE_TEXT = "Coordinated release notes";
const CORRELATION = "coordination-corr";
const RELEASE_NAME = "42 (1.0)";

const dirs: string[] = [];
const servers: DaemonServer[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-coordination-"));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  return dir;
}

function trackState(): ReleaseTrackState {
  return {
    track: TRACK,
    releases: [
      {
        name: RELEASE_NAME,
        status: RELEASE_CONFIGURATION_STATUSES[2],
        versionCodes: [VERSION_CODE],
      },
    ],
  };
}

function bundles(): readonly ReleaseBundle[] {
  return [{ versionCode: VERSION_CODE, sha256: "b".repeat(64), sha1: "c".repeat(40) }];
}

interface Faults {
  createEditHold: Promise<void> | undefined;
  getEditHold: Promise<void> | undefined;
  getTrackHold: Promise<void> | undefined;
  updateTrackHold: Promise<void> | undefined;
  validateEditHold: Promise<void> | undefined;
  commitEditHold: Promise<void> | undefined;
}

interface CoordinationHarness {
  readonly dir: string;
  readonly packageName: string;
  readonly operations: DaemonOperations;
  readonly packageOperations: ReturnType<typeof createPackageOperationSingleFlightCoordinator>;
  readonly pendingStore: PendingOperationStore;
  readonly sessionStore: ReleaseEditSessionStore;
  readonly writeIntentStore: ReleaseWriteIntentStore;
  readonly writeIntentFile: string;
  readonly journal: ReleaseCommitAttemptJournal;
  readonly journalPath: string;
  readonly claimRoot: string;
  readonly approvalPath: string;
  readonly privateKey: KeyObject;
  readonly faults: Faults;
  readonly calls: {
    createEdit: number;
    listBundles: number;
    updateTrack: number;
    getTrack: number;
    getEdit: number;
    validateEdit: number;
    commitEdit: number;
  };
  envelope(request: unknown): ReturnType<typeof parseDaemonRequest>;
  call(request: DaemonRequest): Promise<DaemonResponseEnvelope>;
  prepareSignedOpen(): Promise<{ requestId: string; signature: string }>;
  prepareSignedCommit(): Promise<{ requestId: string; signature: string }>;
  executeOpen(requestId: string, signature: string): Promise<DaemonResponseEnvelope>;
  executeCommit(requestId: string, signature: string): Promise<DaemonResponseEnvelope>;
  attach(overrides?: Record<string, string>): Promise<DaemonResponseEnvelope>;
  gateState(): Promise<string>;
  journalRecords(): Promise<readonly string[]>;
  claimExists(requestId: string): boolean;
  consumptionCount(): number;
  sessionEditId(): Promise<string | undefined>;
}

interface HarnessOptions {
  readonly packageName?: string;
  /**
   * `active` tracks an unexpired managed edit, `expired` tracks an expired one,
   * `none` tracks nothing.
   */
  readonly session?: "active" | "expired" | "none";
  readonly wrapPendingStore?: (store: PendingOperationStore) => PendingOperationStore;
  /** Deliberate mis-wiring probe: gives the attach slot its own package name. */
  readonly attachPackageName?: string;
}

async function buildHarness(options: HarnessOptions = {}): Promise<CoordinationHarness> {
  const dir = tempDir();
  const packageName = options.packageName ?? PACKAGE;
  const pendingRoot = join(dir, "pending");
  mkdirSync(pendingRoot, { mode: 0o700 });
  const rawPendingStore = createFilePendingOperationStore(pendingRoot);
  const pendingStore =
    options.wrapPendingStore === undefined
      ? rawPendingStore
      : options.wrapPendingStore(rawPendingStore);
  const claimRoot = join(dir, "claims");
  const sessionStore = createFileReleaseEditSessionStore(join(dir, "edit-session.json"), {
    expectedPackageName: packageName,
  });
  const tracked = options.session ?? "active";
  if (tracked !== "none") {
    await sessionStore.save({
      version: RELEASE_EDIT_SESSION_VERSION,
      packageName,
      editId: EDIT_A,
      expiryTimeSeconds: tracked === "expired" ? EXPIRED : EXPIRY,
      createdAt: new Date().toISOString(),
    });
  }

  const faults: Faults = {
    createEditHold: undefined,
    getEditHold: undefined,
    getTrackHold: undefined,
    updateTrackHold: undefined,
    validateEditHold: undefined,
    commitEditHold: undefined,
  };
  const calls = {
    createEdit: 0,
    listBundles: 0,
    updateTrack: 0,
    getTrack: 0,
    getEdit: 0,
    validateEdit: 0,
    commitEdit: 0,
  };
  let managed: ReleaseTrackState = trackState();

  const gateway = {
    async createEdit(): Promise<GooglePlayEditSession> {
      calls.createEdit += 1;
      if (faults.createEditHold !== undefined) await faults.createEditHold;
      return { packageName, editId: EDIT_A, expiryTimeSeconds: EXPIRY };
    },
    async getEdit(session: GooglePlayEditSession): Promise<ReleaseEditReadback> {
      calls.getEdit += 1;
      if (faults.getEditHold !== undefined) await faults.getEditHold;
      return { id: session.editId, expiryTimeSeconds: session.expiryTimeSeconds };
    },
    async listTracks(): Promise<readonly ReleaseTrackState[]> {
      return [];
    },
    async listBundles(): Promise<readonly ReleaseBundle[]> {
      calls.listBundles += 1;
      return bundles();
    },
    async getTrack(): Promise<ReleaseTrackState> {
      calls.getTrack += 1;
      if (faults.getTrackHold !== undefined) await faults.getTrackHold;
      return structuredClone(managed);
    },
    async updateTrack(
      _session: GooglePlayEditSession,
      targetTrack: string,
      request: ReleaseTrackUpdateRequest,
    ): Promise<ReleaseTrackState> {
      calls.updateTrack += 1;
      if (faults.updateTrackHold !== undefined) await faults.updateTrackHold;
      managed = {
        track: targetTrack,
        releases: structuredClone(request.releases),
      };
      return structuredClone(managed);
    },
    async validateEdit(): Promise<ReleaseEditReadback> {
      calls.validateEdit += 1;
      if (faults.validateEditHold !== undefined) await faults.validateEditHold;
      return { id: EDIT_A, expiryTimeSeconds: VALIDATION_EXPIRY };
    },
    async commitEdit(): Promise<ReleaseEditReadback> {
      calls.commitEdit += 1;
      if (faults.commitEditHold !== undefined) await faults.commitEditHold;
      return { id: EDIT_A, expiryTimeSeconds: EXPIRY };
    },
  };
  const editGateway: ReleaseEditGateway = gateway;
  const trackGateway: ReleaseTrackUpdateGateway = gateway;
  const commitGateway: ReleaseCommitGateway = gateway;

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const verificationLedger = createFileVerificationLedger(join(dir, "verification.jsonl"));
  const ledger = createFileAgentLedger(join(dir, "agent.jsonl"));
  const approvalPath = join(dir, "approval.jsonl");

  const openBuilt = createReleaseEditOpenTool({
    packageName,
    gateway: editGateway,
    store: sessionStore,
  });
  const registry = new ToolRegistry();
  registry.register(openBuilt.tool);

  const journalPath = join(dir, "commit-attempt-journal.json");
  const openJournal = (): ReleaseCommitAttemptJournal =>
    createFileReleaseCommitAttemptJournal(journalPath, { expectedPackageName: packageName });
  const writeIntentRoot = join(dir, "write-intents");
  const writeIntentStore = createFileReleaseWriteIntentStore(writeIntentRoot);

  const attachDeps: DaemonAttachNotesDependencies = {
    packageName: options.attachPackageName ?? packageName,
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
    commitAuditLedger: {
      append: async (): Promise<void> => undefined,
    },
    openCommitAttemptJournal: openJournal,
    operatorVerifier: createOperatorApprovalVerifier(publicKey, "coordination-anchor"),
    ledger,
    approvalLedger: createFileApprovalLedger(approvalPath),
    verificationLedger,
  };

  const packageOperations = createPackageOperationSingleFlightCoordinator();
  const operations = createDaemonOperations({
    packageName,
    pendingStore,
    claimRoot,
    packageOperations,
    registry,
    openEdit: { binding: openBuilt.binding, input: {} },
    attachNotes: attachDeps,
    commit: commitDeps,
    operatorVerifier: commitDeps.operatorVerifier,
    ledger,
    approvalLedger: commitDeps.approvalLedger,
    verificationLedger,
  });

  const envelope = (request: unknown): ReturnType<typeof parseDaemonRequest> =>
    parseDaemonRequest({
      protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
      correlationId: CORRELATION,
      request,
    });

  const prepareSigned = async (kind: "prepare_open_edit" | "prepare_commit") => {
    const prepared = await operations.handle(
      envelope(
        kind === "prepare_open_edit" ? { kind } : { kind, track: TRACK, versionCode: VERSION_CODE },
      ),
    );
    expect(prepared.outcome).toBe("approval_required");
    const approval = prepared.approval;
    if (approval === undefined) throw new Error("prepare returned no approval challenge");
    return {
      requestId: approval.requestId,
      signature: sign(null, Buffer.from(approval.canonicalPayload, "utf8"), privateKey).toString(
        "base64url",
      ),
    };
  };

  return {
    dir,
    packageName,
    operations,
    packageOperations,
    pendingStore,
    sessionStore,
    writeIntentStore,
    writeIntentFile: releaseWriteIntentPath(writeIntentRoot, packageName, EDIT_A),
    journal: openJournal(),
    journalPath,
    claimRoot,
    approvalPath,
    privateKey,
    faults,
    calls,
    envelope,
    call: (request: DaemonRequest): Promise<DaemonResponseEnvelope> =>
      operations.handle(envelope(request)),
    prepareSignedOpen: () => prepareSigned("prepare_open_edit"),
    prepareSignedCommit: () => prepareSigned("prepare_commit"),
    executeOpen: (requestId: string, signature: string) =>
      operations.handle(envelope({ kind: "execute_open_edit", requestId, signature })),
    executeCommit: (requestId: string, signature: string) =>
      operations.handle(envelope({ kind: "execute_commit", requestId, signature })),
    attach: (overrides = {}): Promise<DaemonResponseEnvelope> =>
      operations.handle(
        envelope({
          kind: "attach_notes",
          track: TRACK,
          versionCode: VERSION_CODE,
          locale: LOCALE,
          noteText: NOTE_TEXT,
          ...overrides,
        }),
      ),
    gateState: async (): Promise<string> => {
      const gate = await writeIntentStore.inspect({ packageName, editId: EDIT_A });
      return gate.status === "clear" ? "clear" : gate.state;
    },
    journalRecords: async (): Promise<readonly string[]> =>
      (await openJournal().list()).map((record) => record.state),
    claimExists: (requestId: string): boolean => existsSync(requestClaimPath(claimRoot, requestId)),
    consumptionCount: (): number =>
      readAuditEntries(approvalPath).filter((entry) => entry.type === "approval.consumed").length,
    sessionEditId: async (): Promise<string | undefined> => (await sessionStore.load())?.editId,
  };
}

/** A controllable latch: the test decides exactly when the holder may finish. */
function latch(): { readonly promise: Promise<void>; open(): void } {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    open: (): void => {
      release?.();
    },
  };
}

/**
 * Bounded wait for an observed side effect of the in-flight operation.
 *
 * Uses real timers so the event loop keeps running: a genuine "the operation
 * never got that far" bug then fails this test instead of hanging it forever.
 */
async function waitUntil(
  label: string,
  condition: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// // -------------------------------------------- one shared instance (§4)

describe("package operation coordination: ONE shared coordinator instance", () => {
  it("gates execute_open_edit, attach_notes and execute_commit through the same instance", async () => {
    const harness = await buildHarness();
    const open = await harness.prepareSignedOpen();
    const commit = await harness.prepareSignedCommit();

    const held = harness.packageOperations.tryAcquirePackageOperation(PACKAGE);
    expect(held.acquired).toBe(true);

    // A per-operation coordinator would make any of these invisible.
    const openAnswer = await harness.executeOpen(open.requestId, open.signature);
    const attachAnswer = await harness.attach();
    const commitAnswer = await harness.executeCommit(commit.requestId, commit.signature);

    for (const answer of [openAnswer, attachAnswer, commitAnswer]) {
      expect(answer.outcome).toBe("operation_in_progress");
      expect(answer.error?.code).toBe("PACKAGE_OPERATION_IN_PROGRESS");
    }
    expect(harness.calls.createEdit).toBe(0);
    expect(harness.calls.updateTrack).toBe(0);
    expect(harness.calls.commitEdit).toBe(0);
    expect(await harness.journalRecords()).toEqual([]);
    expect(existsSync(harness.writeIntentFile)).toBe(false);

    if (held.acquired) harness.packageOperations.releasePackageOperation(held.lease);
    expect(harness.packageOperations.heldPackageOperationCount()).toBe(0);
  });

  it("refuses a composition whose operation slots disagree on the package", async () => {
    // The lease key must come from ONE trusted value. A composition that gave
    // the attach slot its own package name would otherwise split the exclusion
    // domain in silence, so construction must fail closed instead.
    const miswired = await buildHarness({ attachPackageName: OTHER_PACKAGE }).then(
      () => "constructed",
      (cause: unknown) => (cause as Error).message,
    );
    expect(miswired).toBe(
      "Every served operation must be configured with the same trusted package name.",
    );
  });

  it("admits different packages concurrently and never serializes globally", async () => {
    const coordinator = createPackageOperationSingleFlightCoordinator();
    const first = coordinator.tryAcquirePackageOperation(PACKAGE);
    const second = coordinator.tryAcquirePackageOperation(OTHER_PACKAGE);
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(true);
    expect(coordinator.heldPackageOperationCount()).toBe(2);

    // Independent daemon instances (one package each) do not interfere either.
    const otherHarness = await buildHarness({ packageName: OTHER_PACKAGE, session: "none" });
    const otherOpen = await otherHarness.prepareSignedOpen();
    const otherHeld = otherHarness.packageOperations.tryAcquirePackageOperation(OTHER_PACKAGE);
    expect(otherHeld.acquired).toBe(true);
    const answer = await otherHarness.executeOpen(otherOpen.requestId, otherOpen.signature);
    expect(answer.outcome).toBe("operation_in_progress");
    // The A-package hold did not block package B's own coordinator state.
    expect(otherHarness.calls.createEdit).toBe(0);
    if (otherHeld.acquired) otherHarness.packageOperations.releasePackageOperation(otherHeld.lease);
    const released = await otherHarness.executeOpen(otherOpen.requestId, otherOpen.signature);
    expect(released.outcome).toBe("success");
    if (first.acquired) coordinator.releasePackageOperation(first.lease);
    if (second.acquired) coordinator.releasePackageOperation(second.lease);
  });
});

// --------------------------------------------------- open vs open (§6)

describe("open vs open: exactly one edits.insert", () => {
  it("refuses the second approved open while the first is inside its remote insert", async () => {
    const harness = await buildHarness({ session: "none" });
    const first = await harness.prepareSignedOpen();
    const second = await harness.prepareSignedOpen();
    expect(first.requestId).not.toBe(second.requestId);

    const hold = latch();
    harness.faults.createEditHold = hold.promise;
    const winner = harness.executeOpen(first.requestId, first.signature);
    // Wait until the winner is provably inside its remote insert.
    await waitUntil("the winner's edits.insert", () => harness.calls.createEdit >= 1);

    const loser = await harness.executeOpen(second.requestId, second.signature);
    expect(loser.outcome).toBe("operation_in_progress");
    expect(loser.error?.code).toBe("PACKAGE_OPERATION_IN_PROGRESS");
    // The loser took no claim, consumed no approval and made no remote call.
    expect(harness.claimExists(second.requestId)).toBe(false);
    expect(harness.consumptionCount()).toBe(1);
    expect(await harness.pendingStore.state(second.requestId)).toBe("pending");
    expect(harness.calls.createEdit).toBe(1);

    hold.open();
    expect((await winner).outcome).toBe("success");
    expect(harness.calls.createEdit).toBe(1);
    expect(await harness.sessionEditId()).toBe(EDIT_A);

    // After the winner settles, the same approval follows normal preconditions.
    // The coordination guarantee is that no SECOND insert happens. How a burned
    // destructive request maps its outcome is existing daemon behaviour: the
    // open tool refuses the already-tracked session before any mutation and the
    // runtime reports the thrown refusal as EXECUTION_FAILED.
    const retry = await harness.executeOpen(second.requestId, second.signature);
    expect(retry.outcome).not.toBe("success");
    expect(retry.error?.code).toBe("EXECUTION_FAILED");
    expect(harness.calls.createEdit).toBe(1);
    expect(await harness.sessionEditId()).toBe(EDIT_A);
  });
});

// ------------------------------------------ attach vs commit (§8)

describe("attach vs commit: the Stage-3E.2C TOCTOU window is closed", () => {
  it("blocks attach_notes while commit holds the lease after its write-intent recheck", async () => {
    const harness = await buildHarness();
    const commit = await harness.prepareSignedCommit();

    // validateEdit is reached only by the commit path, and only AFTER the
    // package lease, the journal recheck and the write-intent recheck.
    // prepare_commit already consumed the first call, so call 2 is the execute
    // path: the exact point the Stage-3E.2C audit identified as the TOCTOU start.
    const hold = latch();
    harness.faults.validateEditHold = hold.promise;
    const committing = harness.executeCommit(commit.requestId, commit.signature);
    await waitUntil(
      "the commit's post-recheck validateEdit",
      () => harness.calls.validateEdit >= 2,
    );

    const blocked = await harness.attach();
    expect(blocked.outcome).toBe("operation_in_progress");
    expect(blocked.error?.code).toBe("PACKAGE_OPERATION_IN_PROGRESS");
    expect(harness.calls.updateTrack).toBe(0);
    expect(await harness.gateState()).toBe("clear");
    expect(existsSync(harness.writeIntentFile)).toBe(false);

    hold.open();
    expect((await committing).outcome).toBe("success");
    expect(harness.calls.commitEdit).toBe(1);
    expect(harness.packageOperations.heldPackageOperationCount()).toBe(0);
  });

  it("blocks execute_commit at the lease while attach_notes is in flight", async () => {
    const harness = await buildHarness();
    const commit = await harness.prepareSignedCommit();

    const hold = latch();
    harness.faults.getTrackHold = hold.promise;
    // Baseline-relative: `prepare_commit` performs its own track read, so an
    // absolute `>= 1` would return before attach reaches its derivation and the
    // wait would prove nothing.
    const readsBefore = harness.calls.getTrack;
    const attaching = harness.attach();
    await waitUntil("attach's target derivation", () => harness.calls.getTrack > readsBefore);

    const blocked = await harness.executeCommit(commit.requestId, commit.signature);
    expect(blocked.outcome).toBe("operation_in_progress");
    expect(blocked.error?.code).toBe("PACKAGE_OPERATION_IN_PROGRESS");
    expect(harness.calls.commitEdit).toBe(0);
    // Never reached the authoritative journal / write-gate / approval section.
    expect(await harness.journalRecords()).toEqual([]);
    expect(await harness.pendingStore.state(commit.requestId)).toBe("pending");
    expect(harness.claimExists(commit.requestId)).toBe(false);

    hold.open();
    expect((await attaching).outcome).toBe("success");
    expect(harness.calls.updateTrack).toBe(1);
    expect(await harness.gateState()).toBe("clear");
  });
});

// ------------------------------------------- open vs attach (§9)

describe("open vs attach_notes", () => {
  it("prevents edits.insert while attach_notes holds the package lease", async () => {
    const harness = await buildHarness();
    const open = await harness.prepareSignedOpen();

    const hold = latch();
    harness.faults.updateTrackHold = hold.promise;
    const attaching = harness.attach();
    await waitUntil("attach's tracks.update", () => harness.calls.updateTrack >= 1);

    const blocked = await harness.executeOpen(open.requestId, open.signature);
    expect(blocked.outcome).toBe("operation_in_progress");
    expect(blocked.error?.code).toBe("PACKAGE_OPERATION_IN_PROGRESS");
    expect(harness.calls.createEdit).toBe(0);

    hold.open();
    expect((await attaching).outcome).toBe("success");
    expect(harness.calls.createEdit).toBe(0);
  });

  it("prevents write-intent acquisition and tracks.update while open_edit holds the lease, even with an expired tracked session", async () => {
    const harness = await buildHarness({ session: "expired" });
    const open = await harness.prepareSignedOpen();

    const hold = latch();
    harness.faults.createEditHold = hold.promise;
    const opening = harness.executeOpen(open.requestId, open.signature);
    await waitUntil("the open's edits.insert", () => harness.calls.createEdit >= 1);

    const blocked = await harness.attach();
    expect(blocked.outcome).toBe("operation_in_progress");
    expect(blocked.error?.code).toBe("PACKAGE_OPERATION_IN_PROGRESS");
    expect(harness.calls.updateTrack).toBe(0);
    // The expired tracked session is never used as the safety mechanism.
    expect(await harness.gateState()).toBe("clear");
    expect(existsSync(harness.writeIntentFile)).toBe(false);

    hold.open();
    expect((await opening).outcome).toBe("success");
    expect(harness.calls.createEdit).toBe(1);
  });
});

// ------------------------------------------- open vs commit (§10)

describe("open vs commit", () => {
  it("refuses a new edits.insert after the commit cleared the session but before it settled", async () => {
    const hold = latch();
    const harness = await buildHarness({
      wrapPendingStore: (store) => ({
        load: (requestId) => store.load(requestId),
        state: (requestId) => store.state(requestId),
        list: () => store.list(),
        prepare: (input) => store.prepare(input),
        transition: async (requestId, from, to) => {
          // Hold the commit's settlement so the test can inspect the exact
          // window between "session cleared" and "request settled".
          if (from === "CONSUMED" && to === "COMPLETED") await hold.promise;
          return store.transition(requestId, from, to);
        },
      }),
    });
    const commit = await harness.prepareSignedCommit();
    const open = await harness.prepareSignedOpen();

    const committing = harness.executeCommit(commit.requestId, commit.signature);
    await waitUntil(
      "the commit to clear the managed session",
      async () => (await harness.sessionEditId()) === undefined,
    );
    // The production commit acknowledged durably and cleared the managed session.
    expect(await harness.sessionEditId()).toBeUndefined();
    expect(await harness.journalRecords()).toEqual(["ACKNOWLEDGED"]);

    const blocked = await harness.executeOpen(open.requestId, open.signature);
    expect(blocked.outcome).toBe("operation_in_progress");
    expect(blocked.error?.code).toBe("PACKAGE_OPERATION_IN_PROGRESS");
    expect(harness.calls.createEdit).toBe(0);

    hold.open();
    expect((await committing).outcome).toBe("success");
    expect(harness.calls.createEdit).toBe(0);

    // With the lease released and no tracked session, the same approval may now
    // open a new edit: the lease, not the session, was the exclusion.
    const after = await harness.executeOpen(open.requestId, open.signature);
    expect(after.outcome).toBe("success");
    expect(harness.calls.createEdit).toBe(1);
  });

  it("blocks the commit's authoritative section while open_edit holds the lease", async () => {
    const harness = await buildHarness();
    // prepare_commit needs a tracked managed edit; the open-edit execution below
    // is exactly what removes it, i.e. the audited window is this test's setup.
    const commit = await harness.prepareSignedCommit();
    const open = await harness.prepareSignedOpen();
    await harness.sessionStore.clear();

    const hold = latch();
    harness.faults.createEditHold = hold.promise;
    const opening = harness.executeOpen(open.requestId, open.signature);
    await waitUntil("the open's edits.insert", () => harness.calls.createEdit >= 1);

    const blocked = await harness.executeCommit(commit.requestId, commit.signature);
    expect(blocked.outcome).toBe("operation_in_progress");
    expect(blocked.error?.code).toBe("PACKAGE_OPERATION_IN_PROGRESS");
    expect(harness.calls.commitEdit).toBe(0);
    // No journal attempt, no claim, no approval consumption.
    expect(await harness.journalRecords()).toEqual([]);
    expect(harness.claimExists(commit.requestId)).toBe(false);
    expect(await harness.pendingStore.state(commit.requestId)).toBe("pending");

    hold.open();
    expect((await opening).outcome).toBe("success");
    expect(harness.calls.createEdit).toBe(1);
    expect(harness.calls.commitEdit).toBe(0);
  });
});

// ------------------------------ server mutating classification (§21/§22)

describe("server mutating-operation classification", () => {
  async function socketCall(
    socketPath: string,
    request: unknown,
    options: { readonly trailing?: boolean } = {},
  ): Promise<string> {
    const frame = encodeDaemonFrame(
      Buffer.from(
        JSON.stringify({
          protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
          correlationId: CORRELATION,
          request,
        }),
        "utf8",
      ),
    );
    return new Promise<string>((resolve, reject) => {
      const socket = createConnection(socketPath);
      const chunks: Buffer[] = [];
      socket.on("connect", () => {
        socket.write(frame);
        if (options.trailing === true) socket.write(Buffer.from("junk"));
        socket.end();
      });
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("error", reject);
      socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
  }

  it("reports an unexpected dispatcher throw as externally ambiguous for every served mutating operation", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "classification.sock");
    const dispatched: string[] = [];
    const server = createDaemonServer({
      socketPath,
      handle: async (envelope) => {
        dispatched.push(envelope.request.kind);
        throw new Error("dispatcher exploded after dispatch");
      },
    });
    await server.start();
    servers.push(server);

    const requests: readonly unknown[] = [
      {
        kind: "execute_open_edit",
        requestId: "11111111-2222-4333-8444-555555555555",
        signature: "c2ln",
      },
      {
        kind: "attach_notes",
        track: TRACK,
        versionCode: VERSION_CODE,
        locale: LOCALE,
        noteText: NOTE_TEXT,
      },
      {
        kind: "execute_commit",
        requestId: "11111111-2222-4333-8444-555555555555",
        signature: "c2ln",
      },
    ];
    for (const request of requests) {
      const raw = await socketCall(socketPath, request);
      const parsed = JSON.parse(raw) as {
        outcome?: string;
        error?: { code?: string };
      };
      expect(parsed.outcome).toBe("external_state_ambiguous");
      expect(parsed.error?.code).toBe("OPERATION_OUTCOME_UNRECORDED");
    }
    expect(dispatched).toEqual(["execute_open_edit", "attach_notes", "execute_commit"]);

    // Pre-dispatch framing failure stays zero-dispatch and never ambiguous.
    const rejected = await socketCall(socketPath, requests[1], { trailing: true });
    const parsedRejected = JSON.parse(rejected) as { outcome?: string; error?: { code?: string } };
    expect(parsedRejected.outcome).toBe("protocol_error");
    expect(parsedRejected.error?.code).toBe("MALFORMED_REQUEST");
    expect(dispatched).toHaveLength(3);
  });
});

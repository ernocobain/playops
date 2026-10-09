/**
 * Stage 3E.3 — `prepare_verify_committed` / `execute_verify_committed` over the
 * REAL Stage-3B framed Unix socket.
 *
 * Real: the socket server, framing, the dispatcher, the pending store, exclusive
 * O_EXCL claims, operator Ed25519 verification, the operator_signature resolver,
 * executeOneTool, runAgent, the production `releases.verify_committed_release`
 * verifier, the real commit-attempt journal, the Stage-3E.2A evidence sink, the
 * Stage-3E.2B strict journal bridge, the durable cleanup journal and the shared
 * package-operation coordinator.
 *
 * Fake: the Google gateway only. Offline; never touches /run/playops.
 */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonVerifyCommittedDependencies } from "../src/daemon/verify-committed-operations.js";
import { createPackageOperationSingleFlightCoordinator } from "../src/daemon/package-operation-singleflight.js";
import { createDaemonOperations } from "../src/daemon/operations.js";
import { createFilePendingOperationStore } from "../src/daemon/pending-store.js";
import { requestClaimPath } from "../src/daemon/request-claim.js";
import {
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
  encodeDaemonFrame,
  parseDaemonResponse,
  type DaemonResponseEnvelope,
} from "../src/daemon/protocol.js";
import { createDaemonServer, type DaemonServer } from "../src/daemon/server.js";
import type { ReleaseCommitAttemptJournal } from "../src/releases/commit-attempt-journal.js";
import { createFileReleaseCommitAttemptJournal } from "../src/releases/commit-attempt-journal.js";
import { createReleaseCommitStateDigest } from "../src/releases/commit-approval.js";
import { createFileReleaseEditCleanupJournal } from "../src/releases/cleanup-journal.js";
import type {
  ReleaseSummaryGateway,
  ReleaseTemporaryEditVerificationGateway,
} from "../src/releases/gateway.js";
import {
  type GooglePlayEditSession,
  type ReleaseSummaryState,
  type ReleaseTrackState,
} from "../src/releases/index.js";
import { createReleaseEditOpenTool } from "../src/releases/open-tool.js";
import { createFileReleaseEditSessionStore } from "../src/releases/session-store.js";
import { createFileAgentLedger } from "../src/runtime/agent/index.js";
import { createFileApprovalLedger } from "../src/runtime/approvals/index.js";
import { createOperatorApprovalVerifier } from "../src/runtime/approvals/operator-signature.js";
import { ToolRegistry } from "../src/runtime/tools/index.js";
import { createFileVerificationLedger } from "../src/runtime/verification/index.js";

const PACKAGE = "com.example.app";
const EDIT_ID = "edit-managed-socket";
const TEMP_EDIT_ID = "edit-temp-socket";
const TRACK = "internal";
const VERSION_CODE = "42";
const RELEASE_NAME = "42 (1.0)";
const RELEASE_STATUS = "completed";
const EXPIRY = "1900000000";
const VALIDATION_EXPIRY = EXPIRY;
const AT = "2026-10-08T00:00:00.000Z";
const AT_LATER = "2026-10-08T00:05:00.000Z";
const COMMIT_REQUEST_DIGEST = "c".repeat(64);
const CORRELATION = "verify-socket";

const dirs: string[] = [];
const servers: DaemonServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await server.close();
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function trackFixture(): ReleaseTrackState {
  return {
    track: TRACK,
    releases: [
      { name: RELEASE_NAME, status: RELEASE_STATUS as "completed", versionCodes: [VERSION_CODE] },
    ],
  };
}

const EXPECTED_DIGEST = createReleaseCommitStateDigest(trackFixture());

interface Exchange {
  readonly response?: DaemonResponseEnvelope;
  readonly raw: Buffer;
}

async function exchangeOnce(
  socketPath: string,
  chunks: readonly Buffer[],
  options: { destroyAfterMs?: number } = {},
): Promise<Exchange> {
  return await new Promise<Exchange>((resolve) => {
    const socket = createConnection(socketPath);
    const received: Buffer[] = [];
    let settled = false;
    const finalize = (): void => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(received);
      let response: DaemonResponseEnvelope | undefined;
      if (raw.byteLength > 0) {
        try {
          response = parseDaemonResponse(JSON.parse(raw.toString("utf8")) as unknown);
        } catch {
          response = undefined;
        }
      }
      socket.destroy();
      resolve(raw.byteLength === 0 ? { raw } : { raw, response });
    };
    socket.on("connect", () => {
      for (const chunk of chunks) socket.write(chunk);
      socket.end();
      if (options.destroyAfterMs !== undefined) {
        setTimeout(() => socket.destroy(), options.destroyAfterMs);
      }
    });
    socket.on("data", (chunk: Buffer) => received.push(chunk));
    socket.on("error", () => undefined);
    socket.on("close", finalize);
    setTimeout(finalize, 5_000);
  });
}

interface SocketHarness {
  readonly socketPath: string;
  readonly dir: string;
  readonly privateKey: KeyObject;
  readonly journalPath: string;
  readonly calls: {
    listReleaseSummaries: number;
    createEdit: number;
    getTrack: number;
    deleteEdit: number;
    updateTrack: number;
    commitEdit: number;
  };
  readonly faults: { createEditHold: Promise<void> | undefined };
  readonly pendingStore: ReturnType<typeof createFilePendingOperationStore>;
  readonly deps: DaemonVerifyCommittedDependencies;
  frame(request: unknown): Buffer;
  sign(canonicalPayload: string): string;
  call(request: unknown): Promise<DaemonResponseEnvelope>;
  sendRaw(chunks: readonly Buffer[], options?: { destroyAfterMs?: number }): Promise<Exchange>;
  journalStates(): Promise<readonly string[]>;
  claimExists(requestId: string): boolean;
}

async function buildSocketHarness(): Promise<SocketHarness> {
  const dir = mkdtempSync(join(tmpdir(), "playops-verify-socket-"));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  const socketPath = join(dir, "playops.sock");
  const pendingRoot = join(dir, "pending");
  mkdirSync(pendingRoot, { mode: 0o700 });
  const pendingStore = createFilePendingOperationStore(pendingRoot);
  const sessionStore = createFileReleaseEditSessionStore(join(dir, "edit-session.json"), {
    expectedPackageName: PACKAGE,
  });
  // No managed session is tracked: exact verification requires its absence.
  const cleanupJournal = createFileReleaseEditCleanupJournal(join(dir, "cleanup-journal.json"), {
    expectedPackageName: PACKAGE,
  });

  const calls = {
    listReleaseSummaries: 0,
    createEdit: 0,
    getTrack: 0,
    deleteEdit: 0,
    updateTrack: 0,
    commitEdit: 0,
  };
  const faults: { createEditHold: Promise<void> | undefined } = { createEditHold: undefined };
  const gateway = {
    async listReleaseSummaries(): Promise<readonly ReleaseSummaryState[]> {
      calls.listReleaseSummaries += 1;
      return [
        {
          releaseName: RELEASE_NAME,
          track: TRACK,
          versionCodes: [VERSION_CODE],
          releaseLifecycleState: "completed",
        },
      ];
    },
    async createEdit(): Promise<GooglePlayEditSession> {
      calls.createEdit += 1;
      if (faults.createEditHold !== undefined) await faults.createEditHold;
      return { packageName: PACKAGE, editId: TEMP_EDIT_ID, expiryTimeSeconds: EXPIRY };
    },
    async getTrack(): Promise<ReleaseTrackState> {
      calls.getTrack += 1;
      return structuredClone(trackFixture());
    },
    async deleteEdit(): Promise<void> {
      calls.deleteEdit += 1;
    },
    async updateTrack(): Promise<ReleaseTrackState> {
      calls.updateTrack += 1;
      return structuredClone(trackFixture());
    },
    async commitEdit(): Promise<{ id: string; expiryTimeSeconds?: string }> {
      calls.commitEdit += 1;
      return { id: EDIT_ID, expiryTimeSeconds: EXPIRY };
    },
    async getEdit(session: GooglePlayEditSession): Promise<{ id: string }> {
      return { id: session.editId };
    },
    async listTracks(): Promise<readonly ReleaseTrackState[]> {
      return [];
    },
  };
  const summaryGateway: ReleaseSummaryGateway = gateway;
  const temporaryEditGateway: ReleaseTemporaryEditVerificationGateway = gateway;

  const journalPath = join(dir, "commit-attempt-journal.json");
  const openJournal = (): ReleaseCommitAttemptJournal =>
    createFileReleaseCommitAttemptJournal(journalPath, { expectedPackageName: PACKAGE });

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const deps: DaemonVerifyCommittedDependencies = {
    packageName: PACKAGE,
    pendingStore,
    claimRoot: join(dir, "claims"),
    managedSessionStore: sessionStore,
    summaryGateway,
    temporaryEditGateway,
    cleanupJournal,
    verifyAuditLedger: createFileAgentLedger(join(dir, "verify-audit.jsonl")),
    openCommitAttemptJournal: openJournal,
    operatorVerifier: createOperatorApprovalVerifier(publicKey, "verify-socket-anchor"),
    ledger: createFileAgentLedger(join(dir, "agent.jsonl")),
    approvalLedger: createFileApprovalLedger(join(dir, "approval.jsonl")),
    verificationLedger: createFileVerificationLedger(join(dir, "verification.jsonl")),
  };

  const registry = new ToolRegistry();
  const openBuilt = createReleaseEditOpenTool({
    packageName: PACKAGE,
    gateway: {
      createEdit: async () => ({
        packageName: PACKAGE,
        editId: EDIT_ID,
        expiryTimeSeconds: EXPIRY,
      }),
      getEdit: (session) => gateway.getEdit(session),
      listTracks: async () => [],
    },
    store: sessionStore,
  });
  registry.register(openBuilt.tool);

  const operations = createDaemonOperations({
    packageName: PACKAGE,
    pendingStore,
    claimRoot: deps.claimRoot,
    packageOperations: createPackageOperationSingleFlightCoordinator(),
    registry,
    openEdit: { binding: openBuilt.binding, input: {} },
    verifyCommitted: deps,
    operatorVerifier: deps.operatorVerifier,
    ledger: deps.ledger,
    approvalLedger: deps.approvalLedger,
    verificationLedger: deps.verificationLedger,
  });

  // Durable seeds: one acknowledged commit attempt plus its completed commit
  // pending provenance record.
  const journal = openJournal();
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
  const commitRecord = await pendingStore.prepare({
    operation: "commit",
    toolName: "releases.commit_edit",
    permission: "publish",
    packageName: PACKAGE,
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

  const server = createDaemonServer({
    socketPath,
    handle: (envelope) => operations.handle(envelope),
  });
  servers.push(server);
  await server.start();

  const frame = (request: unknown): Buffer =>
    encodeDaemonFrame(
      Buffer.from(
        JSON.stringify({
          protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
          correlationId: CORRELATION,
          request,
        }),
        "utf8",
      ),
    );

  return {
    socketPath,
    dir,
    privateKey,
    journalPath,
    calls,
    faults,
    pendingStore,
    deps,
    frame,
    sign: (canonicalPayload: string): string =>
      sign(null, Buffer.from(canonicalPayload, "utf8"), privateKey).toString("base64url"),
    call: async (request: unknown): Promise<DaemonResponseEnvelope> => {
      const result = await exchangeOnce(socketPath, [frame(request)]);
      if (result.response === undefined) throw new Error("no daemon response received");
      return result.response;
    },
    sendRaw: (chunks, options) => exchangeOnce(socketPath, chunks, options ?? {}),
    journalStates: async () => (await openJournal().list()).map((record) => record.state),
    claimExists: (requestId) => existsSync(requestClaimPath(join(dir, "claims"), requestId)),
  };
}

async function prepareOverSocket(
  harness: SocketHarness,
): Promise<{ requestId: string; canonicalPayload: string }> {
  const prepared = await harness.call({
    kind: "prepare_verify_committed",
    track: TRACK,
    versionCode: VERSION_CODE,
  });
  expect(prepared.outcome).toBe("approval_required");
  const approval = prepared.approval;
  if (approval === undefined) throw new Error("prepare returned no challenge");
  return { requestId: approval.requestId, canonicalPayload: approval.canonicalPayload };
}

describe("verify_committed over the daemon socket", () => {
  it("binds a private socket for the verification path", async () => {
    const harness = await buildSocketHarness();
    const stat = lstatSync(harness.socketPath);
    expect(stat.isSocket()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("prepares a destructive verification challenge with zero Google calls", async () => {
    const harness = await buildSocketHarness();
    const { requestId, canonicalPayload } = await prepareOverSocket(harness);

    expect(canonicalPayload).toContain("PLAYOPS_OPERATOR_APPROVAL_V1");
    expect(harness.calls).toEqual({
      listReleaseSummaries: 0,
      createEdit: 0,
      getTrack: 0,
      deleteEdit: 0,
      updateTrack: 0,
      commitEdit: 0,
    });
    expect(await harness.pendingStore.state(requestId)).toBe("pending");
    const record = await harness.pendingStore.load(requestId);
    expect(record?.operation).toBe("verify_committed");
    expect(record?.permission).toBe("destructive");
    expect(record?.intent).toEqual({
      kind: "verify_committed",
      targetTrack: TRACK,
      versionCode: VERSION_CODE,
      expectedStateDigest: EXPECTED_DIGEST,
    });
    expect(JSON.stringify(record)).not.toContain(TEMP_EDIT_ID);
    expect(JSON.stringify(record)).not.toContain("privateKey");
    expect(await harness.journalStates()).toEqual(["ACKNOWLEDGED"]);
  });

  it("executes the destructive verification end-to-end over a fresh socket", async () => {
    const harness = await buildSocketHarness();
    const { requestId, canonicalPayload } = await prepareOverSocket(harness);

    const executed = await harness.call({
      kind: "execute_verify_committed",
      requestId,
      signature: harness.sign(canonicalPayload),
    });
    expect(executed.outcome).toBe("success");

    // The exact expected Google budget: one Layer-A summary read, at most one
    // temporary insert, one deep read, at most one delete. Never a track
    // mutation, never a commit.
    expect(harness.calls).toEqual({
      listReleaseSummaries: 1,
      createEdit: 1,
      getTrack: 1,
      deleteEdit: 1,
      updateTrack: 0,
      commitEdit: 0,
    });
    expect(await harness.journalStates()).toEqual(["REMOTE_VERIFIED"]);
    expect(await harness.pendingStore.state(requestId)).toBe("completed");
  });

  it("rejects a bad signature with zero Google calls and no claim", async () => {
    const harness = await buildSocketHarness();
    const { requestId } = await prepareOverSocket(harness);

    const rejected = await harness.call({
      kind: "execute_verify_committed",
      requestId,
      signature: "AAAA",
    });
    expect(rejected.outcome).toBe("approval_mismatch");
    expect(rejected.error?.code).toBe("SIGNATURE_INVALID");
    expect(harness.calls).toEqual({
      listReleaseSummaries: 0,
      createEdit: 0,
      getTrack: 0,
      deleteEdit: 0,
      updateTrack: 0,
      commitEdit: 0,
    });
    expect(await harness.pendingStore.state(requestId)).toBe("pending");
    expect(await harness.journalStates()).toEqual(["ACKNOWLEDGED"]);
    // The signature is checked before the package lease, so no claim exists.
    expect(harness.claimExists(requestId)).toBe(false);
  });

  it("refuses a second execution of the same request", async () => {
    const harness = await buildSocketHarness();
    const { requestId, canonicalPayload } = await prepareOverSocket(harness);
    const signature = harness.sign(canonicalPayload);

    expect(
      (await harness.call({ kind: "execute_verify_committed", requestId, signature })).outcome,
    ).toBe("success");
    const replay = await harness.call({ kind: "execute_verify_committed", requestId, signature });
    expect(replay.outcome).toBe("request_already_consumed");
    expect(harness.calls.createEdit).toBe(1);
    expect(harness.calls.listReleaseSummaries).toBe(1);
  });

  it("continues the destructive lifecycle after a client disconnect", async () => {
    const harness = await buildSocketHarness();
    const { requestId, canonicalPayload } = await prepareOverSocket(harness);
    // Keep the temporary insert in flight for a moment so the client's socket
    // really is destroyed while the operation is running.
    let release = (): void => undefined;
    harness.faults.createEditHold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const exchanged = await harness.sendRaw(
      [
        harness.frame({
          kind: "execute_verify_committed",
          requestId,
          signature: harness.sign(canonicalPayload),
        }),
      ],
      { destroyAfterMs: 5 },
    );
    expect(exchanged.response).toBeUndefined();

    // The daemon owns the lifecycle: it finishes independently.
    for (let index = 0; index < 1000 && harness.calls.createEdit === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    release();
    for (let index = 0; index < 1000; index += 1) {
      if ((await harness.pendingStore.state(requestId)) === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await harness.pendingStore.state(requestId)).toBe("completed");
    expect(await harness.journalStates()).toEqual(["REMOTE_VERIFIED"]);
    expect(harness.calls.createEdit).toBe(1);
    expect(harness.calls.deleteEdit).toBe(1);
  });

  it("classifies an unexpected dispatcher throw truthfully for both verify kinds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "playops-verify-classify-"));
    chmodSync(dir, 0o700);
    dirs.push(dir);
    const socketPath = join(dir, "playops.sock");
    const server = createDaemonServer({
      socketPath,
      handle: async () => {
        throw new Error("unexpected dispatcher failure");
      },
    });
    servers.push(server);
    await server.start();
    const frame = (request: unknown): Buffer =>
      encodeDaemonFrame(
        Buffer.from(
          JSON.stringify({
            protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
            correlationId: CORRELATION,
            request,
          }),
          "utf8",
        ),
      );

    const executing = await exchangeOnce(socketPath, [
      frame({
        kind: "execute_verify_committed",
        requestId: "11111111-1111-1111-1111-111111111111",
        signature: "AAAA",
      }),
    ]);
    // Destructive verification may already have created/deleted a temporary
    // edit, so the failure must not be reported as definitely non-mutating.
    expect(executing.response?.outcome).toBe("external_state_ambiguous");
    expect(executing.response?.error?.code).toBe("OPERATION_OUTCOME_UNRECORDED");

    const preparing = await exchangeOnce(socketPath, [
      frame({ kind: "prepare_verify_committed", track: TRACK, versionCode: VERSION_CODE }),
    ]);
    expect(preparing.response?.outcome).toBe("local_state_failure");
    expect(preparing.response?.error?.code).toBe("OPERATION_DISPATCH_FAILED");
  });
});

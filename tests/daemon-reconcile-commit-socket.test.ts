/** Stage 3F.2 reconciliation over the REAL Stage-3B framed Unix socket. */
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonOperations } from "../src/daemon/operations.js";
import type { DaemonReconcileCommitDependencies } from "../src/daemon/reconcile-commit-operations.js";
import { createPackageOperationSingleFlightCoordinator } from "../src/daemon/package-operation-singleflight.js";
import { createFilePendingOperationStore } from "../src/daemon/pending-store.js";
import {
  encodeDaemonFrame,
  parseDaemonResponse,
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
  type DaemonResponseEnvelope,
} from "../src/daemon/protocol.js";
import { createDaemonServer, type DaemonServer } from "../src/daemon/server.js";
import { requestClaimPath } from "../src/daemon/request-claim.js";
import { createFileReleaseCommitAttemptJournal } from "../src/releases/commit-attempt-journal.js";
import { createReleaseCommitStateDigest } from "../src/releases/commit-approval.js";
import { createFileReleaseEditCleanupJournal } from "../src/releases/cleanup-journal.js";
import {
  ReleaseError,
  type GooglePlayEditSession,
  type ReleaseTrackState,
  type ReleaseTrackUpdateRequest,
} from "../src/releases/index.js";
import { createReleaseEditOpenTool } from "../src/releases/open-tool.js";
import { createFileReleaseEditSessionStore } from "../src/releases/session-store.js";
import { createFileAgentLedger } from "../src/runtime/agent/index.js";
import { createFileApprovalLedger } from "../src/runtime/approvals/index.js";
import {
  createOperatorApprovalVerifier,
  encodeOperatorApprovalPayload,
} from "../src/runtime/approvals/operator-signature.js";
import { ToolRegistry } from "../src/runtime/tools/index.js";
import { createFileVerificationLedger } from "../src/runtime/verification/index.js";
import { approvalPayloadFor } from "../src/daemon/pending-view.js";
import { cleanupFixtures, fixture } from "./daemon-reconcile-fixture.js";

const PACKAGE = "com.example.socketreconcile";
const ORIGINAL = "PRIVATE-SOCKET-ORIGINAL";
const TEMPORARY = "PRIVATE-SOCKET-TEMP";
const TEMP_EXPIRY = "4102444900";
const TRACK = "internal";
const VERSION = "42";
const AT = "2026-10-09T00:00:00.000Z";
const dirs: string[] = [];
const servers: DaemonServer[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
  cleanupFixtures();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const track = (): ReleaseTrackState => ({
  track: TRACK,
  releases: [{ name: "Candidate", status: "completed", versionCodes: [VERSION] }],
});
const EXPECTED = createReleaseCommitStateDigest(track());

function inactiveRead(): ReleaseError {
  return new ReleaseError("EDIT_INVALID", "PRIVATE-UPSTREAM", {
    classification: {
      publisherCode: "API_REQUEST_FAILED",
      status: 400,
      googleStatus: "FAILED_PRECONDITION",
      googleReasons: ["failedPrecondition"],
    },
  });
}

async function exchangeOnce(
  socketPath: string,
  chunks: readonly Buffer[],
): Promise<DaemonResponseEnvelope | undefined> {
  return await new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const received: Buffer[] = [];
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      let response: DaemonResponseEnvelope | undefined;
      try {
        response = parseDaemonResponse(
          JSON.parse(Buffer.concat(received).toString("utf8")) as unknown,
        );
      } catch {
        response = undefined;
      }
      socket.destroy();
      resolve(response);
    };
    socket.on("connect", () => {
      for (const chunk of chunks) socket.write(chunk);
      socket.end();
    });
    socket.on("data", (chunk: Buffer) => received.push(chunk));
    socket.on("error", () => undefined);
    socket.on("close", finish);
    setTimeout(finish, 5_000);
  });
}

interface SocketFixture {
  readonly socketPath: string;
  readonly dir: string;
  readonly pendingStore: ReturnType<typeof createFilePendingOperationStore>;
  readonly journalPath: string;
  readonly calls: {
    getEdit: number;
    createEdit: number;
    getTrack: number;
    deleteEdit: number;
    updateTrack: number;
    commitEdit: number;
  };
  readonly faults: { originalFailure?: ReleaseError; insertHold?: Promise<void> };
  frame(request: unknown): Buffer;
  call(request: unknown): Promise<DaemonResponseEnvelope>;
  signRequest(requestId: string): Promise<string>;
  journalStates(): Promise<readonly string[]>;
  claimExists(requestId: string): boolean;
  sendRaw(
    chunks: readonly Buffer[],
    options?: { destroyAfterMs?: number },
  ): Promise<DaemonResponseEnvelope | undefined>;
}

async function socketFixture(options: {
  state: "TRANSPORT_ATTEMPTED" | "REMOTE_VERIFIED";
  prefix?: number;
}): Promise<SocketFixture> {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-reconcile-socket-"));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  const socketPath = join(dir, "playops.sock");
  const pendingRoot = join(dir, "pending");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(pendingRoot, { mode: 0o700 });
  const pendingStore = createFilePendingOperationStore(pendingRoot);
  const sessionStore = createFileReleaseEditSessionStore(join(dir, "session.json"), {
    expectedPackageName: PACKAGE,
  });
  const cleanupJournal = createFileReleaseEditCleanupJournal(join(dir, "cleanup.json"), {
    expectedPackageName: PACKAGE,
  });
  const journalPath = join(dir, "attempts.json");
  const openJournal = () =>
    createFileReleaseCommitAttemptJournal(journalPath, { expectedPackageName: PACKAGE });
  const calls = {
    getEdit: 0,
    createEdit: 0,
    getTrack: 0,
    deleteEdit: 0,
    updateTrack: 0,
    commitEdit: 0,
  };
  const faults: { originalFailure?: ReleaseError; insertHold?: Promise<void> } = {};
  let deleted = false;
  const gateway = {
    async getEdit(session: GooglePlayEditSession) {
      calls.getEdit += 1;
      if (session.editId === ORIGINAL) {
        if (faults.originalFailure) throw faults.originalFailure;
        return { id: session.editId, expiryTimeSeconds: session.expiryTimeSeconds };
      }
      if (deleted) throw inactiveRead();
      return { id: session.editId, expiryTimeSeconds: session.expiryTimeSeconds };
    },
    async createEdit() {
      calls.createEdit += 1;
      if (faults.insertHold) await faults.insertHold;
      return { packageName: PACKAGE, editId: TEMPORARY, expiryTimeSeconds: TEMP_EXPIRY };
    },
    async getTrack() {
      calls.getTrack += 1;
      return structuredClone(track());
    },
    async deleteEdit(session: GooglePlayEditSession) {
      calls.deleteEdit += 1;
      if (session.editId === ORIGINAL) throw new Error("ORIGINAL DELETION FORBIDDEN");
      deleted = true;
    },
    async commitEdit() {
      calls.commitEdit += 1;
      return { id: ORIGINAL, expiryTimeSeconds: "1" };
    },
    async updateTrack(
      _s: GooglePlayEditSession,
      target: string,
      request: ReleaseTrackUpdateRequest,
    ) {
      calls.updateTrack += 1;
      return { track: target, releases: structuredClone(request.releases) };
    },
    async listTracks() {
      return [track()];
    },
    async listBundles() {
      return [];
    },
    async validateEdit() {
      return { id: ORIGINAL, expiryTimeSeconds: "1" };
    },
    async listReleaseSummaries() {
      return [];
    },
  };
  const { publicKey, privateKey } = await import("node:crypto").then((crypto) =>
    crypto.generateKeyPairSync("ed25519"),
  );
  const operatorVerifier = createOperatorApprovalVerifier(publicKey, "socket-anchor");
  const ledger = createFileAgentLedger(join(dir, "agent.jsonl"));
  const approvalLedger = createFileApprovalLedger(join(dir, "approval.jsonl"));
  const verificationLedger = createFileVerificationLedger(join(dir, "verification.jsonl"));
  const auditWriter = createFileAgentLedger(join(dir, "audit.jsonl"));
  const deps: DaemonReconcileCommitDependencies = {
    packageName: PACKAGE,
    pendingStore,
    claimRoot: join(dir, "claims"),
    managedSessionStore: sessionStore,
    gateway,
    cleanupJournal,
    openCommitAttemptJournal: openJournal,
    reconcileAuditLedger: auditWriter,
    finalizationAuditLedger: auditWriter,
    operatorVerifier,
    ledger,
    approvalLedger,
    verificationLedger,
    now: () => new Date(AT),
  };
  const opened = createReleaseEditOpenTool({ packageName: PACKAGE, gateway, store: sessionStore });
  const registry = new ToolRegistry();
  registry.register(opened.tool);
  const operations = createDaemonOperations({
    packageName: PACKAGE,
    pendingStore,
    claimRoot: deps.claimRoot,
    packageOperations: createPackageOperationSingleFlightCoordinator(),
    registry,
    openEdit: { binding: opened.binding, input: {} },
    reconcileCommit: deps,
    operatorVerifier,
    ledger,
    approvalLedger,
    verificationLedger,
    now: () => new Date(AT),
  });
  const journal = openJournal();
  const prepared = await journal.prepare({
    version: 1,
    packageName: PACKAGE,
    editId: ORIGINAL,
    expiryTimeSeconds: "1",
    targetTrack: TRACK,
    versionCode: VERSION,
    releaseName: "Candidate",
    releaseStatus: "completed",
    expectedStateDigest: EXPECTED,
    priorStateDigest: "b".repeat(64),
    validationExpiryTimeSeconds: "1",
    requestDigest: "c".repeat(64),
    attemptedAtUtc: AT,
    updatedAtUtc: AT,
  });
  await journal.transition(prepared.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", AT);
  if (options.state === "REMOTE_VERIFIED" || options.prefix !== undefined) {
    await journal.transition(prepared.attemptId, "TRANSPORT_ATTEMPTED", "ACKNOWLEDGED", AT, {
      acknowledgedAtUtc: AT,
    });
    const ordered = [
      { verificationInsertAttempted: true as const },
      { verificationEditId: TEMPORARY, verificationEditExpiryTimeSeconds: TEMP_EXPIRY },
      { verificationObservedStateDigest: EXPECTED, verificationObservedAtUtc: AT },
      { verificationPreDeleteReadVerified: true as const },
      { verificationDeleteAttempted: true as const },
      { verificationDeleteAcknowledged: true as const },
      { verificationCleanupVerified: true as const },
    ];
    for (const patch of ordered.slice(0, options.prefix ?? 0)) {
      await journal.updateVerification(prepared.attemptId, "ACKNOWLEDGED", AT, patch);
    }
    if (options.state === "REMOTE_VERIFIED") {
      await journal.transition(prepared.attemptId, "ACKNOWLEDGED", "REMOTE_VERIFIED", AT);
    }
  }
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
          correlationId: "reconcile-socket",
          request,
        }),
        "utf8",
      ),
    );
  return {
    socketPath,
    dir,
    pendingStore,
    journalPath,
    calls,
    faults,
    frame,
    call: async (request) => {
      const response = await exchangeOnce(socketPath, [frame(request)]);
      if (response === undefined) throw new Error("no daemon response received");
      return response;
    },
    signRequest: async (requestId) => {
      const record = await pendingStore.load(requestId);
      if (record === undefined) throw new Error("missing pending record");
      const { sign } = await import("node:crypto");
      return sign(
        null,
        encodeOperatorApprovalPayload(approvalPayloadFor(record)),
        privateKey,
      ).toString("base64url");
    },
    journalStates: async () => (await openJournal().list()).map((record) => record.state),
    claimExists: (requestId) => existsSync(requestClaimPath(join(dir, "claims"), requestId)),
    sendRaw: async (chunks) => await exchangeOnce(socketPath, chunks),
  };
}

describe("Stage 3F.2 reconciliation socket paths", () => {
  it("closes complete REMOTE_VERIFIED proof locally over the socket with no pending or approval", async () => {
    const h = await socketFixture({ state: "REMOTE_VERIFIED", prefix: 7 });
    const response = await h.call({ kind: "prepare_reconcile_commit" });
    expect(response).toMatchObject({ outcome: "success" });
    expect(await h.journalStates()).toEqual(["RECONCILED_COMMITTED"]);
    expect(await h.pendingStore.list()).toEqual([]);
    expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
  });

  it("requires a destructive challenge over the socket, then executes the signed recovery", async () => {
    const h = await socketFixture({ state: "TRANSPORT_ATTEMPTED" });
    h.faults.originalFailure = inactiveRead();
    const challenge = await h.call({ kind: "prepare_reconcile_commit" });
    expect(challenge).toMatchObject({
      outcome: "approval_required",
      approval: { permission: "destructive", toolName: "releases.reconcile_commit" },
    });
    const requestId = challenge.approval?.requestId ?? "";
    const canonical = challenge.approval?.canonicalPayload ?? "";
    expect(canonical).not.toContain("PRIVATE-SOCKET-ORIGINAL");
    expect(canonical).not.toContain("PRIVATE-SOCKET-TEMP");
    expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
    const signature = await h.signRequest(requestId);
    const executed = await h.call({ kind: "execute_reconcile_commit", requestId, signature });
    expect(executed).toMatchObject({ outcome: "success", summary: "reconciliation_committed" });
    expect(await h.journalStates()).toEqual(["RECONCILED_COMMITTED"]);
    expect(await h.pendingStore.state(requestId)).toBe("completed");
    expect(h.calls).toMatchObject({
      getEdit: 3,
      createEdit: 1,
      getTrack: 1,
      deleteEdit: 1,
      commitEdit: 0,
      updateTrack: 0,
    });
  });

  it("rejects a bad signature over the socket with zero claim, consumption or Google", async () => {
    const h = await socketFixture({ state: "TRANSPORT_ATTEMPTED" });
    h.faults.originalFailure = inactiveRead();
    const challenge = await h.call({ kind: "prepare_reconcile_commit" });
    const requestId = challenge.approval?.requestId ?? "";
    const response = await h.call({
      kind: "execute_reconcile_commit",
      requestId,
      signature: "AAAA",
    });
    expect(response).toMatchObject({
      outcome: "approval_mismatch",
      error: { code: "SIGNATURE_INVALID" },
    });
    expect(h.claimExists(requestId)).toBe(false);
    expect(await h.pendingStore.state(requestId)).toBe("pending");
    expect(Object.values(h.calls).every((count) => count === 0)).toBe(true);
  });

  it("routes an ACKNOWLEDGED non-expected observation to signed recovery over the real socket", async () => {
    const h = await fixture({ state: "ACKNOWLEDGED", prefix: 7, observed: "unrelated" });
    h.faults.originalFailure = inactiveRead();
    const socketPath = join(h.root, "reconcile-ack.sock");
    const server = createDaemonServer({
      socketPath,
      handle: (envelope) => h.operations.handle(envelope),
    });
    servers.push(server);
    await server.start();
    const frameFor = (request: unknown): Buffer =>
      encodeDaemonFrame(
        Buffer.from(
          JSON.stringify({
            protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
            correlationId: "reconcile-ack-socket",
            request,
          }),
          "utf8",
        ),
      );
    const prepared = await exchangeOnce(socketPath, [
      frameFor({ kind: "prepare_reconcile_commit" }),
    ]);
    expect(prepared).toMatchObject({
      outcome: "approval_required",
      approval: { permission: "destructive", toolName: "releases.reconcile_commit" },
    });
    expect(h.calls.createEdit).toBe(0);
    const requestId = prepared?.approval?.requestId ?? "";
    expect(requestId).not.toBe("");
    const executed = await exchangeOnce(socketPath, [
      frameFor({
        kind: "execute_reconcile_commit",
        requestId,
        signature: await h.signRequest(requestId),
      }),
    ]);
    expect(executed).toMatchObject({ outcome: "external_state_ambiguous" });
    // No second temporary verification edit was created for the existing prefix.
    expect(h.calls.createEdit).toBe(0);
    expect(h.calls.getTrack).toBe(0);
    expect((await h.rawJournal().list())[0]?.state).toBe("ACKNOWLEDGED");
    expect(await h.pendingStore.state(requestId)).toBe("recovery_required");
    expect(h.claimExists(requestId)).toBe(true);
  });

  it("keeps the daemon lifecycle running after a client disconnect during recovery", async () => {
    const h = await socketFixture({ state: "TRANSPORT_ATTEMPTED" });
    h.faults.originalFailure = inactiveRead();
    const challenge = await h.call({ kind: "prepare_reconcile_commit" });
    const requestId = challenge.approval?.requestId ?? "";
    const signature = await h.signRequest(requestId);
    let release: () => void = () => undefined;
    h.faults.insertHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const frame = h.frame({ kind: "execute_reconcile_commit", requestId, signature });
    const pending = h.sendRaw([frame], { destroyAfterMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    release();
    await pending;
    // The daemon completed the lifecycle from its own durable state.
    const deadline = Date.now() + 5_000;
    let states: readonly string[] = [];
    while (Date.now() < deadline) {
      states = await h.journalStates();
      if (states.includes("RECONCILED_COMMITTED")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(states).toEqual(["RECONCILED_COMMITTED"]);
    expect(h.calls.createEdit).toBe(1);
    expect(h.calls.deleteEdit).toBe(1);
  });
});

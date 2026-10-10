/**
 * Stage 4B.4 client E2E over the REAL Stage-3B socket and daemon operations.
 * Fresh operation-specific fixtures use real stores/runtime/crypto and only a
 * fake, offline Google gateway. The synthetic TEST-ONLY external signer accepts
 * a serialized challenge, not daemon-owned pending state. Never /run/playops.
 */
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAuditEntries } from "../src/audit/index.js";
import { createDaemonServer, type DaemonServer } from "../src/daemon/server.js";
import {
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
  type DaemonApprovalChallenge,
  type DaemonRequest,
  type DaemonRequestKind,
  type DaemonResponseEnvelope,
} from "../src/daemon/protocol.js";
import { sendDaemonRequest, type DaemonTransportResult } from "../src/client/transport.js";
import {
  createApprovalExport,
  readChallengeFile,
  serializeApprovalExport,
  validateApprovalChallenge,
  type ClientApprovalExport,
} from "../src/client/approval.js";
import { renderApprovalStatement } from "../src/client/render.js";
import { runDaemonCli, type DaemonOperation } from "../src/cli/daemon.js";
import { validateSerializedApproval } from "./approval-statement-reference.js";
import {
  cleanupFixtures,
  expectedDigest,
  fixture,
  inactiveRead,
  ORIGINAL,
  TEMPORARY,
  TEMP_EXPIRY,
  TRACK,
  VERSION,
} from "./daemon-reconcile-fixture.js";

const servers: DaemonServer[] = [];
const stubs: Server[] = [];
const dirs: string[] = [];
type OperationFixture = Awaited<ReturnType<typeof fixture>>;

interface ApprovalFlow {
  readonly operation: DaemonOperation;
  readonly pendingOperation: "open_edit" | "commit" | "verify_committed" | "reconcile_commit";
  readonly toolName: string;
  readonly permission: "publish" | "destructive";
  readonly prepare: DaemonRequest;
  readonly execute: (requestId: string, signature: string) => DaemonRequest;
  readonly journalBefore: readonly string[];
  readonly journalAfter: readonly string[];
  readonly prepareCalls: Partial<OperationFixture["calls"]>;
  readonly executeCalls: Partial<OperationFixture["calls"]>;
}

const APPROVAL_FLOWS: readonly ApprovalFlow[] = [
  {
    operation: "open",
    pendingOperation: "open_edit",
    toolName: "releases.open_edit",
    permission: "destructive",
    prepare: { kind: "prepare_open_edit" },
    execute: (requestId, signature) => ({ kind: "execute_open_edit", requestId, signature }),
    journalBefore: [],
    journalAfter: [],
    prepareCalls: {},
    executeCalls: { createEdit: 1, getEdit: 1 },
  },
  {
    operation: "commit",
    pendingOperation: "commit",
    toolName: "releases.commit_edit",
    permission: "publish",
    prepare: { kind: "prepare_commit", track: TRACK, versionCode: VERSION },
    execute: (requestId, signature) => ({ kind: "execute_commit", requestId, signature }),
    journalBefore: [],
    journalAfter: ["ACKNOWLEDGED"],
    prepareCalls: { getEdit: 1, getTrack: 1, validateEdit: 1 },
    executeCalls: { getEdit: 3, getTrack: 4, validateEdit: 3, commitEdit: 1 },
  },
  {
    operation: "verify",
    pendingOperation: "verify_committed",
    toolName: "releases.verify_committed_release",
    permission: "destructive",
    prepare: { kind: "prepare_verify_committed", track: TRACK, versionCode: VERSION },
    execute: (requestId, signature) => ({
      kind: "execute_verify_committed",
      requestId,
      signature,
    }),
    journalBefore: ["ACKNOWLEDGED"],
    journalAfter: ["REMOTE_VERIFIED"],
    prepareCalls: {},
    executeCalls: { listReleaseSummaries: 1, createEdit: 1, getTrack: 1, deleteEdit: 1 },
  },
  {
    operation: "reconcile",
    pendingOperation: "reconcile_commit",
    toolName: "releases.reconcile_commit",
    permission: "destructive",
    prepare: { kind: "prepare_reconcile_commit" },
    execute: (requestId, signature) => ({
      kind: "execute_reconcile_commit",
      requestId,
      signature,
    }),
    journalBefore: ["TRANSPORT_ATTEMPTED"],
    journalAfter: ["RECONCILED_COMMITTED"],
    prepareCalls: {},
    executeCalls: { getEdit: 3, createEdit: 1, getTrack: 1, deleteEdit: 1 },
  },
];

function callBudget(overrides: Partial<OperationFixture["calls"]> = {}): OperationFixture["calls"] {
  return {
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
    ...overrides,
  };
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await server.close();
  }
  while (stubs.length > 0) {
    const server = stubs.pop();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  cleanupFixtures();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Test-only ACK provenance seed, matching the existing Stage-3E fixture builder. */
async function seedCompletedCommitProvenance(fx: OperationFixture): Promise<void> {
  const [attempt] = await fx.rawJournal().list();
  expect(attempt?.state).toBe("ACKNOWLEDGED");
  if (attempt === undefined) throw new Error("verification fixture has no ACK attempt");
  const committed = await fx.pendingStore.prepare({
    operation: "commit",
    toolName: "releases.commit_edit",
    permission: "publish",
    packageName: fx.packageName,
    requestDigest: attempt.requestDigest,
    intent: {
      kind: "commit",
      targetTrack: attempt.targetTrack,
      versionCode: attempt.versionCode,
      editId: attempt.editId,
      stateDigest: attempt.expectedStateDigest,
      validationExpiryTimeSeconds: attempt.validationExpiryTimeSeconds,
      releaseName: attempt.releaseName,
      releaseStatus: attempt.releaseStatus,
    },
  });
  await fx.pendingStore.transition(committed.requestId, "PENDING", "CLAIMED");
  await fx.pendingStore.transition(committed.requestId, "CLAIMED", "CONSUMED");
  await fx.pendingStore.transition(committed.requestId, "CONSUMED", "COMPLETED");
  expect(await fx.pendingStore.state(committed.requestId)).toBe("completed");
}

async function startFixtureServer(operation: DaemonOperation) {
  // fixture() wires createDaemonOperations and its real production tools.
  // A recovery seed must not block an unrelated fresh commit/open lifecycle.
  const fx = await fixture(
    operation === "commit"
      ? { state: "none", activeOriginal: true }
      : operation === "verify"
        ? { state: "ACKNOWLEDGED" }
        : operation === "reconcile"
          ? { state: "TRANSPORT_ATTEMPTED" }
          : { state: "none" },
  );
  if (operation === "commit") await fx.saveOriginalSession();
  if (operation === "verify") await seedCompletedCommitProvenance(fx);
  if (operation === "reconcile") fx.faults.originalFailure = inactiveRead();
  const socketPath = join(fx.root, "daemon.sock");
  const dispatches: DaemonRequestKind[] = [];
  const requests: DaemonRequest[] = [];
  const responses: DaemonResponseEnvelope[] = [];
  const server = createDaemonServer({
    socketPath,
    handle: async (envelope) => {
      dispatches.push(envelope.request.kind);
      requests.push(envelope.request);
      const response = await fx.operations.handle(envelope);
      responses.push(response);
      return response;
    },
  });
  servers.push(server);
  await server.start();
  return { ...fx, socketPath, dispatches, requests, responses, sign: fx.signChallenge };
}

type SocketFixture = Awaited<ReturnType<typeof startFixtureServer>>;

async function send(socketPath: string, request: DaemonRequest): Promise<DaemonTransportResult> {
  return await sendDaemonRequest({ socketPath, request });
}

function response(result: DaemonTransportResult): DaemonResponseEnvelope {
  if (!result.ok) throw new Error(`expected a response, got failure ${result.failure.kind}`);
  return result.response;
}

function serializedExport(challenge: DaemonApprovalChallenge, flow: ApprovalFlow): string {
  const validated = validateApprovalChallenge(challenge);
  expect(validated).toMatchObject({ toolName: flow.toolName, permission: flow.permission });
  const rendered = renderApprovalStatement(validated);
  expect(rendered).toContain("SEMANTIC AUTHORIZATION");
  expect(rendered).toContain(`operation: ${flow.pendingOperation}`);
  expect(rendered).toContain(`permission: ${flow.permission}`);
  expect(rendered).toContain(validated.canonicalPayload);
  return serializeApprovalExport(
    createApprovalExport(validated, { requestId: validated.requestId }),
  );
}

/** TEST-ONLY off-host signer: only serialized export + ephemeral signing callback. */
function signExport(serialized: string, sign: (text: string) => string) {
  const exported = JSON.parse(serialized) as ClientApprovalExport;
  const challenge = validateApprovalChallenge(exported.challenge);
  expect(exported.clientExportVersion).toBe(1);
  expect(exported.daemonProtocolVersion).toBe(PLAYOPS_DAEMON_PROTOCOL_VERSION);
  expect(exported.operator?.requestId).toBe(challenge.requestId);
  const verified = validateSerializedApproval(JSON.stringify(exported.challenge));
  expect(verified.requestId).toBe(challenge.requestId);
  expect(verified.bytesToSign).toEqual(Buffer.from(challenge.canonicalPayload, "utf8"));
  return { challenge, signature: sign(verified.bytesToSign.toString("utf8")) };
}

async function assertPrepared(
  fx: SocketFixture,
  flow: ApprovalFlow,
  challenge: DaemonApprovalChallenge,
) {
  expect(fx.responses.map((r) => r.outcome)).toEqual(["approval_required"]);
  expect(fx.dispatches).toEqual([flow.prepare.kind]);
  expect(fx.requests).toEqual([flow.prepare]);
  expect(fx.calls).toEqual(callBudget(flow.prepareCalls));
  expect(await fx.pendingStore.state(challenge.requestId)).toBe("pending");
  expect(await fx.pendingStore.load(challenge.requestId)).toMatchObject({
    operation: flow.pendingOperation,
    state: "PENDING",
    requestDigest: challenge.requestDigest,
    permission: flow.permission,
  });
  expect(fx.claimExists(challenge.requestId)).toBe(false);
  expect(fx.consumptions()).toBe(0);
  expect((await fx.rawJournal().list()).map((r) => r.state)).toEqual(flow.journalBefore);
}

async function assertCompleted(
  fx: SocketFixture,
  flow: ApprovalFlow,
  challenge: DaemonApprovalChallenge,
  request: DaemonRequest,
  client: "transport" | "cli",
) {
  // Exactly one dispatch per client invocation, not just a set of kind names.
  expect(fx.dispatches).toEqual([flow.prepare.kind, request.kind]);
  expect(fx.requests).toEqual([flow.prepare, request]);
  expect(fx.responses.map((r) => r.outcome)).toEqual(["approval_required", "success"]);
  expect(fx.responses[1]?.error).toBeUndefined();
  expect(fx.calls).toEqual(callBudget(flow.executeCalls));
  expect(await fx.pendingStore.state(challenge.requestId)).toBe("completed");
  expect(await fx.pendingStore.load(challenge.requestId)).toMatchObject({
    state: "COMPLETED",
    operation: flow.pendingOperation,
    requestDigest: challenge.requestDigest,
  });
  expect(fx.consumptions()).toBe(1);
  const approved = readAuditEntries(fx.approvalPath).filter((e) => e.type === "approval.approved");
  expect(approved).toHaveLength(1);
  expect(approved[0]?.metadata).toMatchObject({
    source: "operator_signature",
    signatureVerified: true,
  });
  expect(fx.claimExists(challenge.requestId)).toBe(false);
  expect(fx.coordinator.heldPackageOperationCount()).toBe(0);
  expect(await fx.cleanupJournal.list()).toEqual([]);
  const records = await fx.rawJournal().list();
  expect(records.map((r) => r.state)).toEqual(flow.journalAfter);
  if (flow.operation === "open") {
    expect(await fx.sessionStore.load()).toMatchObject({
      packageName: fx.packageName,
      editId: TEMPORARY,
      expiryTimeSeconds: TEMP_EXPIRY,
    });
  } else {
    expect(await fx.sessionStore.load()).toBeUndefined();
    const record = records[0];
    expect(record).toMatchObject({
      editId: ORIGINAL,
      expectedStateDigest: expectedDigest,
      targetTrack: TRACK,
      versionCode: VERSION,
    });
    if (flow.operation === "commit") {
      expect(record?.requestDigest).toBe(challenge.requestDigest);
      expect(record?.acknowledgedAtUtc).toEqual(expect.any(String));
      expect(record?.verificationInsertAttempted).toBeUndefined();
      expect(readAuditEntries(fx.remoteAuditPath).map((e) => e.type)).toContain(
        "release.commit.completed",
      );
    } else {
      expect(record?.attemptId).toBe(fx.attemptId);
      expect(record).toMatchObject({
        verificationInsertAttempted: true,
        verificationEditId: TEMPORARY,
        verificationObservedStateDigest: expectedDigest,
        verificationPreDeleteReadVerified: true,
        verificationDeleteAttempted: true,
        verificationDeleteAcknowledged: true,
        verificationCleanupVerified: true,
      });
      if (flow.operation === "reconcile") {
        expect(fx.responses[1]?.summary).toBe("reconciliation_committed");
      }
    }
  }
  console.log(
    JSON.stringify({
      proof: "Stage4B.4 signed socket lifecycle",
      client,
      operation: flow.operation,
      outcomes: fx.responses.map((r) => r.outcome),
      dispatches: fx.dispatches,
      remoteCalls: fx.calls,
      signatureConsumptions: fx.consumptions(),
      pendingState: await fx.pendingStore.state(challenge.requestId),
      journalStates: records.map((r) => r.state),
    }),
  );
}

describe("client over the real daemon socket", () => {
  it("performs one unsigned notes write through the client without publishing or consuming approval", async () => {
    const fx = await startFixtureServer("commit");
    const updateTrack = fx.gateway.updateTrack;
    // Only the offline Google fixture changes: give it a real synthetic bundle
    // and persist the fake write so the daemon's exact read-back can verify it.
    Object.assign(fx.gateway, {
      async listBundles() {
        fx.calls.listBundles++;
        return [{ versionCode: VERSION, sha256: "a".repeat(64) }];
      },
      async updateTrack(...args: Parameters<typeof updateTrack>) {
        const written = await updateTrack(...args);
        fx.faults.observedTrack = written;
        return written;
      },
    });
    const out: string[] = [],
      err: string[] = [];
    const code = await runDaemonCli(
      [
        "notes",
        "attach",
        "--track",
        TRACK,
        "--version-code",
        VERSION,
        "--locale",
        "en-US",
        "--note-text",
        "Synthetic client notes",
        "--yes",
      ],
      { write: (t) => out.push(t), writeError: (t) => err.push(t) },
      { socketPath: fx.socketPath },
    );
    expect(code, err.join(" ")).toBe(0);
    expect(fx.dispatches).toEqual(["attach_notes"]);
    expect(fx.responses[0]?.outcome).toBe("success");
    expect(fx.calls.updateTrack).toBe(1);
    expect(fx.calls.commitEdit).toBe(0);
    expect(fx.calls.createEdit).toBe(0);
    expect(fx.calls.deleteEdit).toBe(0);
    expect(fx.consumptions()).toBe(0);
    expect(await fx.pendingStore.list()).toEqual([]);
    expect(await fx.rawJournal().list()).toEqual([]);
    expect(await fx.sessionStore.load()).toMatchObject({ editId: ORIGINAL });
    expect(out.join(" ")).toContain("does NOT require a human approval signature");
  });

  it("proves all 10 request kinds with exact outcomes, durable state and no replay", async () => {
    const observed: [DaemonRequestKind, string][] = [];
    const readOnly = await startFixtureServer("open");
    const status = response(await send(readOnly.socketPath, { kind: "status" }));
    expect(status.outcome).toBe("status");
    expect(status.summary).toContain(`configuredPackage=${readOnly.packageName}`);
    expect(status.summary).toContain("managedSessionPresent=false");
    expect(status.summary).toContain("pendingCleanup=false");
    expect(status.summary).toContain("unresolvedCommitRecovery=false");
    observed.push(["status", status.outcome]);

    // An untracked edit must refuse this unsigned write, not silently open one.
    const notes = response(
      await send(readOnly.socketPath, {
        kind: "attach_notes",
        track: TRACK,
        versionCode: VERSION,
        locale: "en-US",
        noteText: "e2e note",
      }),
    );
    expect(notes).toMatchObject({
      outcome: "local_state_failure",
      error: { code: "NO_MANAGED_EDIT" },
    });
    expect(readOnly.dispatches).toEqual(["status", "attach_notes"]);
    expect(readOnly.calls).toEqual(callBudget());
    expect(await readOnly.pendingStore.list()).toEqual([]);
    expect(await readOnly.rawJournal().list()).toEqual([]);
    expect(await readOnly.sessionStore.load()).toBeUndefined();
    expect(await readOnly.cleanupJournal.list()).toEqual([]);
    expect(readOnly.consumptions()).toBe(0);
    expect(readOnly.coordinator.heldPackageOperationCount()).toBe(0);
    observed.push(["attach_notes", notes.outcome]);

    for (const flow of APPROVAL_FLOWS) {
      const fx = await startFixtureServer(flow.operation);
      const prepared = response(await send(fx.socketPath, flow.prepare));
      expect(prepared.outcome, flow.prepare.kind).toBe("approval_required");
      if (prepared.approval === undefined) throw new Error("prepare returned no challenge");
      const exported = serializedExport(prepared.approval, flow);
      const { challenge, signature } = signExport(exported, fx.sign);
      expect(challenge).toEqual(prepared.approval);
      await assertPrepared(fx, flow, challenge);
      observed.push([flow.prepare.kind, prepared.outcome]);
      const request = flow.execute(challenge.requestId, signature);
      const executed = response(await send(fx.socketPath, request));
      expect(executed.outcome, request.kind).toBe("success");
      await assertCompleted(fx, flow, challenge, request, "transport");
      observed.push([request.kind, executed.outcome]);
    }
    expect(observed).toEqual([
      ["status", "status"],
      ["attach_notes", "local_state_failure"],
      ["prepare_open_edit", "approval_required"],
      ["execute_open_edit", "success"],
      ["prepare_commit", "approval_required"],
      ["execute_commit", "success"],
      ["prepare_verify_committed", "approval_required"],
      ["execute_verify_committed", "success"],
      ["prepare_reconcile_commit", "approval_required"],
      ["execute_reconcile_commit", "success"],
    ]);
    console.log(JSON.stringify({ proof: "Stage4B.4 ten request outcomes", outcomes: observed }));
  });

  it.each(APPROVAL_FLOWS)(
    "$operation: drives prepare/export and signed execute through the CLI exactly once",
    async (flow) => {
      const fx = await startFixtureServer(flow.operation);
      const dir = mkdtempSync(join(tmpdir(), "playops-client-e2e-cli-"));
      dirs.push(dir);
      const outPath = join(dir, "challenge.json");
      const out: string[] = [];
      const err: string[] = [];
      const io = {
        write: (text: string) => out.push(text),
        writeError: (text: string) => err.push(text),
      };
      const scoped =
        flow.operation === "commit" || flow.operation === "verify"
          ? ["--track", TRACK, "--version-code", VERSION]
          : [];
      expect(
        await runDaemonCli([flow.operation, "prepare", ...scoped, "--out", outPath], io, {
          socketPath: fx.socketPath,
        }),
        err.join("\n"),
      ).toBe(0);
      expect(out.join("\n")).toMatch(/^APPROVAL REQUIRED\n/u);
      expect(out.join("\n")).toContain("SEMANTIC AUTHORIZATION");
      const exported = readFileSync(outPath, "utf8");
      const { challenge, signature } = signExport(exported, fx.sign);
      expect(readChallengeFile(outPath)).toEqual(challenge);
      const reexported = JSON.parse(serializedExport(challenge, flow)) as ClientApprovalExport;
      expect(reexported.challenge).toEqual(challenge);
      expect(out.join("\n")).toContain(challenge.canonicalPayload);
      await assertPrepared(fx, flow, challenge);
      out.length = 0;
      let signatureReads = 0;
      expect(
        await runDaemonCli(
          [
            flow.operation,
            "execute",
            "--request-id",
            challenge.requestId,
            "--signature-stdin",
            "--challenge",
            outPath,
          ],
          io,
          {
            socketPath: fx.socketPath,
            readSignature: async () => {
              signatureReads += 1;
              return signature;
            },
          },
        ),
        err.join("\n"),
      ).toBe(0);
      expect(signatureReads).toBe(1);
      expect(err).toEqual([]);
      expect(out.join("\n")).toContain("OUTCOME: success");
      await assertCompleted(
        fx,
        flow,
        challenge,
        flow.execute(challenge.requestId, signature),
        "cli",
      );
    },
  );

  it("reports unknown-outcome ambiguity after a disconnect with no replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "playops-client-e2e-drop-"));
    dirs.push(dir);
    const socketPath = join(dir, "drop.sock");
    let dispatches = 0;
    const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("error", () => undefined);
      socket.on("end", () => {
        dispatches += 1;
        socket.destroy();
      });
    });
    stubs.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const result = await send(socketPath, {
      kind: "execute_commit",
      requestId: "99999999-2222-4333-8444-555555555555",
      signature: "x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("malformed_response");
      expect(result.failure.exitCode).toBe(2);
    }
    // Exactly one dispatch, no replay.
    expect(dispatches).toBe(1);
  });

  it("fails closed on an over-large response and on connect failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "playops-client-e2e-large-"));
    dirs.push(dir);
    const socketPath = join(dir, "large.sock");
    const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("error", () => undefined);
      socket.on("end", () => {
        socket.write(Buffer.alloc(300 * 1024, 0x62));
        socket.end();
      });
    });
    stubs.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const large = await send(socketPath, { kind: "status" });
    expect(large.ok).toBe(false);
    if (!large.ok) expect(large.failure.kind).toBe("response_too_large");

    const missing = await send(join(dir, "absent.sock"), { kind: "status" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.failure.kind).toBe("connect_failure");
      expect(missing.failure.exitCode).toBe(1);
    }
  });
});

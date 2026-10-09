/**
 * Stage 3D — `prepare_commit` / `execute_commit` over the REAL Stage-3B socket.
 *
 * Real: the Unix-domain socket server, framing, the dispatcher, the pending
 * store, exclusive claims, operator signature verification, the
 * operator_signature resolver, executeOneTool, runAgent, the production
 * `releases.commit_edit` tool, the real commit-attempt journal, the real
 * write-intent gate and the shared package-scoped coordinator.
 *
 * Fake: the Google gateway only. Offline; never touches /run/playops.
 */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPackageOperationSingleFlightCoordinator } from "../src/daemon/package-operation-singleflight.js";
import type { DaemonCommitDependencies } from "../src/daemon/commit-operations.js";
import { createDaemonOperations } from "../src/daemon/operations.js";
import { createFilePendingOperationStore } from "../src/daemon/pending-store.js";
import {
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
  encodeDaemonFrame,
  parseDaemonResponse,
  type DaemonResponseEnvelope,
} from "../src/daemon/protocol.js";
import { createDaemonServer, type DaemonServer } from "../src/daemon/server.js";
import type { ReleaseCommitAttemptJournal } from "../src/releases/commit-attempt-journal.js";
import { createFileReleaseCommitAttemptJournal } from "../src/releases/commit-attempt-journal.js";
import type { ReleaseCommitGateway } from "../src/releases/gateway.js";
import { createFileReleaseWriteIntentStore } from "../src/releases/release-write-intent-store.js";
import { createFileReleaseEditSessionStore } from "../src/releases/session-store.js";
import { createFileAgentLedger } from "../src/runtime/agent/index.js";
import { createFileApprovalLedger } from "../src/runtime/approvals/index.js";
import { createOperatorApprovalVerifier } from "../src/runtime/approvals/operator-signature.js";
import { ToolRegistry } from "../src/runtime/tools/index.js";
import { createFileVerificationLedger } from "../src/runtime/verification/index.js";
import { createReleaseEditOpenTool } from "../src/releases/open-tool.js";

const PACKAGE = "com.example.app";
const EDIT_ID = "edit-socket-commit";
const TRACK = "internal";
const VERSION_CODE = "42";
const EXPIRY = "1900000000";
/** `edits.validate` returns the edit's own expiry; the journal requires equality. */
const VALIDATION_EXPIRY = EXPIRY;
const CORRELATION = "commit-socket";

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
  vi.restoreAllMocks();
});

interface Exchange {
  readonly response?: DaemonResponseEnvelope;
  readonly raw: Buffer;
}

async function exchangeOnce(
  socketPath: string,
  chunks: readonly Buffer[],
  options: { halfClose?: boolean; destroyAfterMs?: number } = {},
): Promise<Exchange> {
  const halfClose = options.halfClose ?? true;
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
      if (halfClose) socket.end();
      if (options.destroyAfterMs !== undefined) {
        setTimeout(() => socket.destroy(), options.destroyAfterMs);
      }
    });
    socket.on("data", (chunk: Buffer) => received.push(chunk));
    socket.on("error", () => undefined);
    socket.on("close", finalize);
    setTimeout(finalize, 3_000);
  });
}

interface SocketHarness {
  readonly socketPath: string;
  readonly dir: string;
  readonly privateKey: KeyObject;
  readonly calls: { getEdit: number; getTrack: number; validateEdit: number; commitEdit: number };
  readonly faults: { commitHold: Promise<void> | undefined };
  readonly pendingStore: ReturnType<typeof createFilePendingOperationStore>;
  readonly deps: DaemonCommitDependencies;
  frame(request: unknown): Buffer;
  sign(canonicalPayload: string): string;
  call(request: unknown): Promise<DaemonResponseEnvelope>;
  sendRaw(chunks: readonly Buffer[], options?: { destroyAfterMs?: number }): Promise<Exchange>;
}

async function buildSocketHarness(): Promise<SocketHarness> {
  const dir = mkdtempSync(join(tmpdir(), "playops-commit-socket-"));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  const socketPath = join(dir, "playops.sock");
  const pendingRoot = join(dir, "pending");
  mkdirSync(pendingRoot, { mode: 0o700 });
  const pendingStore = createFilePendingOperationStore(pendingRoot);
  const sessionStore = createFileReleaseEditSessionStore(join(dir, "edit-session.json"), {
    expectedPackageName: PACKAGE,
  });
  await sessionStore.save({
    version: 1,
    packageName: PACKAGE,
    editId: EDIT_ID,
    expiryTimeSeconds: EXPIRY,
    createdAt: new Date().toISOString(),
  });

  const calls = { getEdit: 0, getTrack: 0, validateEdit: 0, commitEdit: 0 };
  const faults: { commitHold: Promise<void> | undefined } = { commitHold: undefined };
  const track = {
    track: TRACK,
    releases: [{ name: "42 (1.0)", status: "inProgress" as const, versionCodes: [VERSION_CODE] }],
  };
  const gateway: ReleaseCommitGateway = {
    getEdit: async (session) => {
      calls.getEdit += 1;
      return { id: EDIT_ID, expiryTimeSeconds: session.expiryTimeSeconds };
    },
    getTrack: async () => {
      calls.getTrack += 1;
      return structuredClone(track);
    },
    validateEdit: async () => {
      calls.validateEdit += 1;
      return { id: EDIT_ID, expiryTimeSeconds: VALIDATION_EXPIRY };
    },
    commitEdit: async () => {
      calls.commitEdit += 1;
      if (faults.commitHold !== undefined) await faults.commitHold;
      return { id: EDIT_ID, expiryTimeSeconds: EXPIRY };
    },
  };

  const journalPath = join(dir, "commit-attempt-journal.json");
  const openJournal = (): ReleaseCommitAttemptJournal =>
    createFileReleaseCommitAttemptJournal(journalPath, { expectedPackageName: PACKAGE });

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const deps: DaemonCommitDependencies = {
    packageName: PACKAGE,
    pendingStore,
    claimRoot: join(dir, "claims"),
    managedSessionStore: sessionStore,
    releaseGateway: gateway,
    writeIntentStore: createFileReleaseWriteIntentStore(join(dir, "write-intents")),
    commitAuditLedger: { append: async (): Promise<void> => undefined },
    openCommitAttemptJournal: openJournal,
    operatorVerifier: createOperatorApprovalVerifier(publicKey, "commit-socket-anchor"),
    ledger: createFileAgentLedger(join(dir, "agent.jsonl")),
    approvalLedger: createFileApprovalLedger(join(dir, "approval.jsonl")),
    verificationLedger: createFileVerificationLedger(join(dir, "verification.jsonl")),
  };

  const registry = new ToolRegistry();
  // The dispatcher resolves the open-edit binding's permission from the
  // registry at construction, so the real open-edit tool is registered here too.
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
    commit: deps,
    operatorVerifier: deps.operatorVerifier,
    ledger: deps.ledger,
    approvalLedger: deps.approvalLedger,
    verificationLedger: deps.verificationLedger,
  });

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
  };
}

async function prepareOverSocket(
  harness: SocketHarness,
): Promise<{ requestId: string; canonicalPayload: string }> {
  const prepared = await harness.call({
    kind: "prepare_commit",
    track: TRACK,
    versionCode: VERSION_CODE,
  });
  expect(prepared.outcome).toBe("approval_required");
  const approval = prepared.approval;
  if (approval === undefined) throw new Error("prepare returned no challenge");
  return { requestId: approval.requestId, canonicalPayload: approval.canonicalPayload };
}

describe("commit over the daemon socket", () => {
  it("binds a private socket for the commit path", async () => {
    const harness = await buildSocketHarness();
    const stat = lstatSync(harness.socketPath);
    expect(stat.isSocket()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("prepares a commit approval with zero commit transport", async () => {
    const harness = await buildSocketHarness();
    const { requestId, canonicalPayload } = await prepareOverSocket(harness);

    expect(canonicalPayload).toContain("PLAYOPS_OPERATOR_APPROVAL_V1");
    expect(await harness.pendingStore.state(requestId)).toBe("pending");
    expect(harness.calls).toEqual({ getEdit: 1, getTrack: 1, validateEdit: 1, commitEdit: 0 });
    const record = await harness.pendingStore.load(requestId);
    expect(record?.operation).toBe("commit");
    expect(JSON.stringify(record)).not.toContain("privateKey");
  });

  it("executes the commit end-to-end over a fresh socket", async () => {
    const harness = await buildSocketHarness();
    const { requestId, canonicalPayload } = await prepareOverSocket(harness);

    const executed = await harness.call({
      kind: "execute_commit",
      requestId,
      signature: harness.sign(canonicalPayload),
    });

    expect(executed.outcome).toBe("success");
    expect(harness.calls.commitEdit).toBe(1);
    expect(await harness.pendingStore.state(requestId)).toBe("completed");
    const journal = createFileReleaseCommitAttemptJournal(
      join(harness.dir, "commit-attempt-journal.json"),
      { expectedPackageName: PACKAGE },
    );
    const records = await journal.list();
    expect(records).toHaveLength(1);
    // ACKNOWLEDGED, never REMOTE_VERIFIED: verification belongs to Stage 3E.
    expect(records[0]?.state).toBe("ACKNOWLEDGED");
  });

  it("refuses a bad signature over the socket with zero transport and no consumption", async () => {
    const harness = await buildSocketHarness();
    const { requestId } = await prepareOverSocket(harness);

    const denied = await harness.call({
      kind: "execute_commit",
      requestId,
      signature: "c2ln",
    });

    expect(denied.outcome).toBe("approval_mismatch");
    expect(denied.error?.code).toBe("SIGNATURE_INVALID");
    expect(harness.calls.commitEdit).toBe(0);
    expect(await harness.pendingStore.state(requestId)).toBe("pending");
    const journal = createFileReleaseCommitAttemptJournal(
      join(harness.dir, "commit-attempt-journal.json"),
      { expectedPackageName: PACKAGE },
    );
    expect(await journal.list()).toEqual([]);
  });

  it("keeps the daemon lifecycle running when the client disconnects mid-commit", async () => {
    const harness = await buildSocketHarness();
    const { requestId, canonicalPayload } = await prepareOverSocket(harness);
    let release: (() => void) | undefined;
    harness.faults.commitHold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const exchange = await harness.sendRaw(
      [
        harness.frame({
          kind: "execute_commit",
          requestId,
          signature: harness.sign(canonicalPayload),
        }),
      ],
      { destroyAfterMs: 60 },
    );
    expect(exchange.raw.byteLength).toBe(0);
    // The client is gone, but the daemon-owned lifecycle keeps going: the
    // transport is reached without any client connection present.
    await vi.waitFor(() => {
      expect(harness.calls.commitEdit).toBe(1);
    });

    // The daemon's own lifecycle owns the outcome, not the socket.
    release?.();
    await vi.waitFor(async () => {
      expect(await harness.pendingStore.state(requestId)).toBe("completed");
    });
    // No retry was triggered by the disconnect.
    expect(harness.calls.commitEdit).toBe(1);
  });
});

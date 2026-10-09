/**
 * Stage 3B — safe `status` operation.
 *
 * Read-only: no approval, no signature, no pending request, no claim, and zero
 * Google calls. Real pending store and real managed-session store; fake gateway.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDaemonOperations,
  type DaemonOperations,
  type DaemonStatusEvidence,
} from "../src/daemon/operations.js";
import { createPackageOperationSingleFlightCoordinator } from "../src/daemon/package-operation-singleflight.js";
import {
  createFilePendingOperationStore,
  type PendingOperationStore,
} from "../src/daemon/pending-store.js";
import {
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
  parseDaemonRequest,
  serializeDaemonResponse,
  type DaemonRequestEnvelope,
  type DaemonResponseEnvelope,
} from "../src/daemon/protocol.js";
import { createFileAgentLedger } from "../src/runtime/agent/index.js";
import { createFileApprovalLedger } from "../src/runtime/approvals/index.js";
import { createOperatorApprovalVerifier } from "../src/runtime/approvals/operator-signature.js";
import { ToolRegistry } from "../src/runtime/tools/index.js";
import { createFileVerificationLedger } from "../src/runtime/verification/index.js";
import type { ReleaseEditGateway } from "../src/releases/gateway.js";
import { createReleaseEditOpenTool } from "../src/releases/open-tool.js";
import {
  createFileReleaseEditSessionStore,
  type ReleaseEditSessionStore,
} from "../src/releases/session-store.js";

const PACKAGE = "com.example.release";
const CORRELATION = "status-corr";
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-status-"));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function envelope(request: unknown): DaemonRequestEnvelope {
  return parseDaemonRequest({
    protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
    correlationId: CORRELATION,
    request,
  });
}

interface StatusHarness {
  readonly daemon: DaemonOperations;
  readonly pendingStore: PendingOperationStore;
  readonly sessionStore: ReleaseEditSessionStore;
  readonly createEdit: ReturnType<typeof vi.fn>;
  readonly getEdit: ReturnType<typeof vi.fn>;
  readonly listTracks: ReturnType<typeof vi.fn>;
  status(): Promise<DaemonResponseEnvelope>;
  prepare(): Promise<DaemonResponseEnvelope>;
  execute(requestId: string, signature: string): Promise<DaemonResponseEnvelope>;
  signFor(canonicalPayload: string): string;
}

function buildStatusHarness(evidence?: () => Promise<DaemonStatusEvidence>): StatusHarness {
  const dir = tempDir();
  // Dedicated root: the store's `list()` parses every *.json it finds, so the
  // pending store must not share a directory with the managed-session file.
  const pendingRoot = join(dir, "pending");
  mkdirSync(pendingRoot, { mode: 0o700 });
  const pendingStore = createFilePendingOperationStore(pendingRoot);
  const sessionStore = createFileReleaseEditSessionStore(join(dir, "edit-session.json"), {
    expectedPackageName: PACKAGE,
  });
  const createEdit = vi.fn(async () => ({
    packageName: PACKAGE,
    editId: "edit-1",
    expiryTimeSeconds: "1900000000",
  }));
  const getEdit = vi.fn(async () => ({ id: "edit-1", expiryTimeSeconds: "1900000000" }));
  const listTracks = vi.fn(async () => []);
  const gateway: ReleaseEditGateway = { createEdit, getEdit, listTracks };
  const built = createReleaseEditOpenTool({ packageName: PACKAGE, gateway, store: sessionStore });
  const registry = new ToolRegistry();
  registry.register(built.tool);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const daemon = createDaemonOperations({
    packageName: PACKAGE,
    pendingStore,
    claimRoot: join(dir, "claims"),
    packageOperations: createPackageOperationSingleFlightCoordinator(),
    registry,
    openEdit: { binding: built.binding, input: {} },
    operatorVerifier: createOperatorApprovalVerifier(publicKey, "status-test-anchor"),
    ledger: createFileAgentLedger(join(dir, "agent.jsonl")),
    approvalLedger: createFileApprovalLedger(join(dir, "approval.jsonl")),
    verificationLedger: createFileVerificationLedger(join(dir, "verification.jsonl")),
    ...(evidence === undefined ? {} : { readStatusEvidence: evidence }),
  });
  return {
    daemon,
    pendingStore,
    sessionStore,
    createEdit,
    getEdit,
    listTracks,
    status: (): Promise<DaemonResponseEnvelope> => daemon.handle(envelope({ kind: "status" })),
    prepare: (): Promise<DaemonResponseEnvelope> =>
      daemon.handle(envelope({ kind: "prepare_open_edit" })),
    execute: (requestId: string, signature: string): Promise<DaemonResponseEnvelope> =>
      daemon.handle(envelope({ kind: "execute_open_edit", requestId, signature })),
    signFor: (canonicalPayload: string): string =>
      sign(null, Buffer.from(canonicalPayload, "utf8"), privateKey).toString("base64url"),
  };
}

/** Parse the documented `key=value` status summary into a map. */
function parseSummary(summary: string | undefined): Record<string, string> {
  if (summary === undefined) throw new Error("status carried no summary");
  const fields: Record<string, string> = {};
  for (const token of summary.split(" ")) {
    const index = token.indexOf("=");
    if (index === -1) throw new Error(`status field is not key=value: ${token}`);
    fields[token.slice(0, index)] = token.slice(index + 1);
  }
  return fields;
}

describe("daemon status operation", () => {
  it("is read-only: no approval, signature, claim and zero Google calls", async () => {
    const harness = buildStatusHarness(async () => ({
      packageVersion: "9.9.9-test",
      managedSessionPresent: false,
      pendingCleanup: false,
      unresolvedCommitRecovery: false,
    }));

    const result = await harness.status();

    expect(result.outcome).toBe("status");
    expect(result.approval).toBeUndefined();
    expect(result.requestId).toBeUndefined();
    expect(result.operation).toBeUndefined();
    expect(harness.createEdit).not.toHaveBeenCalled();
    expect(harness.getEdit).not.toHaveBeenCalled();
    expect(harness.listTracks).not.toHaveBeenCalled();
    expect(await harness.sessionStore.load()).toBeUndefined();
  });

  it("reports the safety fields in a stable parseable summary", async () => {
    const harness = buildStatusHarness(async () => ({
      packageVersion: "9.9.9-test",
      managedSessionPresent: true,
      pendingCleanup: false,
      unresolvedCommitRecovery: true,
    }));

    const fields = parseSummary((await harness.status()).summary);

    expect(fields.protocolVersion).toBe(String(PLAYOPS_DAEMON_PROTOCOL_VERSION));
    expect(fields.protocolVersion).toBe("4");
    // Version comes from the injected metadata seam, never hard-coded here.
    expect(fields.packageVersion).toBe("9.9.9-test");
    expect(fields.configuredPackage).toBe(PACKAGE);
    // Stage 3C added attach_notes; Stage 3D added prepare_commit and
    // execute_commit; Stage 3E.3 adds prepare_verify_committed and
    // execute_verify_committed; Stage 3F.2 adds prepare_reconcile_commit and
    // execute_reconcile_commit, so no reconciliation operation stays unserved.
    expect(fields.servedOperations).toBe(
      "status,prepare_open_edit,execute_open_edit,attach_notes,prepare_commit,execute_commit,prepare_verify_committed,execute_verify_committed,prepare_reconcile_commit,execute_reconcile_commit",
    );
    expect(fields.managedSessionPresent).toBe("true");
    expect(fields.pendingCleanup).toBe("false");
    expect(fields.unresolvedCommitRecovery).toBe("true");
  });

  it("reports unavailable rather than guessing when no evidence provider is wired", async () => {
    const harness = buildStatusHarness();
    const fields = parseSummary((await harness.status()).summary);

    expect(fields.packageVersion).toBe("unavailable");
    expect(fields.managedSessionPresent).toBe("unavailable");
    expect(fields.pendingCleanup).toBe("unavailable");
    expect(fields.unresolvedCommitRecovery).toBe("unavailable");
    // Counts still come from the real store, so they stay truthful.
    expect(fields.pending).toBe("0");
    expect(fields.completed).toBe("0");
  });

  it("derives managedSessionPresent from the real session store", async () => {
    const sessionRef: { store?: ReleaseEditSessionStore } = {};
    const harness = buildStatusHarness(async () => ({
      packageVersion: "9.9.9-test",
      managedSessionPresent:
        sessionRef.store === undefined
          ? "unavailable"
          : (await sessionRef.store.load()) !== undefined,
      pendingCleanup: "unavailable",
      unresolvedCommitRecovery: "unavailable",
    }));
    sessionRef.store = harness.sessionStore;

    expect(parseSummary((await harness.status()).summary).managedSessionPresent).toBe("false");

    // A successful open-edit persists a managed session, so status must change.
    const prepared = await harness.prepare();
    const approval = prepared.approval;
    if (approval === undefined) throw new Error("no challenge");
    const executed = await harness.execute(
      approval.requestId,
      harness.signFor(approval.canonicalPayload),
    );
    expect(executed.outcome).toBe("success");

    expect(parseSummary((await harness.status()).summary).managedSessionPresent).toBe("true");
  });

  it("reports live pending-state counts from the store's own projection", async () => {
    const harness = buildStatusHarness();
    expect(parseSummary((await harness.status()).summary).pending).toBe("0");

    const prepared = await harness.prepare();
    const approval = prepared.approval;
    if (approval === undefined) throw new Error("no challenge");

    const afterPrepare = parseSummary((await harness.status()).summary);
    expect(afterPrepare.pending).toBe("1");
    expect(afterPrepare.completed).toBe("0");

    await harness.execute(approval.requestId, harness.signFor(approval.canonicalPayload));

    const afterExecute = parseSummary((await harness.status()).summary);
    expect(afterExecute.pending).toBe("0");
    expect(afterExecute.completed).toBe("1");
    expect(afterExecute.recoveryRequired).toBe("0");
    expect(afterExecute.expired).toBe("0");
  });

  it("never exposes credentials, identities, digests or note material", async () => {
    const harness = buildStatusHarness(async () => ({
      packageVersion: "9.9.9-test",
      managedSessionPresent: true,
      pendingCleanup: false,
      unresolvedCommitRecovery: false,
    }));
    const prepared = await harness.prepare();
    const result = await harness.status();

    // The response must survive the protocol's own secret-field guard.
    expect(() => serializeDaemonResponse(result)).not.toThrow();

    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "editId",
      "edit-1",
      "requestDigest",
      "stateDigest",
      "validationExpiry",
      "nonce",
      "releaseNotes",
      "private_key",
      "privateKey",
      "access_token",
      "refresh_token",
      "client_secret",
      "authorization",
      "Authorization",
      "credentials",
      "serviceAccountJson",
      "signature",
      "client_email",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    // The pending request id must not leak either.
    expect(serialized).not.toContain(prepared.approval?.requestId ?? "unused");
  });
});

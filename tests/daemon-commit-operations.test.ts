/**
 * Stage 3D — `prepare_commit` / `execute_commit` dispatcher proofs.
 *
 * Real: the pending store, the exclusive claim, operator signature verification,
 * the operator_signature approval resolver, executeOneTool, runAgent, the
 * production `releases.commit_edit` tool and its verifier, the real
 * commit-attempt journal, the real release write-intent gate, the managed
 * session store and the Stage-3D.2 package-scoped coordinator.
 *
 * Fake: the Google gateway only. Nothing here contacts Google, and no test
 * asserts anything about remote reality beyond the fake gateway's own calls.
 */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPackageOperationSingleFlightCoordinator } from "../src/daemon/package-operation-singleflight.js";
import {
  executeCommit,
  journalBlockingRecord,
  prepareCommit,
  type DaemonCommitDependencies,
} from "../src/daemon/commit-operations.js";
import { createDaemonOperations } from "../src/daemon/operations.js";
import {
  createFilePendingOperationStore,
  type PendingOperationStore,
} from "../src/daemon/pending-store.js";
import {
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
  type DaemonRequest,
  type DaemonResponseEnvelope,
} from "../src/daemon/protocol.js";

import type { NewAuditEntry } from "../src/audit/index.js";
import { createFileReleaseCommitAttemptJournal } from "../src/releases/commit-attempt-journal.js";
import type { ReleaseCommitAttemptJournal } from "../src/releases/commit-attempt-journal.js";
import {
  createReleaseCommitIntent,
  createReleaseCommitStateDigest,
} from "../src/releases/commit-approval.js";
import type { ReleaseCommitGateway } from "../src/releases/gateway.js";
import { RELEASE_CONFIGURATION_STATUSES, type ReleaseTrackState } from "../src/releases/index.js";
import {
  createFileReleaseWriteIntentStore,
  releaseWriteIntentNoteDigest,
  type ReleaseWriteIntentState,
  type ReleaseWriteIntentStore,
} from "../src/releases/release-write-intent-store.js";
import {
  createFileReleaseEditSessionStore,
  type ReleaseEditSessionStore,
} from "../src/releases/session-store.js";
import { createFileAgentLedger } from "../src/runtime/agent/index.js";
import { createFileApprovalLedger } from "../src/runtime/approvals/index.js";
import { createOperatorApprovalVerifier } from "../src/runtime/approvals/operator-signature.js";
import {
  encodeOperatorApprovalPayload,
  OPERATOR_APPROVAL_PROTOCOL_VERSION,
} from "../src/runtime/approvals/operator-signature.js";
import { ToolRegistry } from "../src/runtime/tools/index.js";
import { createFileVerificationLedger } from "../src/runtime/verification/index.js";
import { createReleaseEditOpenTool } from "../src/releases/open-tool.js";

const PACKAGE = "com.example.app";
const EDIT_A = "edit-alpha";
const EDIT_B = "edit-beta";
const TRACK = "internal";
const VERSION_CODE = "42";
const EXPIRY = "1900000000";
/**
 * Google's `edits.validate` returns the edit's own expiry, so the production
 * journal requires `expiryTimeSeconds === validationExpiryTimeSeconds`; the
 * fixtures therefore keep them equal and drift BOTH together when testing the
 * validation-expiry contract.
 */
const VALIDATION_EXPIRY = EXPIRY;

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-commit-"));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  return dir;
}

function trackState(
  overrides: Partial<ReleaseTrackState["releases"][number]> = {},
): ReleaseTrackState {
  return {
    track: TRACK,
    releases: [
      {
        name: "42 (1.0)",
        status: RELEASE_CONFIGURATION_STATUSES[1],
        versionCodes: [VERSION_CODE],
        ...overrides,
      },
    ],
  };
}

interface FakeGoogle {
  readonly calls: {
    getEdit: number;
    getTrack: number;
    validateEdit: number;
    commitEdit: number;
  };
  readonly gateway: ReleaseCommitGateway;
  readonly faults: {
    commitHold: Promise<void> | undefined;
    commitThrows: Error | undefined;
    editId: string;
    validationExpiry: string;
    track: ReleaseTrackState;
    failGetTrackFrom: number;
  };
  readonly managed: () => ReleaseTrackState;
}

function createFakeGoogle(): FakeGoogle {
  const calls = { getEdit: 0, getTrack: 0, validateEdit: 0, commitEdit: 0 };
  const faults: {
    commitHold: Promise<void> | undefined;
    commitThrows: Error | undefined;
    editId: string;
    validationExpiry: string;
    track: ReleaseTrackState;
    failGetTrackFrom: number;
  } = {
    commitHold: undefined,
    commitThrows: undefined,
    editId: EDIT_A,
    validationExpiry: VALIDATION_EXPIRY,
    track: trackState(),
    failGetTrackFrom: 0,
  };
  const gateway: ReleaseCommitGateway = {
    getEdit: async (session) => {
      calls.getEdit += 1;
      return { id: faults.editId, expiryTimeSeconds: session.expiryTimeSeconds };
    },
    getTrack: async () => {
      calls.getTrack += 1;
      if (faults.failGetTrackFrom > 0 && calls.getTrack >= faults.failGetTrackFrom) {
        throw new Error("fake gateway: track read failed");
      }
      return structuredClone(faults.track);
    },
    validateEdit: async () => {
      calls.validateEdit += 1;
      return { id: faults.editId, expiryTimeSeconds: faults.validationExpiry };
    },
    commitEdit: async () => {
      calls.commitEdit += 1;
      if (faults.commitHold !== undefined) await faults.commitHold;
      if (faults.commitThrows !== undefined) throw faults.commitThrows;
      return { id: faults.editId, expiryTimeSeconds: EXPIRY };
    },
  };
  return { calls, gateway, faults, managed: () => structuredClone(faults.track) };
}

interface Harness {
  readonly dir: string;
  readonly operations: ReturnType<typeof createDaemonOperations>;
  readonly deps: DaemonCommitDependencies;
  /** The ONE shared coordinator this daemon uses for every mutating operation. */
  readonly packageOperations: ReturnType<typeof createPackageOperationSingleFlightCoordinator>;
  readonly fake: FakeGoogle;
  readonly pendingStore: PendingOperationStore;
  readonly sessionStore: ReleaseEditSessionStore;
  readonly journal: ReleaseCommitAttemptJournal;
  readonly journalPath: string;
  readonly writeIntentStore: ReleaseWriteIntentStore;
  readonly privateKey: KeyObject;
  readonly committed: string[];
  readonly dispatched: string[];
  call(request: DaemonRequest): Promise<DaemonResponseEnvelope>;
  envelope(request: DaemonRequest): {
    protocolVersion: number;
    correlationId: string;
    request: DaemonRequest;
  };
  setSessionExpiry(expiry: string): Promise<void>;
  setManagedTrack(track: ReleaseTrackState): void;
  sign(canonicalPayload: string): string;
  seedWriteIntent(state: ReleaseWriteIntentState, editId?: string): Promise<void>;
  journalRecords(): Promise<readonly { attemptId: string; state: string }[]>;
}

async function buildHarness(
  options: { withSession?: boolean; sessionEditId?: string } = {},
): Promise<Harness> {
  const dir = tempDir();
  const pendingRoot = join(dir, "pending");
  mkdirSync(pendingRoot, { mode: 0o700 });
  const pendingStore = createFilePendingOperationStore(pendingRoot);
  const sessionEditId = options.sessionEditId ?? EDIT_A;
  const sessionStore = createFileReleaseEditSessionStore(join(dir, "edit-session.json"), {
    expectedPackageName: PACKAGE,
  });
  if (options.withSession !== false) {
    await sessionStore.save({
      version: 1,
      packageName: PACKAGE,
      editId: sessionEditId,
      expiryTimeSeconds: EXPIRY,
      createdAt: new Date().toISOString(),
    });
  }
  const fake = createFakeGoogle();
  fake.faults.editId = sessionEditId;
  const journalPath = join(dir, "commit-attempt-journal.json");
  const openJournal = (): ReleaseCommitAttemptJournal =>
    createFileReleaseCommitAttemptJournal(journalPath, { expectedPackageName: PACKAGE });
  const writeIntentStore = createFileReleaseWriteIntentStore(join(dir, "write-intents"));
  const committed: string[] = [];
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  const deps: DaemonCommitDependencies = {
    packageName: PACKAGE,
    pendingStore,
    claimRoot: join(dir, "claims"),
    managedSessionStore: sessionStore,
    releaseGateway: fake.gateway,
    writeIntentStore,
    // The commit tool's own audit ledger; entries are captured, not inspected.
    commitAuditLedger: {
      append: async (entry: NewAuditEntry): Promise<void> => {
        committed.push(entry.type);
      },
    },
    openCommitAttemptJournal: openJournal,
    operatorVerifier: createOperatorApprovalVerifier(publicKey, "commit-test-anchor"),
    ledger: createFileAgentLedger(join(dir, "agent.jsonl")),
    approvalLedger: createFileApprovalLedger(join(dir, "approval.jsonl")),
    verificationLedger: createFileVerificationLedger(join(dir, "verification.jsonl")),
  };

  const openBuilt = createReleaseEditOpenTool({
    packageName: PACKAGE,
    gateway: {
      createEdit: async () => ({
        packageName: PACKAGE,
        editId: sessionEditId,
        expiryTimeSeconds: EXPIRY,
      }),
      getEdit: (session) => fake.gateway.getEdit(session),
      listTracks: async () => [],
    },
    store: sessionStore,
  });
  const registry = new ToolRegistry();
  registry.register(openBuilt.tool);

  const dispatched: string[] = [];
  // The ONE coordinator instance this daemon shares across open/attach/commit.
  const packageOperations = createPackageOperationSingleFlightCoordinator();
  const operations = createDaemonOperations({
    packageName: PACKAGE,
    pendingStore,
    claimRoot: join(dir, "claims"),
    packageOperations,
    registry,
    openEdit: { binding: openBuilt.binding, input: {} },
    commit: deps,
    operatorVerifier: deps.operatorVerifier,
    ledger: deps.ledger,
    approvalLedger: deps.approvalLedger,
    verificationLedger: deps.verificationLedger,
  });

  const envelope = (request: DaemonRequest) => ({
    protocolVersion: PLAYOPS_DAEMON_PROTOCOL_VERSION,
    correlationId: "commit-corr",
    request,
  });

  return {
    dir,
    operations,
    deps,
    packageOperations,
    fake,
    pendingStore,
    sessionStore,
    journal: openJournal(),
    journalPath,
    writeIntentStore,
    privateKey,
    committed,
    dispatched,
    envelope,
    call: async (request: DaemonRequest): Promise<DaemonResponseEnvelope> => {
      dispatched.push(request.kind);
      return operations.handle(envelope(request));
    },
    setSessionExpiry: async (expiry: string): Promise<void> => {
      const current = await sessionStore.load();
      if (current === undefined) throw new Error("no tracked session to update");
      fake.faults.validationExpiry = expiry;
      await sessionStore.save({ ...current, expiryTimeSeconds: expiry });
    },
    setManagedTrack: (track: ReleaseTrackState): void => {
      fake.faults.track = structuredClone(track);
    },
    sign: (canonicalPayload: string): string =>
      sign(null, Buffer.from(canonicalPayload, "utf8"), privateKey).toString("base64url"),
    seedWriteIntent: async (
      state: ReleaseWriteIntentState,
      editId: string = EDIT_A,
    ): Promise<void> => {
      const scope = { packageName: PACKAGE, editId };
      await writeIntentStore.acquire({
        ...scope,
        track: TRACK,
        versionCode: VERSION_CODE,
        locale: "en-US",
        noteDigest: releaseWriteIntentNoteDigest("seeded"),
        priorTrackDigest: "a".repeat(64),
        expectedTrackDigest: "b".repeat(64),
      });
      const path: Record<ReleaseWriteIntentState, () => Promise<void>> = {
        PREPARED: async (): Promise<void> => undefined,
        TRANSPORT_ATTEMPTED: async (): Promise<void> => {
          await writeIntentStore.transition({
            ...scope,
            from: "PREPARED",
            to: "TRANSPORT_ATTEMPTED",
          });
        },
        AMBIGUOUS: async (): Promise<void> => {
          await writeIntentStore.transition({
            ...scope,
            from: "PREPARED",
            to: "TRANSPORT_ATTEMPTED",
          });
          await writeIntentStore.transition({
            ...scope,
            from: "TRANSPORT_ATTEMPTED",
            to: "AMBIGUOUS",
          });
        },
        VERIFIED_EXPECTED: async (): Promise<void> => {
          await writeIntentStore.transition({
            ...scope,
            from: "PREPARED",
            to: "TRANSPORT_ATTEMPTED",
          });
          await writeIntentStore.transition({
            ...scope,
            from: "TRANSPORT_ATTEMPTED",
            to: "VERIFIED_EXPECTED",
          });
        },
        VERIFIED_PRIOR: async (): Promise<void> => {
          await writeIntentStore.transition({ ...scope, from: "PREPARED", to: "VERIFIED_PRIOR" });
        },
      };
      await path[state]();
    },
    journalRecords: async () =>
      (await openJournal().list()).map((record) => ({
        attemptId: record.attemptId,
        state: record.state,
      })),
  };
}

/** Prepare a commit approval and return the signed execution material. */
async function prepareSigned(
  harness: Harness,
  overrides: { track?: string; versionCode?: string } = {},
): Promise<{ requestId: string; signature: string; canonicalPayload: string }> {
  const prepared = await harness.call({
    kind: "prepare_commit",
    track: overrides.track ?? TRACK,
    versionCode: overrides.versionCode ?? VERSION_CODE,
  });
  expect(prepared.outcome).toBe("approval_required");
  const approval = prepared.approval;
  if (approval === undefined) throw new Error("prepare returned no challenge");
  return {
    requestId: approval.requestId,
    canonicalPayload: approval.canonicalPayload,
    signature: harness.sign(approval.canonicalPayload),
  };
}

// ------------------------------------------------------------------ prepare

describe("prepare_commit: trusted intent derivation", () => {
  it("derives the production intent from read-only Google calls and returns a safe challenge", async () => {
    const harness = await buildHarness();
    const prepared = await harness.call({
      kind: "prepare_commit",
      track: TRACK,
      versionCode: VERSION_CODE,
    });

    expect(prepared.outcome).toBe("approval_required");
    expect(prepared.approval?.permission).toBe("publish");
    expect(prepared.approval?.toolName).toBe("releases.commit_edit");
    expect(prepared.approval?.canonicalPayload).toContain("PLAYOPS_OPERATOR_APPROVAL_V1");
    expect(prepared.summary).toContain("PUBLISH Google Play edit.");

    // Exactly the read/validation budget; zero commit-shaped calls.
    expect(harness.fake.calls).toEqual({
      getEdit: 1,
      getTrack: 1,
      validateEdit: 1,
      commitEdit: 0,
    });

    const requestId = prepared.approval?.requestId;
    if (requestId === undefined) throw new Error("missing request id");
    const record = await harness.pendingStore.load(requestId);
    expect(record).toBeDefined();
    expect(record?.state).toBe("PENDING");
    expect(record?.operation).toBe("commit");
    expect(record?.permission).toBe("publish");
    expect(record?.packageName).toBe(PACKAGE);
    // The private intent carries only server-derived identity.
    expect(record?.intent).toEqual({
      kind: "commit",
      targetTrack: TRACK,
      versionCode: VERSION_CODE,
      editId: EDIT_A,
      stateDigest: createReleaseCommitStateDigest(trackState()),
      validationExpiryTimeSeconds: VALIDATION_EXPIRY,
      releaseName: "42 (1.0)",
      releaseStatus: RELEASE_CONFIGURATION_STATUSES[1],
    });
    // The challenge never exposes the intent.
    expect(prepared.approval).not.toHaveProperty("intent");
    expect(JSON.stringify(prepared)).not.toContain(EDIT_A);
    expect(harness.dispatched).toEqual(["prepare_commit"]);
  });

  it("refuses with zero Google calls when no managed edit is tracked", async () => {
    const harness = await buildHarness({ withSession: false });
    const prepared = await harness.call({
      kind: "prepare_commit",
      track: TRACK,
      versionCode: VERSION_CODE,
    });

    expect(prepared.outcome).toBe("local_state_failure");
    expect(prepared.error?.code).toBe("NO_MANAGED_EDIT");
    expect(harness.fake.calls.getEdit).toBe(0);
    expect(await harness.pendingStore.list()).toEqual([]);
  });

  it("refuses to create a challenge while a durable commit attempt is unresolved", async () => {
    const harness = await buildHarness();
    // A real unresolved PREPARED record for this package.
    await harness.journal.prepare({
      version: 1,
      packageName: PACKAGE,
      editId: EDIT_A,
      expiryTimeSeconds: EXPIRY,
      targetTrack: TRACK,
      versionCode: VERSION_CODE,
      releaseName: "42 (1.0)",
      releaseStatus: "inProgress",
      expectedStateDigest: createReleaseCommitStateDigest(trackState()),
      validationExpiryTimeSeconds: VALIDATION_EXPIRY,
      requestDigest: "c".repeat(64),
      attemptedAtUtc: "2026-10-06T00:00:00.000Z",
      updatedAtUtc: "2026-10-06T00:00:00.000Z",
    });

    const prepared = await harness.call({
      kind: "prepare_commit",
      track: TRACK,
      versionCode: VERSION_CODE,
    });

    expect(prepared.outcome).toBe("operation_in_progress");
    expect(prepared.error?.code).toBe("COMMIT_JOURNAL_PREPARED_UNRESOLVED");
    expect(harness.fake.calls.commitEdit).toBe(0);
    expect(await harness.pendingStore.list()).toEqual([]);
  });

  it.each([
    ["PREPARED", "operation_in_progress"],
    ["TRANSPORT_ATTEMPTED", "external_state_ambiguous"],
    ["AMBIGUOUS", "external_state_ambiguous"],
    ["VERIFIED_EXPECTED", "cleanup_pending"],
    ["VERIFIED_PRIOR", "cleanup_pending"],
  ] as const)(
    "refuses to create a challenge while the release write gate is %s",
    async (state, expectedOutcome) => {
      const harness = await buildHarness();
      await harness.seedWriteIntent(state);

      const prepared = await harness.call({
        kind: "prepare_commit",
        track: TRACK,
        versionCode: VERSION_CODE,
      });

      expect(prepared.outcome).toBe(expectedOutcome);
      expect(prepared.error?.code).toBe(`WRITE_INTENT_${state}`);
      expect(harness.fake.calls.getEdit).toBe(0);
      expect(await harness.pendingStore.list()).toEqual([]);
    },
  );

  it("refuses a commit when the tracked edit is not the remote edit", async () => {
    const harness = await buildHarness();
    harness.fake.faults.editId = EDIT_B;
    const prepared = await harness.call({
      kind: "prepare_commit",
      track: TRACK,
      versionCode: VERSION_CODE,
    });
    expect(prepared.outcome).toBe("local_state_failure");
    expect(prepared.error?.code).toBe("EDIT_SESSION_INVALID");
    expect(harness.fake.calls.commitEdit).toBe(0);
  });

  it("refuses a versionCode that no configured release carries", async () => {
    const harness = await buildHarness();
    const prepared = await harness.call({
      kind: "prepare_commit",
      track: TRACK,
      versionCode: "99",
    });
    expect(prepared.outcome).toBe("local_state_failure");
    expect(prepared.error?.code).toBe("INVALID_COMMIT_INTENT");
    expect(harness.fake.calls.commitEdit).toBe(0);
  });
});

// ------------------------------------------------------------------ execute

describe("execute_commit: signed execution", () => {
  it("executes the production commit path exactly once and completes the request", async () => {
    const harness = await buildHarness();
    const { requestId, signature } = await prepareSigned(harness);

    const executed = await harness.call({ kind: "execute_commit", requestId, signature });

    expect(executed.outcome).toBe("success");
    expect(harness.fake.calls.commitEdit).toBe(1);
    expect(await harness.pendingStore.state(requestId)).toBe("completed");
    // The production tool's own settled behavior is reported, not changed.
    expect(await harness.sessionStore.load()).toBeUndefined();
    const records = await harness.journalRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.state).toBe("ACKNOWLEDGED");
    expect(harness.committed).toContain("release.commit.completed");
  });

  it("requires a genuine signature: socket access is not authorization", async () => {
    const harness = await buildHarness();
    const { requestId } = await prepareSigned(harness);

    const denied = await harness.call({
      kind: "execute_commit",
      requestId,
      signature: "c2ln",
    });

    expect(denied.outcome).toBe("approval_mismatch");
    expect(denied.error?.code).toBe("SIGNATURE_INVALID");
    expect(harness.fake.calls.commitEdit).toBe(0);
    // No claim, no consumption, nothing durable written.
    expect(await harness.pendingStore.state(requestId)).toBe("pending");
    expect(await harness.journalRecords()).toEqual([]);
  });

  it("refuses a request id it never issued", async () => {
    const harness = await buildHarness();
    const answer = await harness.call({
      kind: "execute_commit",
      requestId: "11111111-2222-4333-8444-555555555555",
      signature: "c2ln",
    });
    expect(answer.outcome).toBe("request_not_found");
    expect(harness.fake.calls.commitEdit).toBe(0);
  });

  it("refuses a signature over a different pending request", async () => {
    const harness = await buildHarness();
    const first = await prepareSigned(harness);
    const second = await prepareSigned(harness, { versionCode: VERSION_CODE });

    const denied = await harness.call({
      kind: "execute_commit",
      requestId: second.requestId,
      signature: first.signature,
    });

    expect(denied.outcome).toBe("approval_mismatch");
    expect(harness.fake.calls.commitEdit).toBe(0);
    expect(await harness.pendingStore.state(second.requestId)).toBe("pending");
  });

  it("reports a definite preconditions failure with zero commit transport", async () => {
    const harness = await buildHarness();
    const { requestId, signature } = await prepareSigned(harness);
    harness.fake.faults.failGetTrackFrom = 1;

    const answer = await harness.call({ kind: "execute_commit", requestId, signature });

    expect(answer.outcome).toBe("local_state_failure");
    expect(harness.fake.calls.commitEdit).toBe(0);
  });

  it("records operator_signature provenance without leaking the signature or key material", async () => {
    const harness = await buildHarness();
    const { requestId, signature } = await prepareSigned(harness);
    expect((await harness.call({ kind: "execute_commit", requestId, signature })).outcome).toBe(
      "success",
    );

    const approvalRaw = readFileSync(join(harness.dir, "approval.jsonl"), "utf8");
    const approvals = approvalRaw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; metadata: Record<string, unknown> });
    const approved = approvals.filter((entry) => entry.type === "approval.approved");
    expect(approved).toHaveLength(1);
    expect(approved[0]?.metadata.source).toBe("operator_signature");
    expect(approved[0]?.metadata.signatureVerified).toBe(true);
    expect(approvalRaw).not.toContain(signature);
    expect(approvalRaw).not.toContain("privateKey");

    const agent = readFileSync(join(harness.dir, "agent.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(agent.some((entry) => entry.type === "agent.tool.execution.completed")).toBe(true);
    // The production tool's own audit entry, not a daemon re-implementation.
    expect(harness.committed).toContain("release.commit.completed");
  });

  it("pins the exact Google call budget of one commit execution", async () => {
    const harness = await buildHarness();
    const { requestId, signature } = await prepareSigned(harness);
    const afterPrepare = { ...harness.fake.calls };
    await harness.call({ kind: "execute_commit", requestId, signature });
    // Preparation is read-only: one identity read, one track read, one
    // validation, zero commit-shaped calls.
    expect(afterPrepare).toEqual({ getEdit: 1, getTrack: 1, validateEdit: 1, commitEdit: 0 });
    // Execution adds the daemon's own trusted re-derivation (one of each) plus
    // the authoritative production tool's documented passes (one more getEdit,
    // two fresh track checks and one fresh validation), and exactly ONE commit
    // transport.
    expect(harness.fake.calls).toEqual({ getEdit: 3, getTrack: 4, validateEdit: 3, commitEdit: 1 });
  });
});

// ------------------------------------------- concurrency and single flight

describe("execute_commit: package-scoped single flight", () => {
  it("shares ONE coordinator across requests: an externally held package lease blocks execution", async () => {
    const harness = await buildHarness();
    const { requestId, signature } = await prepareSigned(harness);
    // If the daemon constructed a coordinator per request, this externally held
    // lease would be invisible and the commit would proceed.
    const held = harness.packageOperations.tryAcquirePackageOperation(PACKAGE);
    expect(held.acquired).toBe(true);

    const answer = await harness.call({ kind: "execute_commit", requestId, signature });

    expect(answer.outcome).toBe("operation_in_progress");
    expect(answer.error?.code).toBe("PACKAGE_OPERATION_IN_PROGRESS");
    expect(harness.fake.calls.commitEdit).toBe(0);
    expect(await harness.pendingStore.state(requestId)).toBe("pending");
    expect(await harness.journalRecords()).toEqual([]);
    if (held.acquired) harness.packageOperations.releasePackageOperation(held.lease);
  });

  it("bounds two concurrent calls for the SAME signed request to one commit", async () => {
    const harness = await buildHarness();
    const { requestId, signature } = await prepareSigned(harness);
    let release: (() => void) | undefined;
    harness.fake.faults.commitHold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = harness.call({ kind: "execute_commit", requestId, signature });
    // Deterministic: wait until the winner is provably inside commit transport.
    await vi.waitFor(() => {
      expect(harness.fake.calls.commitEdit).toBe(1);
    });
    const second = harness.call({ kind: "execute_commit", requestId, signature });
    const loser = await second;
    expect(["request_claim_held", "request_already_consumed", "operation_in_progress"]).toContain(
      loser.outcome,
    );
    release?.();
    const winner = await first;

    expect(winner.outcome).toBe("success");
    expect(harness.fake.calls.commitEdit).toBe(1);
    expect(await harness.pendingStore.state(requestId)).toBe("completed");
    // Exactly one durable attempt exists: one transport, one prepared record.
    expect(await harness.journalRecords()).toHaveLength(1);
  });

  it("bounds two DIFFERENT signed approvals for the same package to one commit transport", async () => {
    const harness = await buildHarness();
    const first = await prepareSigned(harness);
    const second = await prepareSigned(harness);
    expect(second.requestId).not.toBe(first.requestId);
    let release: (() => void) | undefined;
    harness.fake.faults.commitHold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const winnerPromise = harness.call({
      kind: "execute_commit",
      requestId: first.requestId,
      signature: first.signature,
    });
    await vi.waitFor(() => {
      expect(harness.fake.calls.commitEdit).toBe(1);
    });

    const loser = await harness.call({
      kind: "execute_commit",
      requestId: second.requestId,
      signature: second.signature,
    });

    // The package gate refuses the second request before any journal prepare,
    // approval consumption or transport.
    expect(loser.outcome).toBe("operation_in_progress");
    expect(await harness.pendingStore.state(second.requestId)).toBe("pending");
    expect(harness.fake.calls.commitEdit).toBe(1);
    expect(await harness.journalRecords()).toHaveLength(1);

    release?.();
    expect((await winnerPromise).outcome).toBe("success");
    expect(harness.fake.calls.commitEdit).toBe(1);
  });

  it("bounds two approved requests for DIFFERENT edit identities in the same package", async () => {
    const harness = await buildHarness();
    const first = await prepareSigned(harness);
    const firstRecord = await harness.pendingStore.load(first.requestId);
    // The daemon tracks exactly one managed edit at a time, so a second commit
    // approval for a DIFFERENT edit identity in the SAME package is seeded
    // directly: the point under test is that the exclusion scope is the PACKAGE,
    // not the edit key.
    const seeded = await harness.pendingStore.prepare({
      operation: "commit",
      toolName: "releases.commit_edit",
      permission: "publish",
      packageName: PACKAGE,
      requestDigest: "9".repeat(64),
      intent: {
        kind: "commit",
        targetTrack: TRACK,
        versionCode: VERSION_CODE,
        editId: EDIT_B,
        stateDigest: createReleaseCommitStateDigest(trackState()),
        validationExpiryTimeSeconds: VALIDATION_EXPIRY,
        releaseName: "42 (1.0)",
        releaseStatus: "inProgress",
      },
    });
    const secondSignature = harness.sign(
      encodeOperatorApprovalPayload({
        protocolVersion: OPERATOR_APPROVAL_PROTOCOL_VERSION,
        requestId: seeded.requestId,
        nonce: seeded.nonce,
        toolName: seeded.toolName,
        permission: seeded.permission,
        packageName: seeded.packageName,
        requestDigest: seeded.requestDigest,
        expiresAtUtc: seeded.expiresAtUtc,
      }).toString("utf8"),
    );
    const secondRecord = await harness.pendingStore.load(seeded.requestId);
    expect(firstRecord?.intent).toMatchObject({ editId: EDIT_A });
    expect(secondRecord?.intent).toMatchObject({ editId: EDIT_B });
    expect(firstRecord?.packageName).toBe(secondRecord?.packageName);

    let release: (() => void) | undefined;
    harness.fake.faults.commitHold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const winnerPromise = harness.call({
      kind: "execute_commit",
      requestId: first.requestId,
      signature: first.signature,
    });
    await vi.waitFor(() => {
      expect(harness.fake.calls.commitEdit).toBe(1);
    });

    const loser = await harness.call({
      kind: "execute_commit",
      requestId: seeded.requestId,
      signature: secondSignature,
    });

    expect(loser.outcome).toBe("operation_in_progress");
    expect(await harness.pendingStore.state(seeded.requestId)).toBe("pending");
    expect(await harness.journalRecords()).toHaveLength(1);
    expect(harness.fake.calls.commitEdit).toBe(1);

    release?.();
    expect((await winnerPromise).outcome).toBe("success");
    expect(harness.fake.calls.commitEdit).toBe(1);
    // The loser is still a clean, unconsumed approval.
    expect(await harness.pendingStore.state(seeded.requestId)).toBe("pending");
  });

  it("releases the package lease at request completion", async () => {
    const harness = await buildHarness();
    const { requestId, signature } = await prepareSigned(harness);
    expect((await harness.call({ kind: "execute_commit", requestId, signature })).outcome).toBe(
      "success",
    );
    const after = harness.packageOperations.tryAcquirePackageOperation(PACKAGE);
    expect(after.acquired).toBe(true);
    if (after.acquired)
      expect(harness.packageOperations.releasePackageOperation(after.lease)).toEqual({
        released: true,
      });
  });
});

// --------------------------------------------------- durable authority gates

describe("execute_commit: durable authority rechecks", () => {
  it("refuses a later commit while the previous attempt is durably unresolved", async () => {
    const harness = await buildHarness();
    // Two approvals prepared while the package is still clean.
    const first = await prepareSigned(harness);
    const second = await prepareSigned(harness);

    expect(
      (
        await harness.call({
          kind: "execute_commit",
          requestId: first.requestId,
          signature: first.signature,
        })
      ).outcome,
    ).toBe("success");
    const records = await harness.journalRecords();
    expect(records).toHaveLength(1);
    // ACKNOWLEDGED is unresolved: it is NOT remote verification.
    expect(records[0]?.state).toBe("ACKNOWLEDGED");
    const attemptId = records[0]?.attemptId;

    const blocked = await harness.call({
      kind: "execute_commit",
      requestId: second.requestId,
      signature: second.signature,
    });

    expect(blocked.outcome).toBe("external_state_ambiguous");
    expect(blocked.error?.code).toBe("COMMIT_JOURNAL_UNRESOLVED");
    expect(harness.fake.calls.commitEdit).toBe(1);
    // The journal record is untouched and the second approval is not consumed.
    expect(await harness.journalRecords()).toEqual([{ attemptId, state: "ACKNOWLEDGED" }]);
    expect(await harness.pendingStore.state(second.requestId)).toBe("pending");
  });

  it.each([
    ["PREPARED", "operation_in_progress", "COMMIT_JOURNAL_PREPARED_UNRESOLVED"],
    ["TRANSPORT_ATTEMPTED", "external_state_ambiguous", "COMMIT_JOURNAL_UNRESOLVED"],
    ["AMBIGUOUS", "external_state_ambiguous", "COMMIT_JOURNAL_UNRESOLVED"],
  ] as const)(
    "refuses execution while a durable %s attempt exists for the package",
    async (state, expectedOutcome, expectedCode) => {
      const harness = await buildHarness();
      const { requestId, signature } = await prepareSigned(harness);
      const seeded = await harness.journal.prepare({
        version: 1,
        packageName: PACKAGE,
        editId: EDIT_B,
        expiryTimeSeconds: EXPIRY,
        targetTrack: TRACK,
        versionCode: VERSION_CODE,
        releaseName: "42 (1.0)",
        releaseStatus: "inProgress",
        expectedStateDigest: createReleaseCommitStateDigest(trackState()),
        validationExpiryTimeSeconds: VALIDATION_EXPIRY,
        requestDigest: "d".repeat(64),
        attemptedAtUtc: "2026-10-06T00:00:00.000Z",
        updatedAtUtc: "2026-10-06T00:00:00.000Z",
      });
      if (state !== "PREPARED") {
        await harness.journal.transition(
          seeded.attemptId,
          "PREPARED",
          "TRANSPORT_ATTEMPTED",
          "2026-10-06T00:05:00.000Z",
        );
        if (state === "AMBIGUOUS") {
          await harness.journal.transition(
            seeded.attemptId,
            "TRANSPORT_ATTEMPTED",
            "AMBIGUOUS",
            "2026-10-06T00:10:00.000Z",
          );
        }
      }
      const before = await harness.journalRecords();
      expect(before).toHaveLength(1);
      expect(before[0]?.state).toBe(state);

      const answer = await harness.call({ kind: "execute_commit", requestId, signature });

      expect(answer.outcome).toBe(expectedOutcome);
      expect(answer.error?.code).toBe(expectedCode);
      expect(harness.fake.calls.commitEdit).toBe(0);
      expect(await harness.pendingStore.state(requestId)).toBe("pending");
      // The unresolved attempt is never altered by the refusal.
      expect(await harness.journalRecords()).toEqual(before);
    },
  );

  it("refuses execution while the release write gate is held, with the store's own mapping", async () => {
    const harness = await buildHarness();
    const { requestId, signature } = await prepareSigned(harness);
    await harness.seedWriteIntent("TRANSPORT_ATTEMPTED");

    const answer = await harness.call({ kind: "execute_commit", requestId, signature });

    expect(answer.outcome).toBe("external_state_ambiguous");
    expect(answer.error?.code).toBe("WRITE_INTENT_TRANSPORT_ATTEMPTED");
    expect(harness.fake.calls.commitEdit).toBe(0);
    expect(await harness.pendingStore.state(requestId)).toBe("pending");
    expect(await harness.journalRecords()).toEqual([]);
  });

  it("refuses execution when the approved state has drifted, requiring a new approval", async () => {
    const harness = await buildHarness();
    const { requestId, signature } = await prepareSigned(harness);
    // Somebody else changes the release after approval.
    harness.setManagedTrack(
      trackState({ releaseNotes: [{ language: "en-US", text: "changed elsewhere" }] }),
    );

    const answer = await harness.call({ kind: "execute_commit", requestId, signature });

    expect(answer.outcome).toBe("local_state_failure");
    expect(answer.error?.code).toBe("COMMIT_INTENT_DRIFT_STATE_DIGEST");
    expect(harness.fake.calls.commitEdit).toBe(0);
    // The signature is not consumed by a refused attempt.
    expect(await harness.pendingStore.state(requestId)).toBe("pending");
    expect(await harness.journalRecords()).toEqual([]);
  });

  it("refuses execution when the validation expiry changed after approval", async () => {
    const harness = await buildHarness();
    const { requestId, signature } = await prepareSigned(harness);
    // A new validation window: both the tracked session and the remote edit move.
    await harness.setSessionExpiry("1900000200");

    const answer = await harness.call({ kind: "execute_commit", requestId, signature });

    expect(answer.outcome).toBe("local_state_failure");
    expect(answer.error?.code).toBe("COMMIT_INTENT_DRIFT_VALIDATION_EXPIRY");
    expect(harness.fake.calls.commitEdit).toBe(0);
  });

  it("refuses execution when the target track drifted after approval", async () => {
    const harness = await buildHarness();
    const { requestId, signature } = await prepareSigned(harness);
    harness.fake.faults.track = { track: TRACK, releases: [] };

    const answer = await harness.call({ kind: "execute_commit", requestId, signature });

    expect(answer.outcome).toBe("local_state_failure");
    expect(harness.fake.calls.commitEdit).toBe(0);
  });
});

// --------------------------------------------------- durability failure paths

/** Journal wrapper that can fail one durable write, to prove the failure paths. */
function failingJournal(
  inner: ReleaseCommitAttemptJournal,
  failOn: "PREPARED" | "TRANSPORT_ATTEMPTED" | "ACKNOWLEDGED",
): ReleaseCommitAttemptJournal {
  return {
    list: () => inner.list(),
    prepare: (input) =>
      failOn === "PREPARED"
        ? Promise.reject(new Error("injected: PREPARED durability failure"))
        : inner.prepare(input),
    transition: (attemptId, from, to, updatedAtUtc, patch) =>
      (failOn === "TRANSPORT_ATTEMPTED" && to === "TRANSPORT_ATTEMPTED") ||
      (failOn === "ACKNOWLEDGED" && to === "ACKNOWLEDGED")
        ? Promise.reject(new Error(`injected: ${to} durability failure`))
        : inner.transition(attemptId, from, to, updatedAtUtc, patch),
    updateVerification: (attemptId, from, updatedAtUtc, patch) =>
      inner.updateVerification(attemptId, from, updatedAtUtc, patch),
  };
}

async function harnessWithJournal(
  failOn: "PREPARED" | "TRANSPORT_ATTEMPTED" | "ACKNOWLEDGED",
): Promise<Harness> {
  const harness = await buildHarness();
  const real = createFileReleaseCommitAttemptJournal(harness.journalPath, {
    expectedPackageName: PACKAGE,
  });
  const broken = failingJournal(real, failOn);
  (
    harness.deps as { openCommitAttemptJournal: () => ReleaseCommitAttemptJournal }
  ).openCommitAttemptJournal = () => broken;
  return harness;
}

describe("execute_commit: durable failure paths never fake ambiguity", () => {
  it("reports a definite local failure when the journal PREPARED write fails before any transport", async () => {
    const harness = await harnessWithJournal("PREPARED");
    const { requestId, signature } = await prepareSigned(harness);

    const answer = await harness.call({ kind: "execute_commit", requestId, signature });

    expect(harness.fake.calls.commitEdit).toBe(0);
    expect(answer.outcome).toBe("local_state_failure");
    // Not reusable: the approval was already consumed.
    expect(await harness.pendingStore.state(requestId)).toBe("recovery_required");
    expect(harness.committed).toContain("release.commit.failed");
  });

  it("reports a definite local failure when the TRANSPORT_ATTEMPTED marker cannot be written", async () => {
    const harness = await harnessWithJournal("TRANSPORT_ATTEMPTED");
    const { requestId, signature } = await prepareSigned(harness);

    const answer = await harness.call({ kind: "execute_commit", requestId, signature });

    expect(harness.fake.calls.commitEdit).toBe(0);
    expect(answer.outcome).toBe("local_state_failure");
    expect(await harness.pendingStore.state(requestId)).toBe("recovery_required");
  });

  it("reports remote ambiguity when the commit may have succeeded but the ACK write failed", async () => {
    const harness = await harnessWithJournal("ACKNOWLEDGED");
    const { requestId, signature } = await prepareSigned(harness);

    const answer = await harness.call({ kind: "execute_commit", requestId, signature });

    expect(harness.fake.calls.commitEdit).toBe(1);
    expect(answer.outcome).toBe("external_state_ambiguous");
    expect(await harness.pendingStore.state(requestId)).toBe("recovery_required");
  });

  it("reports remote ambiguity for an uncertain transport with exactly one attempt and no retry", async () => {
    const harness = await buildHarness();
    const { requestId, signature } = await prepareSigned(harness);
    harness.fake.faults.commitThrows = new Error("fake gateway: transport outcome unknown");

    const answer = await harness.call({ kind: "execute_commit", requestId, signature });

    expect(answer.outcome).toBe("external_state_ambiguous");
    expect(harness.fake.calls.commitEdit).toBe(1);
    expect(await harness.pendingStore.state(requestId)).toBe("recovery_required");
    const records = await harness.journalRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.state).toBe("AMBIGUOUS");
  });

  it("leaves the pending record non-reusable after any consumed approval", async () => {
    const harness = await buildHarness();
    const { requestId, signature } = await prepareSigned(harness);
    harness.fake.faults.commitThrows = new Error("fake gateway: transport outcome unknown");
    await harness.call({ kind: "execute_commit", requestId, signature });

    const replay = await harness.call({ kind: "execute_commit", requestId, signature });

    expect(replay.outcome).toBe("external_state_ambiguous");
    expect(harness.fake.calls.commitEdit).toBe(1);
  });
});

// --------------------------------------------------- journal semantics mirror

describe("commit journal mirror", () => {
  async function blocking(journal: ReleaseCommitAttemptJournal): Promise<boolean> {
    return journalBlockingRecord(await journal.list()) !== undefined;
  }

  async function realJournalWouldRefuse(journal: ReleaseCommitAttemptJournal): Promise<boolean> {
    try {
      await journal.prepare({
        version: 1,
        packageName: PACKAGE,
        editId: EDIT_B,
        expiryTimeSeconds: EXPIRY,
        targetTrack: TRACK,
        versionCode: VERSION_CODE,
        releaseName: "42 (1.0)",
        releaseStatus: "inProgress",
        expectedStateDigest: createReleaseCommitStateDigest(trackState()),
        validationExpiryTimeSeconds: VALIDATION_EXPIRY,
        requestDigest: "e".repeat(64),
        attemptedAtUtc: "2026-10-06T00:00:00.000Z",
        updatedAtUtc: "2026-10-06T00:00:00.000Z",
      });
      return false;
    } catch (cause) {
      expect((cause as { code?: string }).code).toBe("COMMIT_ATTEMPT_JOURNAL_INVALID");
      return true;
    }
  }

  const AT = "2026-10-06T00:00:00.000Z";
  const LATER = "2026-10-06T00:05:00.000Z";

  async function journalWith(
    build: (journal: ReleaseCommitAttemptJournal) => Promise<void>,
  ): Promise<ReleaseCommitAttemptJournal> {
    const dir = tempDir();
    const journal = createFileReleaseCommitAttemptJournal(
      join(dir, "commit-attempt-journal.json"),
      { expectedPackageName: PACKAGE },
    );
    await build(journal);
    return journal;
  }

  it.each([
    ["empty", async (): Promise<void> => undefined],
    [
      "PREPARED",
      async (journal: ReleaseCommitAttemptJournal): Promise<void> => {
        await journal.prepare(seedPrepared());
      },
    ],
    [
      "TRANSPORT_ATTEMPTED",
      async (journal: ReleaseCommitAttemptJournal): Promise<void> => {
        const record = await journal.prepare(seedPrepared());
        await journal.transition(record.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", LATER);
      },
    ],
    [
      "ACKNOWLEDGED",
      async (journal: ReleaseCommitAttemptJournal): Promise<void> => {
        const record = await journal.prepare(seedPrepared());
        await journal.transition(record.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", LATER);
        await journal.transition(record.attemptId, "TRANSPORT_ATTEMPTED", "ACKNOWLEDGED", LATER, {
          acknowledgedAtUtc: LATER,
        });
      },
    ],
    [
      "AMBIGUOUS",
      async (journal: ReleaseCommitAttemptJournal): Promise<void> => {
        const record = await journal.prepare(seedPrepared());
        await journal.transition(record.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", LATER);
        await journal.transition(record.attemptId, "TRANSPORT_ATTEMPTED", "AMBIGUOUS", LATER);
      },
    ],
    [
      "REMOTE_VERIFIED",
      async (journal: ReleaseCommitAttemptJournal): Promise<void> => {
        const record = await journal.prepare(seedPrepared());
        await journal.transition(record.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", LATER);
        await journal.updateVerification(record.attemptId, "TRANSPORT_ATTEMPTED", LATER, {
          verificationInsertAttempted: true,
        });
        await journal.updateVerification(record.attemptId, "TRANSPORT_ATTEMPTED", LATER, {
          verificationEditId: "verification-edit",
          verificationEditExpiryTimeSeconds: "9223372036854775807",
        });
        await journal.updateVerification(record.attemptId, "TRANSPORT_ATTEMPTED", LATER, {
          verificationObservedStateDigest: createReleaseCommitStateDigest(trackState()),
          verificationObservedAtUtc: LATER,
        });
        await journal.transition(record.attemptId, "TRANSPORT_ATTEMPTED", "REMOTE_VERIFIED", LATER);
      },
    ],
    [
      "RECONCILED_NOT_COMMITTED",
      async (journal: ReleaseCommitAttemptJournal): Promise<void> => {
        const record = await journal.prepare(seedPrepared());
        await journal.transition(record.attemptId, "PREPARED", "RECONCILED_NOT_COMMITTED", LATER);
      },
    ],
    [
      "RECONCILED_NOT_COMMITTED with pending verification cleanup",
      async (journal: ReleaseCommitAttemptJournal): Promise<void> => {
        const record = await journal.prepare(seedPrepared());
        await journal.transition(record.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", LATER);
        await journal.updateVerification(record.attemptId, "TRANSPORT_ATTEMPTED", LATER, {
          verificationInsertAttempted: true,
        });
        await journal.updateVerification(record.attemptId, "TRANSPORT_ATTEMPTED", LATER, {
          verificationEditId: "verification-edit",
          verificationEditExpiryTimeSeconds: "9223372036854775807",
        });
        await journal.transition(
          record.attemptId,
          "TRANSPORT_ATTEMPTED",
          "RECONCILED_NOT_COMMITTED",
          LATER,
        );
      },
    ],
    [
      "RECONCILED_COMMITTED",
      async (journal: ReleaseCommitAttemptJournal): Promise<void> => {
        const record = await journal.prepare(seedPrepared());
        await journal.transition(record.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", LATER);
        await journal.updateVerification(record.attemptId, "TRANSPORT_ATTEMPTED", LATER, {
          verificationInsertAttempted: true,
        });
        await journal.updateVerification(record.attemptId, "TRANSPORT_ATTEMPTED", LATER, {
          verificationEditId: "verification-edit",
          verificationEditExpiryTimeSeconds: "9223372036854775807",
        });
        await journal.updateVerification(record.attemptId, "TRANSPORT_ATTEMPTED", LATER, {
          verificationObservedStateDigest: createReleaseCommitStateDigest(trackState()),
          verificationObservedAtUtc: LATER,
        });
        await journal.transition(record.attemptId, "TRANSPORT_ATTEMPTED", "REMOTE_VERIFIED", LATER);
        await journal.updateVerification(record.attemptId, "REMOTE_VERIFIED", LATER, {
          verificationPreDeleteReadVerified: true,
        });
        await journal.updateVerification(record.attemptId, "REMOTE_VERIFIED", LATER, {
          verificationDeleteAttempted: true,
        });
        await journal.updateVerification(record.attemptId, "REMOTE_VERIFIED", LATER, {
          verificationDeleteAcknowledged: true,
        });
        await journal.updateVerification(record.attemptId, "REMOTE_VERIFIED", LATER, {
          verificationCleanupVerified: true,
        });
        await journal.transition(
          record.attemptId,
          "REMOTE_VERIFIED",
          "RECONCILED_COMMITTED",
          LATER,
        );
      },
    ],
  ] as const)("mirrors the real journal's own refusal for the %s state", async (_name, build) => {
    const journal = await journalWith(
      build as (journal: ReleaseCommitAttemptJournal) => Promise<void>,
    );
    const mirrorBlocks = await blocking(journal);
    const realBlocks = await realJournalWouldRefuse(journal);
    expect(mirrorBlocks).toBe(realBlocks);
  });

  function seedPrepared(): Parameters<ReleaseCommitAttemptJournal["prepare"]>[0] {
    return {
      version: 1,
      packageName: PACKAGE,
      editId: EDIT_A,
      expiryTimeSeconds: EXPIRY,
      targetTrack: TRACK,
      versionCode: VERSION_CODE,
      releaseName: "42 (1.0)",
      releaseStatus: "inProgress",
      expectedStateDigest: createReleaseCommitStateDigest(trackState()),
      validationExpiryTimeSeconds: VALIDATION_EXPIRY,
      requestDigest: "f".repeat(64),
      attemptedAtUtc: AT,
      updatedAtUtc: AT,
    };
  }
});

/** Intent creation is exercised directly so the production helper stays pinned. */
describe("commit intent binding", () => {
  it("is derived by the shared production helper, not a daemon-specific digest", async () => {
    const intent = createReleaseCommitIntent({
      packageName: PACKAGE,
      editId: EDIT_A,
      targetTrack: TRACK,
      versionCode: VERSION_CODE,
      targetTrackState: trackState(),
      validatedEdit: { valid: true, expiryTimeSeconds: VALIDATION_EXPIRY },
    });
    const harness = await buildHarness();
    const prepared = await harness.call({
      kind: "prepare_commit",
      track: TRACK,
      versionCode: VERSION_CODE,
    });
    expect(harness.dispatched).toEqual(["prepare_commit"]);
    expect(prepared.approval?.requestDigest).toBe(intent.requestDigest);
  });
});

/** The dispatcher-level path and the exported functions must agree. */
describe("commit operation entry points", () => {
  it("behaves identically when called directly with the same dependencies", async () => {
    const harness = await buildHarness();
    const direct = await prepareCommit(harness.deps, "direct-corr", {
      track: TRACK,
      versionCode: VERSION_CODE,
    });
    expect(direct.outcome).toBe("approval_required");
    const requestId = direct.approval?.requestId;
    if (requestId === undefined) throw new Error("missing request id");
    const executed = await executeCommit(
      harness.deps,
      harness.packageOperations,
      "direct-corr",
      requestId,
      harness.sign(direct.approval?.canonicalPayload ?? ""),
    );
    expect(executed.outcome).toBe("success");
    expect(harness.fake.calls.commitEdit).toBe(1);
  });
});

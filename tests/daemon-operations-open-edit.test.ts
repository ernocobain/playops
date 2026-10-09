/**
 * Stage 3A — daemon dispatcher, `open_edit` vertical slice.
 *
 * Real: protocol parsing, pending store (schema v2), exclusive O_EXCL claim,
 * operator Ed25519 verification, approval resolver, executeOneTool, runAgent,
 * the production `releases.open_edit` tool, its verifier and the managed-session
 * store. Fake: the Google gateway only. Offline throughout; no network.
 */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { readAuditEntries } from "../src/audit/index.js";
import { createDaemonOperations, type DaemonOperations } from "../src/daemon/operations.js";
import { createPackageOperationSingleFlightCoordinator } from "../src/daemon/package-operation-singleflight.js";
import {
  createFilePendingOperationStore,
  type PendingOperationStore,
} from "../src/daemon/pending-store.js";
import {
  PLAYOPS_DAEMON_PROTOCOL_VERSION,
  parseDaemonRequest,
  type DaemonRequestEnvelope,
  type DaemonResponseEnvelope,
} from "../src/daemon/protocol.js";
import { acquireRequestClaim, requestClaimPath } from "../src/daemon/request-claim.js";
import { createFileAgentLedger, type AgentToolBinding } from "../src/runtime/agent/index.js";
import { createFileApprovalLedger } from "../src/runtime/approvals/index.js";
import { createOperatorApprovalVerifier } from "../src/runtime/approvals/operator-signature.js";
import { ToolRegistry, type ToolDefinition } from "../src/runtime/tools/index.js";
import { createFileVerificationLedger } from "../src/runtime/verification/index.js";
import type { ReleaseEditGateway } from "../src/releases/gateway.js";
import type { GooglePlayEditSession } from "../src/releases/index.js";
import { createReleaseEditOpenTool } from "../src/releases/open-tool.js";
import {
  createFileReleaseEditSessionStore,
  type ReleaseEditSessionStore,
} from "../src/releases/session-store.js";

const PACKAGE = "com.example.release";
const EDIT_ID = "edit-created";
const CORRELATION = "corr-stage3a";
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-daemon-open-"));
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

interface Harness {
  readonly dir: string;
  /** Mutable override simulating the bound approval identity changing at runtime. */
  readonly runtimeDigest: { override: string };
  readonly pendingStore: PendingOperationStore;
  readonly claimRoot: string;
  readonly daemon: DaemonOperations;
  readonly createEdit: Mock;
  readonly getEdit: Mock;
  readonly sessionStore: ReleaseEditSessionStore;
  readonly approvalPath: string;
  readonly auditPath: string;
  readonly observedStatesAtMutation: string[];
  readonly privateKey: KeyObject;
  readonly requestId: string;
  claimExists(): boolean;
  recordFile(): string;
  tamper(mutate: (record: Record<string, unknown>) => void): void;
  prepare(): Promise<DaemonResponseEnvelope>;
  execute(requestId: string, signature: string): Promise<DaemonResponseEnvelope>;
  approvalEntries(): ReturnType<typeof readAuditEntries>;
}

interface HarnessOptions {
  readonly configureGateway?: (gateway: {
    readonly createEdit: Mock;
    readonly getEdit: Mock;
  }) => void;
  readonly wrapStore?: (store: PendingOperationStore) => PendingOperationStore;
  readonly packageName?: string;
  readonly now?: () => Date;
}

async function buildHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = tempDir();
  const packageName = options.packageName ?? PACKAGE;
  const pendingStore = createFilePendingOperationStore(
    dir,
    options.now === undefined ? {} : { now: options.now },
  );
  const claimRoot = join(dir, "claims");
  const sessionStore = createFileReleaseEditSessionStore(join(dir, "edit-session.json"), {
    expectedPackageName: packageName,
  });
  const auditPath = join(dir, "agent.jsonl");
  const approvalPath = join(dir, "approval.jsonl");
  const verificationPath = join(dir, "verification.jsonl");

  // The request id is only known after prepare; the gateway is invoked later.
  const observedStatesAtMutation: string[] = [];
  const stateRef = { requestId: "" };

  const createEdit = vi.fn(async (): Promise<GooglePlayEditSession> => {
    // Recorded at the exact moment the mutating call is made: this is the proof
    // that the durable CONSUMED record precedes mutation.
    observedStatesAtMutation.push(await pendingStore.state(stateRef.requestId));
    return { packageName, editId: EDIT_ID, expiryTimeSeconds: "1900000000" };
  });
  const getEdit = vi.fn(async () => ({ id: EDIT_ID, expiryTimeSeconds: "1900000000" }));
  const listTracks = vi.fn(async () => []);
  const gateway: ReleaseEditGateway = { createEdit, getEdit, listTracks };
  options.configureGateway?.({ createEdit, getEdit });

  const built = createReleaseEditOpenTool({
    packageName,
    gateway,
    store: sessionStore,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const registry = new ToolRegistry();
  registry.register(built.tool);

  // The production binding's digest is stable by construction, so a genuine
  // runtime approval mismatch after successful pre-claim signature validation can
  // only arise if the bound identity changes between prepare and execute. This
  // override simulates exactly that, and is empty by default.
  const runtimeDigest = { override: "" };
  const openApproval = built.binding.approval;
  if (openApproval === undefined) throw new Error("open binding must expose approval hooks");
  const binding: AgentToolBinding = {
    ...built.binding,
    approval: {
      createRequestDigest: (input: unknown): string =>
        runtimeDigest.override === ""
          ? openApproval.createRequestDigest(input)
          : runtimeDigest.override,
      createSafeSummary: (input: unknown): string => openApproval.createSafeSummary(input),
    },
  };

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const daemon = createDaemonOperations({
    packageName,
    pendingStore: options.wrapStore ? options.wrapStore(pendingStore) : pendingStore,
    claimRoot,
    packageOperations: createPackageOperationSingleFlightCoordinator(),
    registry,
    openEdit: { binding, input: {} },
    operatorVerifier: createOperatorApprovalVerifier(publicKey, "stage3a-test-anchor"),
    ledger: createFileAgentLedger(auditPath),
    approvalLedger: createFileApprovalLedger(approvalPath),
    verificationLedger: createFileVerificationLedger(verificationPath),
  });

  const recordFile = (): string => join(dir, `${stateRef.requestId}.json`);

  const harness: Harness = {
    dir,
    pendingStore,
    claimRoot,
    daemon,
    createEdit,
    getEdit,
    sessionStore,
    approvalPath,
    auditPath,
    observedStatesAtMutation,
    runtimeDigest,
    privateKey,
    get requestId(): string {
      return stateRef.requestId;
    },
    claimExists: (): boolean => existsSync(requestClaimPath(claimRoot, stateRef.requestId)),
    recordFile,
    tamper: (mutate): void => {
      const path = recordFile();
      const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      mutate(record);
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    },
    prepare: async (): Promise<DaemonResponseEnvelope> => {
      const prepared = await daemon.handle(envelope({ kind: "prepare_open_edit" }));
      // Track the server-generated id so helpers can address the private record
      // and the claim file without the caller having to thread it through.
      if (prepared.approval !== undefined) stateRef.requestId = prepared.approval.requestId;
      return prepared;
    },
    execute: (requestId: string, signature: string): Promise<DaemonResponseEnvelope> => {
      stateRef.requestId = requestId;
      return daemon.handle(envelope({ kind: "execute_open_edit", requestId, signature }));
    },
    approvalEntries: (): ReturnType<typeof readAuditEntries> => readAuditEntries(approvalPath),
  };
  return harness;
}

/** Prepare, then sign the exact canonical challenge bytes with the test key. */
async function prepareAndSign(harness: Harness): Promise<{
  prepared: DaemonResponseEnvelope;
  requestId: string;
  signature: string;
  canonicalPayload: string;
}> {
  const prepared = await harness.prepare();
  expect(prepared.outcome).toBe("approval_required");
  const approval = prepared.approval;
  if (approval === undefined) throw new Error("prepare returned no approval challenge");
  const signature = sign(
    null,
    Buffer.from(approval.canonicalPayload, "utf8"),
    harness.privateKey,
  ).toString("base64url");
  return {
    prepared,
    requestId: approval.requestId,
    signature,
    canonicalPayload: approval.canonicalPayload,
  };
}

describe("daemon dispatcher static routing", () => {
  it("serves status, prepare_open_edit and execute_open_edit", async () => {
    const harness = await buildHarness();
    expect((await harness.prepare()).outcome).toBe("approval_required");
    // Stage 3B serves status; the other operations are covered below.
    const status = await harness.daemon.handle(envelope({ kind: "status" }));
    expect(status.outcome).toBe("status");
  });

  it("answers every recognized-but-unserved operation with operation_unavailable", async () => {
    const harness = await buildHarness();
    const unserved: readonly unknown[] = [
      { kind: "prepare_commit", track: "internal", versionCode: "3" },
      {
        kind: "execute_commit",
        requestId: "11111111-2222-4333-8444-555555555555",
        signature: "c2ln",
      },
      { kind: "prepare_verify_committed", track: "internal", versionCode: "3" },
      {
        kind: "execute_verify_committed",
        requestId: "11111111-2222-4333-8444-555555555555",
        signature: "c2ln",
      },
      { kind: "prepare_reconcile_commit" },
      {
        kind: "execute_reconcile_commit",
        requestId: "11111111-2222-4333-8444-555555555555",
        signature: "c2ln",
      },
      {
        kind: "attach_notes",
        track: "internal",
        versionCode: "3",
        locale: "en-US",
        noteText: "note",
      },
    ];
    for (const request of unserved) {
      const parsed = envelope(request);
      const answer = await harness.daemon.handle(parsed);
      expect(answer.outcome).toBe("operation_unavailable");
      // Never capability_blocked: that is reserved for capability policy.
      expect(answer.outcome).not.toBe("capability_blocked");
      expect(answer.operation).toBe(parsed.request.kind);
      expect(answer.requestId).toBeUndefined();
    }
  });

  it("rejects an unknown operation before dispatch at the protocol layer", () => {
    expect(() => envelope({ kind: "execute_tool" })).toThrow();
  });

  it("refuses invalid daemon configuration at construction, never as an outcome", () => {
    const dir = tempDir();
    const registry = new ToolRegistry();
    const tool: ToolDefinition<Record<string, never>, unknown> = {
      name: "releases.open_edit",
      description: "Ungated open-edit stand-in.",
      permission: "destructive",
      inputSchema: {
        parse(): Record<string, never> {
          return Object.freeze({});
        },
      },
      outputSchema: {
        parse(value: unknown): unknown {
          return value;
        },
      },
      execute: async () => ({ ok: true }),
      verify: async () => true,
    };
    registry.register(tool);
    // A binding with no approval hooks cannot be gated, so the daemon cannot be
    // constructed at all. This is the configuration fault path — reachable only
    // here, never as `local_state_failure` or any other response outcome.
    const ungated: AgentToolBinding = {
      toolName: "releases.open_edit",
      llm: { name: "releases.open_edit", description: "ungated", inputSchema: { type: "object" } },
      serializeResult: () => "{}",
    };
    const { publicKey } = generateKeyPairSync("ed25519");
    expect(() =>
      createDaemonOperations({
        packageName: PACKAGE,
        pendingStore: createFilePendingOperationStore(dir),
        claimRoot: join(dir, "claims"),
        packageOperations: createPackageOperationSingleFlightCoordinator(),
        registry,
        openEdit: { binding: ungated, input: {} },
        operatorVerifier: createOperatorApprovalVerifier(publicKey, "cfg-test-anchor"),
        ledger: createFileAgentLedger(join(dir, "agent.jsonl")),
        approvalLedger: createFileApprovalLedger(join(dir, "approval.jsonl")),
        verificationLedger: createFileVerificationLedger(join(dir, "verification.jsonl")),
      }),
    ).toThrow(/createRequestDigest/u);
  });
});

describe("prepare_open_edit", () => {
  it("returns a safe challenge and performs zero Google calls", async () => {
    const harness = await buildHarness();
    const prepared = await harness.prepare();

    expect(prepared.outcome).toBe("approval_required");
    expect(harness.createEdit).not.toHaveBeenCalled();
    expect(harness.getEdit).not.toHaveBeenCalled();
    // No managed session exists yet: preparation is not an execution.
    expect(await harness.sessionStore.load()).toBeUndefined();

    const approval = prepared.approval;
    expect(approval?.toolName).toBe("releases.open_edit");
    expect(approval?.permission).toBe("destructive");
    expect(approval?.packageName).toBe(PACKAGE);
    expect(approval?.requestDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(approval?.canonicalPayload.length).toBeGreaterThan(0);
    // The client never supplied any of this.
    expect(await harness.pendingStore.state(approval?.requestId ?? "")).toBe("pending");
  });

  it("derives the digest from the production binding rather than inventing one", async () => {
    const harness = await buildHarness();
    const prepared = await harness.prepare();
    const record = await harness.pendingStore.load(prepared.approval?.requestId ?? "");
    expect(record?.operation).toBe("open_edit");
    expect(record?.packageName).toBe(PACKAGE);
    expect(record?.toolName).toBe("releases.open_edit");
    expect(record?.intent).toEqual({ kind: "open_edit" });
    // No client-controlled identity is persisted.
    expect(JSON.stringify(record?.intent)).not.toContain("editId");
  });
});

describe("execute_open_edit — success lifecycle", () => {
  it("runs claim -> CLAIMED -> approval -> CONSUMED-before-mutation -> COMPLETED", async () => {
    const harness = await buildHarness();
    const { requestId, signature } = await prepareAndSign(harness);

    const result = await harness.execute(requestId, signature);

    expect(result.outcome).toBe("success");
    expect(harness.createEdit).toHaveBeenCalledTimes(1);
    // §12 proof: the durable record read at the moment of the mutating Google
    // call must already be CONSUMED, i.e. before the tool was allowed to run.
    expect(harness.observedStatesAtMutation).toEqual(["consumed"]);
    expect(await harness.pendingStore.state(requestId)).toBe("completed");

    const session = await harness.sessionStore.load();
    expect(session?.editId).toBe(EDIT_ID);
    expect(session?.packageName).toBe(PACKAGE);

    const entries = harness.approvalEntries();
    const approved = entries.filter((entry) => entry.type === "approval.approved");
    const consumed = entries.filter((entry) => entry.type === "approval.consumed");
    expect(approved).toHaveLength(1);
    expect(consumed).toHaveLength(1);
    expect(approved[0]?.metadata?.source).toBe("operator_signature");
    expect(entries.some((entry) => entry.metadata?.source === "interactive")).toBe(false);

    // §17: the claim is released after confirmed success, and the durable
    // COMPLETED state — not the claim file — is the replay authority.
    expect(harness.claimExists()).toBe(false);
  });

  it("blocks replay after success while keeping edits.insert at exactly 1", async () => {
    const harness = await buildHarness();
    const { requestId, signature } = await prepareAndSign(harness);
    expect((await harness.execute(requestId, signature)).outcome).toBe("success");

    const replay = await harness.execute(requestId, signature);
    expect(replay.outcome).toBe("request_already_consumed");
    expect(harness.createEdit).toHaveBeenCalledTimes(1);
    expect(
      harness.approvalEntries().filter((entry) => entry.type === "approval.approved"),
    ).toHaveLength(1);
    expect(await harness.pendingStore.state(requestId)).toBe("completed");
  });
});

describe("execute_open_edit — pre-claim rejection is zero-mutation", () => {
  it("returns request_not_found for a canonical absent request id", async () => {
    const harness = await buildHarness();
    const result = await harness.execute("99999999-8888-4777-8666-555555555555", "c2ln");
    expect(result.outcome).toBe("request_not_found");
    expect(result.requestId).toBe("99999999-8888-4777-8666-555555555555");
    expect(harness.createEdit).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong key", "wrong-key"],
    ["modified signature", "modified"],
    ["unrelated signature", "unrelated"],
  ])("rejects %s before claiming, leaving PENDING and no claim", async (_label, mode) => {
    const harness = await buildHarness();
    const { requestId, signature, canonicalPayload } = await prepareAndSign(harness);
    const other = generateKeyPairSync("ed25519");
    const flipped = Buffer.from(signature, "base64url");
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    const bad =
      mode === "wrong-key"
        ? sign(null, Buffer.from(canonicalPayload, "utf8"), other.privateKey).toString("base64url")
        : mode === "modified"
          ? flipped.toString("base64url")
          : "c2ln";

    const result = await harness.execute(requestId, bad);
    expect(result.outcome).toBe("approval_mismatch");
    expect(harness.createEdit).not.toHaveBeenCalled();
    expect(harness.claimExists()).toBe(false);
    expect(await harness.pendingStore.state(requestId)).toBe("pending");
  });

  it("rejects package drift and a tampered pending record before claiming", async () => {
    const drift = await buildHarness();
    const d = await prepareAndSign(drift);
    drift.tamper((record) => {
      record.packageName = "com.example.drifted";
    });
    expect((await drift.execute(d.requestId, d.signature)).outcome).toBe("approval_mismatch");
    expect(drift.createEdit).not.toHaveBeenCalled();
    expect(drift.claimExists()).toBe(false);

    const tampered = await buildHarness();
    const t = await prepareAndSign(tampered);
    tampered.tamper((record) => {
      record.requestDigest = "f".repeat(64);
    });
    expect((await tampered.execute(t.requestId, t.signature)).outcome).toBe("approval_mismatch");
    expect(tampered.createEdit).not.toHaveBeenCalled();
    expect(tampered.claimExists()).toBe(false);
    expect(await tampered.pendingStore.state(t.requestId)).toBe("pending");
  });

  it("rejects an expired request without claiming", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    let skew = 0;
    const harness = await buildHarness({ now: () => new Date(base + skew) });
    const { requestId, signature } = await prepareAndSign(harness);
    skew = 24 * 60 * 60 * 1000;
    const result = await harness.execute(requestId, signature);
    expect(result.outcome).toBe("approval_expired");
    expect(harness.createEdit).not.toHaveBeenCalled();
    expect(harness.claimExists()).toBe(false);
  });
});

describe("execute_open_edit — ordering, ambiguity and concurrency", () => {
  it("denies and never reaches the tool when CONSUMED cannot be persisted", async () => {
    const harness = await buildHarness({
      wrapStore: (store) => ({
        prepare: (input) => store.prepare(input),
        load: (id) => store.load(id),
        list: () => store.list(),
        state: (id) => store.state(id),
        transition: async (id, from, to) => {
          // The critical seam: the durable consumption write fails.
          if (from === "CLAIMED" && to === "CONSUMED") {
            throw new Error("simulated durable write failure");
          }
          return store.transition(id, from, to);
        },
      }),
    });
    const { requestId, signature } = await prepareAndSign(harness);

    const result = await harness.execute(requestId, signature);

    // A local durable-state failure is NOT an approval mismatch, NOT invalid
    // configuration, NOT a remote failure and NOT externally ambiguous.
    expect(result.outcome).toBe("local_state_failure");
    expect(result.error?.code).toBe("APPROVAL_CONSUMPTION_PERSIST_FAILED");
    expect(result.outcome).not.toBe("approval_mismatch");
    expect(result.outcome).not.toBe("config_invalid");
    expect(result.outcome).not.toBe("remote_failure");
    expect(result.outcome).not.toBe("external_state_ambiguous");
    expect(result.outcome).not.toBe("cleanup_pending");
    // Mutation was provably impossible: the mutating path never ran at all.
    expect(harness.createEdit).not.toHaveBeenCalled();
    expect(harness.getEdit).not.toHaveBeenCalled();
    expect(harness.observedStatesAtMutation).toEqual([]);
    // No approved grant was ever issued.
    expect(
      harness.approvalEntries().filter((entry) => entry.type === "approval.approved"),
    ).toHaveLength(0);
    expect(harness.approvalEntries().some((entry) => entry.type === "approval.denied")).toBe(true);
    // Fail-closed and non-reusable: claim retained, request terminal.
    expect(harness.claimExists()).toBe(true);
    expect(await harness.pendingStore.state(requestId)).toBe("recovery_required");

    const replay = await harness.execute(requestId, signature);
    expect(replay.outcome).toBe("external_state_ambiguous");
    expect(harness.createEdit).not.toHaveBeenCalled();
  });

  it("maps a genuine runtime approval mismatch to approval_mismatch, not local_state_failure", async () => {
    const harness = await buildHarness();
    const { requestId, signature } = await prepareAndSign(harness);
    // The bound approval identity changes after prepare, so the runtime approval
    // request no longer matches the signed pending request. The signature itself
    // is still valid — this is a real mismatch, not a persistence failure.
    harness.runtimeDigest.override = "d".repeat(64);

    const result = await harness.execute(requestId, signature);

    expect(result.outcome).toBe("approval_mismatch");
    expect(result.outcome).not.toBe("local_state_failure");
    expect(harness.createEdit).not.toHaveBeenCalled();
    expect(harness.observedStatesAtMutation).toEqual([]);
    expect(
      harness.approvalEntries().filter((entry) => entry.type === "approval.approved"),
    ).toHaveLength(0);
    // The three-way match records the real reason: a digest mismatch, not a
    // durable-write failure.
    expect(
      harness
        .approvalEntries()
        .some((entry) => entry.metadata?.reason === "REQUEST_DIGEST_MISMATCH"),
    ).toBe(true);
  });

  it("maps an unverified-but-possibly-inserted edit to RECOVERY_REQUIRED with no retry", async () => {
    const harness = await buildHarness({
      configureGateway: ({ getEdit }) => {
        // The edit was created, but the read-back cannot be trusted.
        getEdit.mockImplementation(async () => ({
          id: "edit-different",
          expiryTimeSeconds: "1900000000",
        }));
      },
    });
    const { requestId, signature } = await prepareAndSign(harness);

    const result = await harness.execute(requestId, signature);

    expect(result.outcome).toBe("external_state_ambiguous");
    expect(result.outcome).not.toBe("success");
    // Exactly one attempt: never 2.
    expect(harness.createEdit).toHaveBeenCalledTimes(1);
    expect(await harness.pendingStore.state(requestId)).toBe("recovery_required");
    expect(harness.claimExists()).toBe(true);
  });

  it("bounds concurrent execution: one winner, one busy loser, at most one insert", async () => {
    const harness = await buildHarness({
      configureGateway: ({ createEdit }) => {
        createEdit.mockImplementation(async (): Promise<GooglePlayEditSession> => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return { packageName: PACKAGE, editId: EDIT_ID, expiryTimeSeconds: "1900000000" };
        });
      },
    });
    const { requestId, signature } = await prepareAndSign(harness);

    const [first, second] = await Promise.all([
      harness.execute(requestId, signature),
      harness.execute(requestId, signature),
    ]);
    const outcomes = [first.outcome, second.outcome];

    expect(outcomes.filter((outcome) => outcome === "success")).toHaveLength(1);
    const loser = outcomes.find((outcome) => outcome !== "success");
    // The loser must never normalize the winner's in-flight request, and must
    // never reach the tool. Since Stage 3E.2D the package-operation lease is
    // acquired BEFORE the per-request claim, so a same-request loser is now
    // refused as `operation_in_progress`; the claim/consumed verdicts remain
    // reachable (e.g. a retry after a failed winner whose claim was retained).
    expect(["operation_in_progress", "request_claim_held", "request_already_consumed"]).toContain(
      loser,
    );
    expect(harness.createEdit).toHaveBeenCalledTimes(1);
    expect(await harness.pendingStore.state(requestId)).toBe("completed");
    expect(
      harness.approvalEntries().filter((entry) => entry.type === "approval.approved"),
    ).toHaveLength(1);
  });

  it("returns request_claim_held with zero mutation when a claim already exists", async () => {
    const harness = await buildHarness();
    const { requestId, signature } = await prepareAndSign(harness);
    // Simulate another executor holding the claim while the record is still PENDING.
    await acquireRequestClaim(harness.claimRoot, requestId);

    const first = await harness.execute(requestId, signature);
    expect(first.outcome).toBe("request_claim_held");
    expect(harness.createEdit).not.toHaveBeenCalled();
    // §28/§29: the record is NOT normalized — PID liveness is not trusted, and an
    // in-flight winner must not be corrupted into RECOVERY_REQUIRED.
    expect(await harness.pendingStore.state(requestId)).toBe("pending");
    expect(harness.claimExists()).toBe(true);
  });
});

describe("execute_open_edit — secret hygiene", () => {
  it("never leaks private intent, edit identity or credentials into responses", async () => {
    const harness = await buildHarness();
    const { prepared, requestId, signature } = await prepareAndSign(harness);
    const result = await harness.execute(requestId, signature);

    const prepareJson = JSON.stringify(prepared);
    expect(prepareJson).not.toContain("editId");
    expect(prepareJson).not.toContain("stateDigest");
    expect(prepareJson).not.toContain("private_key");
    expect(prepareJson).not.toContain("access_token");
    expect(prepareJson).not.toContain("releaseNotes");
    // requestDigest is only ever exposed inside the intentional approval challenge.
    expect(prepareJson.replace(JSON.stringify(prepared.approval), "")).not.toContain(
      "requestDigest",
    );

    const successJson = JSON.stringify(result);
    expect(successJson).not.toContain(EDIT_ID);
    expect(successJson).not.toContain("requestDigest");
    expect(successJson).not.toContain("stateDigest");
    expect(successJson).not.toContain(signature);

    const ledgers = JSON.stringify([
      ...readAuditEntries(harness.approvalPath),
      ...readAuditEntries(harness.auditPath),
    ]);
    expect(ledgers).not.toContain("private_key");
    expect(ledgers).not.toContain("access_token");
    expect(ledgers).not.toContain("Authorization");
    expect(ledgers).not.toContain("credential");
    expect(ledgers).not.toContain(signature);
  });
});

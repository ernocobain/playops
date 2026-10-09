/**
 * Durable pending-operation store: schema, private file modes, TTL, restart
 * survival, strict fail-closed parsing and the state machine.
 * Temp directories only; no daemon, no socket, no Google.
 */
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APPROVAL_TOKEN_TTL_MS } from "../src/runtime/approvals/index.js";
import {
  LEGAL_PENDING_TRANSITIONS,
  PENDING_RECORD_SCHEMA_VERSION,
  PendingStoreError,
  createFilePendingOperationStore,
  parsePendingOperationRecord,
  type PendingPrepareInput,
} from "../src/daemon/pending-store.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "playops-pending-"));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const DIGEST = "a".repeat(64);

function commitInput(overrides: Partial<PendingPrepareInput> = {}): PendingPrepareInput {
  return {
    operation: "commit",
    toolName: "releases.commit_edit",
    permission: "publish",
    packageName: "com.dhikrama.driver",
    requestDigest: DIGEST,
    intent: {
      kind: "commit",
      targetTrack: "internal",
      versionCode: "3",
      editId: "edit-123",
      stateDigest: "b".repeat(64),
      validationExpiryTimeSeconds: "1900000000",
      releaseName: "3 (1.1)",
      releaseStatus: "completed",
    },
    ...overrides,
  };
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (cause) {
    return cause instanceof PendingStoreError ? cause.code : `UNEXPECTED:${String(cause)}`;
  }
}

async function codeOfAsync(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (cause) {
    return cause instanceof PendingStoreError ? cause.code : `UNEXPECTED:${String(cause)}`;
  }
}

describe("pending operation store", () => {
  it("prepares a record with a generated identity and private modes", async () => {
    const dir = tempDir();
    const store = createFilePendingOperationStore(dir);
    const record = await store.prepare(commitInput());
    expect(record.schemaVersion).toBe(PENDING_RECORD_SCHEMA_VERSION);
    expect(record.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(record.state).toBe("PENDING");
    expect(record.operation).toBe("commit");
    expect(record.permission).toBe("publish");
    expect(record.nonce.length).toBeGreaterThanOrEqual(40);
    const path = join(dir, `${record.requestId}.json`);
    expect(readFileSync(path, "utf8").length).toBeGreaterThan(0);
    expect(statMode(dir)).toBe(0o700);
    expect(statMode(path)).toBe(0o600);
  });

  it("derives expiry from the existing approval TTL policy", async () => {
    const store = createFilePendingOperationStore(tempDir());
    const record = await store.prepare(commitInput());
    expect(Date.parse(record.expiresAtUtc) - Date.parse(record.createdAtUtc)).toBe(
      APPROVAL_TOKEN_TTL_MS,
    );
  });

  it("generates a fresh random nonce per record and never derives it from a request field", async () => {
    const store = createFilePendingOperationStore(tempDir());
    // Two records prepared from byte-identical inputs. If the nonce were a
    // function of the request (time, package, digest, id, pid) these would
    // collide; distinct nonces here is the deterministic proof it is not.
    const first = await store.prepare(commitInput());
    const second = await store.prepare(commitInput());
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.requestId).not.toBe(second.requestId);
    // 32 random bytes encode to at least 43 base64url characters.
    expect(first.nonce.length).toBeGreaterThanOrEqual(43);
    expect(first.nonce).not.toBe(first.requestId);
    expect(second.nonce).not.toBe(second.requestId);
  });

  it("reloads identically through a fresh store instance", async () => {
    const dir = tempDir();
    const record = await createFilePendingOperationStore(dir).prepare(commitInput());
    const reloaded = await createFilePendingOperationStore(dir).load(record.requestId);
    expect(reloaded).toEqual(record);
    expect(await createFilePendingOperationStore(dir).list()).toEqual([record]);
  });

  it("reports absent, pending and expired states without deleting evidence", async () => {
    const dir = tempDir();
    const store = createFilePendingOperationStore(dir);
    const record = await store.prepare(commitInput());
    expect(await store.state("00000000-0000-4000-8000-000000000000")).toBe("absent");
    expect(await store.state(record.requestId)).toBe("pending");
    const future = createFilePendingOperationStore(dir, {
      now: () => new Date(Date.now() + APPROVAL_TOKEN_TTL_MS + 60_000),
    });
    expect(await future.state(record.requestId)).toBe("expired");
    // Expiry is reported, never enforced by deletion.
    expect(await future.load(record.requestId)).toBeDefined();
  });

  it("enforces the legal state machine and refuses every illegal transition", async () => {
    const dir = tempDir();
    const store = createFilePendingOperationStore(dir);
    const record = await store.prepare(commitInput());
    expect(LEGAL_PENDING_TRANSITIONS.PENDING).toEqual(["CLAIMED", "RECOVERY_REQUIRED"]);
    expect(LEGAL_PENDING_TRANSITIONS.RECOVERY_REQUIRED).toEqual([]);
    expect(LEGAL_PENDING_TRANSITIONS.COMPLETED).toEqual([]);

    expect(
      await codeOfAsync(() => store.transition(record.requestId, "PENDING", "COMPLETED")),
    ).toBe("PENDING_TRANSITION_ILLEGAL");
    expect(await codeOfAsync(() => store.transition(record.requestId, "PENDING", "CONSUMED"))).toBe(
      "PENDING_TRANSITION_ILLEGAL",
    );
    expect(await codeOfAsync(() => store.transition(record.requestId, "CLAIMED", "PENDING"))).toBe(
      "PENDING_TRANSITION_ILLEGAL",
    );

    const claimed = await store.transition(record.requestId, "PENDING", "CLAIMED");
    expect(claimed.state).toBe("CLAIMED");
    // Replaying the same transition must fail: no double claim.
    expect(await codeOfAsync(() => store.transition(record.requestId, "PENDING", "CLAIMED"))).toBe(
      "PENDING_TRANSITION_ILLEGAL",
    );
    const consumed = await store.transition(record.requestId, "CLAIMED", "CONSUMED");
    expect(consumed.state).toBe("CONSUMED");
    expect(await codeOfAsync(() => store.transition(record.requestId, "CONSUMED", "PENDING"))).toBe(
      "PENDING_TRANSITION_ILLEGAL",
    );
    const completed = await store.transition(record.requestId, "CONSUMED", "COMPLETED");
    expect(completed.state).toBe("COMPLETED");
    expect(await store.state(record.requestId)).toBe("completed");
    expect(
      await codeOfAsync(() => store.transition(record.requestId, "COMPLETED", "COMPLETED")),
    ).toBe("PENDING_TRANSITION_ILLEGAL");
    expect(await codeOfAsync(() => store.transition(record.requestId, "PENDING", "CLAIMED"))).toBe(
      "PENDING_TRANSITION_ILLEGAL",
    );
  });

  it("survives a restart with its state intact", async () => {
    const dir = tempDir();
    const first = createFilePendingOperationStore(dir);
    const record = await first.prepare(commitInput());
    await first.transition(record.requestId, "PENDING", "CLAIMED");
    const restarted = createFilePendingOperationStore(dir);
    const reloaded = await restarted.load(record.requestId);
    expect(reloaded?.state).toBe("CLAIMED");
    expect(await restarted.state(record.requestId)).toBe("claimed");
  });

  it("fails closed on malformed records instead of repairing them", async () => {
    const dir = tempDir();
    const store = createFilePendingOperationStore(dir);
    const record = await store.prepare(commitInput());
    const path = join(dir, `${record.requestId}.json`);

    const cases: string[] = [
      JSON.stringify({ ...record, schemaVersion: 99 }),
      JSON.stringify({ ...record, surprise: true }),
      JSON.stringify({ ...record, nonce: "short" }),
      JSON.stringify({ ...record, permission: "read" }),
      JSON.stringify({ ...record, requestDigest: "xyz" }),
      JSON.stringify({ ...record, state: "REUSABLE" }),
      JSON.stringify({ ...record, operation: "rollout", intent: { kind: "rollout" } }),
      "{ not json",
    ];
    for (const contents of cases) {
      writeFileSync(path, contents, { mode: 0o600 });
      expect(await codeOfAsync(() => store.load(record.requestId))).toBe("PENDING_RECORD_INVALID");
    }
  });

  it("rejects a strict-parse of unknown keys, bad versions and unbound intents", () => {
    const base = {
      schemaVersion: PENDING_RECORD_SCHEMA_VERSION,
      requestId: "11111111-2222-4333-8444-555555555555",
      nonce: "n".repeat(43),
      operation: "commit",
      toolName: "releases.commit_edit",
      permission: "publish",
      packageName: "com.dhikrama.driver",
      requestDigest: DIGEST,
      createdAtUtc: "2026-01-01T00:00:00.000Z",
      expiresAtUtc: "2026-01-01T00:10:00.000Z",
      intent: {
        kind: "commit",
        targetTrack: "internal",
        versionCode: "3",
        editId: "e",
        stateDigest: "b".repeat(64),
        validationExpiryTimeSeconds: "1900000000",
        releaseName: "3 (1.1)",
        releaseStatus: "completed",
      },
      state: "PENDING",
    };
    expect(parsePendingOperationRecord(base).requestId).toBe(base.requestId);
    expect(codeOf(() => parsePendingOperationRecord({ ...base, schemaVersion: 1 }))).toBe(
      "PENDING_RECORD_INVALID",
    );
    expect(codeOf(() => parsePendingOperationRecord({ ...base, schemaVersion: 3 }))).toBe(
      "PENDING_RECORD_INVALID",
    );
    expect(codeOf(() => parsePendingOperationRecord({ ...base, extra: 1 }))).toBe(
      "PENDING_RECORD_INVALID",
    );
    expect(
      codeOf(() => parsePendingOperationRecord({ ...base, intent: { kind: "open_edit" } })),
    ).toBe("PENDING_RECORD_INVALID");
    expect(
      codeOf(() =>
        parsePendingOperationRecord({
          ...base,
          intent: { ...base.intent, access_token: "leak" },
        }),
      ),
    ).toBe("PENDING_RECORD_INVALID");
  });

  it("refuses a request identifier that is not canonical (no path traversal)", async () => {
    const store = createFilePendingOperationStore(tempDir());
    expect(await codeOfAsync(() => store.load("../../etc/passwd"))).toBe(
      "PENDING_REQUEST_ID_INVALID",
    );
    expect(await codeOfAsync(() => store.load("not-a-uuid"))).toBe("PENDING_REQUEST_ID_INVALID");
  });

  it("refuses an insecure store directory mode", async () => {
    const dir = tempDir();
    chmodSync(dir, 0o755);
    const store = createFilePendingOperationStore(dir);
    expect(await codeOfAsync(() => store.prepare(commitInput()))).toBe("PENDING_STORE_INSECURE");
  });

  it("accepts only approval-gated permissions", async () => {
    const store = createFilePendingOperationStore(tempDir());
    expect(
      await codeOfAsync(() => store.prepare(commitInput({ permission: "read" as never }))),
    ).toBe("PENDING_RECORD_INVALID");
    expect(
      await codeOfAsync(() => store.prepare(commitInput({ permission: "write" as never }))),
    ).toBe("PENDING_RECORD_INVALID");
  });

  it("never persists credential or key material", async () => {
    const dir = tempDir();
    const store = createFilePendingOperationStore(dir);
    const record = await store.prepare(commitInput());
    const contents = readFileSync(join(dir, `${record.requestId}.json`), "utf8");
    for (const forbidden of [
      "private_key",
      "privateKey",
      "access_token",
      "refresh_token",
      "client_secret",
      "authorization",
      "serviceAccount",
      "credentials",
    ]) {
      expect(contents.includes(forbidden)).toBe(false);
    }
    expect(contents.includes(record.nonce)).toBe(true);
  });
});

/** A structurally valid v2 record with only `state` varying. */
function baseRecord(state: string): Record<string, unknown> {
  return {
    schemaVersion: PENDING_RECORD_SCHEMA_VERSION,
    requestId: "11111111-2222-4333-8444-555555555555",
    nonce: "n".repeat(43),
    operation: "commit",
    toolName: "releases.commit_edit",
    permission: "publish",
    packageName: "com.dhikrama.driver",
    requestDigest: DIGEST,
    createdAtUtc: "2026-01-01T00:00:00.000Z",
    expiresAtUtc: "2026-01-01T00:10:00.000Z",
    intent: {
      kind: "commit",
      targetTrack: "internal",
      versionCode: "3",
      editId: "e",
      stateDigest: "b".repeat(64),
      validationExpiryTimeSeconds: "1900000000",
      releaseName: "3 (1.1)",
      releaseStatus: "completed",
    },
    state,
  };
}

describe("pending recovery state model (v2)", () => {
  it("accepts every v2 state and rejects any other schema version or state", () => {
    for (const state of ["PENDING", "CLAIMED", "CONSUMED", "RECOVERY_REQUIRED", "COMPLETED"]) {
      expect(parsePendingOperationRecord(baseRecord(state)).state).toBe(state);
    }
    for (const version of [0, 1, 3, 99]) {
      expect(
        codeOf(() =>
          parsePendingOperationRecord({ ...baseRecord("PENDING"), schemaVersion: version }),
        ),
      ).toBe("PENDING_RECORD_INVALID");
    }
    expect(
      codeOf(() =>
        parsePendingOperationRecord({ ...baseRecord("RECOVERY_REQUIRED"), state: "REUSABLE" }),
      ),
    ).toBe("PENDING_RECORD_INVALID");
  });

  it("lets PENDING normalize into RECOVERY_REQUIRED and become terminal", async () => {
    const store = createFilePendingOperationStore(tempDir());
    const record = await store.prepare(commitInput());
    expect(await store.state(record.requestId)).toBe("pending");
    const normalized = await store.transition(record.requestId, "PENDING", "RECOVERY_REQUIRED");
    expect(normalized.state).toBe("RECOVERY_REQUIRED");
    expect(await store.state(record.requestId)).toBe("recovery_required");
    // Terminal: no path back to an executable or reusable state.
    for (const target of ["PENDING", "CLAIMED", "CONSUMED", "COMPLETED"] as const) {
      expect(
        await codeOfAsync(() => store.transition(record.requestId, "RECOVERY_REQUIRED", target)),
      ).toBe("PENDING_TRANSITION_ILLEGAL");
    }
  });

  it("lets CLAIMED become RECOVERY_REQUIRED and then never resume", async () => {
    const store = createFilePendingOperationStore(tempDir());
    const record = await store.prepare(commitInput());
    await store.transition(record.requestId, "PENDING", "CLAIMED");
    const recovery = await store.transition(record.requestId, "CLAIMED", "RECOVERY_REQUIRED");
    expect(recovery.state).toBe("RECOVERY_REQUIRED");
    expect(await codeOfAsync(() => store.transition(record.requestId, "CLAIMED", "CONSUMED"))).toBe(
      "PENDING_TRANSITION_ILLEGAL",
    );
    expect(
      await codeOfAsync(() => store.transition(record.requestId, "RECOVERY_REQUIRED", "CLAIMED")),
    ).toBe("PENDING_TRANSITION_ILLEGAL");
  });

  it("lets CONSUMED become RECOVERY_REQUIRED and forbids reuse afterwards", async () => {
    const store = createFilePendingOperationStore(tempDir());
    const record = await store.prepare(commitInput());
    await store.transition(record.requestId, "PENDING", "CLAIMED");
    await store.transition(record.requestId, "CLAIMED", "CONSUMED");
    // The critical commit case: transport attempted, outcome ambiguous.
    const recovery = await store.transition(record.requestId, "CONSUMED", "RECOVERY_REQUIRED");
    expect(recovery.state).toBe("RECOVERY_REQUIRED");
    expect(await store.state(record.requestId)).toBe("recovery_required");
    for (const target of ["PENDING", "CLAIMED", "CONSUMED", "COMPLETED"] as const) {
      expect(
        await codeOfAsync(() => store.transition(record.requestId, "RECOVERY_REQUIRED", target)),
      ).toBe("PENDING_TRANSITION_ILLEGAL");
    }
  });

  it("keeps COMPLETED terminal against every later rewrite", async () => {
    const store = createFilePendingOperationStore(tempDir());
    const record = await store.prepare(commitInput());
    await store.transition(record.requestId, "PENDING", "CLAIMED");
    await store.transition(record.requestId, "CLAIMED", "CONSUMED");
    await store.transition(record.requestId, "CONSUMED", "COMPLETED");
    expect(await store.state(record.requestId)).toBe("completed");
    for (const target of [
      "RECOVERY_REQUIRED",
      "PENDING",
      "CLAIMED",
      "CONSUMED",
      "COMPLETED",
    ] as const) {
      expect(await codeOfAsync(() => store.transition(record.requestId, "COMPLETED", target))).toBe(
        "PENDING_TRANSITION_ILLEGAL",
      );
    }
  });

  it("never hides recovery-required or completed behind TTL expiry", async () => {
    const dir = tempDir();
    const store = createFilePendingOperationStore(dir);
    const recovery = await store.prepare(commitInput());
    await store.transition(recovery.requestId, "PENDING", "RECOVERY_REQUIRED");
    const completed = await store.prepare(commitInput());
    await store.transition(completed.requestId, "PENDING", "CLAIMED");
    await store.transition(completed.requestId, "CLAIMED", "CONSUMED");
    await store.transition(completed.requestId, "CONSUMED", "COMPLETED");

    const future = createFilePendingOperationStore(dir, {
      now: () => new Date(Date.now() + APPROVAL_TOKEN_TTL_MS + 60_000),
    });
    expect(await future.state(recovery.requestId)).toBe("recovery_required");
    expect(await future.state(completed.requestId)).toBe("completed");
    // Durable evidence is never deleted merely because the window closed.
    expect(await future.load(recovery.requestId)).toBeDefined();
    expect(await future.load(completed.requestId)).toBeDefined();
  });
});

function statMode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

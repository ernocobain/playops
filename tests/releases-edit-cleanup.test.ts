/**
 * Phase 4.15 — edit lifecycle hygiene: durable cleanup journal, read-only hygiene
 * inspection, and exact-record abandonment with a verified post-delete check.
 *
 * These tests encode the locked D1–D6 decisions and the D4 evidence gate: a bare
 * `getEdit` failure is never treated as inactivity (standalone hygiene stays
 * UNKNOWN), and a remote delete is verified inactive ONLY for the complete
 * confirmed-delete context produced by `releases.cleanup_known_edit`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyReleaseEditCleanupRecordLocally,
  createFileReleaseEditCleanupJournal,
  RELEASE_EDIT_CLEANUP_JOURNAL_VERSION,
  type ReleaseEditCleanupJournal,
  type ReleaseEditCleanupJournalRecord,
} from "../src/releases/cleanup-journal.js";
import {
  createReleaseEditCleanupDigest,
  createReleaseEditCleanupSummary,
  createReleaseEditCleanupTool,
  RELEASES_CLEANUP_KNOWN_EDIT_TOOL_NAME,
  type ReleaseEditCleanupCandidate,
} from "../src/releases/cleanup-tool.js";
import {
  createReleaseEditHygieneTool,
  RELEASES_INSPECT_EDIT_HYGIENE_TOOL_NAME,
} from "../src/releases/hygiene-tool.js";
import { ToolRegistry } from "../src/runtime/tools/index.js";
import {
  ReleaseError,
  type ReleaseEditSession,
  type ReleaseErrorClassification,
} from "../src/releases/index.js";
import type { ReleaseEditSessionStore } from "../src/releases/session-store.js";
import type {
  ReleaseEditCleanupGateway,
  ReleaseEditHygieneGateway,
} from "../src/releases/gateway.js";

const packageName = "com.example.playops";
const fixedNow = new Date("2026-10-01T00:00:00.000Z");
const futureExpiry = String(Math.trunc(fixedNow.getTime() / 1000) + 3600);
const pastExpiry = String(Math.trunc(fixedNow.getTime() / 1000) - 3600);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "playops-phase415-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function journalPath(): string {
  return join(dir, "edit-cleanup-journal.json");
}

function makeJournal(options: { readonly package?: string; readonly path?: string } = {}) {
  return createFileReleaseEditCleanupJournal(options.path ?? journalPath(), {
    expectedPackageName: options.package ?? packageName,
  });
}

function makeSession(overrides: Partial<ReleaseEditSession> = {}): ReleaseEditSession {
  return {
    version: 1,
    packageName,
    editId: "managed-edit-1",
    expiryTimeSeconds: futureExpiry,
    createdAt: "2026-09-30T00:00:00.000Z",
    ...overrides,
  };
}

/** In-memory managed-session store double; counts the exact operations used. */
function makeStore(initial?: ReleaseEditSession) {
  let current = initial;
  const calls = { load: 0, clear: 0 };
  const store: ReleaseEditSessionStore = {
    async load() {
      calls.load += 1;
      return current;
    },
    async save(session) {
      current = session;
    },
    async clear() {
      calls.clear += 1;
      current = undefined;
    },
  };
  return { store, calls, remaining: () => current };
}

function makeGateway(behaviour: "ok" | "fail" = "ok", failure?: unknown) {
  const calls = { getEdit: 0 };
  const gateway: ReleaseEditHygieneGateway = {
    getEdit: vi.fn(async (session: { readonly editId: string }) => {
      calls.getEdit += 1;
      if (behaviour === "fail") throw failure ?? new Error("PRIVATE-TRANSPORT-DETAIL");
      return { id: session.editId, expiryTimeSeconds: futureExpiry };
    }),
  };
  return { gateway, calls };
}

function httpError(status: number): unknown {
  return Object.assign(new Error("PRIVATE-UPSTREAM-TEXT"), { status });
}

function sourceOf(relative: string): string {
  const text = readFileSync(new URL(`../src/releases/${relative}`, import.meta.url), "utf8");
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/.*$/gmu, "$1");
}

describe("Phase 4.15 cleanup journal", () => {
  it("round-trips exactly one record with the allowlisted shape", async () => {
    const journal = makeJournal();
    expect(await journal.list()).toEqual([]);
    await journal.record({
      editId: "temporary-edit-1",
      expiryTimeSeconds: futureExpiry,
      source: "exact_release_verification",
      createdAt: fixedNow.toISOString(),
    });
    const entries = await journal.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      version: RELEASE_EDIT_CLEANUP_JOURNAL_VERSION,
      packageName,
      editId: "temporary-edit-1",
      expiryTimeSeconds: futureExpiry,
      source: "exact_release_verification",
    });
    const raw = JSON.parse(readFileSync(journalPath(), "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(["packageName", "records", "version"]);
    const [stored] = raw.records as readonly Record<string, unknown>[];
    expect(stored).toBeDefined();
    expect(Object.keys(stored ?? {}).sort()).toEqual([
      "createdAt",
      "editId",
      "expiryTimeSeconds",
      "packageName",
      "source",
      "version",
    ]);
    for (const forbidden of [
      "token",
      "credential",
      "privateKey",
      "approvalToken",
      "releaseNotes",
    ]) {
      expect(readFileSync(journalPath(), "utf8")).not.toContain(forbidden);
    }

    await journal.remove("temporary-edit-1");
    expect(await journal.list()).toEqual([]);
  });

  it("never overwrites malformed, unsupported, or foreign state", async () => {
    const path = journalPath();
    writeFileSync(path, "{ not json", "utf8");
    await expect(makeJournal().list()).rejects.toMatchObject({
      code: "EDIT_CLEANUP_JOURNAL_INVALID",
    });
    writeFileSync(path, JSON.stringify({ version: 2, packageName, records: [] }), "utf8");
    await expect(makeJournal().list()).rejects.toMatchObject({
      code: "EDIT_CLEANUP_JOURNAL_INVALID",
    });
    writeFileSync(
      path,
      JSON.stringify({ version: 1, packageName: "com.other.app", records: [] }),
      "utf8",
    );
    await expect(makeJournal().list()).rejects.toMatchObject({
      code: "EDIT_CLEANUP_JOURNAL_PACKAGE_MISMATCH",
    });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        packageName,
        records: [
          {
            version: 1,
            packageName,
            editId: "temporary-edit-1",
            expiryTimeSeconds: futureExpiry,
            source: "exact_release_verification",
            createdAt: fixedNow.toISOString(),
            extra: "unexpected",
          },
        ],
      }),
      "utf8",
    );
    await expect(makeJournal().list()).rejects.toMatchObject({
      code: "EDIT_CLEANUP_JOURNAL_INVALID",
    });
  });

  it("rejects duplicate identities, closed-enum violations, and invalid identities", async () => {
    const duplicate = {
      version: 1,
      packageName,
      records: [
        {
          version: 1,
          packageName,
          editId: "temporary-edit-1",
          expiryTimeSeconds: futureExpiry,
          source: "exact_release_verification",
          createdAt: fixedNow.toISOString(),
        },
        {
          version: 1,
          packageName,
          editId: "temporary-edit-1",
          expiryTimeSeconds: pastExpiry,
          source: "rollout_verification",
          createdAt: fixedNow.toISOString(),
        },
      ],
    };
    writeFileSync(journalPath(), JSON.stringify(duplicate), "utf8");
    await expect(makeJournal().list()).rejects.toMatchObject({
      code: "EDIT_CLEANUP_JOURNAL_INVALID",
    });

    const journal = makeJournal();
    await expect(
      journal.record({
        editId: "temporary-edit-1",
        expiryTimeSeconds: futureExpiry,
        // Deliberately outside the closed purpose enum.
        source: "made_up_purpose" as never,
        createdAt: fixedNow.toISOString(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      journal.record({
        editId: "bad edit id",
        expiryTimeSeconds: futureExpiry,
        source: "rollout_verification",
        createdAt: fixedNow.toISOString(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      journal.record({
        editId: "temporary-edit-1",
        expiryTimeSeconds: "not-a-number",
        source: "rollout_verification",
        createdAt: fixedNow.toISOString(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      journal.record({
        editId: "temporary-edit-1",
        expiryTimeSeconds: futureExpiry,
        source: "rollout_verification",
        createdAt: "2026-10-01",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("treats a missing removal target as a no-op and classifies expiry inclusively", async () => {
    const journal = makeJournal();
    await journal.record({
      editId: "temporary-edit-1",
      expiryTimeSeconds: futureExpiry,
      source: "rollout_verification",
      createdAt: fixedNow.toISOString(),
    });
    const before = readFileSync(journalPath(), "utf8");
    await journal.remove("unknown-edit");
    expect(readFileSync(journalPath(), "utf8")).toBe(before);

    const record: ReleaseEditCleanupJournalRecord = {
      version: RELEASE_EDIT_CLEANUP_JOURNAL_VERSION,
      packageName,
      editId: "temporary-edit-1",
      expiryTimeSeconds: pastExpiry,
      source: "rollout_verification",
      createdAt: fixedNow.toISOString(),
    };
    // `record` expires exactly at pastExpiry, so it is expired from then on.
    expect(classifyReleaseEditCleanupRecordLocally(record, pastExpiry)).toBe("expired");
    expect(classifyReleaseEditCleanupRecordLocally(record, String(BigInt(pastExpiry) + 1n))).toBe(
      "expired",
    );
    const later = { ...record, expiryTimeSeconds: futureExpiry };
    expect(classifyReleaseEditCleanupRecordLocally(later, pastExpiry)).toBe("not-expired");
  });
});

describe("Phase 4.15 hygiene inspection (read-only, REPORT ONLY)", () => {
  it("is a read-permission tool with an empty authoritative input and no verifier", async () => {
    const { store } = makeStore();
    const { gateway } = makeGateway();
    const built = createReleaseEditHygieneTool({
      packageName,
      gateway,
      store,
      cleanupJournal: makeJournal(),
      now: () => fixedNow,
    });
    expect(built.tool.name).toBe(RELEASES_INSPECT_EDIT_HYGIENE_TOOL_NAME);
    expect(built.tool.permission).toBe("read");
    expect(built.tool.verify).toBeUndefined();
    expect(() => built.tool.inputSchema.parse({ editId: "managed-edit-1" })).toThrowError();
    expect(() => built.tool.inputSchema.parse({})).not.toThrow();
    const registry = new ToolRegistry();
    registry.register(built.tool);
    expect(registry.get(RELEASES_INSPECT_EDIT_HYGIENE_TOOL_NAME)).toBeDefined();
  });

  it("reports an expired managed record as expired without any Google call", async () => {
    const { store } = makeStore(makeSession({ expiryTimeSeconds: pastExpiry }));
    const { gateway, calls } = makeGateway();
    const built = createReleaseEditHygieneTool({
      packageName,
      gateway,
      store,
      cleanupJournal: makeJournal(),
      now: () => fixedNow,
    });
    const result = await built.tool.execute({}, {} as never);
    expect(result.records).toEqual([
      {
        kind: "managed_session",
        state: "expired",
        reason: "local_expiry_elapsed",
        expiryTimeSeconds: pastExpiry,
      },
    ]);
    expect(result.counts).toEqual({ expired: 1, active: 0, unknown: 0 });
    expect(result.deletionsPerformed).toBe(0);
    expect(result.remoteDeleteSupported).toBe(false);
    expect(result.remoteEditEnumerationSupported).toBe(false);
    expect(calls.getEdit).toBe(0);
  });

  it("reports a confirmed read as active and every failure as unknown (never inactive)", async () => {
    const expiryById: Record<string, string> = {
      "managed-edit-1": futureExpiry,
      "temporary-edit-1": futureExpiry,
    };
    const failures: readonly unknown[] = [
      httpError(401),
      httpError(403),
      httpError(429),
      httpError(500),
      Object.assign(new Error("PRIVATE-TIMEOUT"), { code: "ETIMEDOUT" }),
      Object.assign(new Error("PRIVATE-RESET"), { code: "ECONNRESET" }),
      new Error("PRIVATE-UNCLASSIFIED"),
    ];
    let mode: "ok" | number = "ok";
    const gatewayCalls: { getEdit: number } = { getEdit: 0 };
    const gateway: ReleaseEditHygieneGateway = {
      getEdit: vi.fn(async (session) => {
        gatewayCalls.getEdit += 1;
        expect(expiryById[session.editId]).toBeDefined();
        if (mode === "ok") return { id: session.editId, expiryTimeSeconds: futureExpiry };
        throw failures[mode] ?? new Error("PRIVATE-UNCLASSIFIED");
      }),
    };
    const journal = makeJournal();
    await journal.record({
      editId: "temporary-edit-1",
      expiryTimeSeconds: futureExpiry,
      source: "rollout_verification",
      createdAt: fixedNow.toISOString(),
    });
    const { store } = makeStore(makeSession());
    const built = createReleaseEditHygieneTool({
      packageName,
      gateway,
      store,
      cleanupJournal: journal,
      now: () => fixedNow,
    });

    const active = await built.tool.execute({}, {} as never);
    expect(active.records.map((record) => record.state)).toEqual(["active", "active"]);
    expect(active.records[0]?.reason).toBe("remote_edit_confirmed_active");
    expect(active.counts).toEqual({ expired: 0, active: 2, unknown: 0 });

    for (let index = 0; index < failures.length; index += 1) {
      mode = index;
      const result = await built.tool.execute({}, {} as never);
      expect(result.records.every((record) => record.state === "unknown")).toBe(true);
      expect(result.records.every((record) => record.reason === "remote_state_undecidable")).toBe(
        true,
      );
      expect(result.counts).toEqual({ expired: 0, active: 0, unknown: 2 });
      expect(result.deletionsPerformed).toBe(0);
    }
    // One confirmed read per record plus one read per failure case per record.
    expect(gatewayCalls.getEdit).toBe(2 + failures.length * 2);
  });

  it("reports a mismatched remote record as unknown instead of active", async () => {
    const gateway: ReleaseEditHygieneGateway = {
      getEdit: vi.fn(async () => ({ id: "different-edit", expiryTimeSeconds: futureExpiry })),
    };
    const { store } = makeStore(makeSession());
    const built = createReleaseEditHygieneTool({
      packageName,
      gateway,
      store,
      cleanupJournal: makeJournal(),
      now: () => fixedNow,
    });
    const result = await built.tool.execute({}, {} as never);
    expect(result.records[0]).toMatchObject({
      kind: "managed_session",
      state: "unknown",
      reason: "remote_record_mismatch",
    });
  });

  it("reports an unreadable journal as unknown and still inspects the managed record", async () => {
    writeFileSync(journalPath(), "{ not json", "utf8");
    const { store } = makeStore(makeSession({ expiryTimeSeconds: pastExpiry }));
    const { gateway } = makeGateway();
    const built = createReleaseEditHygieneTool({
      packageName,
      gateway,
      store,
      cleanupJournal: makeJournal(),
      now: () => fixedNow,
    });
    const result = await built.tool.execute({}, {} as never);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({ kind: "managed_session", state: "expired" });
    expect(result.records[1]).toMatchObject({
      kind: "verification_edit",
      state: "unknown",
      reason: "journal_entry_invalid",
    });
  });

  it("detects a leftover active verification edit as report-only and never leaks the edit id", async () => {
    const journal = makeJournal();
    await journal.record({
      editId: "temporary-edit-1",
      expiryTimeSeconds: futureExpiry,
      source: "status_control_verification",
      createdAt: fixedNow.toISOString(),
    });
    const { store } = makeStore();
    const { gateway } = makeGateway();
    const built = createReleaseEditHygieneTool({
      packageName,
      gateway,
      store,
      cleanupJournal: journal,
      now: () => fixedNow,
    });
    const result = await built.tool.execute({}, {} as never);
    expect(result.records).toEqual([
      {
        kind: "verification_edit",
        purpose: "status_control_verification",
        state: "active",
        reason: "remote_edit_confirmed_active",
        expiryTimeSeconds: futureExpiry,
      },
    ]);
    const serialized = built.binding.serializeResult(result, {
      toolName: RELEASES_INSPECT_EDIT_HYGIENE_TOOL_NAME,
      permission: "read",
      required: false,
      status: "skipped",
      code: "VERIFICATION_SKIPPED",
      verified: false,
    });
    expect(serialized).not.toContain("temporary-edit-1");
    expect(serialized).not.toContain(journalPath());
    expect(serialized).not.toContain("PRIVATE");
  });

  it("contains no delete, creation, commit, or track-mutation reference", () => {
    const source = sourceOf("hygiene-tool.ts");
    for (const forbidden of [
      "deleteEdit",
      "createEdit",
      "commitEdit",
      "updateTrack",
      "edits.list",
      "edits.insert",
      "edits.delete",
      "edits.commit",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe("Phase 4.15 exact-record reconciliation and post-delete verification", () => {
  function makeCleanupGateway(
    options: {
      readonly preDelete?: unknown;
      readonly postDelete?: unknown;
      readonly deleteFails?: unknown;
    } = {},
  ) {
    const calls = { get: 0, del: 0 };
    const events: string[] = [];
    const gateway: ReleaseEditCleanupGateway = {
      async getEdit(session) {
        calls.get += 1;
        const isPreDelete = calls.get === 1;
        events.push(isPreDelete ? "edits.get:pre" : "edits.get:post");
        if (isPreDelete) {
          if (options.preDelete !== undefined) throw options.preDelete;
          return { id: session.editId, expiryTimeSeconds: futureExpiry };
        }
        if (options.postDelete !== undefined) throw options.postDelete;
        return { id: session.editId, expiryTimeSeconds: futureExpiry };
      },
      async deleteEdit() {
        calls.del += 1;
        events.push("edits.delete");
        if (options.deleteFails !== undefined) throw options.deleteFails;
      },
    };
    return { gateway, calls, events };
  }

  /** Exactly what the production adapter produces after mapping a Google failure. */
  function classifiedFailure(classification: ReleaseErrorClassification): ReleaseError {
    return new ReleaseError("EDIT_INVALID", "Tracked edit read-back failed.", { classification });
  }

  const observedPostDeleteFailure = (): ReleaseError =>
    classifiedFailure({
      publisherCode: "API_REQUEST_FAILED",
      status: 400,
      googleStatus: "FAILED_PRECONDITION",
      googleReasons: ["failedPrecondition"],
    });

  const managedCandidate: ReleaseEditCleanupCandidate = {
    recordSource: "managed_session",
    editId: "managed-edit-1",
    expiryTimeSeconds: pastExpiry,
  };

  const activeCandidate: ReleaseEditCleanupCandidate = {
    ...managedCandidate,
    expiryTimeSeconds: futureExpiry,
  };

  function build(
    options: {
      readonly candidate?: ReleaseEditCleanupCandidate;
      readonly session?: ReleaseEditSession;
      readonly journal?: ReleaseEditCleanupJournal;
      readonly preDelete?: unknown;
      readonly postDelete?: unknown;
      readonly deleteFails?: unknown;
    } = {},
  ) {
    const store = makeStore(options.session);
    const gateway = makeCleanupGateway(options);
    const journal = options.journal ?? makeJournal();
    const built = createReleaseEditCleanupTool({
      packageName,
      candidate: options.candidate ?? activeCandidate,
      gateway: gateway.gateway,
      sessionStore: store.store,
      cleanupJournal: journal,
      now: () => fixedNow,
    });
    return {
      ...built,
      calls: gateway.calls,
      events: gateway.events,
      remaining: store.remaining,
      journal,
    };
  }

  it("is destructive, approval-bound, and describes the verified path honestly", () => {
    const built = build({
      candidate: managedCandidate,
      session: makeSession({ expiryTimeSeconds: pastExpiry }),
    });
    expect(built.tool.name).toBe(RELEASES_CLEANUP_KNOWN_EDIT_TOOL_NAME);
    expect(built.tool.permission).toBe("destructive");
    expect(() => built.tool.inputSchema.parse({ editId: "managed-edit-1" })).toThrowError();
    const binding = built.binding.approval;
    expect(binding).toBeDefined();
    expect(binding?.createRequestDigest({}).length).toBe(64);
    const summary = binding?.createSafeSummary({}) ?? "";
    expect(summary).toContain("does NOT delete any remote edit");
    expect(summary).toContain("permanently discards uncommitted edit state");
    expect(summary).toContain("FAILED_PRECONDITION");
    expect(summary).not.toContain("managed-edit-1");
    expect(summary).not.toContain(pastExpiry);
  });

  it("reconciles a locally expired record with zero Google calls and no delete", async () => {
    const built = build({
      candidate: managedCandidate,
      session: makeSession({ expiryTimeSeconds: pastExpiry }),
    });
    const result = await built.tool.execute({}, {} as never);
    expect(result).toEqual({
      recordSource: "managed_session",
      outcome: "LOCAL_EXPIRY_RECONCILED",
      localRecordReconciled: true,
      remoteDeleteAttempted: false,
      remoteDeleteSupported: true,
      remoteInactivityProven: false,
    });
    expect(built.calls.get).toBe(0);
    expect(built.calls.del).toBe(0);
    expect(built.remaining()).toBeUndefined();
    const verify = built.tool.verify;
    if (verify === undefined) throw new Error("cleanup must declare a real verifier");
    await expect(verify({}, result, {} as never)).resolves.toBe(true);
  });

  it("deletes exactly once and verifies inactivity for the exact observed tuple", async () => {
    const built = build({ session: makeSession(), postDelete: observedPostDeleteFailure() });
    const result = await built.tool.execute({}, {} as never);
    expect(result).toEqual({
      recordSource: "managed_session",
      outcome: "REMOTE_DELETE_VERIFIED",
      localRecordReconciled: true,
      remoteDeleteAttempted: true,
      remoteDeleteSupported: true,
      remoteInactivityProven: true,
    });
    // Exact order: one fresh read, exactly one delete, one post-delete read.
    expect(built.events).toEqual(["edits.get:pre", "edits.delete", "edits.get:post"]);
    expect(built.calls.del).toBe(1);
    expect(built.remaining()).toBeUndefined();
    const verify = built.tool.verify;
    if (verify === undefined) throw new Error("cleanup must declare a real verifier");
    await expect(verify({}, result, {} as never)).resolves.toBe(true);
    const serialized = built.binding.serializeResult(result, {
      toolName: RELEASES_CLEANUP_KNOWN_EDIT_TOOL_NAME,
      permission: "destructive",
      required: true,
      status: "passed",
      code: "VERIFIED",
      verified: true,
    });
    expect(serialized).toContain("REMOTE_DELETE_VERIFIED");
    expect(serialized).not.toContain("managed-edit-1");
  });

  it("retains the record when the post-delete read unexpectedly succeeds", async () => {
    const built = build({ session: makeSession(), postDelete: "ok" });
    await expect(built.tool.execute({}, {} as never)).rejects.toMatchObject({
      code: "EDIT_CLEANUP_REMOTE_INACTIVE_UNVERIFIED",
      externalStateUncertain: true,
    });
    expect(built.calls.del).toBe(1);
    expect(built.calls.get).toBe(2);
    expect(built.remaining()).toBeDefined();
  });

  it("retains the record and never re-deletes when the tuple is not the verified one", async () => {
    const failures: readonly unknown[] = [
      classifiedFailure({
        publisherCode: "API_REQUEST_FAILED",
        status: 404,
        googleStatus: "NOT_FOUND",
        googleReasons: ["notFound"],
      }),
      classifiedFailure({
        publisherCode: "API_REQUEST_FAILED",
        status: 400,
        googleStatus: "FAILED_PRECONDITION",
      }),
      classifiedFailure({ publisherCode: "API_REQUEST_FAILED", status: 403 }),
      classifiedFailure({ publisherCode: "API_REQUEST_FAILED", status: 429 }),
      classifiedFailure({ publisherCode: "API_REQUEST_FAILED", status: 500 }),
      classifiedFailure({ publisherCode: "API_REQUEST_FAILED", transportCode: "ECONNRESET" }),
      classifiedFailure({
        publisherCode: "INVALID_RESPONSE",
        status: 400,
        googleStatus: "FAILED_PRECONDITION",
        googleReasons: ["failedPrecondition"],
      }),
      new Error("PRIVATE-UNCLASSIFIED"),
      httpError(403),
    ];
    for (const failure of failures) {
      const built = build({ session: makeSession(), postDelete: failure });
      await expect(built.tool.execute({}, {} as never)).rejects.toMatchObject({
        code: "EDIT_CLEANUP_REMOTE_INACTIVE_UNVERIFIED",
        externalStateUncertain: true,
      });
      expect(built.calls.del).toBe(1);
      expect(built.calls.get).toBe(2);
      expect(built.remaining()).toBeDefined();
    }
  });

  it("treats every pre-delete read failure as unknown with zero deletes", async () => {
    const failures: readonly unknown[] = [
      httpError(401),
      httpError(403),
      httpError(429),
      httpError(500),
      Object.assign(new Error("PRIVATE-TIMEOUT"), { code: "ETIMEDOUT" }),
      Object.assign(new Error("PRIVATE-RESET"), { code: "ECONNRESET" }),
      new Error("PRIVATE-UNCLASSIFIED"),
    ];
    for (const failure of failures) {
      const built = build({ session: makeSession(), preDelete: failure });
      await expect(built.tool.execute({}, {} as never)).rejects.toMatchObject({
        code: "EDIT_CLEANUP_STATE_UNKNOWN",
        externalStateUncertain: false,
      });
      expect(built.calls.del).toBe(0);
      expect(built.remaining()).toBeDefined();
    }
  });

  it("retains the record when the delete is not acknowledged and never retries it", async () => {
    const built = build({
      session: makeSession(),
      deleteFails: new Error("PRIVATE-DELETE-FAILURE"),
    });
    await expect(built.tool.execute({}, {} as never)).rejects.toMatchObject({
      code: "EDIT_CLEANUP_REMOTE_DELETE_FAILED",
      externalStateUncertain: true,
    });
    expect(built.calls.del).toBe(1);
    expect(built.calls.get).toBe(1);
    expect(built.remaining()).toBeDefined();
  });

  it("refuses a missing or changed bound record before any Google call", async () => {
    const missing = build({ candidate: activeCandidate });
    await expect(missing.tool.execute({}, {} as never)).rejects.toMatchObject({
      code: "EDIT_CLEANUP_RECORD_NOT_FOUND",
    });
    expect(missing.calls.get).toBe(0);
    expect(missing.calls.del).toBe(0);

    const changed = build({ candidate: managedCandidate, session: makeSession() });
    await expect(changed.tool.execute({}, {} as never)).rejects.toMatchObject({
      code: "EDIT_CLEANUP_RECORD_CHANGED",
    });
    expect(changed.calls.get).toBe(0);
    expect(changed.calls.del).toBe(0);
    expect(changed.remaining()).toBeDefined();
  });

  it("reconciles a journalled record after trusted local expiry with no Google call", async () => {
    const journal = makeJournal();
    await journal.record({
      editId: "temporary-edit-1",
      expiryTimeSeconds: pastExpiry,
      source: "exact_release_verification",
      createdAt: fixedNow.toISOString(),
    });
    const built = build({
      candidate: {
        recordSource: "cleanup_journal",
        editId: "temporary-edit-1",
        expiryTimeSeconds: pastExpiry,
      },
      journal,
    });
    const result = await built.tool.execute({}, {} as never);
    expect(result.recordSource).toBe("cleanup_journal");
    expect(result.outcome).toBe("LOCAL_EXPIRY_RECONCILED");
    expect(built.calls.get).toBe(0);
    expect(built.calls.del).toBe(0);
    expect(await journal.list()).toEqual([]);
    const verify = built.tool.verify;
    if (verify === undefined) throw new Error("cleanup must declare a real verifier");
    await expect(verify({}, result, {} as never)).resolves.toBe(true);
  });

  it("reconciles a journalled record only after a verified remote delete", async () => {
    const journal = makeJournal();
    await journal.record({
      editId: "temporary-edit-1",
      expiryTimeSeconds: futureExpiry,
      source: "rollout_verification",
      createdAt: fixedNow.toISOString(),
    });
    const built = build({
      candidate: {
        recordSource: "cleanup_journal",
        editId: "temporary-edit-1",
        expiryTimeSeconds: futureExpiry,
      },
      journal,
      postDelete: observedPostDeleteFailure(),
    });
    const result = await built.tool.execute({}, {} as never);
    expect(result.recordSource).toBe("cleanup_journal");
    expect(result.outcome).toBe("REMOTE_DELETE_VERIFIED");
    expect(built.calls.del).toBe(1);
    expect(await journal.list()).toEqual([]);
  });

  it("binds the approval digest to the exact record identity", () => {
    const base = createReleaseEditCleanupDigest(packageName, managedCandidate);
    expect(base).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      createReleaseEditCleanupDigest(packageName, { ...managedCandidate, editId: "other-edit" }),
    ).not.toBe(base);
    expect(
      createReleaseEditCleanupDigest(packageName, {
        ...managedCandidate,
        expiryTimeSeconds: futureExpiry,
      }),
    ).not.toBe(base);
    expect(
      createReleaseEditCleanupDigest(packageName, {
        ...managedCandidate,
        recordSource: "cleanup_journal",
      }),
    ).not.toBe(base);
    const summary = createReleaseEditCleanupSummary(packageName, managedCandidate);
    expect(summary).toContain(packageName);
    expect(summary).not.toContain("managed-edit-1");
  });

  it("exposes exactly one delete capability and no creation, commit, validate, or track mutation", () => {
    const source = sourceOf("cleanup-tool.ts");
    for (const forbidden of [
      "createEdit",
      "commitEdit",
      "updateTrack",
      "uploadBundle",
      "edits.insert",
      "edits.list",
      "edits.commit",
      "edits.validate",
      "tracks.update",
      ".delete(",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).toContain("gateway.deleteEdit(");
  });
});

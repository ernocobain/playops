import { describe, expect, it } from "vitest";
import type { NewAuditEntry } from "../src/audit/index.js";
import {
  createReleaseCommitIntent,
  type ReleaseCommitIntent,
} from "../src/releases/commit-approval.js";
import {
  createReleaseCommitTool,
  type ReleaseCommitAuditLedger,
  type ReleaseCommitResult,
} from "../src/releases/commit-edit-tool.js";
import type { ReleaseEditCommitGateway, ReleaseEditReadback } from "../src/releases/gateway.js";
import {
  ReleaseError,
  type ReleaseEditSession,
  type ReleaseState,
  type ReleaseTrackState,
} from "../src/releases/index.js";
import type { ReleaseEditSessionStore } from "../src/releases/session-store.js";
import type {
  ReleaseCommitAttemptJournal,
  ReleaseCommitAttemptPreparedInput,
  ReleaseCommitAttemptJournalRecord,
  ReleaseCommitAttemptState,
  ReleaseCommitAttemptVerificationPatch,
} from "../src/releases/commit-attempt-journal.js";

const packageName = "com.example.release";
const editId = "edit-phase410";
const targetTrack = "production";
const expiryTimeSeconds = "1900000000";
const fixedNow = new Date("2026-09-29T04:00:00.000Z");
const noteText = "Exact private note text";

function targetRelease(overrides: Partial<ReleaseState> = {}): ReleaseState {
  return {
    name: "Candidate 101",
    status: "inProgress",
    versionCodes: ["100", "101"],
    userFraction: 0.05,
    releaseNotes: [
      { language: "en-US", text: noteText },
      { language: "id", text: "Perbaikan stabilitas." },
    ],
    countryTargeting: { countries: ["ID", "US"], includeRestOfWorld: false },
    inAppUpdatePriority: 5,
    ...overrides,
  };
}

function track(overrides: Partial<ReleaseTrackState> = {}): ReleaseTrackState {
  return {
    track: targetTrack,
    releases: [
      {
        name: "Older release",
        status: "completed",
        versionCodes: ["99"],
        releaseNotes: [{ language: "de-AT", text: "Older" }],
        countryTargeting: { countries: ["DE"], includeRestOfWorld: true },
        inAppUpdatePriority: 2,
      },
      targetRelease(),
    ],
    ...overrides,
  };
}

function intent(overrides: Partial<ReleaseTrackState> = {}): ReleaseCommitIntent {
  return createReleaseCommitIntent({
    packageName,
    editId,
    targetTrack,
    versionCode: "101",
    targetTrackState: track(overrides),
    validatedEdit: { valid: true, expiryTimeSeconds },
  });
}

function session(overrides: Partial<ReleaseEditSession> = {}): ReleaseEditSession {
  return {
    version: 1,
    packageName,
    editId,
    expiryTimeSeconds,
    createdAt: "2026-09-29T00:00:00.000Z",
    ...overrides,
  };
}

class FakeStore implements ReleaseEditSessionStore {
  value: ReleaseEditSession | undefined = session();
  clearCalls = 0;
  loadCalls = 0;
  saveCalls = 0;
  clearError?: unknown;
  loadAfterClear?: ReleaseEditSession | undefined;

  async load(): Promise<ReleaseEditSession | undefined> {
    this.loadCalls += 1;
    if (this.clearCalls > 0 && this.loadAfterClear !== undefined) return this.loadAfterClear;
    return this.value;
  }

  async save(value: ReleaseEditSession): Promise<void> {
    this.saveCalls += 1;
    this.value = value;
  }

  async clear(): Promise<void> {
    this.clearCalls += 1;
    if (this.clearError !== undefined) throw this.clearError;
    this.value = undefined;
  }
}

class FakeCommitJournal implements ReleaseCommitAttemptJournal {
  records: ReleaseCommitAttemptJournalRecord[] = [];
  prepareError?: unknown;
  transportError?: unknown;
  ackError?: unknown;
  async list() {
    return this.records;
  }
  async prepare(input: ReleaseCommitAttemptPreparedInput) {
    if (this.prepareError !== undefined) throw this.prepareError;
    const record = {
      ...input,
      attemptId: "11111111-1111-4111-8111-111111111111",
      state: "PREPARED" as const,
    };
    this.records.push(record);
    return record;
  }
  async transition(
    attemptId: string,
    from: ReleaseCommitAttemptState,
    to: ReleaseCommitAttemptState,
    updatedAtUtc: string,
    changes: ReleaseCommitAttemptVerificationPatch = {},
  ) {
    if (to === "TRANSPORT_ATTEMPTED" && this.transportError !== undefined)
      throw this.transportError;
    if (to === "ACKNOWLEDGED" && this.ackError !== undefined) throw this.ackError;
    const index = this.records.findIndex((record) => record.attemptId === attemptId);
    const previous = this.records[index];
    if (!previous || previous.state !== from) throw new Error("journal state mismatch");
    const record = { ...previous, ...changes, state: to, updatedAtUtc };
    this.records[index] = record;
    return record;
  }
  async updateVerification(
    attemptId: string,
    from: ReleaseCommitAttemptState,
    updatedAtUtc: string,
    changes: ReleaseCommitAttemptVerificationPatch,
  ) {
    const index = this.records.findIndex((record) => record.attemptId === attemptId);
    const previous = this.records[index];
    if (!previous || previous.state !== from) throw new Error("journal state mismatch");
    const record = { ...previous, ...changes, updatedAtUtc };
    this.records[index] = record;
    return record;
  }
}

class FakeAudit implements ReleaseCommitAuditLedger {
  readonly entries: NewAuditEntry[] = [];
  error?: unknown;
  async append(entry: NewAuditEntry): Promise<void> {
    if (this.error !== undefined) throw this.error;
    this.entries.push(entry);
  }
}

interface GatewayOptions {
  readonly currentTrack?: ReleaseTrackState;
  readonly trackSequence?: readonly ReleaseTrackState[];
  readonly edit?: ReleaseEditReadback;
  readonly validation?: ReleaseEditReadback;
  readonly validationError?: unknown;
  readonly commitResult?: ReleaseEditReadback;
  readonly commitError?: unknown;
  readonly onValidate?: () => void;
  readonly onCommit?: () => void;
}

function gateway(options: GatewayOptions = {}): {
  readonly gateway: ReleaseEditCommitGateway;
  readonly calls: string[];
  readonly commitPolicies: unknown[];
} {
  const calls: string[] = [];
  const commitPolicies: unknown[] = [];
  const implementation: ReleaseEditCommitGateway = {
    async getEdit(received) {
      calls.push("getEdit");
      expect(received.editId).toBe(editId);
      return options.edit ?? { id: editId, expiryTimeSeconds };
    },
    async getTrack(received, receivedTrack) {
      calls.push("getTrack");
      expect(received.editId).toBe(editId);
      expect(receivedTrack).toBe(targetTrack);
      const readIndex = calls.filter((call) => call === "getTrack").length - 1;
      return options.trackSequence?.[readIndex] ?? options.currentTrack ?? track();
    },
    async validateEdit(received) {
      calls.push("validateEdit");
      expect(received.editId).toBe(editId);
      options.onValidate?.();
      if (options.validationError !== undefined) throw options.validationError;
      return options.validation ?? { id: editId, expiryTimeSeconds };
    },
    async commitEdit(received, policy) {
      calls.push("commitEdit");
      expect(received.editId).toBe(editId);
      commitPolicies.push(policy);
      options.onCommit?.();
      if (options.commitError !== undefined) throw options.commitError;
      return options.commitResult ?? { id: editId, expiryTimeSeconds };
    },
  };
  return { gateway: implementation, calls, commitPolicies };
}

function makeTool(
  options: {
    readonly intent?: ReleaseCommitIntent;
    readonly gatewayOptions?: GatewayOptions;
    readonly store?: FakeStore;
    readonly audit?: FakeAudit;
    readonly journal?: FakeCommitJournal;
  } = {},
) {
  const store = options.store ?? new FakeStore();
  const audit = options.audit ?? new FakeAudit();
  const fake = gateway(options.gatewayOptions);
  const journal = options.journal ?? new FakeCommitJournal();
  const built = createReleaseCommitTool({
    packageName,
    intent: options.intent ?? intent(),
    gateway: fake.gateway,
    sessionStore: store,
    auditLedger: audit,
    commitAttemptJournal: journal,
    now: () => new Date(fixedNow),
  });
  return { ...built, fake, store, audit, journal };
}

async function execute(tool: ReturnType<typeof makeTool>["tool"]): Promise<ReleaseCommitResult> {
  return tool.execute({}, {});
}

describe("Phase 4.10 commit tool contract", () => {
  it("is publish-only, empty-input, uses the exact Phase 4.9 approval binding, and warns about other edits", () => {
    const built = makeTool();
    expect(built.tool.name).toBe("releases.commit_edit");
    expect(built.tool.permission).toBe("publish");
    expect(built.binding.approval?.createRequestDigest({})).toBe(intent().requestDigest);
    expect(built.binding.approval?.createRequestDigest({ unexpected: "ignored" })).toBe(
      intent().requestDigest,
    );
    const summary = built.binding.approval?.createSafeSummary({}) ?? "";
    expect(summary).toContain("PUBLISH");
    expect(summary).toContain("invalidate other active edits");
    expect(summary).not.toContain(noteText);
    expect(() => built.tool.inputSchema.parse({ packageName })).toThrow();
  });

  it("freshly rechecks state, validates, commits once, clears, and verifies local lifecycle", async () => {
    const built = makeTool();
    const result = await execute(built.tool);

    expect(result).toEqual({
      committed: true,
      commitAcknowledged: true,
      targetTrack,
      versionCode: "101",
      releaseStatus: "inProgress",
      changesInReviewBehavior: "ERROR_IF_IN_REVIEW",
      liveReleaseVerified: false,
    });
    expect(built.fake.calls).toEqual([
      "getEdit",
      "getTrack",
      "validateEdit",
      "getTrack",
      "commitEdit",
    ]);
    expect(built.fake.commitPolicies).toEqual([
      { changesInReviewBehavior: "ERROR_IF_IN_REVIEW", changesNotSentForReview: false },
    ]);
    expect(built.store.clearCalls).toBe(1);
    expect(await built.store.load()).toBeUndefined();
    expect(built.audit.entries).toContainEqual(
      expect.objectContaining({
        type: "release.commit.completed",
        status: "success",
        metadata: expect.objectContaining({
          permission: "publish",
          requestDigest: intent().requestDigest,
          committed: true,
          liveReleaseVerified: false,
        }),
      }),
    );
    expect(JSON.stringify(built.audit.entries)).not.toContain(noteText);
  });

  it("blocks before validation and commit when the approved state digest is stale", async () => {
    const built = makeTool({
      gatewayOptions: {
        currentTrack: track({
          releases: [targetRelease({ status: "completed", userFraction: undefined })],
        }),
      },
    });
    await expect(execute(built.tool)).rejects.toMatchObject({
      code: "COMMIT_STATE_CHANGED",
      externalStateUncertain: false,
    });
    expect(built.fake.calls).toEqual(["getEdit", "getTrack"]);
    expect(built.store.clearCalls).toBe(0);
  });

  it("blocks any material fresh-track change before validation or commit", async () => {
    const cases: readonly [string, ReleaseTrackState][] = [
      [
        "status",
        track({ releases: [targetRelease({ status: "completed", userFraction: undefined })] }),
      ],
      ["fraction", track({ releases: [targetRelease({ userFraction: 0.1 })] })],
      [
        "notes",
        track({
          releases: [targetRelease({ releaseNotes: [{ language: "en-US", text: "changed" }] })],
        }),
      ],
      ["versionCodes", track({ releases: [targetRelease({ versionCodes: ["102"] })] })],
      [
        "unrelated release",
        track({
          releases: [
            {
              name: "Changed older",
              status: "completed",
              versionCodes: ["99"],
              releaseNotes: [{ language: "de-AT", text: "Older" }],
              countryTargeting: { countries: ["DE"], includeRestOfWorld: true },
              inAppUpdatePriority: 2,
            },
            targetRelease(),
          ],
        }),
      ],
    ];
    for (const [_label, currentTrack] of cases) {
      const built = makeTool({ gatewayOptions: { currentTrack } });
      await expect(execute(built.tool)).rejects.toMatchObject({
        code: "COMMIT_STATE_CHANGED",
        externalStateUncertain: false,
      });
      expect(built.fake.calls).toEqual(["getEdit", "getTrack"]);
    }

    const wrongTrack = makeTool({
      gatewayOptions: { currentTrack: { ...track(), track: "beta" } },
    });
    await expect(execute(wrongTrack.tool)).rejects.toMatchObject({
      code: "TRACK_MISMATCH",
      externalStateUncertain: false,
    });
    expect(wrongTrack.fake.calls).toEqual(["getEdit", "getTrack"]);
  });

  it("blocks validation rejection without commit or session clear", async () => {
    const built = makeTool({ gatewayOptions: { validationError: new Error("PRIVATE-VALIDATE") } });
    await expect(execute(built.tool)).rejects.toMatchObject({
      code: "EDIT_VALIDATION_FAILED",
      externalStateUncertain: false,
    });
    expect(built.fake.calls).toEqual(["getEdit", "getTrack", "validateEdit"]);
    expect(built.store.clearCalls).toBe(0);
    expect(JSON.stringify(built.audit.entries)).not.toContain("PRIVATE-VALIDATE");
  });

  it("R6 durably prepares before final validation and claims transport before commit gateway", async () => {
    const journal = new FakeCommitJournal();
    const seen: string[] = [];
    const built = makeTool({
      journal,
      gatewayOptions: {
        onValidate: () => {
          expect(journal.records[0]?.state).toBe("PREPARED");
          seen.push("validation-after-prepared");
        },
        onCommit: () => {
          expect(journal.records[0]?.state).toBe("TRANSPORT_ATTEMPTED");
          seen.push("commit-after-durable-claim");
        },
      },
    });
    await execute(built.tool);
    expect(seen).toEqual(["validation-after-prepared", "commit-after-durable-claim"]);
    expect(journal.records[0]?.state).toBe("ACKNOWLEDGED");
  });
  it("R6 rejects a tampered request digest before preparing trusted recovery evidence", () => {
    const candidate = { ...intent(), requestDigest: "d".repeat(64) };
    expect(() => makeTool({ intent: candidate })).toThrowError(
      expect.objectContaining({ code: "INVALID_COMMIT_INTENT" }),
    );
  });

  it("R6 retains acknowledged evidence while live release verification remains false", async () => {
    const built = makeTool();
    const result = await execute(built.tool);
    expect(result).toMatchObject({ commitAcknowledged: true, liveReleaseVerified: false });
    expect(built.journal.records).toHaveLength(1);
    expect(built.journal.records[0]).toMatchObject({
      state: "ACKNOWLEDGED",
      acknowledgedAtUtc: fixedNow.toISOString(),
      editId,
      expiryTimeSeconds,
      expectedStateDigest: intent().stateDigest,
      requestDigest: intent().requestDigest,
    });
    expect(await built.store.load()).toBeUndefined();
    expect(JSON.stringify(built.journal.records)).not.toContain(noteText);
  });
  it("R6 PREPARED persistence failure prevents all commit transport", async () => {
    const journal = new FakeCommitJournal();
    journal.prepareError = new Error("private write failure");
    const built = makeTool({ journal });
    await expect(execute(built.tool)).rejects.toMatchObject({ externalStateUncertain: false });
    expect(built.fake.calls).not.toContain("commitEdit");
    expect(await built.store.load()).toEqual(session());
  });
  it("R6 TRANSPORT_ATTEMPTED persistence failure prevents all commit transport", async () => {
    const journal = new FakeCommitJournal();
    journal.transportError = new Error("private sync failure");
    const built = makeTool({ journal });
    await expect(execute(built.tool)).rejects.toMatchObject({ externalStateUncertain: false });
    expect(built.fake.calls).not.toContain("commitEdit");
    expect(journal.records[0]?.state).toBe("PREPARED");
    expect(await built.store.load()).toEqual(session());
  });
  it("R6 keeps an explicit rejection certain even when failure-audit append fails", async () => {
    const audit = new FakeAudit();
    audit.error = new Error("private audit failure");
    const built = makeTool({
      audit,
      gatewayOptions: {
        commitError: new ReleaseError("COMMIT_REJECTED", "Explicit rejection.", {
          externalStateUncertain: false,
        }),
      },
    });
    await expect(execute(built.tool)).rejects.toMatchObject({
      code: "COMMIT_AUDIT_FAILED",
      externalStateUncertain: false,
    });
    expect(built.journal.records[0]?.state).toBe("RECONCILED_NOT_COMMITTED");
    expect(await built.store.load()).toEqual(session());
    expect(built.fake.calls.filter((call) => call === "commitEdit")).toHaveLength(1);
  });

  it("R6 retains durable acknowledgement evidence when the local session cannot be cleared", async () => {
    const store = new FakeStore();
    store.clearError = new Error("private clear failure");
    const built = makeTool({ store });
    await expect(execute(built.tool)).rejects.toMatchObject({
      code: "COMMIT_SESSION_CLEANUP_FAILED",
      externalStateUncertain: true,
    });
    expect(built.fake.calls.filter((call) => call === "commitEdit")).toHaveLength(1);
    expect(built.journal.records).toHaveLength(1);
    expect(built.journal.records[0]).toMatchObject({
      state: "ACKNOWLEDGED",
      acknowledgedAtUtc: fixedNow.toISOString(),
      editId,
      expectedStateDigest: intent().stateDigest,
    });
    expect(built.journal.records[0]?.attemptId).toBeTypeOf("string");
    expect(await built.store.load()).toEqual(session());
    expect(built.store.clearCalls).toBe(1);
  });

  it("R6 ambiguous commit preserves durable AMBIGUOUS recovery and never retries", async () => {
    const built = makeTool({ gatewayOptions: { commitError: new Error("lost response") } });
    await expect(execute(built.tool)).rejects.toMatchObject({ externalStateUncertain: true });
    expect(built.fake.calls.filter((call) => call === "commitEdit")).toHaveLength(1);
    expect(built.journal.records[0]?.state).toBe("AMBIGUOUS");
    expect(await built.store.load()).toEqual(session());
  });
  it("R6 ACKNOWLEDGED persistence failure retains the session and never retries", async () => {
    const journal = new FakeCommitJournal();
    journal.ackError = new Error("lost journal acknowledgement");
    const built = makeTool({ journal });
    await expect(execute(built.tool)).rejects.toMatchObject({ externalStateUncertain: true });
    expect(built.fake.calls.filter((call) => call === "commitEdit")).toHaveLength(1);
    expect(await built.store.load()).toEqual(session());
    expect(journal.records[0]?.state).toBe("AMBIGUOUS");
  });

  it("R6 blocks track state drift after validation without sending commit", async () => {
    const changed = track({
      releases: [
        ...track().releases.slice(0, 1),
        targetRelease({ releaseNotes: [{ language: "en-US", text: "changed after validation" }] }),
      ],
    });
    const built = makeTool({ gatewayOptions: { trackSequence: [track(), changed] } });
    await expect(execute(built.tool)).rejects.toMatchObject({
      code: "COMMIT_STATE_CHANGED",
      externalStateUncertain: false,
    });
    expect(built.fake.calls).toEqual(["getEdit", "getTrack", "validateEdit", "getTrack"]);
    expect(built.fake.commitPolicies).toHaveLength(0);
    expect(await built.store.load()).toEqual(session());
    expect(built.store.clearCalls).toBe(0);
  });

  it("R6 blocks another future validation expiry before commit transport", async () => {
    const built = makeTool({
      gatewayOptions: { validation: { id: editId, expiryTimeSeconds: "2000000000" } },
    });
    await expect(execute(built.tool)).rejects.toMatchObject({
      code: "COMMIT_VALIDATION_EXPIRY_MISMATCH",
      externalStateUncertain: false,
    });
    expect(built.fake.calls).toEqual(["getEdit", "getTrack", "validateEdit"]);
    expect(built.store.clearCalls).toBe(0);
    expect(await built.store.load()).toEqual(session());
  });

  it("blocks malformed, mismatched, and expired fresh validation responses", async () => {
    const cases: readonly ReleaseEditReadback[] = [
      { id: "other-edit", expiryTimeSeconds },
      { id: editId, expiryTimeSeconds: "bad" },
      { id: editId, expiryTimeSeconds: "1" },
    ];
    for (const validation of cases) {
      const built = makeTool({ gatewayOptions: { validation } });
      await expect(execute(built.tool)).rejects.toMatchObject({ externalStateUncertain: false });
      expect(built.fake.calls).toEqual(["getEdit", "getTrack", "validateEdit"]);
      expect(built.store.clearCalls).toBe(0);
    }
  });

  it("keeps the session on explicit review conflict", async () => {
    const built = makeTool({
      gatewayOptions: {
        commitError: new ReleaseError(
          "CHANGES_ALREADY_IN_REVIEW",
          "Changes are already in review.",
          { externalStateUncertain: false },
        ),
      },
    });
    await expect(execute(built.tool)).rejects.toMatchObject({
      code: "CHANGES_ALREADY_IN_REVIEW",
      externalStateUncertain: false,
    });
    expect(built.fake.calls).toEqual([
      "getEdit",
      "getTrack",
      "validateEdit",
      "getTrack",
      "commitEdit",
    ]);
    expect(built.store.clearCalls).toBe(0);
  });

  it("keeps the session and reports uncertainty on ambiguous commit failure", async () => {
    const built = makeTool({ gatewayOptions: { commitError: new Error("PRIVATE-TIMEOUT") } });
    await expect(execute(built.tool)).rejects.toMatchObject({
      code: "COMMIT_FAILED",
      externalStateUncertain: true,
    });
    expect(built.fake.calls).toEqual([
      "getEdit",
      "getTrack",
      "validateEdit",
      "getTrack",
      "commitEdit",
    ]);
    expect(built.store.clearCalls).toBe(0);
  });

  it("does not clear on malformed or mismatched commit response", async () => {
    const built = makeTool({
      gatewayOptions: { commitResult: { id: "other-edit", expiryTimeSeconds } },
    });
    await expect(execute(built.tool)).rejects.toMatchObject({
      code: "COMMIT_RESPONSE_INVALID",
      externalStateUncertain: true,
    });
    expect(built.store.clearCalls).toBe(0);
  });

  it("reports cleanup failure as uncertain without retrying commit", async () => {
    const store = new FakeStore();
    store.clearError = new Error("PRIVATE-CLEAR");
    const built = makeTool({ store });
    await expect(execute(built.tool)).rejects.toMatchObject({
      code: "COMMIT_SESSION_CLEANUP_FAILED",
      externalStateUncertain: true,
    });
    expect(built.fake.calls.filter((call: string) => call === "commitEdit")).toHaveLength(1);
  });

  it("reports audit write failure after confirmed commit as uncertain", async () => {
    const audit = new FakeAudit();
    audit.error = new Error("PRIVATE-AUDIT");
    const built = makeTool({ audit });
    await expect(execute(built.tool)).rejects.toMatchObject({
      code: "COMMIT_AUDIT_FAILED",
      externalStateUncertain: true,
    });
    expect(built.fake.calls.filter((call: string) => call === "commitEdit")).toHaveLength(1);
    expect(await built.store.load()).toBeUndefined();
  });

  it("fails if clear returns but the active session remains", async () => {
    const store = new FakeStore();
    store.loadAfterClear = session();
    const built = makeTool({ store });
    await expect(execute(built.tool)).rejects.toMatchObject({
      code: "COMMIT_SESSION_CLEANUP_FAILED",
      externalStateUncertain: true,
    });
    expect(built.fake.calls.filter((call: string) => call === "commitEdit")).toHaveLength(1);
  });

  it("fails when the tracked session edit identity no longer matches the approved intent", async () => {
    const store = new FakeStore();
    store.value = session({ editId: "other-edit" });
    const built = makeTool({ store });
    await expect(execute(built.tool)).rejects.toMatchObject({
      code: "EDIT_SESSION_INVALID",
      externalStateUncertain: false,
    });
    expect(built.fake.calls).toEqual([]);
    expect(built.store.clearCalls).toBe(0);
  });

  it("fails safely for missing, expired, and wrong remote edit state", async () => {
    const missingStore = new FakeStore();
    missingStore.value = undefined;
    const missing = makeTool({ store: missingStore });
    await expect(execute(missing.tool)).rejects.toMatchObject({
      code: "EDIT_SESSION_REQUIRED",
      externalStateUncertain: false,
    });
    expect(missing.fake.calls).toEqual([]);

    const expired = makeTool({ store: new FakeStore() });
    expired.store.value = session({ expiryTimeSeconds: "1" });
    await expect(execute(expired.tool)).rejects.toMatchObject({
      code: "EDIT_SESSION_EXPIRED",
      externalStateUncertain: false,
    });
    expect(expired.fake.calls).toEqual([]);

    const wrongEdit = makeTool({
      gatewayOptions: { edit: { id: "other-edit", expiryTimeSeconds } },
    });
    await expect(execute(wrongEdit.tool)).rejects.toMatchObject({
      code: "EDIT_SESSION_INVALID",
      externalStateUncertain: false,
    });
    expect(wrongEdit.fake.calls).toEqual(["getEdit"]);
  });
});

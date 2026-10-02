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
  readonly edit?: ReleaseEditReadback;
  readonly validation?: ReleaseEditReadback;
  readonly validationError?: unknown;
  readonly commitResult?: ReleaseEditReadback;
  readonly commitError?: unknown;
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
      return options.currentTrack ?? track();
    },
    async validateEdit(received) {
      calls.push("validateEdit");
      expect(received.editId).toBe(editId);
      if (options.validationError !== undefined) throw options.validationError;
      return options.validation ?? { id: editId, expiryTimeSeconds };
    },
    async commitEdit(received, policy) {
      calls.push("commitEdit");
      expect(received.editId).toBe(editId);
      commitPolicies.push(policy);
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
  } = {},
) {
  const store = options.store ?? new FakeStore();
  const audit = options.audit ?? new FakeAudit();
  const fake = gateway(options.gatewayOptions);
  const built = createReleaseCommitTool({
    packageName,
    intent: options.intent ?? intent(),
    gateway: fake.gateway,
    sessionStore: store,
    auditLedger: audit,
    now: () => new Date(fixedNow),
  });
  return { ...built, fake, store, audit };
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
      targetTrack,
      versionCode: "101",
      releaseStatus: "inProgress",
      changesInReviewBehavior: "ERROR_IF_IN_REVIEW",
      liveReleaseVerified: false,
    });
    expect(built.fake.calls).toEqual(["getEdit", "getTrack", "validateEdit", "commitEdit"]);
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
    expect(built.fake.calls).toEqual(["getEdit", "getTrack", "validateEdit", "commitEdit"]);
    expect(built.store.clearCalls).toBe(0);
  });

  it("keeps the session and reports uncertainty on ambiguous commit failure", async () => {
    const built = makeTool({ gatewayOptions: { commitError: new Error("PRIVATE-TIMEOUT") } });
    await expect(execute(built.tool)).rejects.toMatchObject({
      code: "COMMIT_FAILED",
      externalStateUncertain: true,
    });
    expect(built.fake.calls).toEqual(["getEdit", "getTrack", "validateEdit", "commitEdit"]);
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

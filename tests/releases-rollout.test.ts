import { describe, expect, it, vi } from "vitest";
import type { NewAuditEntry } from "../src/audit/index.js";
import {
  createReleaseRolloutApprovalBinding,
  createReleaseRolloutIntent,
  createReleaseRolloutRequestDigest,
  type ReleaseRolloutIntent,
} from "../src/releases/rollout-approval.js";
import {
  createReleaseRolloutTool,
  RELEASES_UPDATE_ROLLOUT_FRACTION_TOOL_NAME,
} from "../src/releases/rollout-tool.js";
import type { ReleaseEditSession, ReleaseState, ReleaseTrackState } from "../src/releases/index.js";
import type { ReleaseEditSessionStore } from "../src/releases/session-store.js";
import type { ReleaseRolloutGateway } from "../src/releases/gateway.js";

const packageName = "com.example.rollout";
const targetTrack = "production";
const versionCode = "123";
const releaseName = "1.2.3";
const expiryTimeSeconds = "4102444800";
const fixedNow = new Date("2026-09-30T06:00:00.000Z");
const noteText = "PRIVATE-ROLLOUT-NOTE";

function targetRelease(overrides: Partial<ReleaseState> = {}): ReleaseState {
  return {
    name: releaseName,
    status: "inProgress",
    versionCodes: [versionCode],
    userFraction: 0.05,
    releaseNotes: [{ language: "en-US", text: noteText }],
    countryTargeting: { countries: ["US", "ID"], includeRestOfWorld: false },
    inAppUpdatePriority: 3,
    ...overrides,
  };
}

function currentTrack(release: ReleaseState = targetRelease()): ReleaseTrackState {
  return {
    track: targetTrack,
    releases: [
      {
        name: "Older release",
        status: "completed",
        versionCodes: ["122"],
        releaseNotes: [{ language: "en-US", text: "Older" }],
        countryTargeting: { countries: ["US"], includeRestOfWorld: true },
        inAppUpdatePriority: 1,
      },
      release,
    ],
  };
}

function makeIntent(state = currentTrack(), newFraction = 0.1): ReleaseRolloutIntent {
  return createReleaseRolloutIntent({
    packageName,
    targetTrack,
    versionCode,
    releaseName,
    currentTrackState: state,
    newFraction,
  });
}

function makeStore(active?: ReleaseEditSession): ReleaseEditSessionStore {
  let current = active;
  return {
    load: vi.fn(async () => current),
    save: vi.fn(async (session) => {
      current = session;
    }),
    clear: vi.fn(async () => {
      current = undefined;
    }),
  };
}

function makeAudit() {
  const entries: NewAuditEntry[] = [];
  return {
    entries,
    append: vi.fn(async (entry: NewAuditEntry) => {
      entries.push(entry);
    }),
  };
}

function fromUpdate(request: {
  track: string;
  releases: readonly Record<string, unknown>[];
}): ReleaseTrackState {
  return {
    track: request.track,
    releases: request.releases.map((release) => ({
      name: release.name as string | undefined,
      versionCodes: release.versionCodes as readonly string[],
      status: release.status as ReleaseState["status"],
      ...(release.userFraction !== undefined
        ? { userFraction: release.userFraction as number }
        : {}),
      ...(release.releaseNotes !== undefined
        ? { releaseNotes: release.releaseNotes as ReleaseState["releaseNotes"] }
        : {}),
      ...(release.countryTargeting !== undefined
        ? { countryTargeting: release.countryTargeting as ReleaseState["countryTargeting"] }
        : {}),
      ...(release.inAppUpdatePriority !== undefined
        ? { inAppUpdatePriority: release.inAppUpdatePriority as number }
        : {}),
    })),
  };
}

function makeGateway(
  options: {
    readonly operationalTrack?: ReleaseTrackState;
    readonly postCommitTrack?: ReleaseTrackState;
    readonly summaryObserved?: boolean;
    readonly summarySequence?: readonly boolean[];
    readonly updateError?: unknown;
    readonly validateError?: unknown;
    readonly commitError?: unknown;
    readonly deleteError?: unknown;
    readonly operationalTrackSequence?: readonly ReleaseTrackState[];
  } = {},
): {
  readonly gateway: ReleaseRolloutGateway;
  readonly calls: {
    summary: number;
    create: number;
    getEdit: number;
    getTrack: number;
    update: number;
    validate: number;
    commit: number;
    delete: number;
  };
  readonly events: string[];
  readonly requests: unknown[];
} {
  const calls = {
    summary: 0,
    create: 0,
    getEdit: 0,
    getTrack: 0,
    update: 0,
    validate: 0,
    commit: 0,
    delete: 0,
  };
  const events: string[] = [];
  const requests: unknown[] = [];
  let operationalTrack = options.operationalTrack ?? currentTrack();
  let operationalReads = 0;
  let summaryReads = 0;
  let created = 0;
  const gateway: ReleaseRolloutGateway = {
    listReleaseSummaries: vi.fn(async (track) => {
      expect(track).toBe(targetTrack);
      calls.summary += 1;
      events.push("applications.tracks.releases.list");
      const observed = options.summarySequence
        ? (options.summarySequence[summaryReads++] ?? false)
        : options.summaryObserved !== false;
      return !observed
        ? []
        : [
            {
              releaseName,
              track: targetTrack,
              versionCodes: [versionCode],
              releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
            },
          ];
    }),
    createEdit: vi.fn(async () => {
      calls.create += 1;
      created += 1;
      events.push(`edits.insert:${created}`);
      return {
        packageName,
        editId: created === 1 ? "rollout-edit" : "verification-edit",
        expiryTimeSeconds,
      };
    }),
    getEdit: vi.fn(async (session) => {
      calls.getEdit += 1;
      events.push(`edits.get:${session.editId}`);
      return { id: session.editId, expiryTimeSeconds };
    }),
    getTrack: vi.fn(async (session) => {
      calls.getTrack += 1;
      events.push(`edits.tracks.get:${session.editId}`);
      if (session.editId === "rollout-edit") {
        operationalReads += 1;
        const sequence = options.operationalTrackSequence;
        if (sequence && sequence[operationalReads - 1]) {
          return sequence[operationalReads - 1] ?? operationalTrack;
        }
        return operationalTrack;
      }
      return options.postCommitTrack ?? operationalTrack;
    }),
    updateTrack: vi.fn(async (_session, _track, request) => {
      calls.update += 1;
      events.push("edits.tracks.update");
      requests.push(request);
      if (options.updateError !== undefined) throw options.updateError;
      operationalTrack = fromUpdate(request as never);
      return operationalTrack;
    }),
    validateEdit: vi.fn(async (session) => {
      calls.validate += 1;
      events.push("edits.validate");
      if (options.validateError !== undefined) throw options.validateError;
      return { id: session.editId, expiryTimeSeconds };
    }),
    commitEdit: vi.fn(async (session, policy) => {
      calls.commit += 1;
      events.push("edits.commit");
      expect(policy).toEqual({
        changesInReviewBehavior: "ERROR_IF_IN_REVIEW",
        changesNotSentForReview: false,
      });
      if (options.commitError !== undefined) throw options.commitError;
      return { id: session.editId, expiryTimeSeconds };
    }),
    deleteEdit: vi.fn(async (session) => {
      calls.delete += 1;
      events.push(`edits.delete:${session.editId}`);
      if (options.deleteError !== undefined) throw options.deleteError;
    }),
  };
  return { gateway, calls, events, requests };
}

/** In-memory Phase 4.15 cleanup journal double; records call ordering explicitly. */
function makeCleanupJournal(
  options: { readonly recordError?: unknown; readonly removeError?: unknown } = {},
) {
  const entries = new Map<
    string,
    {
      readonly version: 1;
      readonly packageName: string;
      readonly editId: string;
      readonly expiryTimeSeconds: string;
      readonly source:
        "exact_release_verification" | "rollout_verification" | "status_control_verification";
      readonly createdAt: string;
    }
  >();
  const calls: string[] = [];
  return {
    entries,
    calls,
    async list() {
      return Object.freeze([...entries.values()]);
    },
    async record(entry: {
      readonly editId: string;
      readonly expiryTimeSeconds: string;
      readonly source:
        "exact_release_verification" | "rollout_verification" | "status_control_verification";
      readonly createdAt: string;
    }): Promise<void> {
      calls.push(`record:${entry.editId}`);
      if (options.recordError !== undefined) throw options.recordError;
      entries.set(entry.editId, {
        version: 1,
        packageName,
        editId: entry.editId,
        expiryTimeSeconds: entry.expiryTimeSeconds,
        source: entry.source,
        createdAt: entry.createdAt,
      });
    },
    async remove(editId: string): Promise<void> {
      calls.push(`remove:${editId}`);
      if (options.removeError !== undefined) throw options.removeError;
      entries.delete(editId);
    },
  };
}

function buildTool(
  options: Parameters<typeof makeGateway>[0] = {},
  intent = makeIntent(),
  journal: ReturnType<typeof makeCleanupJournal> = makeCleanupJournal(),
) {
  const fake = makeGateway(options);
  const store = makeStore();
  const audit = makeAudit();
  const built = createReleaseRolloutTool({
    packageName,
    intent,
    gateway: fake.gateway,
    sessionStore: store,
    cleanupJournal: journal,
    auditLedger: audit,
    now: () => fixedNow,
  });
  return { ...fake, ...built, store, audit, journal };
}

describe("Phase 4.12 rollout intent and approval", () => {
  it("binds exact identity, old/new fractions, full state digest, and policy", () => {
    const intent = makeIntent();
    const binding = createReleaseRolloutApprovalBinding(intent);
    expect(intent.operationKind).toBe("increase_staged_rollout");
    expect(intent.previousFraction).toBe(0.05);
    expect(intent.newFraction).toBe(0.1);
    expect(intent.currentStateDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(binding.permission).toBe("destructive");
    const summary = binding.createSafeSummary({});
    expect(summary).toContain("Current rollout: 0.05");
    expect(summary).toContain("New rollout: 0.1");
    expect(summary).toContain("inProgress");
    expect(summary).toContain("ERROR_IF_IN_REVIEW");
    expect(summary).toContain("invalidate");
    expect(summary).toContain("live user eligibility");
    expect(summary).not.toContain(noteText);
    expect(summary).not.toContain("rollout-edit");
  });

  it.each([
    [0.05, 0.1],
    [0.1, 0.25],
    [0.25, 0.5],
  ])("accepts monotonic staged rollout %s -> %s", (current, next) => {
    expect(
      makeIntent(currentTrack(targetRelease({ userFraction: current })), next).newFraction,
    ).toBe(next);
  });

  it.each([0, -0.1, 1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid target fraction %s",
    (newFraction) => {
      expect(() => makeIntent(currentTrack(), newFraction)).toThrowError();
    },
  );

  it("rejects no-op and decrease", () => {
    expect(() => makeIntent(currentTrack(), 0.05)).toThrowError();
    expect(() => makeIntent(currentTrack(), 0.04)).toThrowError();
  });

  it("changes the exact approval digest when the target fraction or release identity changes", () => {
    const base = makeIntent();
    const differentFraction = makeIntent(currentTrack(), 0.25);
    const differentRelease = createReleaseRolloutIntent({
      packageName,
      targetTrack,
      versionCode,
      releaseName: "1.2.4",
      currentTrackState: currentTrack(targetRelease({ name: "1.2.4" })),
      newFraction: 0.1,
    });
    expect(createReleaseRolloutRequestDigest(base)).not.toBe(
      createReleaseRolloutRequestDigest(differentFraction),
    );
    expect(createReleaseRolloutRequestDigest(base)).not.toBe(
      createReleaseRolloutRequestDigest(differentRelease),
    );
  });

  it.each(["draft", "halted", "completed", "statusUnspecified"] as const)(
    "rejects current status %s",
    (status) => {
      expect(() =>
        makeIntent(currentTrack(targetRelease({ status, userFraction: undefined }))),
      ).toThrowError();
    },
  );
});

describe("Phase 4.12 rollout tool", () => {
  it("is destructive with empty input and separate rollout approval", () => {
    const built = buildTool();
    expect(built.tool.name).toBe(RELEASES_UPDATE_ROLLOUT_FRACTION_TOOL_NAME);
    expect(built.tool.permission).toBe("destructive");
    expect(built.binding.approval?.createSafeSummary({})).toContain("Increase staged rollout");
    expect(() => built.tool.inputSchema.parse({ newFraction: 0.2 })).toThrowError();
  });

  it("runs the bounded operational workflow and changes only the target fraction", async () => {
    const built = buildTool();
    const result = await built.tool.execute({}, {});
    expect(result).toEqual({
      targetTrack,
      versionCode,
      releaseName,
      previousFraction: 0.05,
      newFraction: 0.1,
      status: "inProgress",
      rolloutCommitted: true,
      liveRolloutVerified: true,
      servingPropagationVerified: false,
    });
    expect(built.events).toEqual([
      "applications.tracks.releases.list",
      "edits.insert:1",
      "edits.get:rollout-edit",
      "edits.tracks.get:rollout-edit",
      "edits.tracks.update",
      "edits.tracks.get:rollout-edit",
      "edits.validate",
      "edits.commit",
      "applications.tracks.releases.list",
      "edits.insert:2",
      "edits.tracks.get:verification-edit",
      "edits.delete:verification-edit",
    ]);
    expect(built.calls).toMatchObject({
      summary: 2,
      create: 2,
      getEdit: 1,
      getTrack: 3,
      update: 1,
      validate: 1,
      commit: 1,
      delete: 1,
    });
    const request = built.requests[0] as { releases: readonly ReleaseState[] };
    expect(request.releases[0]).toMatchObject({ name: "Older release", versionCodes: ["122"] });
    expect(request.releases[1]).toMatchObject({
      name: releaseName,
      versionCodes: [versionCode],
      status: "inProgress",
      userFraction: 0.1,
      releaseNotes: [{ language: "en-US", text: noteText }],
      countryTargeting: { countries: ["US", "ID"], includeRestOfWorld: false },
      inAppUpdatePriority: 3,
    });
    await expect(built.store.load()).resolves.toBeUndefined();
    expect(JSON.stringify(built.audit.entries)).not.toContain(noteText);
    expect(JSON.stringify(built.audit.entries)).not.toContain("rollout-edit");
  });

  it("blocks a stale current fraction before tracks.update and cleans the operational edit", async () => {
    const built = buildTool({
      operationalTrackSequence: [currentTrack(targetRelease({ userFraction: 0.07 }))],
    });
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "ROLLOUT_STATE_CHANGED",
      externalStateUncertain: false,
    });
    expect(built.calls.update).toBe(0);
    expect(built.calls.commit).toBe(0);
    expect(built.calls.delete).toBe(1);
    await expect(built.store.load()).resolves.toBeUndefined();
  });

  it("blocks a missing or invalid fresh fraction before tracks.update", async () => {
    const built = buildTool({
      operationalTrackSequence: [currentTrack(targetRelease({ userFraction: undefined }))],
    });
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "INVALID_ROLLOUT_FRACTION",
      externalStateUncertain: false,
    });
    expect(built.calls.update).toBe(0);
    expect(built.calls.commit).toBe(0);
    expect(built.calls.delete).toBe(1);
  });

  it.each(["draft", "halted", "completed", "statusUnspecified"] as const)(
    "blocks fresh status %s without update or commit",
    async (status) => {
      const built = buildTool({
        operationalTrackSequence: [
          currentTrack(targetRelease({ status, userFraction: undefined })),
        ],
      });
      await expect(built.tool.execute({}, {})).rejects.toMatchObject({
        code: "ROLLOUT_NOT_IN_PROGRESS",
      });
      expect(built.calls.update).toBe(0);
      expect(built.calls.commit).toBe(0);
      expect(built.calls.delete).toBe(1);
    },
  );

  it("blocks validation failure and commits zero", async () => {
    const built = buildTool({ validateError: new Error("validation rejected") });
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "EDIT_VALIDATION_FAILED",
      externalStateUncertain: false,
    });
    expect(built.calls.update).toBe(1);
    expect(built.calls.commit).toBe(0);
    expect(built.calls.delete).toBe(1);
  });

  it("does not retry ambiguous commit and retains the operational session", async () => {
    const built = buildTool({
      commitError: Object.assign(new Error("commit timeout"), { status: 500 }),
    });
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "ROLLOUT_COMMIT_FAILED",
      externalStateUncertain: true,
    });
    expect(built.calls.commit).toBe(1);
    expect(built.calls.delete).toBe(0);
    await expect(built.store.load()).resolves.toMatchObject({ editId: "rollout-edit" });
  });

  it("does not create a deep verification edit when post-commit direct summary is absent", async () => {
    const built = buildTool({ summarySequence: [true, false] });
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "ROLLOUT_POST_COMMIT_NOT_OBSERVED",
      externalStateUncertain: true,
    });
    expect(built.calls.commit).toBe(1);
    expect(built.calls.create).toBe(1);
    expect(built.calls.delete).toBe(0);
  });

  it("fails deep verification on fraction mismatch and deletes verification edit once", async () => {
    const built = buildTool({
      postCommitTrack: currentTrack(targetRelease({ userFraction: 0.05 })),
    });
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "ROLLOUT_POST_COMMIT_MISMATCH",
      externalStateUncertain: true,
    });
    expect(built.calls.commit).toBe(1);
    expect(built.calls.create).toBe(2);
    expect(built.calls.delete).toBe(1);
  });

  it("marks verification cleanup failure uncertain without retry", async () => {
    const built = buildTool({ deleteError: new Error("delete failed") });
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "ROLLOUT_VERIFICATION_CLEANUP_FAILED",
      externalStateUncertain: true,
    });
    expect(built.calls.delete).toBe(2);
  });
});

describe("Phase 4.15 temporary-edit journal ordering", () => {
  it("journals the exact id returned by the insert and removes it after the delete", async () => {
    const built = buildTool();
    await built.tool.execute({}, {});
    // The rollout fake returns "verification-edit" for the second insert.
    const verificationId = "verification-edit";
    expect(built.events.filter((event) => event.startsWith("edits.insert:"))).toHaveLength(2);
    expect(built.journal.calls).toEqual([`record:${verificationId}`, `remove:${verificationId}`]);
    expect(built.journal.entries.size).toBe(0);
  });

  it("stops before the verification track read and deletes once when journaling fails", async () => {
    const journal = makeCleanupJournal({ recordError: new Error("PRIVATE-JOURNAL") });
    const built = buildTool({}, makeIntent(), journal);
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "ROLLOUT_JOURNAL_WRITE_FAILED",
      externalStateUncertain: false,
    });
    const verificationId = "verification-edit";
    expect(built.events.filter((event) => event.startsWith("edits.insert:"))).toHaveLength(2);
    expect(built.events).not.toContain(`edits.tracks.get:${verificationId}`);
    expect(built.events.filter((event) => event === `edits.delete:${verificationId}`)).toHaveLength(
      1,
    );
    expect(journal.entries.size).toBe(0);
  });

  it("fails safely when the journal record cannot be removed after a confirmed delete", async () => {
    const journal = makeCleanupJournal({ removeError: new Error("PRIVATE-REMOVE") });
    const built = buildTool({}, makeIntent(), journal);
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "ROLLOUT_JOURNAL_REMOVE_FAILED",
      externalStateUncertain: false,
    });
    expect(built.calls.delete).toBe(1);
  });
});

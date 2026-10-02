import { describe, expect, it, vi } from "vitest";
import type { NewAuditEntry } from "../src/audit/index.js";
import {
  createHaltRolloutIntent,
  createResumeRolloutIntent,
  createReleaseStatusControlApprovalBinding,
  type ReleaseStatusControlIntent,
} from "../src/releases/status-control-approval.js";
import {
  createReleaseStatusControlTool,
  HALT_ROLLOUT_TOOL_NAME,
  RESUME_ROLLOUT_TOOL_NAME,
} from "../src/releases/status-control-tool.js";
import type { ReleaseEditSession, ReleaseState, ReleaseTrackState } from "../src/releases/index.js";
import type { ReleaseEditSessionStore } from "../src/releases/session-store.js";
import type { ReleaseStatusControlGateway } from "../src/releases/gateway.js";

const packageName = "com.example.halt";
const targetTrack = "production";
const versionCode = "321";
const releaseName = "3.2.1";
const expiryTimeSeconds = "4102444800";
const fixedNow = new Date("2026-09-30T08:00:00.000Z");
const noteText = "PRIVATE-HALT-NOTE";

function targetRelease(overrides: Partial<ReleaseState> = {}): ReleaseState {
  return {
    name: releaseName,
    status: "inProgress",
    versionCodes: [versionCode],
    userFraction: 0.1,
    releaseNotes: [{ language: "en-US", text: noteText }],
    countryTargeting: { countries: ["US", "ID"], includeRestOfWorld: false },
    inAppUpdatePriority: 4,
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
        versionCodes: ["320"],
        releaseNotes: [{ language: "en-US", text: "Older" }],
        inAppUpdatePriority: 1,
      },
      release,
    ],
  };
}

function makeHaltIntent(state = currentTrack()): ReleaseStatusControlIntent {
  return createHaltRolloutIntent({
    packageName,
    targetTrack,
    versionCode,
    releaseName,
    currentTrackState: state,
  });
}

function makeResumeIntent(
  state = currentTrack(targetRelease({ status: "halted" })),
): ReleaseStatusControlIntent {
  return createResumeRolloutIntent({
    packageName,
    targetTrack,
    versionCode,
    releaseName,
    currentTrackState: state,
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

function rawTrackFromRequest(request: {
  track: string;
  releases: readonly ReleaseState[];
}): ReleaseTrackState {
  return {
    track: request.track,
    releases: request.releases.map((release) => ({
      ...(release.name !== undefined ? { name: release.name } : {}),
      versionCodes: [...release.versionCodes],
      status: release.status,
      ...(release.userFraction !== undefined ? { userFraction: release.userFraction } : {}),
      ...(release.releaseNotes !== undefined ? { releaseNotes: release.releaseNotes } : {}),
      ...(release.countryTargeting !== undefined
        ? { countryTargeting: release.countryTargeting }
        : {}),
      ...(release.inAppUpdatePriority !== undefined
        ? { inAppUpdatePriority: release.inAppUpdatePriority }
        : {}),
    })),
  };
}

function makeGateway(
  options: {
    readonly operationalTrack?: ReleaseTrackState;
    readonly postCommitTrack?: ReleaseTrackState;
    readonly updateError?: unknown;
    readonly commitError?: unknown;
    readonly deleteError?: unknown;
  } = {},
) {
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

  let editCount = 0;
  const gateway: ReleaseStatusControlGateway = {
    listReleaseSummaries: vi.fn(async () => {
      calls.summary += 1;
      events.push("applications.tracks.releases.list");
      return [
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
      editCount += 1;
      const editId = editCount === 1 ? "status-edit" : "verification-edit";
      events.push(`edits.insert:${editId}`);
      return { packageName, editId, expiryTimeSeconds };
    }),
    getEdit: vi.fn(async (session) => {
      calls.getEdit += 1;
      events.push(`edits.get:${session.editId}`);
      return { id: session.editId, expiryTimeSeconds };
    }),
    getTrack: vi.fn(async (session) => {
      calls.getTrack += 1;
      events.push(`edits.tracks.get:${session.editId}`);
      if (session.editId === "verification-edit")
        return options.postCommitTrack ?? operationalTrack;
      return operationalTrack;
    }),
    updateTrack: vi.fn(async (_session, _track, request) => {
      calls.update += 1;
      events.push("edits.tracks.update");
      requests.push(request);
      if (options.updateError !== undefined) throw options.updateError;
      operationalTrack = rawTrackFromRequest(request as never);
      return operationalTrack;
    }),
    validateEdit: vi.fn(async (session) => {
      calls.validate += 1;
      events.push("edits.validate");
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
  intent: ReleaseStatusControlIntent,
  options: Parameters<typeof makeGateway>[0] = {},
  journal: ReturnType<typeof makeCleanupJournal> = makeCleanupJournal(),
) {
  const fake = makeGateway({ operationalTrack: intent.expectedTrackState, ...options });
  const store = makeStore();
  const audit = makeAudit();
  const built = createReleaseStatusControlTool({
    packageName,
    intent,
    gateway: fake.gateway,
    sessionStore: store,
    cleanupJournal: journal,
    auditLedger: audit,
    now: () => fixedNow,
  });
  return { ...fake, ...built, intent, store, audit, journal };
}

describe("Phase 4.13 status-control intents and approval", () => {
  it("creates separate HALT and RESUME capabilities with destructive permission", () => {
    const halt = buildTool(
      makeHaltIntent(currentTrack(targetRelease({ countryTargeting: undefined }))),
    );
    const resume = buildTool(makeResumeIntent());
    expect(halt.tool.name).toBe(HALT_ROLLOUT_TOOL_NAME);
    expect(resume.tool.name).toBe(RESUME_ROLLOUT_TOOL_NAME);
    expect(halt.tool.permission).toBe("destructive");
    expect(resume.tool.permission).toBe("destructive");
    expect(() => halt.tool.inputSchema.parse({ operation: "halt" })).toThrowError();
    expect(() => resume.tool.inputSchema.parse({ fraction: 0.2 })).toThrowError();
    expect(halt.intent.requestDigest).not.toBe(resume.intent.requestDigest);
  });

  it("binds exact current/desired status and keeps the fraction unchanged", () => {
    const halt = makeHaltIntent(currentTrack(targetRelease({ countryTargeting: undefined })));
    const resume = makeResumeIntent();
    expect(halt.expectedCurrentStatus).toBe("inProgress");
    expect(halt.desiredStatus).toBe("halted");
    expect(resume.expectedCurrentStatus).toBe("halted");
    expect(resume.desiredStatus).toBe("inProgress");
    expect(halt.expectedUserFraction).toBe(0.1);
    expect(resume.expectedUserFraction).toBe(0.1);
    const haltSummary = createReleaseStatusControlApprovalBinding(halt).createSafeSummary({});
    const resumeSummary = createReleaseStatusControlApprovalBinding(resume).createSafeSummary({});
    expect(haltSummary).toContain("inProgress");
    expect(haltSummary).toContain("halted");
    expect(haltSummary).toContain("new users");
    expect(haltSummary).toContain("already have");
    expect(resumeSummary).toContain("halted");
    expect(resumeSummary).toContain("inProgress");
    expect(resumeSummary).toContain("same fraction");
    expect(haltSummary).not.toContain(noteText);
    expect(resumeSummary).not.toContain("status-edit");
  });

  it("rejects wrong current status and invalid/missing fractions at intent construction", () => {
    expect(() => makeHaltIntent(currentTrack(targetRelease({ status: "halted" })))).toThrowError();
    expect(() =>
      makeResumeIntent(currentTrack(targetRelease({ status: "inProgress" }))),
    ).toThrowError();
    expect(() =>
      makeHaltIntent(currentTrack(targetRelease({ userFraction: undefined }))),
    ).toThrowError();
    expect(() =>
      makeResumeIntent(currentTrack(targetRelease({ status: "halted", userFraction: undefined }))),
    ).toThrowError();
    expect(() => makeHaltIntent(currentTrack(targetRelease({ userFraction: 0 })))).toThrowError();
    expect(() =>
      makeResumeIntent(currentTrack(targetRelease({ status: "halted", userFraction: 1 }))),
    ).toThrowError();
  });

  it("fails closed when HALT would send country targeting with halted status", () => {
    expect(() => makeHaltIntent()).toThrowError(/country|round/i);
  });

  it("allows RESUME with country targeting because desired status is inProgress", () => {
    expect(makeResumeIntent().desiredStatus).toBe("inProgress");
  });
});

describe("Phase 4.13 status-control tool", () => {
  it("halts an inProgress release without changing its fraction or other fields", async () => {
    const intent = makeHaltIntent(currentTrack(targetRelease({ countryTargeting: undefined })));
    const built = buildTool(intent);
    const result = await built.tool.execute({}, {});
    expect(result).toEqual({
      targetTrack,
      versionCode,
      releaseName,
      previousStatus: "inProgress",
      status: "halted",
      userFraction: 0.1,
      committed: true,
      liveRolloutStateVerified: true,
      servingPropagationVerified: false,
    });
    const request = built.requests[0] as { releases: readonly ReleaseState[] };
    expect(request.releases[1]).toMatchObject({
      name: releaseName,
      versionCodes: [versionCode],
      status: "halted",
      userFraction: 0.1,
      releaseNotes: [{ language: "en-US", text: noteText }],
      inAppUpdatePriority: 4,
    });
    expect(request.releases[0]).toMatchObject({ name: "Older release", status: "completed" });
    expect(built.events).toEqual([
      "applications.tracks.releases.list",
      "edits.insert:status-edit",
      "edits.get:status-edit",
      "edits.tracks.get:status-edit",
      "edits.tracks.update",
      "edits.tracks.get:status-edit",
      "edits.validate",
      "edits.commit",
      "applications.tracks.releases.list",
      "edits.insert:verification-edit",
      "edits.tracks.get:verification-edit",
      "edits.delete:verification-edit",
    ]);
    expect(built.calls).toMatchObject({
      summary: 2,
      create: 2,
      update: 1,
      validate: 1,
      commit: 1,
      delete: 1,
    });
    await expect(built.store.load()).resolves.toBeUndefined();
    expect(JSON.stringify(built.audit.entries)).not.toContain(noteText);
  });

  it("resumes a halted release without changing its fraction", async () => {
    const intent = makeResumeIntent();
    const built = buildTool(intent);
    const result = await built.tool.execute({}, {});
    expect(result).toMatchObject({
      previousStatus: "halted",
      status: "inProgress",
      userFraction: 0.1,
      committed: true,
      liveRolloutStateVerified: true,
      servingPropagationVerified: false,
    });
    const request = built.requests[0] as { releases: readonly ReleaseState[] };
    expect(request.releases[1]).toMatchObject({ status: "inProgress", userFraction: 0.1 });
  });

  it("blocks stale fraction before update and cleans the operational edit", async () => {
    const intent = makeHaltIntent(currentTrack(targetRelease({ countryTargeting: undefined })));
    const built = buildTool(intent, {
      operationalTrack: currentTrack(
        targetRelease({ userFraction: 0.15, countryTargeting: undefined }),
      ),
    });
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "ROLLOUT_STATE_CHANGED",
    });
    expect(built.calls.update).toBe(0);
    expect(built.calls.commit).toBe(0);
    expect(built.calls.delete).toBe(1);
  });

  it("blocks wrong fresh status without update or commit", async () => {
    const halt = buildTool(
      makeHaltIntent(currentTrack(targetRelease({ countryTargeting: undefined }))),
      {
        operationalTrack: currentTrack(
          targetRelease({ status: "halted", countryTargeting: undefined }),
        ),
      },
    );
    await expect(halt.tool.execute({}, {})).rejects.toMatchObject({
      code: "ROLLOUT_STATUS_NOT_ELIGIBLE",
    });
    expect(halt.calls.update).toBe(0);
    expect(halt.calls.commit).toBe(0);
    const resume = buildTool(makeResumeIntent(), {
      operationalTrack: currentTrack(
        targetRelease({ status: "inProgress", countryTargeting: undefined }),
      ),
    });
    await expect(resume.tool.execute({}, {})).rejects.toMatchObject({
      code: "ROLLOUT_STATUS_NOT_ELIGIBLE",
    });
    expect(resume.calls.update).toBe(0);
    expect(resume.calls.commit).toBe(0);
  });

  it("blocks an active managed edit before operational insert", async () => {
    const built = buildTool(
      makeHaltIntent(currentTrack(targetRelease({ countryTargeting: undefined }))),
    );
    await built.store.save({
      version: 1,
      packageName,
      editId: "already-open",
      expiryTimeSeconds,
      createdAt: fixedNow.toISOString(),
    });
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "MANAGED_EDIT_ALREADY_OPEN",
    });
    expect(built.calls.create).toBe(0);
  });

  it("does not retry an ambiguous update", async () => {
    const built = buildTool(
      makeHaltIntent(currentTrack(targetRelease({ countryTargeting: undefined }))),
      {
        updateError: Object.assign(new Error("update timeout"), { status: 500 }),
      },
    );
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "STATUS_CONTROL_UPDATE_FAILED",
      externalStateUncertain: true,
    });
    expect(built.calls.update).toBe(1);
    expect(built.calls.commit).toBe(0);
    expect(built.calls.delete).toBe(1);
  });

  it("does not retry an ambiguous commit and skips post-commit verification", async () => {
    const built = buildTool(
      makeHaltIntent(currentTrack(targetRelease({ countryTargeting: undefined }))),
      {
        commitError: Object.assign(new Error("commit timeout"), { status: 500 }),
      },
    );
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "STATUS_CONTROL_COMMIT_FAILED",
      externalStateUncertain: true,
    });
    expect(built.calls.commit).toBe(1);
    expect(built.calls.create).toBe(1);
    expect(built.calls.delete).toBe(0);
    await expect(built.store.load()).resolves.toMatchObject({ editId: "status-edit" });
  });

  it("fails safely when verification cleanup fails", async () => {
    const built = buildTool(makeResumeIntent(), { deleteError: new Error("delete failed") });
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "STATUS_CONTROL_VERIFICATION_CLEANUP_FAILED",
      externalStateUncertain: true,
    });
    expect(built.calls.delete).toBe(1);
  });
});

describe("Phase 4.15 temporary-edit journal ordering", () => {
  function insertedIds(events: readonly string[]): string[] {
    return events
      .filter((event) => event.startsWith("edits.insert:"))
      .map((event) => event.slice("edits.insert:".length));
  }

  it("journals the exact id returned by the insert and removes it after the delete", async () => {
    const built = buildTool(makeResumeIntent());
    await built.tool.execute({}, {});
    const verificationId = insertedIds(built.events).at(-1);
    expect(verificationId).toBeDefined();
    expect(built.journal.calls).toEqual([`record:${verificationId}`, `remove:${verificationId}`]);
    expect(built.journal.entries.size).toBe(0);
  });

  it("stops before the verification track read and deletes once when journaling fails", async () => {
    const journal = makeCleanupJournal({ recordError: new Error("PRIVATE-JOURNAL") });
    const built = buildTool(makeResumeIntent(), {}, journal);
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "STATUS_CONTROL_JOURNAL_WRITE_FAILED",
      externalStateUncertain: false,
    });
    const verificationId = insertedIds(built.events).at(-1);
    expect(verificationId).toBeDefined();
    expect(built.events).not.toContain(`edits.tracks.get:${verificationId}`);
    expect(built.events.filter((event) => event === `edits.delete:${verificationId}`)).toHaveLength(
      1,
    );
    expect(journal.entries.size).toBe(0);
  });

  it("fails safely when the journal record cannot be removed after a confirmed delete", async () => {
    const journal = makeCleanupJournal({ removeError: new Error("PRIVATE-REMOVE") });
    const built = buildTool(makeResumeIntent(), {}, journal);
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "STATUS_CONTROL_JOURNAL_REMOVE_FAILED",
      externalStateUncertain: false,
    });
    expect(built.calls.delete).toBe(1);
  });
});

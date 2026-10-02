import { describe, expect, it, vi } from "vitest";
import {
  createReleaseCommitIntent,
  type ReleaseCommitIntent,
} from "../src/releases/commit-approval.js";
import {
  createReleaseSummaryInspectionTool,
  RELEASES_INSPECT_COMMITTED_RELEASE_TOOL_NAME,
} from "../src/releases/inspect-committed-release-tool.js";
import {
  createReleaseVerificationIntent,
  type ReleaseVerificationIntent,
} from "../src/releases/readback-approval.js";
import {
  createReleaseExactVerificationTool,
  RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME,
} from "../src/releases/verify-committed-release-tool.js";
import type {
  ReleaseEditSession,
  ReleaseState,
  ReleaseSummaryState,
  ReleaseTrackState,
} from "../src/releases/index.js";
import type { ReleaseEditSessionStore } from "../src/releases/session-store.js";
import type {
  ReleaseSummaryGateway,
  ReleaseTemporaryEditVerificationGateway,
} from "../src/releases/gateway.js";
import type { NewAuditEntry } from "../src/audit/index.js";

const packageName = "com.example.release";
const targetTrack = "wear:production";
const versionCode = "101";
const releaseName = "Candidate 101";
const noteText = "PRIVATE-NOTE-TEXT-PHASE411";
const fixedNow = new Date("2026-09-30T05:00:00.000Z");
const expiryTimeSeconds = "4102444800";

function targetRelease(overrides: Partial<ReleaseState> = {}): ReleaseState {
  return {
    name: releaseName,
    status: "inProgress",
    versionCodes: [versionCode],
    userFraction: 0.05,
    releaseNotes: [
      { language: "en-US", text: noteText },
      { language: "id", text: "Perbaikan stabilitas." },
    ],
    ...overrides,
  };
}

function targetTrackState(release: ReleaseState = targetRelease()): ReleaseTrackState {
  return { track: targetTrack, releases: [release] };
}

function makeCommitIntent(state = targetTrackState()): ReleaseCommitIntent {
  return createReleaseCommitIntent({
    packageName,
    editId: "managed-edit-411",
    targetTrack,
    versionCode,
    targetTrackState: state,
    validatedEdit: { valid: true, expiryTimeSeconds: expiryTimeSeconds },
  });
}

function makeVerificationIntent(state = targetTrackState()): ReleaseVerificationIntent {
  return createReleaseVerificationIntent(makeCommitIntent(state));
}

function makeSummary(overrides: Partial<ReleaseSummaryState> = {}): ReleaseSummaryState {
  return {
    releaseName,
    track: targetTrack,
    versionCodes: [versionCode],
    releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
    ...overrides,
  };
}

function makeSession(): ReleaseEditSession {
  return {
    version: 1,
    packageName,
    editId: "managed-edit-411",
    expiryTimeSeconds,
    createdAt: "2026-09-30T00:00:00.000Z",
  };
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

function makeGateways(
  options: {
    readonly summaries?: readonly ReleaseSummaryState[];
    readonly track?: ReleaseTrackState;
    readonly createError?: unknown;
    readonly trackError?: unknown;
    readonly deleteError?: unknown;
  } = {},
) {
  const calls = { summaries: 0, create: 0, getTrack: 0, delete: 0 };
  const summaryGateway: ReleaseSummaryGateway = {
    listReleaseSummaries: vi.fn(async (track) => {
      calls.summaries += 1;
      expect(track).toBe(targetTrack);
      if (options.summaries !== undefined) return options.summaries;
      return [makeSummary()];
    }),
  };
  const temporaryEditGateway: ReleaseTemporaryEditVerificationGateway = {
    createEdit: vi.fn(async () => {
      calls.create += 1;
      if (options.createError !== undefined) throw options.createError;
      return { packageName, editId: "temporary-readback-edit", expiryTimeSeconds };
    }),
    getTrack: vi.fn(async (session, track) => {
      calls.getTrack += 1;
      expect(session.editId).toBe("temporary-readback-edit");
      expect(track).toBe(targetTrack);
      if (options.trackError !== undefined) throw options.trackError;
      return options.track ?? targetTrackState();
    }),
    deleteEdit: vi.fn(async (session) => {
      calls.delete += 1;
      expect(session.editId).toBe("temporary-readback-edit");
      if (options.deleteError !== undefined) throw options.deleteError;
    }),
  };
  return { calls, summaryGateway, temporaryEditGateway };
}

/** In-memory Phase 4.15 cleanup journal double; records call ordering explicitly. */
function makeJournal(
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

function buildLayerB(
  options: {
    readonly intent?: ReleaseVerificationIntent;
    readonly summaries?: readonly ReleaseSummaryState[];
    readonly track?: ReleaseTrackState;
    readonly createError?: unknown;
    readonly trackError?: unknown;
    readonly deleteError?: unknown;
    readonly activeSession?: ReleaseEditSession;
    readonly journal?: ReturnType<typeof makeJournal>;
  } = {},
) {
  const gateways = makeGateways(options);
  const audit = makeAudit();
  const journal = options.journal ?? makeJournal();
  const tool = createReleaseExactVerificationTool({
    packageName,
    intent: options.intent ?? makeVerificationIntent(),
    summaryGateway: gateways.summaryGateway,
    temporaryEditGateway: gateways.temporaryEditGateway,
    sessionStore: makeStore(options.activeSession),
    cleanupJournal: journal,
    auditLedger: audit,
    now: () => fixedNow,
  });
  return { ...tool, ...gateways, audit, journal };
}

describe("Phase 4.11 Layer A direct summary", () => {
  it("is read-only, has no approval, preserves custom track, and records coarse lifecycle evidence", async () => {
    const audit = makeAudit();
    const gateways = makeGateways();
    const tool = createReleaseSummaryInspectionTool({
      packageName,
      intent: makeVerificationIntent(),
      gateway: gateways.summaryGateway,
      auditLedger: audit,
      now: () => fixedNow,
    });
    expect(tool.tool.name).toBe(RELEASES_INSPECT_COMMITTED_RELEASE_TOOL_NAME);
    expect(tool.tool.permission).toBe("read");
    expect(tool.binding.approval).toBeUndefined();
    await expect(tool.tool.execute({}, {})).resolves.toEqual({
      targetTrack,
      versionCode,
      releaseName,
      releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
      releaseObserved: true,
      exactTrackStateVerified: false,
    });
    expect(gateways.calls).toEqual({ summaries: 1, create: 0, getTrack: 0, delete: 0 });
    expect(JSON.stringify(audit.entries)).not.toContain(noteText);
  });

  it.each([
    ["zero match", [] as readonly ReleaseSummaryState[], "COMMITTED_RELEASE_NOT_OBSERVED"],
    [
      "duplicate match",
      [makeSummary(), makeSummary({ releaseName: "Duplicate" })],
      "COMMITTED_RELEASE_AMBIGUOUS",
    ],
    ["wrong track", [makeSummary({ track: "production" })], "COMMITTED_RELEASE_NOT_OBSERVED"],
    [
      "wrong release name",
      [makeSummary({ releaseName: "Other" })],
      "COMMITTED_RELEASE_NOT_OBSERVED",
    ],
  ])("rejects %s without inventing identity", async (_label, summaries, code) => {
    const audit = makeAudit();
    const gateways = makeGateways({ summaries });
    const tool = createReleaseSummaryInspectionTool({
      packageName,
      intent: makeVerificationIntent(),
      gateway: gateways.summaryGateway,
      auditLedger: audit,
      now: () => fixedNow,
    });
    await expect(tool.tool.execute({}, {})).rejects.toMatchObject({ code });
  });
});

describe("Phase 4.11 Layer B exact Track verification", () => {
  it("is destructive, requires separate approval, and warns about edit invalidation without note text", () => {
    const built = buildLayerB();
    expect(built.tool.name).toBe(RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME);
    expect(built.tool.permission).toBe("destructive");
    const summary = built.binding.approval?.createSafeSummary({}) ?? "";
    expect(summary).toContain("temporary Google Play edit");
    expect(summary).toContain("invalidate another active edit");
    expect(summary).toContain("No release mutation or edits.commit");
    expect(summary).not.toContain(noteText);
  });

  it("short-circuits before insert when Layer A has not observed the release", async () => {
    const built = buildLayerB({ summaries: [] });
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "COMMITTED_RELEASE_NOT_OBSERVED",
    });
    expect(built.calls).toEqual({ summaries: 1, create: 0, getTrack: 0, delete: 0 });
  });

  it("refuses a locally managed edit after Layer A and does not insert", async () => {
    const built = buildLayerB({ activeSession: makeSession() });
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "MANAGED_EDIT_ALREADY_OPEN",
    });
    expect(built.calls).toEqual({ summaries: 1, create: 0, getTrack: 0, delete: 0 });
  });

  it("verifies exact in-progress fraction and deletes the temporary edit once", async () => {
    const built = buildLayerB();
    const result = await built.tool.execute({}, {});
    expect(result).toMatchObject({
      targetTrack,
      versionCode,
      releaseName,
      status: "inProgress",
      userFraction: 0.05,
      releaseObserved: true,
      exactTrackStateVerified: true,
      liveReleaseVerified: true,
      servingPropagationVerified: false,
      temporaryEditCleanupSucceeded: true,
    });
    expect(built.calls).toEqual({ summaries: 1, create: 1, getTrack: 1, delete: 1 });
    expect(JSON.stringify(built.audit.entries)).not.toContain(noteText);
    expect(JSON.stringify(built.audit.entries)).not.toContain("temporary-readback-edit");
  });

  it("journals the temporary edit id after the insert and before any track read", async () => {
    const built = buildLayerB();
    await built.tool.execute({}, {});
    expect(built.journal.calls).toEqual([
      "record:temporary-readback-edit",
      "remove:temporary-readback-edit",
    ]);
    expect(built.journal.entries.size).toBe(0);
  });

  it("stops before the track read and deletes once when the journal cannot be written", async () => {
    const journal = makeJournal({ recordError: new Error("PRIVATE-JOURNAL-FAILURE") });
    const built = buildLayerB({ journal });
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "VERIFICATION_JOURNAL_WRITE_FAILED",
      externalStateUncertain: false,
    });
    expect(built.calls).toEqual({ summaries: 1, create: 1, getTrack: 0, delete: 1 });
    expect(built.journal.entries.size).toBe(0);
  });

  it("stays uncertain when the journal write fails and the delete also fails", async () => {
    const journal = makeJournal({ recordError: new Error("PRIVATE-JOURNAL-FAILURE") });
    const built = buildLayerB({ journal, deleteError: new Error("PRIVATE-DELETE") });
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "VERIFICATION_JOURNAL_WRITE_FAILED",
      externalStateUncertain: true,
    });
    expect(built.calls.getTrack).toBe(0);
    expect(built.calls.delete).toBe(1);
  });

  it("keeps the exact journal record when the temporary edit cannot be deleted", async () => {
    const built = buildLayerB({ deleteError: new Error("PRIVATE-DELETE") });
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "VERIFICATION_EDIT_CLEANUP_FAILED",
    });
    expect(built.journal.entries.has("temporary-readback-edit")).toBe(true);
  });

  it("fails safely when the journal record cannot be removed after a confirmed delete", async () => {
    const journal = makeJournal({ removeError: new Error("PRIVATE-REMOVE") });
    const built = buildLayerB({ journal });
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "VERIFICATION_JOURNAL_REMOVE_FAILED",
      externalStateUncertain: false,
    });
    expect(built.calls).toEqual({ summaries: 1, create: 1, getTrack: 1, delete: 1 });
  });

  it("records nothing before a trustworthy insert response", async () => {
    const journal = makeJournal();
    const built = buildLayerB({ createError: new Error("PRIVATE-INSERT"), journal });
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "VERIFICATION_EDIT_CREATE_FAILED",
    });
    expect(journal.calls).toEqual([]);
    expect(journal.entries.size).toBe(0);
  });

  it.each([
    ["completed without fraction", targetRelease({ status: "completed", userFraction: undefined })],
    ["draft without fraction", targetRelease({ status: "draft", userFraction: undefined })],
  ])("supports exact %s semantics", async (_label, release) => {
    const intent = makeVerificationIntent(targetTrackState(release));
    const built = buildLayerB({
      intent,
      track: targetTrackState(release),
    });
    const result = await built.tool.execute({}, {});
    expect(result).toMatchObject({
      status: release.status,
      liveReleaseVerified: true,
    });
    expect("userFraction" in result).toBe(false);
    expect(built.calls.delete).toBe(1);
  });

  it.each([
    [
      "wrong status",
      targetRelease({ status: "completed", userFraction: undefined }),
      targetRelease(),
    ],
    ["wrong fraction", targetRelease({ userFraction: 0.1 }), targetRelease()],
    ["wrong release name", targetRelease({ name: "Other" }), targetRelease()],
    [
      "wrong notes",
      targetRelease({
        releaseNotes: [
          { language: "en-US", text: "different" },
          { language: "id", text: "Perbaikan stabilitas." },
        ],
      }),
      targetRelease(),
    ],
  ])("blocks %s and still deletes once", async (_label, actualRelease, expectedRelease) => {
    const expectedIntent = makeVerificationIntent(targetTrackState(expectedRelease));
    const built = buildLayerB({
      intent: expectedIntent,
      track: targetTrackState(actualRelease),
    });
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "VERIFICATION_STATE_MISMATCH",
    });
    expect(built.calls).toEqual({ summaries: 1, create: 1, getTrack: 1, delete: 1 });
  });

  it("marks cleanup failure uncertain and never retries delete", async () => {
    const built = buildLayerB({ deleteError: new Error("delete unavailable") });
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "VERIFICATION_EDIT_CLEANUP_FAILED",
      externalStateUncertain: true,
    });
    expect(built.calls.delete).toBe(1);
  });

  it("deletes once after a deterministic temporary-track read failure", async () => {
    const built = buildLayerB({ trackError: new Error("temporary track read failed") });
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "VERIFICATION_TRACK_READ_FAILED",
      externalStateUncertain: false,
    });
    expect(built.calls).toEqual({ summaries: 1, create: 1, getTrack: 1, delete: 1 });
  });

  it("does not retry an ambiguous insert and cannot guess a delete id", async () => {
    const built = buildLayerB({ createError: new Error("transport timeout") });
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "VERIFICATION_EDIT_CREATE_FAILED",
      externalStateUncertain: true,
    });
    expect(built.calls).toEqual({ summaries: 1, create: 1, getTrack: 0, delete: 0 });
  });

  it("verifier only checks captured output and performs no second temporary edit", async () => {
    const built = buildLayerB();
    const result = await built.tool.execute({}, {});
    const before = { ...built.calls };
    await expect(built.tool.verify?.({}, result, {})).resolves.toBe(true);
    expect(built.calls).toEqual(before);
  });
});

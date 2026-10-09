import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createReleaseCommitIntent,
  createReleaseCommitStateDigest,
  type ReleaseCommitIntent,
} from "../src/releases/commit-approval.js";
import { createFileReleaseCommitAttemptJournal } from "../src/releases/commit-attempt-journal.js";
import {
  createReleaseSummaryInspectionTool,
  RELEASES_INSPECT_COMMITTED_RELEASE_TOOL_NAME,
} from "../src/releases/inspect-committed-release-tool.js";
import {
  createReleaseStateVerificationApprovalBinding,
  createReleaseStateVerificationIntent,
  createReleaseStateVerificationRequestDigest,
  createReleaseVerificationIntent,
  RELEASE_STATE_VERIFICATION_INTENT_VERSION,
  RELEASE_STATE_VERIFICATION_OPERATION_KIND,
  type ReleaseStateVerificationIntent,
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

/** Stage 3E.1 Layer-B intent: durable identity plus the commit-state digest. */
function makeStateVerificationIntent(
  state = targetTrackState(),
  expectedReleaseName = releaseName,
): ReleaseStateVerificationIntent {
  return createReleaseStateVerificationIntent({
    packageName,
    targetTrack,
    versionCode,
    expectedReleaseName,
    expectedStateDigest: createReleaseCommitStateDigest(state),
  });
}

function unrelatedRelease(overrides: Partial<ReleaseState> = {}): ReleaseState {
  return {
    name: "Older 99",
    status: "completed",
    versionCodes: ["99"],
    releaseNotes: [],
    ...overrides,
  };
}

function twoReleaseTrack(order: readonly ReleaseState[]): ReleaseTrackState {
  return { track: targetTrack, releases: [...order] };
}

/**
 * The retired Phase 4.11 approval preimage for this same app/track/version,
 * reproduced here so the domain-separation proof is independent of the new code.
 */
function legacyPhase411Digest(): string {
  const preimage = {
    expectedReleaseName: releaseName,
    expectedReleaseNotes: [
      { language: "en-US", text: noteText },
      { language: "id", text: "Perbaikan stabilitas." },
    ],
    expectedStatus: "inProgress",
    expectedUserFraction: 0.05,
    operationKind: "exact_track_state_readback",
    packageName,
    targetTrack,
    version: 1,
    versionCode,
  };
  const stable = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(",")}}`;
  };
  return createHash("sha256").update(stable(preimage), "utf8").digest("hex");
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
    readonly intent?: ReleaseStateVerificationIntent;
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
  const intent = options.intent ?? makeStateVerificationIntent();
  const tool = createReleaseExactVerificationTool({
    packageName,
    intent,
    summaryGateway: gateways.summaryGateway,
    temporaryEditGateway: gateways.temporaryEditGateway,
    sessionStore: makeStore(options.activeSession),
    cleanupJournal: journal,
    auditLedger: audit,
    now: () => fixedNow,
  });
  return { ...tool, ...gateways, audit, journal, intent };
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
    expect(summary).toContain(
      `Expected committed-state digest: ${built.intent.expectedStateDigest}`,
    );
    expect(summary).toContain("no release-note or rollout-fraction comparison");
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

  it("verifies the durable commit-state digest and deletes the temporary edit once", async () => {
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
      verificationCleanupVerified: true,
    });
    expect(result.observedStateDigest).toBe(built.intent.expectedStateDigest);
    expect(result.observedStateDigest).toBe(createReleaseCommitStateDigest(targetTrackState()));
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
    const state = targetTrackState(release);
    const intent = makeStateVerificationIntent(state);
    const built = buildLayerB({ intent, track: state });
    const result = await built.tool.execute({}, {});
    expect(result).toMatchObject({
      status: release.status,
      liveReleaseVerified: true,
    });
    expect("userFraction" in result).toBe(false);
    expect(built.calls.delete).toBe(1);
  });

  /**
   * Stage 3E.1 documents the deliberate move from selected-release field equality
   * to full commit-state equality: every field of the canonical commit-state
   * domain now participates in the decisive proof.
   */
  it.each([
    [
      "changed release notes",
      targetTrackState(
        targetRelease({
          releaseNotes: [
            { language: "en-US", text: "different" },
            { language: "id", text: "Perbaikan stabilitas." },
          ],
        }),
      ),
      targetTrackState(),
    ],
    [
      "changed rollout fraction",
      targetTrackState(targetRelease({ userFraction: 0.1 })),
      targetTrackState(),
    ],
    [
      "changed release name",
      targetTrackState(targetRelease({ name: "Other" })),
      targetTrackState(),
    ],
    [
      "changed status",
      targetTrackState(targetRelease({ status: "completed", userFraction: undefined })),
      targetTrackState(),
    ],
    [
      "changed version codes",
      targetTrackState(targetRelease({ versionCodes: [versionCode, "102"] })),
      targetTrackState(),
    ],
    [
      "changed country targeting",
      targetTrackState(
        targetRelease({ countryTargeting: { countries: ["ID"], includeRestOfWorld: true } }),
      ),
      targetTrackState(),
    ],
    [
      "changed update priority",
      targetTrackState(targetRelease({ inAppUpdatePriority: 3 })),
      targetTrackState(),
    ],
    [
      "an unrelated release changed",
      twoReleaseTrack([targetRelease(), unrelatedRelease({ name: "Older 98" })]),
      twoReleaseTrack([targetRelease(), unrelatedRelease()]),
    ],
  ])("blocks %s and still deletes once", async (_label, actualState, expectedState) => {
    const built = buildLayerB({
      intent: makeStateVerificationIntent(expectedState),
      track: actualState,
    });
    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "VERIFICATION_STATE_MISMATCH",
      externalStateUncertain: false,
    });
    expect(built.calls).toEqual({ summaries: 1, create: 1, getTrack: 1, delete: 1 });
  });

  it("still matches release-array reordering that is equivalent under the commit-state digest", async () => {
    const expectedState = twoReleaseTrack([targetRelease(), unrelatedRelease()]);
    const actualState = twoReleaseTrack([unrelatedRelease(), targetRelease()]);
    expect(createReleaseCommitStateDigest(expectedState)).toBe(
      createReleaseCommitStateDigest(actualState),
    );
    const built = buildLayerB({
      intent: makeStateVerificationIntent(expectedState),
      track: actualState,
    });
    const result = await built.tool.execute({}, {});
    expect(result.exactTrackStateVerified).toBe(true);
    expect(result.observedStateDigest).toBe(built.intent.expectedStateDigest);
    expect(built.calls).toEqual({ summaries: 1, create: 1, getTrack: 1, delete: 1 });
  });

  it("fails closed with a definite mismatch when the observed track cannot be canonicalized", async () => {
    const uncanonicalizable = {
      track: targetTrack,
      releases: [
        {
          name: releaseName,
          status: "bogus-status",
          versionCodes: ["not-a-version-code"],
        },
      ],
    } as unknown as ReleaseTrackState;
    const built = buildLayerB({ track: uncanonicalizable });
    const failure = (await built.tool.execute({}, {}).then(
      () => undefined,
      (cause: unknown) => cause as { code?: string; cause?: unknown },
    )) as { code?: string; cause?: unknown } | undefined;
    expect(failure?.code).toBe("VERIFICATION_STATE_MISMATCH");
    // Only the canonicalization branch carries a cause; a plain mismatch does not.
    expect(failure?.cause).toBeDefined();
    expect(built.calls).toEqual({ summaries: 1, create: 1, getTrack: 1, delete: 1 });
    expect(built.journal.entries.size).toBe(0);
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
    expect(result.observedStateDigest).toBe(built.intent.expectedStateDigest);
    expect(built.calls).toEqual(before);
  });
});

describe("Stage 3E.1 durable commit-state digest domain", () => {
  it("uses createReleaseCommitStateDigest for the commit intent and the verification expectation", () => {
    const state = targetTrackState();
    const commit = makeCommitIntent(state);
    expect(commit.stateDigest).toBe(createReleaseCommitStateDigest(state));
    const intent = makeStateVerificationIntent(state);
    expect(intent.expectedStateDigest).toBe(commit.stateDigest);
    expect(intent.version).toBe(RELEASE_STATE_VERIFICATION_INTENT_VERSION);
    expect(intent.operationKind).toBe(RELEASE_STATE_VERIFICATION_OPERATION_KIND);
    expect(intent.expectedStateDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects evidence without a durable digest or a release identity", () => {
    const digest = createReleaseCommitStateDigest(targetTrackState());
    const base = { packageName, targetTrack, versionCode, expectedReleaseName: releaseName };
    for (const bad of [
      { ...base, expectedStateDigest: "short" },
      { ...base, expectedStateDigest: "A".repeat(64) },
      { ...base, expectedReleaseName: "   ", expectedStateDigest: digest },
    ]) {
      expect(() => createReleaseStateVerificationIntent(bad)).toThrowError(
        expect.objectContaining({ code: "INVALID_COMMIT_INTENT" }),
      );
    }
  });

  it("emits the observed digest as journal-ready evidence without conversion", async () => {
    const built = buildLayerB();
    const result = await built.tool.execute({}, {});
    expect(result.observedStateDigest).toBe(built.intent.expectedStateDigest);
    expect(result.verificationCleanupVerified).toBe(true);
    const serialized = JSON.parse(
      built.binding.serializeResult(result, {
        toolName: RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME,
        permission: "destructive",
        required: true,
        code: "VERIFIED",
        verified: true,
      } as never),
    ) as Record<string, unknown>;
    expect(serialized.observedStateDigest).toBe(result.observedStateDigest);
    expect(serialized.verificationCleanupVerified).toBe(true);
  });
});

describe("Stage 3E.1 verification approval domain", () => {
  it("binds the durable commit-state digest and never the retired field-comparison preimage", () => {
    const intent = makeStateVerificationIntent();
    const approval = createReleaseStateVerificationApprovalBinding(intent);
    expect(approval.permission).toBe("destructive");
    const digest = approval.createRequestDigest({});
    expect(digest).toBe(createReleaseStateVerificationRequestDigest(intent));
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    const legacy = legacyPhase411Digest();
    expect(legacy).toMatch(/^[0-9a-f]{64}$/u);
    expect(legacy).not.toBe(digest);
  });

  it("keeps the production tool name and the destructive permission", () => {
    const built = buildLayerB();
    expect(built.tool.name).toBe(RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME);
    expect(built.tool.permission).toBe("destructive");
    expect(built.binding.approval?.createRequestDigest({})).toBe(
      createReleaseStateVerificationRequestDigest(built.intent),
    );
  });

  it("removes the retired Phase 4.11 approval constructors from the module", async () => {
    const module = await import("../src/releases/readback-approval.js");
    expect("createReleaseVerificationApprovalBinding" in module).toBe(false);
    expect("createReleaseVerificationRequestDigest" in module).toBe(false);
  });
});

describe("Stage 3E.1 reconciliation compatibility (real journal)", () => {
  it("accepts the observed digest as verificationObservedStateDigest and permits REMOTE_VERIFIED", async () => {
    const dir = mkdtempSync(join(tmpdir(), "playops-3e1-journal-"));
    try {
      const journal = createFileReleaseCommitAttemptJournal(join(dir, "commit-attempt.json"), {
        expectedPackageName: packageName,
      });
      const built = buildLayerB();
      const result = await built.tool.execute({}, {});
      const digest = result.observedStateDigest;
      const now = fixedNow.toISOString();
      const attempt = await journal.prepare({
        version: 1,
        packageName,
        editId: "managed-edit-411",
        expiryTimeSeconds,
        targetTrack,
        versionCode,
        releaseName,
        releaseStatus: "inProgress",
        expectedStateDigest: digest,
        validationExpiryTimeSeconds: expiryTimeSeconds,
        requestDigest: "b".repeat(64),
        attemptedAtUtc: now,
        updatedAtUtc: now,
      });
      await journal.transition(attempt.attemptId, "PREPARED", "TRANSPORT_ATTEMPTED", now);
      await journal.transition(attempt.attemptId, "TRANSPORT_ATTEMPTED", "ACKNOWLEDGED", now, {
        acknowledgedAtUtc: now,
      });
      // The journal admits verification evidence only in its ordered lifecycle,
      // exactly as the production reconciliation path writes it.
      await journal.updateVerification(attempt.attemptId, "ACKNOWLEDGED", now, {
        verificationInsertAttempted: true,
      });
      await journal.updateVerification(attempt.attemptId, "ACKNOWLEDGED", now, {
        verificationEditId: "temporary-verify-edit",
        verificationEditExpiryTimeSeconds: expiryTimeSeconds,
      });
      await journal.updateVerification(attempt.attemptId, "ACKNOWLEDGED", now, {
        verificationObservedStateDigest: digest,
        verificationObservedAtUtc: now,
      });
      await journal.updateVerification(attempt.attemptId, "ACKNOWLEDGED", now, {
        verificationPreDeleteReadVerified: true,
      });
      await journal.updateVerification(attempt.attemptId, "ACKNOWLEDGED", now, {
        verificationDeleteAttempted: true,
      });
      await journal.updateVerification(attempt.attemptId, "ACKNOWLEDGED", now, {
        verificationDeleteAcknowledged: true,
      });
      const verified = await journal.updateVerification(attempt.attemptId, "ACKNOWLEDGED", now, {
        verificationCleanupVerified: true,
      });
      // Exactly the precondition reconciliation checks before advancing.
      expect(verified.verificationObservedStateDigest).toBe(verified.expectedStateDigest);
      expect(verified.verificationCleanupVerified).toBe(true);
      const advanced = await journal.transition(
        attempt.attemptId,
        "ACKNOWLEDGED",
        "REMOTE_VERIFIED",
        now,
      );
      expect(advanced.state).toBe("REMOTE_VERIFIED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

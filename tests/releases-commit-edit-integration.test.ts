import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAuditEntries } from "../src/audit/index.js";
import { DEFAULT_CONFIG, type PlayOpsConfig } from "../src/config/index.js";
import type { AndroidPublisherClient } from "../src/googleplay/publisher/index.js";
import {
  approveInteractively,
  APPROVAL_TOKEN_TTL_MS,
  createApprovalChallenge,
  resolveApprovalToken,
  type ApprovalRequest,
  type ApprovalGrant,
} from "../src/runtime/approvals/index.js";
import { runAgent, type AgentRunResult } from "../src/runtime/agent/index.js";
import type { LlmAdapter } from "../src/runtime/llm/index.js";
import {
  createReleaseCommitIntent,
  type ReleaseCommitIntent,
} from "../src/releases/commit-approval.js";
import { createReleaseComposition, type ReleaseComposition } from "../src/releases/composition.js";
import type { ReleaseEditSession, ReleaseState, ReleaseTrackState } from "../src/releases/index.js";
import { RELEASES_COMMIT_EDIT_TOOL_NAME } from "../src/releases/commit-edit-tool.js";

const packageName = "com.example.release";
const editId = "edit-phase410-runtime";
const expiryTimeSeconds = "1900000000";
const fixedNow = new Date("2026-09-29T04:00:00.000Z");
const noteText = "PRIVATE-NOTE-TEXT-PHASE410";
let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs = [];
});

function makeDir(): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-phase410-runtime-"));
  tempDirs.push(dir);
  return dir;
}

function configFor(dir: string): PlayOpsConfig {
  return {
    ...DEFAULT_CONFIG,
    googlePlay: { packageName, serviceAccountJson: "[REDACTED]" },
    audit: { logPath: join(dir, "audit.jsonl") },
    release: {
      editSessionPath: join(dir, "edit-session.json"),
      editCleanupJournalPath: join(dir, "edit-cleanup-journal.json"),
    },
  };
}

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

function targetTrackState(release: ReleaseState = targetRelease()): ReleaseTrackState {
  return {
    track: "production",
    releases: [
      {
        name: "Older release",
        status: "completed",
        versionCodes: ["99"],
        releaseNotes: [{ language: "de-AT", text: "Older" }],
        countryTargeting: { countries: ["DE"], includeRestOfWorld: true },
        inAppUpdatePriority: 2,
      },
      release,
    ],
  };
}

function makeIntent(state = targetTrackState()): ReleaseCommitIntent {
  return createReleaseCommitIntent({
    packageName,
    editId,
    targetTrack: "production",
    versionCode: "101",
    targetTrackState: state,
    validatedEdit: { valid: true, expiryTimeSeconds },
  });
}

function session(): ReleaseEditSession {
  return {
    version: 1,
    packageName,
    editId,
    expiryTimeSeconds,
    createdAt: "2026-09-29T00:00:00.000Z",
  };
}

interface FakeOptions {
  readonly validationError?: unknown;
  readonly commitError?: unknown;
  readonly commitResponse?: unknown;
}

function fakePublisher(options: FakeOptions = {}) {
  const events: string[] = [];
  const calls = {
    getEdit: 0,
    getTrack: 0,
    validate: 0,
    commit: 0,
    insert: 0,
    upload: 0,
    trackUpdate: 0,
  };
  let currentTrack = targetTrackState();
  const publisher = {
    version: "v3",
    reviews: {},
    edits: {
      insert: async () => {
        calls.insert += 1;
        throw new Error("insert forbidden");
      },
      get: async () => {
        calls.getEdit += 1;
        events.push("edits.get");
        return { data: { id: editId, expiryTimeSeconds } };
      },
      validate: async () => {
        calls.validate += 1;
        events.push("edits.validate");
        if (options.validationError !== undefined) throw options.validationError;
        return { data: { id: editId, expiryTimeSeconds } };
      },
      commit: async (params: unknown, requestOptions: unknown) => {
        expect(params).toEqual({
          packageName,
          editId,
          changesInReviewBehavior: "ERROR_IF_IN_REVIEW",
          changesNotSentForReview: false,
        });
        expect(requestOptions).toEqual({ retry: false });
        calls.commit += 1;
        events.push("edits.commit");
        if (options.commitError !== undefined) throw options.commitError;
        return { data: options.commitResponse ?? { id: editId, expiryTimeSeconds } };
      },
      tracks: {
        list: async () => ({ data: { tracks: [] } }),
        get: async (_params: unknown) => {
          calls.getTrack += 1;
          events.push("edits.tracks.get");
          return { data: currentTrack };
        },
        update: async () => {
          calls.trackUpdate += 1;
          throw new Error("track update forbidden");
        },
      },
      bundles: {
        list: async () => ({ data: { bundles: [] } }),
        upload: async () => {
          calls.upload += 1;
          throw new Error("upload forbidden");
        },
      },
    },
  } as unknown as AndroidPublisherClient & { currentTrack: ReleaseTrackState };
  Object.defineProperty(publisher, "currentTrack", {
    configurable: true,
    get: () => currentTrack,
    set: (value: ReleaseTrackState) => {
      currentTrack = value;
    },
  });
  return { publisher, events, calls };
}

function scriptedLlm(): LlmAdapter {
  let turn = 0;
  return {
    provider: "fake-phase410-runtime",
    async complete() {
      turn += 1;
      if (turn === 1) {
        return {
          toolCalls: [{ id: "commit-call", name: RELEASES_COMMIT_EDIT_TOOL_NAME, arguments: {} }],
          usage: { totalTokens: 1 },
        };
      }
      return { content: "Commit boundary finished.", toolCalls: [], usage: { totalTokens: 1 } };
    },
  };
}

async function runCommit(
  options: {
    readonly fake?: FakeOptions;
    readonly intent?: ReleaseCommitIntent;
    readonly resolver?: (
      request: ApprovalRequest,
      composition: ReleaseComposition,
    ) => Promise<ApprovalGrant>;
    readonly mutateAfterApproval?: (
      publisher: AndroidPublisherClient & { currentTrack: ReleaseTrackState },
    ) => void;
  } = {},
): Promise<{
  readonly result: AgentRunResult;
  readonly composition: ReleaseComposition;
  readonly fake: ReturnType<typeof fakePublisher>;
  readonly dir: string;
}> {
  const dir = makeDir();
  const fake = fakePublisher(options.fake);
  const composition = createReleaseComposition(
    configFor(dir),
    { publisher: fake.publisher, now: () => new Date(fixedNow) },
    { commitEdit: { intent: options.intent ?? makeIntent() } },
  );
  await composition.store.save(session());
  const now = () => new Date(fixedNow);
  const resolver = options.resolver
    ? {
        resolve: async (request: ApprovalRequest) => {
          const resolverFunction = options.resolver;
          if (!resolverFunction) throw new Error("approval resolver unavailable");
          const grant = await resolverFunction(request, composition);
          options.mutateAfterApproval?.(fake.publisher);
          return grant;
        },
      }
    : undefined;
  const commitBinding = composition.commitEditBinding;
  if (!commitBinding) throw new Error("commit binding unavailable");
  const result = await runAgent({
    llm: scriptedLlm(),
    registry: composition.registry,
    bindings: [commitBinding],
    messages: [{ role: "user", content: "Commit the approved release." }],
    limits: { maxSteps: 3, maxToolCalls: 1, maxTotalTokens: 10 },
    ledger: composition.ledger,
    approvalLedger: composition.ledger,
    ...(resolver ? { approvalResolver: resolver } : {}),
    now,
    runId: () => "phase410-runtime-run",
  });
  return { result, composition, fake, dir };
}

async function exactApproval(
  request: ApprovalRequest,
  composition: ReleaseComposition,
): Promise<ApprovalGrant> {
  return approveInteractively(
    request,
    { ask: async () => "yes" },
    { ledger: composition.ledger, now: () => fixedNow },
  );
}

describe("Phase 4.10 through the real Phase 2 runtime", () => {
  it("registers releases.commit_edit as publish with the reserved exact binding", async () => {
    const dir = makeDir();
    const fake = fakePublisher();
    const composition = createReleaseComposition(
      configFor(dir),
      { publisher: fake.publisher, now: () => new Date(fixedNow) },
      { commitEdit: { intent: makeIntent() } },
    );
    expect(composition.registry.has(RELEASES_COMMIT_EDIT_TOOL_NAME)).toBe(true);
    expect(composition.commitEditTool?.permission).toBe("publish");
    expect(composition.commitEditBinding?.approval?.createRequestDigest({})).toBe(
      makeIntent().requestDigest,
    );
  });

  it("requires approval and performs zero commit without approval", async () => {
    const { result, fake } = await runCommit();
    expect(result).toMatchObject({
      ok: false,
      code: "APPROVAL_REQUIRED",
      externalStateUncertain: false,
    });
    expect(fake.calls.commit).toBe(0);
  });

  it("denial performs zero commit", async () => {
    const { result, fake } = await runCommit({
      resolver: (request, composition) =>
        approveInteractively(
          request,
          { ask: async () => "no" },
          { ledger: composition.ledger, now: () => fixedNow },
        ),
    });
    expect(result).toMatchObject({
      ok: false,
      code: "APPROVAL_DENIED",
      externalStateUncertain: false,
    });
    expect(fake.calls.commit).toBe(0);
  });

  it("expired approval performs zero commit", async () => {
    const { result, fake } = await runCommit({
      resolver: async (request, composition) => {
        const challenge = createApprovalChallenge(request, {
          ledger: composition.ledger,
          now: () => fixedNow,
        });
        return resolveApprovalToken(request, challenge.rawToken, {
          ledger: composition.ledger,
          now: () => new Date(fixedNow.getTime() + APPROVAL_TOKEN_TTL_MS),
        });
      },
    });
    expect(result).toMatchObject({
      ok: false,
      code: "APPROVAL_DENIED",
      externalStateUncertain: false,
    });
    expect(fake.calls.commit).toBe(0);
  });

  it("mismatched and wrong-tool approvals perform zero commit", async () => {
    const mismatched = await runCommit({
      resolver: async (request) => ({
        record: { toolName: request.toolName, permission: "publish", decision: "approved" },
        requestId: request.requestId,
        requestDigest: "different-digest",
        source: "token",
      }),
    });
    expect(mismatched.result).toMatchObject({ ok: false, code: "APPROVAL_DENIED" });
    expect(mismatched.fake.calls.commit).toBe(0);

    const wrongTool = await runCommit({
      resolver: async (request) => ({
        record: { toolName: "reviews.publish_reply", permission: "publish", decision: "approved" },
        requestId: request.requestId,
        requestDigest: request.requestDigest,
        source: "token",
      }),
    });
    expect(wrongTool.result).toMatchObject({ ok: false, code: "APPROVAL_DENIED" });
    expect(wrongTool.fake.calls.commit).toBe(0);
  });

  it("exact approval commits once, clears the session, and does not perform Phase 4.11 read-back", async () => {
    const { result, fake, composition, dir } = await runCommit({
      resolver: exactApproval,
    });
    expect(result).toMatchObject({ ok: true, code: "COMPLETED", externalStateUncertain: false });
    expect(fake.events).toEqual([
      "edits.get",
      "edits.tracks.get",
      "edits.validate",
      "edits.commit",
    ]);
    expect(fake.calls.commit).toBe(1);
    expect(await composition.store.load()).toBeUndefined();
    const content = JSON.parse(
      result.conversation.find((message) => message.role === "tool")?.content ?? "null",
    );
    expect(content).toEqual({
      committed: true,
      targetTrack: "production",
      versionCode: "101",
      releaseStatus: "inProgress",
      changesInReviewBehavior: "ERROR_IF_IN_REVIEW",
      liveReleaseVerified: false,
    });
    const audit = readAuditEntries(join(dir, "audit.jsonl"));
    expect(audit).toContainEqual(
      expect.objectContaining({ type: "approval.approved", status: "success" }),
    );
    expect(audit).toContainEqual(
      expect.objectContaining({
        type: "release.commit.completed",
        status: "success",
        metadata: expect.objectContaining({ committed: true, liveReleaseVerified: false }),
      }),
    );
    expect(JSON.stringify(audit)).not.toContain(noteText);
  });

  it("rejects stale state after exact approval without commit", async () => {
    const { result, fake } = await runCommit({
      resolver: exactApproval,
      mutateAfterApproval: (publisher) => {
        publisher.currentTrack = targetTrackState(
          targetRelease({ status: "completed", userFraction: undefined }),
        );
      },
    });
    expect(result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: false,
    });
    expect(result.cause).toMatchObject({ code: "COMMIT_STATE_CHANGED" });
    expect(fake.calls.commit).toBe(0);
  });

  it("blocks fresh validation rejection after approval", async () => {
    const { result, fake, composition } = await runCommit({
      fake: { validationError: Object.assign(new Error("PRIVATE-VALIDATE"), { status: 400 }) },
      resolver: exactApproval,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: false,
    });
    expect(result.cause).toMatchObject({ code: "EDIT_VALIDATION_FAILED" });
    expect(fake.calls.commit).toBe(0);
    expect(await composition.store.load()).toBeDefined();
  });

  it("handles structured in-review rejection without retry and retains session", async () => {
    const conflict = Object.assign(new Error("PRIVATE-IN-REVIEW"), {
      response: {
        status: 400,
        data: { error: { errors: [{ reason: "changesAlreadyInReview" }] } },
      },
    });
    const { result, fake, composition } = await runCommit({
      fake: { commitError: conflict },
      resolver: exactApproval,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: false,
    });
    expect(result.cause).toMatchObject({ code: "CHANGES_ALREADY_IN_REVIEW" });
    expect(fake.calls.commit).toBe(1);
    expect(await composition.store.load()).toBeDefined();
  });

  it("marks ambiguous commit outcome uncertain without retry or cleanup", async () => {
    const { result, fake, composition } = await runCommit({
      fake: { commitError: Object.assign(new Error("PRIVATE-500"), { status: 500 }) },
      resolver: exactApproval,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: true,
    });
    expect(result.cause).toMatchObject({ code: "COMMIT_FAILED" });
    expect(fake.calls.commit).toBe(1);
    expect(await composition.store.load()).toBeDefined();
  });

  it("rejects a mismatched commit response as uncertain without retry or cleanup", async () => {
    const { result, fake, composition } = await runCommit({
      fake: { commitResponse: { id: "other-edit", expiryTimeSeconds } },
      resolver: exactApproval,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: true,
    });
    expect(result.cause).toMatchObject({ code: "COMMIT_RESPONSE_INVALID" });
    expect(fake.calls.commit).toBe(1);
    expect(await composition.store.load()).toBeDefined();
  });
});

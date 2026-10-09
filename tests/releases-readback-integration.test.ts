import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAuditEntries } from "../src/audit/index.js";
import { DEFAULT_CONFIG, type PlayOpsConfig } from "../src/config/index.js";
import type { AndroidPublisherClient } from "../src/googleplay/publisher/index.js";
import {
  APPROVAL_TOKEN_TTL_MS,
  approveInteractively,
  createApprovalChallenge,
  resolveApprovalToken,
  type ApprovalGrant,
  type ApprovalRequest,
} from "../src/runtime/approvals/index.js";
import { runAgent } from "../src/runtime/agent/index.js";
import type { LlmAdapter } from "../src/runtime/llm/index.js";
import {
  createReleaseCommitIntent,
  type ReleaseCommitIntent,
} from "../src/releases/commit-approval.js";
import { createReleaseComposition, type ReleaseComposition } from "../src/releases/composition.js";
import type { ReleaseState, ReleaseTrackState } from "../src/releases/index.js";
import { RELEASES_INSPECT_COMMITTED_RELEASE_TOOL_NAME } from "../src/releases/inspect-committed-release-tool.js";
import { RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME } from "../src/releases/verify-committed-release-tool.js";
import type {
  ReleaseVerificationEvidenceEvent,
  ReleaseVerificationEvidenceSink,
} from "../src/releases/verification-evidence.js";
import { toOperatorError } from "../src/errors/index.js";

const packageName = "com.example.release";
const targetTrack = "wear:production";
const versionCode = "101";
const releaseName = "Candidate 101";
const expiryTimeSeconds = "4102444800";
const noteText = "PRIVATE-NOTE-TEXT-PHASE411-INTEGRATION";
const fixedNow = new Date("2026-09-30T05:00:00.000Z");
const evidenceEventTypes = [
  "verification_insert_attempted",
  "verification_edit_identified",
  "verification_state_observed",
  "verification_pre_delete_read_verified",
  "verification_delete_attempted",
  "verification_delete_acknowledged",
  "verification_cleanup_verified",
] as const;
let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeDir(): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-phase411-runtime-"));
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

function makeIntent(state = targetTrackState()): ReleaseCommitIntent {
  return createReleaseCommitIntent({
    packageName,
    editId: "managed-edit-411-runtime",
    targetTrack,
    versionCode,
    targetTrackState: state,
    validatedEdit: { valid: true, expiryTimeSeconds },
  });
}

/** Stage 3E.1 durable verification evidence derived from the same commit intent. */
function verifyEvidence(intent: ReleaseCommitIntent) {
  return {
    targetTrack: intent.targetTrack,
    versionCode: intent.versionCode,
    expectedReleaseName: intent.releaseName,
    expectedStateDigest: intent.stateDigest,
  };
}

interface FakeOptions {
  readonly summaryRelease?: {
    readonly releaseName?: string;
    readonly track?: string;
    readonly versionCode?: number;
    readonly releaseLifecycleState?: string;
  };
  readonly track?: ReleaseTrackState;
  readonly insertError?: unknown;
  readonly deleteError?: unknown;
  readonly temporaryEditId?: string;
}

function fakePublisher(options: FakeOptions = {}, events: string[] = []) {
  const temporaryEditId = options.temporaryEditId ?? "temporary-readback-edit";
  const calls = {
    summaryList: 0,
    insert: 0,
    trackGet: 0,
    delete: 0,
    commit: 0,
    upload: 0,
    trackUpdate: 0,
  };
  const summary = {
    releaseName: options.summaryRelease?.releaseName ?? releaseName,
    track: options.summaryRelease?.track ?? targetTrack,
    releaseLifecycleState:
      options.summaryRelease?.releaseLifecycleState ?? "RELEASE_LIFECYCLE_STATE_PUBLISHED",
    activeArtifacts: [{ versionCode: options.summaryRelease?.versionCode ?? 101 }],
  };
  const publisher = {
    version: "v3",
    reviews: {},
    applications: {
      tracks: {
        releases: {
          list: async (params: unknown, requestOptions: unknown) => {
            expect(params).toEqual({
              parent: `applications/${packageName}/tracks/${targetTrack}`,
            });
            expect(requestOptions).toEqual({ retry: false });
            calls.summaryList += 1;
            events.push("applications.tracks.releases.list");
            return { data: { releases: [summary] } };
          },
        },
      },
    },
    edits: {
      insert: async (params: unknown, requestOptions: unknown) => {
        expect(params).toEqual({ packageName });
        expect(requestOptions).toEqual({ retry: false });
        calls.insert += 1;
        events.push("edits.insert");
        if (options.insertError !== undefined) throw options.insertError;
        return { data: { id: temporaryEditId, expiryTimeSeconds } };
      },
      delete: async (params: unknown, requestOptions: unknown) => {
        expect(params).toEqual({ packageName, editId: temporaryEditId });
        expect(requestOptions).toEqual({ retry: false });
        calls.delete += 1;
        events.push("edits.delete");
        if (options.deleteError !== undefined) throw options.deleteError;
        return { data: {} };
      },
      get: async () => ({ data: { id: "managed-edit-411-runtime", expiryTimeSeconds } }),
      validate: async () => ({ data: { id: "managed-edit-411-runtime", expiryTimeSeconds } }),
      commit: async () => {
        calls.commit += 1;
        throw new Error("edits.commit must not be called by Phase 4.11");
      },
      tracks: {
        list: async () => ({ data: { tracks: [] } }),
        get: async (params: unknown, requestOptions: unknown) => {
          expect(params).toEqual({
            packageName,
            editId: temporaryEditId,
            track: targetTrack,
          });
          expect(requestOptions).toEqual({ retry: false });
          calls.trackGet += 1;
          events.push("edits.tracks.get");
          return { data: options.track ?? targetTrackState() };
        },
        update: async () => {
          calls.trackUpdate += 1;
          throw new Error("tracks.update must not be called by Phase 4.11");
        },
      },
      bundles: {
        list: async () => ({ data: { bundles: [] } }),
        upload: async () => {
          calls.upload += 1;
          throw new Error("bundles.upload must not be called by Phase 4.11");
        },
      },
    },
  } as unknown as AndroidPublisherClient;
  return { publisher, calls, events };
}

function scriptedLlm(toolName: string): LlmAdapter {
  let turn = 0;
  return {
    provider: "fake-phase411-runtime",
    async complete() {
      turn += 1;
      if (turn === 1) {
        return {
          toolCalls: [{ id: "phase411-call", name: toolName, arguments: {} }],
          usage: { totalTokens: 1 },
        };
      }
      return { content: "Phase 4.11 finished.", toolCalls: [], usage: { totalTokens: 1 } };
    },
  };
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

async function runTool(options: {
  readonly toolName: string;
  readonly intent?: ReleaseCommitIntent;
  readonly fake?: FakeOptions;
  readonly evidenceSink?: ReleaseVerificationEvidenceSink;
  readonly timeline?: string[];
  readonly resolver?: (
    request: ApprovalRequest,
    composition: ReleaseComposition,
  ) => Promise<ApprovalGrant>;
}): Promise<{
  readonly result: Awaited<ReturnType<typeof runAgent>>;
  readonly composition: ReleaseComposition;
  readonly fake: ReturnType<typeof fakePublisher>;
  readonly dir: string;
}> {
  const dir = makeDir();
  const fake = fakePublisher(options.fake, options.timeline);
  const composition = createReleaseComposition(
    configFor(dir),
    { publisher: fake.publisher, now: () => new Date(fixedNow) },
    options.toolName === RELEASES_INSPECT_COMMITTED_RELEASE_TOOL_NAME
      ? { inspectCommittedRelease: { intent: options.intent ?? makeIntent() } }
      : {
          verifyCommittedRelease: verifyEvidence(options.intent ?? makeIntent()),
          ...(options.evidenceSink !== undefined
            ? { verificationEvidenceSink: options.evidenceSink }
            : {}),
        },
  );
  const selectedBinding =
    options.toolName === RELEASES_INSPECT_COMMITTED_RELEASE_TOOL_NAME
      ? composition.inspectCommittedReleaseBinding
      : composition.verifyCommittedReleaseBinding;
  if (!selectedBinding) throw new Error("selected Phase 4.11 binding unavailable");
  const resolver = options.resolver
    ? {
        resolve: async (request: ApprovalRequest) => {
          const result = await options.resolver?.(request, composition);
          if (!result) throw new Error("approval resolver did not return a grant");
          return result;
        },
      }
    : undefined;
  const result = await runAgent({
    llm: scriptedLlm(options.toolName),
    registry: composition.registry,
    bindings: [selectedBinding],
    messages: [{ role: "user", content: "Verify the committed release." }],
    limits: { maxSteps: 3, maxToolCalls: 1, maxTotalTokens: 10 },
    ledger: composition.ledger,
    approvalLedger: composition.ledger,
    ...(resolver ? { approvalResolver: resolver } : {}),
    now: () => fixedNow,
    runId: () => "phase411-runtime-run",
  });
  return { result, composition, fake, dir };
}

describe("Phase 4.11 through the real Phase 2 runtime", () => {
  it("awaits trusted internal evidence around real Publisher adapter calls while keeping all public surfaces private", async () => {
    const timeline: string[] = [];
    const events: ReleaseVerificationEvidenceEvent[] = [];
    const temporaryEditId = "INTERNAL-3E2A-PUBLISHER-TEMP-IDENTITY-NEVER-PUBLIC";
    const sink: ReleaseVerificationEvidenceSink = {
      async record(event) {
        events.push(event);
        await Promise.resolve();
        timeline.push(`evidence:${event.type}`);
      },
    };
    const run = await runTool({
      toolName: RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME,
      resolver: exactApproval,
      fake: { temporaryEditId },
      evidenceSink: sink,
      timeline,
    });
    expect(run.result).toMatchObject({
      ok: true,
      code: "COMPLETED",
      externalStateUncertain: false,
    });
    expect(events.map((event) => event.type)).toEqual(evidenceEventTypes);
    expect(events[1]).toEqual({
      type: "verification_edit_identified",
      editId: temporaryEditId,
      expiryTimeSeconds,
    });
    expect(events[2]).toEqual({
      type: "verification_state_observed",
      observedStateDigest: makeIntent().stateDigest,
      observedAtUtc: fixedNow.toISOString(),
    });
    expect(timeline).toEqual([
      "applications.tracks.releases.list",
      "evidence:verification_insert_attempted",
      "edits.insert",
      "evidence:verification_edit_identified",
      "edits.tracks.get",
      "evidence:verification_state_observed",
      "evidence:verification_pre_delete_read_verified",
      "evidence:verification_delete_attempted",
      "edits.delete",
      "evidence:verification_delete_acknowledged",
      "evidence:verification_cleanup_verified",
    ]);
    expect(run.fake.calls).toEqual({
      summaryList: 1,
      insert: 1,
      trackGet: 1,
      delete: 1,
      commit: 0,
      upload: 0,
      trackUpdate: 0,
    });
    const binding = run.composition.verifyCommittedReleaseBinding;
    const approval = binding?.approval;
    if (!approval) throw new Error("Verification approval unavailable");
    const request = {
      toolName: RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME,
      permission: "destructive" as const,
      requestId: "privacy-challenge-3e2a",
      requestDigest: approval.createRequestDigest({}),
      safeSummary: approval.createSafeSummary({}),
      createdAt: fixedNow.toISOString(),
      expiresAt: "2026-09-30T05:10:00.000Z",
    };
    const challenge = createApprovalChallenge(request, {
      ledger: run.composition.ledger,
      now: () => fixedNow,
    });
    const audit = readAuditEntries(join(run.dir, "audit.jsonl"));
    const toolMessage = run.result.conversation.find((message) => message.role === "tool");
    expect(JSON.parse(toolMessage?.content ?? "null")).toMatchObject({
      observedStateDigest: makeIntent().stateDigest,
      verificationCleanupVerified: true,
    });
    for (const safe of [
      toolMessage?.content ?? "",
      JSON.stringify(run.result.conversation),
      JSON.stringify(audit),
      request.safeSummary,
      JSON.stringify(request),
      JSON.stringify(challenge),
      JSON.stringify(binding?.llm),
    ]) {
      expect(safe).not.toContain(temporaryEditId);
      expect(safe).not.toContain(expiryTimeSeconds);
    }
  });

  it.each(evidenceEventTypes)(
    "returns runtime failure for sink rejection at %s without retry or release mutations",
    async (failAt) => {
      const events: ReleaseVerificationEvidenceEvent[] = [];
      const temporaryEditId = "INTERNAL-3E2A-FAILURE-TEMP-IDENTITY-NEVER-PUBLIC";
      const run = await runTool({
        toolName: RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME,
        resolver: exactApproval,
        fake: { temporaryEditId },
        evidenceSink: {
          async record(event) {
            events.push(event);
            if (event.type === failAt)
              throw new Error(`Local persistence unavailable: ${temporaryEditId}`);
          },
        },
      });
      const position = evidenceEventTypes.indexOf(failAt);
      expect(run.result).toMatchObject({
        ok: false,
        code: "EXECUTION_FAILED",
        externalStateUncertain: false,
      });
      expect(run.result.cause).toMatchObject({
        code: "VERIFICATION_EVIDENCE_PERSISTENCE_FAILED",
        committedStateObserved: position >= 2,
        temporaryEditCleanupSucceeded: position > 0,
        verificationCleanupVerified: position > 0,
      });
      expect(events.map((event) => event.type)).toEqual(evidenceEventTypes.slice(0, position + 1));
      expect(new Set(events.map((event) => event.type)).size).toBe(events.length);
      expect(run.fake.calls).toEqual({
        summaryList: 1,
        insert: position === 0 ? 0 : 1,
        trackGet: position < 2 ? 0 : 1,
        delete: position === 0 ? 0 : 1,
        commit: 0,
        upload: 0,
        trackUpdate: 0,
      });
      const audit = readAuditEntries(join(run.dir, "audit.jsonl"));
      for (const safe of [
        JSON.stringify(run.result.conversation),
        JSON.stringify(audit),
        JSON.stringify(toOperatorError(run.result.cause)),
        run.composition.verifyCommittedReleaseBinding?.approval?.createSafeSummary({}) ?? "",
        (run.result.cause as Error).message,
      ]) {
        expect(safe).not.toContain(temporaryEditId);
        expect(safe).not.toContain(expiryTimeSeconds);
      }
    },
  );

  it("registers Layer A as read without approval and observes the direct endpoint", async () => {
    const run = await runTool({ toolName: RELEASES_INSPECT_COMMITTED_RELEASE_TOOL_NAME });
    expect(run.composition.inspectCommittedReleaseTool?.permission).toBe("read");
    expect(run.composition.inspectCommittedReleaseBinding?.approval).toBeUndefined();
    expect(run.result).toMatchObject({
      ok: true,
      code: "COMPLETED",
      externalStateUncertain: false,
    });
    expect(run.fake.calls).toMatchObject({ summaryList: 1, insert: 0, trackGet: 0, delete: 0 });
    const toolMessage = run.result.conversation.find((message) => message.role === "tool");
    expect(JSON.parse(toolMessage?.content ?? "null")).toEqual({
      targetTrack,
      versionCode,
      releaseName,
      releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
      releaseObserved: true,
      exactTrackStateVerified: false,
    });
    const audit = readAuditEntries(join(run.dir, "audit.jsonl"));
    expect(audit).toContainEqual(
      expect.objectContaining({
        type: "release.readback.summary.completed",
        status: "success",
        metadata: expect.objectContaining({ layer: "A", exactTrackStateVerified: false }),
      }),
    );
    expect(JSON.stringify(audit)).not.toContain(noteText);
  });

  it("requires destructive approval and performs zero insert without approval", async () => {
    const run = await runTool({ toolName: RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME });
    expect(run.composition.verifyCommittedReleaseTool?.permission).toBe("destructive");
    expect(run.result).toMatchObject({
      ok: false,
      code: "APPROVAL_REQUIRED",
      externalStateUncertain: false,
    });
    expect(run.fake.calls).toMatchObject({ summaryList: 0, insert: 0, trackGet: 0, delete: 0 });
  });

  it("denial, expiry, and mismatched approval all perform zero insert", async () => {
    const denied = await runTool({
      toolName: RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME,
      resolver: (request, composition) =>
        approveInteractively(
          request,
          { ask: async () => "no" },
          { ledger: composition.ledger, now: () => fixedNow },
        ),
    });
    expect(denied.result).toMatchObject({ ok: false, code: "APPROVAL_DENIED" });
    expect(denied.fake.calls.insert).toBe(0);

    const expired = await runTool({
      toolName: RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME,
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
    expect(expired.result).toMatchObject({ ok: false, code: "APPROVAL_DENIED" });
    expect(expired.fake.calls.insert).toBe(0);

    const mismatched = await runTool({
      toolName: RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME,
      resolver: async (request) => ({
        record: { toolName: request.toolName, permission: "destructive", decision: "approved" },
        requestId: request.requestId,
        requestDigest: "wrong-digest",
        source: "token",
      }),
    });
    expect(mismatched.result).toMatchObject({ ok: false, code: "APPROVAL_DENIED" });
    expect(mismatched.fake.calls.insert).toBe(0);
  });

  it("short-circuits before insert when direct summary is not observed", async () => {
    const run = await runTool({
      toolName: RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME,
      fake: { summaryRelease: { versionCode: 999 } },
      resolver: exactApproval,
    });
    expect(run.result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: false,
    });
    expect(run.result.cause).toMatchObject({ code: "COMMITTED_RELEASE_NOT_OBSERVED" });
    expect(run.fake.calls).toMatchObject({ summaryList: 1, insert: 0, trackGet: 0, delete: 0 });
  });

  it("exact approval performs one insert, exact track read, one delete, and no publish mutations", async () => {
    const run = await runTool({
      toolName: RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME,
      resolver: exactApproval,
    });
    expect(run.result).toMatchObject({
      ok: true,
      code: "COMPLETED",
      externalStateUncertain: false,
    });
    expect(run.fake.events).toEqual([
      "applications.tracks.releases.list",
      "edits.insert",
      "edits.tracks.get",
      "edits.delete",
    ]);
    expect(run.fake.calls).toMatchObject({
      summaryList: 1,
      insert: 1,
      trackGet: 1,
      delete: 1,
      commit: 0,
      upload: 0,
      trackUpdate: 0,
    });
    const content = JSON.parse(
      run.result.conversation.find((message) => message.role === "tool")?.content ?? "null",
    );
    expect(content).toMatchObject({
      targetTrack,
      versionCode,
      releaseName,
      status: "inProgress",
      userFraction: 0.05,
      releaseObserved: true,
      exactTrackStateVerified: true,
      liveReleaseVerified: true,
      servingPropagationVerified: false,
    });
    const audit = readAuditEntries(join(run.dir, "audit.jsonl"));
    expect(audit).toContainEqual(
      expect.objectContaining({
        type: "release.readback.exact.completed",
        status: "success",
        metadata: expect.objectContaining({
          layer: "B",
          liveReleaseVerified: true,
          temporaryEditCleanupSucceeded: true,
        }),
      }),
    );
    expect(JSON.stringify(audit)).not.toContain(noteText);
    expect(JSON.stringify(audit)).not.toContain("temporary-readback-edit");
  });

  it("deletes once after deterministic exact mismatch", async () => {
    const run = await runTool({
      toolName: RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME,
      fake: { track: targetTrackState(targetRelease({ userFraction: 0.1 })) },
      resolver: exactApproval,
    });
    expect(run.result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: false,
    });
    expect(run.result.cause).toMatchObject({ code: "VERIFICATION_STATE_MISMATCH" });
    expect(run.fake.calls).toMatchObject({ summaryList: 1, insert: 1, trackGet: 1, delete: 1 });
  });

  it("marks cleanup failure uncertain and does not retry delete", async () => {
    const run = await runTool({
      toolName: RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME,
      fake: { deleteError: new Error("delete failed") },
      resolver: exactApproval,
    });
    expect(run.result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: true,
    });
    expect(run.result.cause).toMatchObject({ code: "VERIFICATION_EDIT_CLEANUP_FAILED" });
    expect(run.fake.calls).toMatchObject({ insert: 1, trackGet: 1, delete: 1 });
  });

  it("does not retry ambiguous insert or guess a delete id", async () => {
    const run = await runTool({
      toolName: RELEASES_VERIFY_COMMITTED_RELEASE_TOOL_NAME,
      fake: { insertError: Object.assign(new Error("transport timeout"), { status: 500 }) },
      resolver: exactApproval,
    });
    expect(run.result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: true,
    });
    expect(run.result.cause).toMatchObject({ code: "VERIFICATION_EDIT_CREATE_FAILED" });
    expect(run.fake.calls).toMatchObject({ summaryList: 1, insert: 1, trackGet: 0, delete: 0 });
  });
});

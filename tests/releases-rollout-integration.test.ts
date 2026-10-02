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
import { createReleaseComposition, type ReleaseComposition } from "../src/releases/composition.js";
import {
  createReleaseRolloutIntent,
  type ReleaseRolloutIntent,
} from "../src/releases/rollout-approval.js";
import type { ReleaseState, ReleaseTrackState } from "../src/releases/index.js";
import { RELEASES_UPDATE_ROLLOUT_FRACTION_TOOL_NAME } from "../src/releases/rollout-tool.js";

const packageName = "com.example.rollout";
const targetTrack = "production";
const versionCode = "123";
const releaseName = "1.2.3";
const expiryTimeSeconds = "4102444800";
const noteText = "PRIVATE-ROLLOUT-NOTE-INTEGRATION";
const fixedNow = new Date("2026-09-30T06:00:00.000Z");
let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeDir(): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-phase412-runtime-"));
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
    countryTargeting: { countries: ["US", "ID"], includeRestOfWorld: false },
    inAppUpdatePriority: 3,
    ...overrides,
  };
}

function trackState(release: ReleaseState = targetRelease()): ReleaseTrackState {
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

function makeIntent(state = trackState(), newFraction = 0.1): ReleaseRolloutIntent {
  return createReleaseRolloutIntent({
    packageName,
    targetTrack,
    versionCode,
    releaseName,
    currentTrackState: state,
    newFraction,
  });
}

function rawTrack(state: ReleaseTrackState): unknown {
  return {
    track: state.track,
    releases: state.releases.map((release) => ({
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

interface FakeOptions {
  readonly operationalTrack?: ReleaseTrackState;
  readonly postCommitTrack?: ReleaseTrackState;
  readonly summarySequence?: readonly boolean[];
  readonly updateError?: unknown;
  readonly commitError?: unknown;
  readonly deleteError?: unknown;
}

function fakePublisher(options: FakeOptions = {}) {
  const calls = {
    summary: 0,
    insert: 0,
    getEdit: 0,
    getTrack: 0,
    update: 0,
    validate: 0,
    commit: 0,
    delete: 0,
    upload: 0,
  };
  const events: string[] = [];
  const updateRequests: unknown[] = [];
  const initialTrack = options.operationalTrack ?? trackState();
  let operationalTrack = initialTrack;
  let deployedTrack = options.postCommitTrack ?? initialTrack;
  let updated = false;
  let editCount = 0;
  let summaryIndex = 0;
  const activeEdits = new Set<string>();

  const publisher = {
    version: "v3",
    reviews: {},
    applications: {
      tracks: {
        releases: {
          list: async (params: unknown, requestOptions: unknown) => {
            expect(params).toEqual({ parent: `applications/${packageName}/tracks/${targetTrack}` });
            expect(requestOptions).toEqual({ retry: false });
            calls.summary += 1;
            events.push("applications.tracks.releases.list");
            const observed = options.summarySequence
              ? (options.summarySequence[summaryIndex++] ?? false)
              : true;
            return {
              data: {
                releases: observed
                  ? [
                      {
                        releaseName,
                        track: targetTrack,
                        activeArtifacts: [{ versionCode: 123 }],
                        releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
                      },
                    ]
                  : [],
              },
            };
          },
        },
      },
    },
    edits: {
      insert: async (params: unknown, requestOptions: unknown) => {
        expect(params).toEqual({ packageName });
        expect(requestOptions).toEqual({ retry: false });
        calls.insert += 1;
        editCount += 1;
        const id = editCount === 1 ? "rollout-edit" : "verification-edit";
        activeEdits.add(id);
        events.push(`edits.insert:${id}`);
        return { data: { id, expiryTimeSeconds } };
      },
      get: async (params: unknown, requestOptions: unknown) => {
        expect(requestOptions).toEqual({ retry: false });
        calls.getEdit += 1;
        events.push("edits.get");
        const id = (params as { editId: string }).editId;
        return { data: { id, expiryTimeSeconds } };
      },
      tracks: {
        list: async () => ({ data: { tracks: [] } }),
        get: async (params: unknown, requestOptions: unknown) => {
          expect(requestOptions).toEqual({ retry: false });
          calls.getTrack += 1;
          const id = (params as { editId: string }).editId;
          events.push(`edits.tracks.get:${id}`);
          return {
            data: rawTrack(
              id === "verification-edit"
                ? deployedTrack
                : updated
                  ? operationalTrack
                  : initialTrack,
            ),
          };
        },
        update: async (params: unknown, requestOptions: unknown) => {
          expect(requestOptions).toEqual({ retry: false });
          calls.update += 1;
          events.push("edits.tracks.update");
          updateRequests.push(params);
          if (options.updateError !== undefined) throw options.updateError;
          const body = (params as { requestBody: unknown }).requestBody;
          operationalTrack = body as ReleaseTrackState;
          updated = true;
          return { data: rawTrack(operationalTrack) };
        },
      },
      validate: async (params: unknown, requestOptions: unknown) => {
        expect(requestOptions).toEqual({ retry: false });
        calls.validate += 1;
        events.push("edits.validate");
        const id = (params as { editId: string }).editId;
        return { data: { id, expiryTimeSeconds } };
      },
      commit: async (params: unknown, requestOptions: unknown) => {
        expect(requestOptions).toEqual({ retry: false });
        expect(params).toMatchObject({
          packageName,
          editId: "rollout-edit",
          changesInReviewBehavior: "ERROR_IF_IN_REVIEW",
          changesNotSentForReview: false,
        });
        calls.commit += 1;
        events.push("edits.commit");
        if (options.commitError !== undefined) throw options.commitError;
        deployedTrack = options.postCommitTrack ?? operationalTrack;
        return { data: { id: "rollout-edit", expiryTimeSeconds } };
      },
      delete: async (params: unknown, requestOptions: unknown) => {
        expect(requestOptions).toEqual({ retry: false });
        calls.delete += 1;
        const id = (params as { editId: string }).editId;
        events.push(`edits.delete:${id}`);
        if (options.deleteError !== undefined) throw options.deleteError;
        activeEdits.delete(id);
        return { data: {} };
      },
      bundles: {
        list: async () => ({ data: { bundles: [] } }),
        upload: async () => {
          calls.upload += 1;
          throw new Error("bundle upload must not be called");
        },
      },
    },
  } as unknown as AndroidPublisherClient;
  return { publisher, calls, events, updateRequests, activeEdits };
}

function scriptedLlm(): LlmAdapter {
  let turn = 0;
  return {
    provider: "fake-phase412-runtime",
    async complete() {
      turn += 1;
      if (turn === 1) {
        return {
          toolCalls: [
            {
              id: "phase412-call",
              name: RELEASES_UPDATE_ROLLOUT_FRACTION_TOOL_NAME,
              arguments: {},
            },
          ],
          usage: { totalTokens: 1 },
        };
      }
      return { content: "Phase 4.12 finished.", toolCalls: [], usage: { totalTokens: 1 } };
    },
  };
}

async function approved(
  request: ApprovalRequest,
  composition: ReleaseComposition,
): Promise<ApprovalGrant> {
  return approveInteractively(
    request,
    { ask: async () => "yes" },
    { ledger: composition.ledger, now: () => fixedNow },
  );
}

async function runRollout(
  options: {
    readonly intent?: ReleaseRolloutIntent;
    readonly fake?: FakeOptions;
    readonly activeEdit?: boolean;
    readonly resolver?: (
      request: ApprovalRequest,
      composition: ReleaseComposition,
    ) => Promise<ApprovalGrant>;
  } = {},
) {
  const dir = makeDir();
  const fake = fakePublisher(options.fake);
  const intent = options.intent ?? makeIntent();
  const composition = createReleaseComposition(
    configFor(dir),
    { publisher: fake.publisher, now: () => new Date(fixedNow) },
    { updateRolloutFraction: { intent } },
  );
  const binding = composition.updateRolloutFractionBinding;
  if (!binding) throw new Error("rollout binding unavailable");
  if (options.activeEdit) {
    await composition.store.save({
      version: 1,
      packageName,
      editId: "already-open-edit",
      expiryTimeSeconds,
      createdAt: fixedNow.toISOString(),
    });
  }
  const resolver = options.resolver
    ? {
        resolve: async (request: ApprovalRequest) => {
          const grant = await options.resolver?.(request, composition);
          if (!grant) throw new Error("resolver returned no grant");
          return grant;
        },
      }
    : undefined;
  const result = await runAgent({
    llm: scriptedLlm(),
    registry: composition.registry,
    bindings: [binding],
    messages: [{ role: "user", content: "Increase the approved staged rollout." }],
    limits: { maxSteps: 3, maxToolCalls: 1, maxTotalTokens: 10 },
    ledger: composition.ledger,
    approvalLedger: composition.ledger,
    ...(resolver ? { approvalResolver: resolver } : {}),
    now: () => fixedNow,
    runId: () => "phase412-runtime-run",
  });
  return { result, composition, fake, dir };
}

describe("Phase 4.12 through the real Phase 2 runtime", () => {
  it("registers exactly destructive rollout control and uses empty model input", async () => {
    const run = await runRollout();
    expect(run.composition.registry.has(RELEASES_UPDATE_ROLLOUT_FRACTION_TOOL_NAME)).toBe(true);
    expect(run.composition.updateRolloutFractionTool?.permission).toBe("destructive");
    expect(run.composition.updateRolloutFractionBinding?.llm.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(run.result.code).toBe("APPROVAL_REQUIRED");
    expect(run.fake.calls.insert).toBe(0);
  });

  it("denial performs zero operational insert", async () => {
    const run = await runRollout({
      resolver: (request, composition) =>
        approveInteractively(
          request,
          { ask: async () => "no" },
          { ledger: composition.ledger, now: () => fixedNow },
        ),
    });
    expect(run.result).toMatchObject({
      ok: false,
      code: "APPROVAL_DENIED",
      externalStateUncertain: false,
    });
    expect(run.fake.calls.insert).toBe(0);
  });

  it("expired approval performs zero operational insert", async () => {
    const run = await runRollout({
      resolver: (request, composition) => {
        const challenge = createApprovalChallenge(request, {
          ledger: composition.ledger,
          now: () => fixedNow,
        });
        return Promise.resolve(
          resolveApprovalToken(request, challenge.rawToken, {
            ledger: composition.ledger,
            now: () => new Date(fixedNow.getTime() + APPROVAL_TOKEN_TTL_MS + 1),
          }),
        );
      },
    });
    expect(run.result).toMatchObject({
      ok: false,
      code: "APPROVAL_DENIED",
      externalStateUncertain: false,
    });
    expect(run.fake.calls.insert).toBe(0);
  });

  it("mismatched approval grant performs zero operational insert", async () => {
    const run = await runRollout({
      resolver: async (request) => ({
        record: {
          toolName: request.toolName,
          permission: request.permission,
          decision: "approved",
        },
        requestId: request.requestId,
        requestDigest: "0".repeat(64),
        source: "interactive",
      }),
    });
    expect(run.result).toMatchObject({
      ok: false,
      code: "APPROVAL_DENIED",
      externalStateUncertain: false,
    });
    expect(run.fake.calls.insert).toBe(0);
  });

  it("blocks a pre-existing managed edit before edits.insert", async () => {
    const run = await runRollout({
      activeEdit: true,
      resolver: (request, composition) => approved(request, composition),
    });
    expect(run.result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: false,
    });
    expect(run.fake.calls).toMatchObject({ summary: 1, insert: 0 });
  });

  it("runs the approved 0.05 to 0.10 lifecycle once and verifies the committed rollout", async () => {
    const run = await runRollout({
      resolver: (request, composition) => approved(request, composition),
    });
    expect(run.result).toMatchObject({
      ok: true,
      code: "COMPLETED",
      externalStateUncertain: false,
    });
    const toolMessage = run.result.conversation.find((message) => message.role === "tool");
    expect(JSON.parse(toolMessage?.content ?? "null")).toEqual({
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
    expect(run.fake.calls).toMatchObject({
      summary: 2,
      insert: 2,
      getEdit: 1,
      getTrack: 3,
      update: 1,
      validate: 1,
      commit: 1,
      delete: 1,
      upload: 0,
    });
    expect(run.fake.events).toEqual([
      "applications.tracks.releases.list",
      "edits.insert:rollout-edit",
      "edits.get",
      "edits.tracks.get:rollout-edit",
      "edits.tracks.update",
      "edits.tracks.get:rollout-edit",
      "edits.validate",
      "edits.commit",
      "applications.tracks.releases.list",
      "edits.insert:verification-edit",
      "edits.tracks.get:verification-edit",
      "edits.delete:verification-edit",
    ]);
    expect(JSON.stringify(readAuditEntries(join(run.dir, "audit.jsonl")))).not.toContain(noteText);
    expect(JSON.stringify(readAuditEntries(join(run.dir, "audit.jsonl")))).not.toContain(
      "rollout-edit",
    );
  });

  it("blocks a stale approved fraction without update or commit", async () => {
    const run = await runRollout({
      fake: { operationalTrack: trackState(targetRelease({ userFraction: 0.07 })) },
      resolver: (request, composition) => approved(request, composition),
    });
    expect(run.result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: false,
    });
    expect(run.fake.calls).toMatchObject({ insert: 1, update: 0, commit: 0, delete: 1 });
  });

  it("blocks halted release without resuming it", async () => {
    const run = await runRollout({
      fake: {
        operationalTrack: trackState(targetRelease({ status: "halted", userFraction: 0.05 })),
      },
      resolver: (request, composition) => approved(request, composition),
    });
    expect(run.result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: false,
    });
    expect(run.fake.calls).toMatchObject({ update: 0, commit: 0, delete: 1 });
  });

  it("handles ambiguous update once without committing", async () => {
    const run = await runRollout({
      fake: { updateError: Object.assign(new Error("update timeout"), { status: 500 }) },
      resolver: (request, composition) => approved(request, composition),
    });
    expect(run.result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: true,
    });
    expect(run.fake.calls).toMatchObject({ update: 1, commit: 0, delete: 1 });
  });

  it("handles ambiguous commit once, retains the managed session, and skips verification", async () => {
    const run = await runRollout({
      fake: { commitError: Object.assign(new Error("commit timeout"), { status: 500 }) },
      resolver: (request, composition) => approved(request, composition),
    });
    expect(run.result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: true,
    });
    expect(run.fake.calls).toMatchObject({ commit: 1, delete: 0, insert: 1 });
    await expect(run.composition.store.load()).resolves.toMatchObject({ editId: "rollout-edit" });
  });

  it("does not create verification edit when the direct post-commit summary is absent", async () => {
    const run = await runRollout({
      fake: { summarySequence: [true, false] },
      resolver: (request, composition) => approved(request, composition),
    });
    expect(run.result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: true,
    });
    expect(run.fake.calls).toMatchObject({ summary: 2, commit: 1, insert: 1, delete: 0 });
  });

  it("cleans one verification edit on exact post-commit fraction mismatch", async () => {
    const run = await runRollout({
      fake: { postCommitTrack: trackState(targetRelease({ userFraction: 0.05 })) },
      resolver: (request, composition) => approved(request, composition),
    });
    expect(run.result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: true,
    });
    expect(run.fake.calls).toMatchObject({ commit: 1, insert: 2, delete: 1 });
  });
});

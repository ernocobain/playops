import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type PlayOpsConfig } from "../src/config/index.js";
import type { AndroidPublisherClient } from "../src/googleplay/publisher/index.js";
import {
  approveInteractively,
  type ApprovalGrant,
  type ApprovalRequest,
} from "../src/runtime/approvals/index.js";
import { runAgent } from "../src/runtime/agent/index.js";
import type { LlmAdapter } from "../src/runtime/llm/index.js";
import { createReleaseComposition, type ReleaseComposition } from "../src/releases/composition.js";
import {
  createHaltRolloutIntent,
  createResumeRolloutIntent,
  type ReleaseStatusControlIntent,
} from "../src/releases/status-control-approval.js";
import type { ReleaseState, ReleaseTrackState } from "../src/releases/index.js";
import {
  HALT_ROLLOUT_TOOL_NAME,
  RESUME_ROLLOUT_TOOL_NAME,
} from "../src/releases/status-control-tool.js";

const packageName = "com.example.status";
const targetTrack = "production";
const versionCode = "321";
const releaseName = "3.2.1";
const expiryTimeSeconds = "4102444800";
const fixedNow = new Date("2026-09-30T08:00:00.000Z");
let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeDir(): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-phase413-runtime-"));
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
    userFraction: 0.1,
    releaseNotes: [{ language: "en-US", text: "[REDACTED-STATUS-NOTE]" }],
    countryTargeting: { countries: ["US", "ID"], includeRestOfWorld: false },
    inAppUpdatePriority: 4,
    ...overrides,
  };
}

function trackState(release: ReleaseState): ReleaseTrackState {
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

function makeIntent(operation: "halt" | "resume"): ReleaseStatusControlIntent {
  if (operation === "halt") {
    return createHaltRolloutIntent({
      packageName,
      targetTrack,
      versionCode,
      releaseName,
      currentTrackState: trackState(targetRelease({ countryTargeting: undefined })),
    });
  }
  return createResumeRolloutIntent({
    packageName,
    targetTrack,
    versionCode,
    releaseName,
    currentTrackState: trackState(targetRelease({ status: "halted" })),
  });
}

interface FakeOptions {
  readonly initialTrack?: ReleaseTrackState;
  readonly postCommitTrack?: ReleaseTrackState;
  readonly updateError?: unknown;
  readonly commitError?: unknown;
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
  };
  const events: string[] = [];
  const requests: unknown[] = [];
  const initialTrack =
    options.initialTrack ?? trackState(targetRelease({ countryTargeting: undefined }));
  let operationalTrack = initialTrack;
  let deployedTrack = options.postCommitTrack ?? initialTrack;
  let editCount = 0;
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
            return {
              data: {
                releases: [
                  {
                    releaseName,
                    track: targetTrack,
                    activeArtifacts: [{ versionCode: 321 }],
                    releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
                  },
                ],
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
        const id = editCount === 1 ? "status-edit" : "verification-edit";
        events.push(`edits.insert:${id}`);
        return { data: { id, expiryTimeSeconds } };
      },
      get: async (params: unknown, requestOptions: unknown) => {
        expect(requestOptions).toEqual({ retry: false });
        calls.getEdit += 1;
        events.push("edits.get");
        return { data: { id: (params as { editId: string }).editId, expiryTimeSeconds } };
      },
      tracks: {
        list: async () => ({ data: { tracks: [] } }),
        get: async (params: unknown, requestOptions: unknown) => {
          expect(requestOptions).toEqual({ retry: false });
          calls.getTrack += 1;
          const id = (params as { editId: string }).editId;
          events.push(`edits.tracks.get:${id}`);
          return { data: rawTrack(id === "verification-edit" ? deployedTrack : operationalTrack) };
        },
        update: async (params: unknown, requestOptions: unknown) => {
          expect(requestOptions).toEqual({ retry: false });
          calls.update += 1;
          events.push("edits.tracks.update");
          requests.push(params);
          if (options.updateError !== undefined) throw options.updateError;
          operationalTrack = (params as { requestBody: ReleaseTrackState }).requestBody;
          return { data: rawTrack(operationalTrack) };
        },
      },
      validate: async (params: unknown, requestOptions: unknown) => {
        expect(requestOptions).toEqual({ retry: false });
        calls.validate += 1;
        events.push("edits.validate");
        return { data: { id: (params as { editId: string }).editId, expiryTimeSeconds } };
      },
      commit: async (params: unknown, requestOptions: unknown) => {
        expect(requestOptions).toEqual({ retry: false });
        expect(params).toMatchObject({
          packageName,
          editId: "status-edit",
          changesInReviewBehavior: "ERROR_IF_IN_REVIEW",
          changesNotSentForReview: false,
        });
        calls.commit += 1;
        events.push("edits.commit");
        if (options.commitError !== undefined) throw options.commitError;
        deployedTrack = options.postCommitTrack ?? operationalTrack;
        return { data: { id: "status-edit", expiryTimeSeconds } };
      },
      delete: async (params: unknown, requestOptions: unknown) => {
        expect(requestOptions).toEqual({ retry: false });
        calls.delete += 1;
        events.push(`edits.delete:${(params as { editId: string }).editId}`);
        return { data: {} };
      },
      bundles: {
        list: async () => ({ data: { bundles: [] } }),
        upload: async () => ({ data: {} }),
      },
    },
  } as unknown as AndroidPublisherClient;
  return { publisher, calls, events, requests };
}

function scriptedLlm(toolName: string): LlmAdapter {
  let turn = 0;
  return {
    provider: "fake-phase413-runtime",
    async complete() {
      turn += 1;
      return turn === 1
        ? {
            toolCalls: [{ id: "status-call", name: toolName, arguments: {} }],
            usage: { totalTokens: 1 },
          }
        : { content: "status control complete", toolCalls: [], usage: { totalTokens: 1 } };
    },
  };
}

async function approve(
  request: ApprovalRequest,
  composition: ReleaseComposition,
): Promise<ApprovalGrant> {
  return approveInteractively(
    request,
    { ask: async () => "yes" },
    { ledger: composition.ledger, now: () => fixedNow },
  );
}

async function runStatus(options: {
  readonly operation: "halt" | "resume";
  readonly fake?: FakeOptions;
  readonly resolver?: (
    request: ApprovalRequest,
    composition: ReleaseComposition,
  ) => Promise<ApprovalGrant>;
}) {
  const dir = makeDir();
  const fake = fakePublisher({
    initialTrack:
      options.fake?.initialTrack ??
      (options.operation === "halt"
        ? trackState(targetRelease({ countryTargeting: undefined }))
        : trackState(targetRelease({ status: "halted" }))),
    ...options.fake,
  });
  const intent = makeIntent(options.operation);
  const composition = createReleaseComposition(
    configFor(dir),
    { publisher: fake.publisher, now: () => new Date(fixedNow) },
    options.operation === "halt" ? { haltRollout: { intent } } : { resumeRollout: { intent } },
  );
  const binding =
    options.operation === "halt"
      ? composition.haltRolloutBinding
      : composition.resumeRolloutBinding;
  if (!binding) throw new Error("status-control binding unavailable");
  const resolver = options.resolver
    ? {
        resolve: async (request: ApprovalRequest) =>
          options.resolver?.(request, composition) as Promise<ApprovalGrant>,
      }
    : undefined;
  const result = await runAgent({
    llm: scriptedLlm(
      options.operation === "halt" ? HALT_ROLLOUT_TOOL_NAME : RESUME_ROLLOUT_TOOL_NAME,
    ),
    registry: composition.registry,
    bindings: [binding],
    messages: [{ role: "user", content: "perform status control" }],
    limits: { maxSteps: 3, maxToolCalls: 1, maxTotalTokens: 10 },
    ledger: composition.ledger,
    approvalLedger: composition.ledger,
    ...(resolver ? { approvalResolver: resolver } : {}),
    now: () => fixedNow,
    runId: () => "phase413-runtime-run",
  });
  return { result, composition, fake };
}

describe("Phase 4.13 through the real Phase 2 runtime", () => {
  it("registers HALT and RESUME as separate destructive capabilities and requires approval", async () => {
    const halt = await runStatus({ operation: "halt" });
    const resume = await runStatus({ operation: "resume" });
    expect(halt.composition.haltRolloutTool?.permission).toBe("destructive");
    expect(resume.composition.resumeRolloutTool?.permission).toBe("destructive");
    expect(halt.result.code).toBe("APPROVAL_REQUIRED");
    expect(resume.result.code).toBe("APPROVAL_REQUIRED");
    expect(halt.fake.calls.insert).toBe(0);
    expect(resume.fake.calls.insert).toBe(0);
  });

  it("runs approved HALT with exact status transition and unchanged fraction", async () => {
    const run = await runStatus({ operation: "halt", resolver: approve });
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
      previousStatus: "inProgress",
      status: "halted",
      userFraction: 0.1,
      committed: true,
      liveRolloutStateVerified: true,
      servingPropagationVerified: false,
    });
    expect(run.fake.calls).toMatchObject({
      summary: 2,
      insert: 2,
      getTrack: 3,
      update: 1,
      validate: 1,
      commit: 1,
      delete: 1,
    });
    const request = run.fake.requests[0] as { requestBody: ReleaseTrackState };
    expect(request.requestBody.releases[1]).toMatchObject({ status: "halted", userFraction: 0.1 });
    expect(request.requestBody.releases[0]).toMatchObject({
      status: "completed",
      versionCodes: ["320"],
    });
  });

  it("runs approved RESUME with exact status transition and unchanged fraction", async () => {
    const run = await runStatus({ operation: "resume", resolver: approve });
    expect(run.result).toMatchObject({
      ok: true,
      code: "COMPLETED",
      externalStateUncertain: false,
    });
    const toolMessage = run.result.conversation.find((message) => message.role === "tool");
    expect(JSON.parse(toolMessage?.content ?? "null")).toMatchObject({
      previousStatus: "halted",
      status: "inProgress",
      userFraction: 0.1,
      committed: true,
      liveRolloutStateVerified: true,
    });
    expect(run.fake.calls).toMatchObject({ update: 1, commit: 1, delete: 1 });
  });
});

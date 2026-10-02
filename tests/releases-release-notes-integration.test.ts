import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAuditEntries } from "../src/audit/index.js";
import { DEFAULT_CONFIG, type PlayOpsConfig } from "../src/config/index.js";
import type { AndroidPublisherClient } from "../src/googleplay/publisher/index.js";
import { runAgent, type AgentRunResult } from "../src/runtime/agent/index.js";
import type { LlmAdapter } from "../src/runtime/llm/index.js";
import { createReleaseComposition, type ReleaseComposition } from "../src/releases/composition.js";
import type { ReleaseConfigurationResult } from "../src/releases/configure-release-tool.js";
import type { ReleaseBundleUploadResult } from "../src/releases/bundle-upload-tool.js";
import type { ReleaseEditSession, ReleaseState } from "../src/releases/index.js";
import { RELEASES_ATTACH_RELEASE_NOTES_TOOL_NAME } from "../src/releases/release-notes-tool.js";

const packageName = "com.example.release";
const editId = "edit-phase47-runtime";
const expiryTimeSeconds = "1900000000";
const fixedNow = new Date("2026-09-29T04:00:00.000Z");
const uploadedHash = "a".repeat(64);
const credentialMarker = "FAKE-CREDENTIAL-PHASE47";
const rawTrackMarker = "RAW-PHASE47-TRACK";
const configuredRelease: ReleaseConfigurationResult = {
  targetTrack: "production",
  releaseName: "Candidate 101",
  status: "inProgress",
  versionCodes: ["101"],
  userFraction: 0.05,
};
const notes = [
  { language: "en-us", text: "Improved login reliability." },
  { language: "id", text: "Meningkatkan keandalan proses masuk." },
];
let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs = [];
  vi.unstubAllGlobals();
});

function makeDir(): string {
  const dir = mkdtempSync(
    join(process.env.TMPDIR ?? process.cwd(), "playops-phase47-integration-"),
  );
  tempDirs.push(dir);
  return dir;
}

function makeConfig(dir: string): PlayOpsConfig {
  return {
    ...DEFAULT_CONFIG,
    googlePlay: { packageName, serviceAccountJson: credentialMarker },
    audit: { logPath: join(dir, "audit.jsonl") },
    release: {
      editSessionPath: join(dir, "edit-session.json"),
      editCleanupJournalPath: join(dir, "edit-cleanup-journal.json"),
    },
  };
}

function trackedSession(): ReleaseEditSession {
  return {
    version: 1,
    packageName,
    editId,
    expiryTimeSeconds,
    createdAt: "2026-09-29T00:00:00.000Z",
  };
}

function uploadedBundle(): ReleaseBundleUploadResult {
  return { editId, expiryTimeSeconds, versionCode: "101", sha256: uploadedHash, uploaded: true };
}

function targetRelease(overrides: Partial<ReleaseState> = {}): ReleaseState {
  return {
    name: "Candidate 101",
    status: "inProgress",
    versionCodes: ["101"],
    userFraction: 0.05,
    countryTargeting: { countries: ["US", "ID"], includeRestOfWorld: false },
    inAppUpdatePriority: 5,
    ...overrides,
  };
}

interface FakeOptions {
  readonly initialReleases: readonly ReleaseState[];
  readonly readbackReleases?: readonly ReleaseState[];
}

function fakePublisher(options: FakeOptions) {
  let releases = options.initialReleases;
  const events: string[] = [];
  const counts = {
    insert: 0,
    upload: 0,
    validate: 0,
    commit: 0,
    editDelete: 0,
    trackUpdate: 0,
    trackPatch: 0,
    trackCreate: 0,
    reviewReply: 0,
    trackList: 0,
  };
  const getEdit = vi.fn(async (params: unknown, requestOptions: unknown) => {
    expect(params).toEqual({ packageName, editId });
    expect(requestOptions).toEqual({ retry: false });
    events.push("edits.get");
    return { data: { id: editId, expiryTimeSeconds } };
  });
  const listBundles = vi.fn(async (params: unknown, requestOptions: unknown) => {
    expect(params).toEqual({ packageName, editId });
    expect(requestOptions).toEqual({ retry: false });
    events.push("edits.bundles.list");
    return { data: { bundles: [{ versionCode: 101, sha256: uploadedHash }] } };
  });
  const getTrack = vi.fn(async (params: unknown, requestOptions: unknown) => {
    expect(params).toEqual({ packageName, editId, track: "production" });
    expect(requestOptions).toEqual({ retry: false });
    events.push("edits.tracks.get");
    return {
      data: {
        track: "production",
        releases:
          options.readbackReleases !== undefined && counts.trackUpdate > 0
            ? options.readbackReleases
            : releases,
        rawTrack: rawTrackMarker,
      },
    };
  });
  const update = vi.fn(async (params: unknown, requestOptions: unknown) => {
    const request = params as {
      packageName: string;
      editId: string;
      track: string;
      requestBody: { track: string; releases: readonly unknown[] };
    };
    expect(requestOptions).toEqual({ retry: false });
    expect(request.packageName).toBe(packageName);
    expect(request.editId).toBe(editId);
    expect(request.track).toBe("production");
    events.push("edits.tracks.update");
    counts.trackUpdate += 1;
    releases = request.requestBody.releases as readonly ReleaseState[];
    return {
      data: {
        track: request.requestBody.track,
        releases: request.requestBody.releases,
        raw: rawTrackMarker,
      },
    };
  });
  const forbidden = (name: keyof typeof counts) => async () => {
    counts[name] += 1;
    throw new Error(`forbidden Phase 4.7 call: ${name}`);
  };
  const publisher = {
    version: "v3",
    reviews: { reply: forbidden("reviewReply") },
    edits: {
      insert: forbidden("insert"),
      get: getEdit,
      validate: forbidden("validate"),
      commit: forbidden("commit"),
      delete: forbidden("editDelete"),
      bundles: { list: listBundles, upload: forbidden("upload") },
      tracks: {
        list: forbidden("trackList"),
        get: getTrack,
        update,
        patch: forbidden("trackPatch"),
        create: forbidden("trackCreate"),
        delete: forbidden("trackPatch"),
      },
    },
  } as unknown as AndroidPublisherClient;
  return { publisher, events, counts, update, getTrack };
}

function scriptedLlm(): LlmAdapter {
  let turn = 0;
  return {
    provider: "fake-phase47-runtime",
    async complete() {
      turn += 1;
      if (turn === 1) {
        return {
          toolCalls: [
            {
              id: "attach-notes-call",
              name: RELEASES_ATTACH_RELEASE_NOTES_TOOL_NAME,
              arguments: {},
            },
          ],
          usage: { totalTokens: 1 },
        };
      }
      return { content: "Release notes attached.", toolCalls: [], usage: { totalTokens: 1 } };
    },
  };
}

async function runAttachment(options: {
  readonly initialReleases: readonly ReleaseState[];
  readonly readbackReleases?: readonly ReleaseState[];
  readonly configured?: ReleaseConfigurationResult;
  readonly localizedReleaseNotes?: readonly { language: string; text: string }[];
}): Promise<{
  readonly result: AgentRunResult;
  readonly composition: ReleaseComposition;
  readonly fake: ReturnType<typeof fakePublisher>;
  readonly dir: string;
}> {
  const dir = makeDir();
  const fake = fakePublisher(options);
  const composition = createReleaseComposition(
    makeConfig(dir),
    { publisher: fake.publisher, now: () => new Date(fixedNow) },
    {
      attachReleaseNotes: {
        targetTrack: "production",
        configuredRelease: options.configured ?? configuredRelease,
        uploadedBundle: uploadedBundle(),
        localizedReleaseNotes: options.localizedReleaseNotes ?? notes,
      },
    },
  );
  await composition.store.save(trackedSession());
  const binding = composition.attachReleaseNotesBinding;
  if (!binding) throw new Error("attach-release-notes binding was not composed");
  const result = await runAgent({
    llm: scriptedLlm(),
    registry: composition.registry,
    bindings: [binding],
    messages: [{ role: "user", content: "Attach the operator-bound release notes." }],
    limits: { maxSteps: 3, maxToolCalls: 1, maxTotalTokens: 10 },
    ledger: composition.ledger,
    runId: () => "phase47-notes-run",
  });
  return { result, composition, fake, dir };
}

function expectNoForbiddenCalls(fake: ReturnType<typeof fakePublisher>): void {
  for (const key of [
    "insert",
    "upload",
    "validate",
    "commit",
    "editDelete",
    "trackPatch",
    "trackCreate",
    "reviewReply",
    "trackList",
  ] as const) {
    expect(fake.counts[key]).toBe(0);
  }
}

describe("Phase 4.7 through the real Phase 2 runtime", () => {
  it("attaches notes once, preserves unrelated active releases, verifies, and keeps notes out of output/audit", async () => {
    const network = vi.fn(() => Promise.reject(new Error("network forbidden in fake-only test")));
    vi.stubGlobal("fetch", network);
    const unrelated: ReleaseState = {
      name: "Older",
      status: "completed",
      versionCodes: ["100"],
      releaseNotes: [{ language: "de-AT", text: "Older note" }],
      countryTargeting: { countries: ["DE"], includeRestOfWorld: true },
      inAppUpdatePriority: 2,
    };
    const { result, fake, dir } = await runAttachment({
      initialReleases: [
        unrelated,
        targetRelease({ releaseNotes: [{ language: "en-US", text: "Old note" }] }),
      ],
    });

    expect(result).toMatchObject({ ok: true, code: "COMPLETED", externalStateUncertain: false });
    expect(result.finalContent).toBe("Release notes attached.");
    expect(fake.events).toEqual([
      "edits.get",
      "edits.bundles.list",
      "edits.tracks.get",
      "edits.tracks.update",
      "edits.tracks.get",
    ]);
    expect(fake.update).toHaveBeenCalledTimes(1);
    expect(fake.update.mock.calls[0]?.[1]).toEqual({ retry: false });
    const updateCall = fake.update.mock.calls[0]?.[0] as
      { requestBody?: { releases?: readonly unknown[] } } | undefined;
    expect(updateCall?.requestBody?.releases).toEqual([
      {
        name: "Older",
        versionCodes: ["100"],
        status: "completed",
        releaseNotes: [{ language: "de-AT", text: "Older note" }],
        countryTargeting: { countries: ["DE"], includeRestOfWorld: true },
        inAppUpdatePriority: 2,
      },
      {
        name: "Candidate 101",
        versionCodes: ["101"],
        status: "inProgress",
        userFraction: 0.05,
        releaseNotes: [
          { language: "en-US", text: "Improved login reliability." },
          { language: "id", text: "Meningkatkan keandalan proses masuk." },
        ],
        countryTargeting: { countries: ["US", "ID"], includeRestOfWorld: false },
        inAppUpdatePriority: 5,
      },
    ]);
    expectNoForbiddenCalls(fake);
    expect(network).not.toHaveBeenCalled();

    const toolMessage = result.conversation.find((message) => message.role === "tool");
    expect(JSON.parse(toolMessage?.content ?? "null")).toEqual({
      targetTrack: "production",
      versionCode: "101",
      languages: ["en-US", "id"],
      noteCount: 2,
      updated: true,
    });
    expect(toolMessage?.content ?? "").not.toContain("Improved login reliability");
    expect(toolMessage?.content ?? "").not.toContain(credentialMarker);
    expect(toolMessage?.content ?? "").not.toContain(rawTrackMarker);

    const audit = readAuditEntries(join(dir, "audit.jsonl"));
    expect(audit.some((entry) => entry.type.startsWith("approval."))).toBe(false);
    expect(audit).toContainEqual(
      expect.objectContaining({
        type: "verification.completed",
        status: "success",
        metadata: expect.objectContaining({
          toolName: RELEASES_ATTACH_RELEASE_NOTES_TOOL_NAME,
          permission: "write",
          required: true,
          status: "passed",
          code: "VERIFIED",
        }),
      }),
    );
    expect(JSON.stringify(audit)).not.toContain("Improved login reliability");
  });

  it("recognizes an already-identical canonical note set as a no-op", async () => {
    const { result, fake } = await runAttachment({
      initialReleases: [
        targetRelease({
          releaseNotes: [
            { language: "id", text: "Meningkatkan keandalan proses masuk." },
            { language: "en-US", text: "Improved login reliability." },
          ],
        }),
      ],
    });
    expect(result).toMatchObject({ ok: true, code: "COMPLETED", externalStateUncertain: false });
    expect(fake.update).not.toHaveBeenCalled();
    const toolMessage = result.conversation.find((message) => message.role === "tool");
    expect(JSON.parse(toolMessage?.content ?? "null").updated).toBe(false);
    expectNoForbiddenCalls(fake);
  });

  it("blocks stale Phase 4.6 configuration before mutation", async () => {
    const { result, fake } = await runAttachment({
      initialReleases: [targetRelease({ userFraction: 0.1 })],
    });
    expect(result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: false,
    });
    expect(result.cause).toMatchObject({ code: "CONFIGURED_RELEASE_CHANGED" });
    expect(fake.update).not.toHaveBeenCalled();
    expectNoForbiddenCalls(fake);
  });

  it("marks a post-update read-back mismatch as uncertain", async () => {
    const { result, fake } = await runAttachment({
      initialReleases: [targetRelease({ releaseNotes: [{ language: "en-US", text: "Old" }] })],
      readbackReleases: [targetRelease({ status: "completed", releaseNotes: notes })],
    });
    expect(result).toMatchObject({
      ok: false,
      code: "VERIFICATION_FAILED",
      externalStateUncertain: true,
    });
    expect(fake.update).toHaveBeenCalledTimes(1);
    expectNoForbiddenCalls(fake);
  });
});

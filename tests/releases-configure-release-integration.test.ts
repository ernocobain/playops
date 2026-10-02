import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAuditEntries } from "../src/audit/index.js";
import { DEFAULT_CONFIG, type PlayOpsConfig } from "../src/config/index.js";
import type { AndroidPublisherClient } from "../src/googleplay/publisher/index.js";
import { runAgent, type AgentRunResult } from "../src/runtime/agent/index.js";
import type { LlmAdapter } from "../src/runtime/llm/index.js";
import { createReleaseComposition, type ReleaseComposition } from "../src/releases/composition.js";
import type { ReleaseBundleUploadResult } from "../src/releases/bundle-upload-tool.js";
import type { ReleaseEditSession } from "../src/releases/index.js";
import { RELEASES_CONFIGURE_RELEASE_TOOL_NAME } from "../src/releases/configure-release-tool.js";

const packageName = "com.example.release";
const editId = "edit-phase46-runtime";
const expiryTimeSeconds = "1900000000";
const fixedNow = new Date("2026-09-29T04:00:00.000Z");
const uploadedHash = "a".repeat(64);
const credentialMarker = "FAKE-CREDENTIAL-PHASE46";
const rawTrackMarker = "RAW-PHASE46-TRACK";
let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs = [];
  vi.unstubAllGlobals();
});

function makeDir(): string {
  const dir = mkdtempSync(
    join(process.env.TMPDIR ?? process.cwd(), "playops-phase46-integration-"),
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

function verifiedUpload(versionCode = "101"): ReleaseBundleUploadResult {
  return { editId, expiryTimeSeconds, versionCode, sha256: uploadedHash, uploaded: true };
}

interface FakePublisherOptions {
  readonly initialReleases: readonly unknown[];
  readonly readbackReleases?: readonly unknown[];
  readonly updateError?: unknown;
}

function fakePublisher(options: FakePublisherOptions) {
  let currentReleases: readonly unknown[] = options.initialReleases;
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
    events.push("edits.get");
    expect(params).toEqual({ packageName, editId });
    expect(requestOptions).toEqual({ retry: false });
    return { data: { id: editId, expiryTimeSeconds } };
  });
  const listBundles = vi.fn(async (params: unknown, requestOptions: unknown) => {
    events.push("edits.bundles.list");
    expect(params).toEqual({ packageName, editId });
    expect(requestOptions).toEqual({ retry: false });
    return { data: { bundles: [{ versionCode: 101, sha256: uploadedHash }] } };
  });
  const getTrack = vi.fn(async (params: unknown, requestOptions: unknown) => {
    events.push("edits.tracks.get");
    expect(params).toEqual({ packageName, editId, track: "production" });
    expect(requestOptions).toEqual({ retry: false });
    return {
      data: {
        track: "production",
        releases:
          options.readbackReleases !== undefined && counts.trackUpdate > 0
            ? options.readbackReleases
            : currentReleases,
        rawTrack: rawTrackMarker,
      },
    };
  });
  const update = vi.fn(async (params: unknown, requestOptions: unknown) => {
    events.push("edits.tracks.update");
    counts.trackUpdate += 1;
    expect(params).toMatchObject({
      packageName,
      editId,
      track: "production",
      requestBody: expect.any(Object),
    });
    expect(requestOptions).toEqual({ retry: false });
    if (options.updateError !== undefined) throw options.updateError;
    const body = (params as { requestBody: { track: string; releases: readonly unknown[] } })
      .requestBody;
    currentReleases = body.releases;
    return { data: { track: body.track, releases: body.releases, rawResponse: rawTrackMarker } };
  });
  const forbidden = (name: keyof typeof counts) => async () => {
    counts[name] += 1;
    throw new Error(`unexpected Phase 4.6 call: ${name}`);
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
      bundles: {
        list: listBundles,
        upload: forbidden("upload"),
      },
      tracks: {
        list: async () => {
          counts.trackList += 1;
          throw new Error("tracks.list must not be used by Phase 4.6");
        },
        get: getTrack,
        update,
        patch: forbidden("trackPatch"),
        create: forbidden("trackCreate"),
        delete: forbidden("trackPatch"),
      },
    },
  } as unknown as AndroidPublisherClient;
  return { publisher, events, counts, getTrack, listBundles, update };
}

function scriptedLlm(): LlmAdapter {
  let turn = 0;
  return {
    provider: "fake-phase46-runtime",
    async complete() {
      turn += 1;
      if (turn === 1) {
        return {
          toolCalls: [
            {
              id: "configure-release-call",
              name: RELEASES_CONFIGURE_RELEASE_TOOL_NAME,
              arguments: {},
            },
          ],
          usage: { totalTokens: 1 },
        };
      }
      return {
        content: "Release configuration finished.",
        toolCalls: [],
        usage: { totalTokens: 1 },
      };
    },
  };
}

async function runConfiguration(options: {
  readonly initialReleases: readonly unknown[];
  readonly readbackReleases?: readonly unknown[];
  readonly releaseStatus: "draft" | "inProgress" | "completed";
  readonly initialRolloutFraction?: number;
  readonly retainVersionCodes?: readonly string[];
  readonly updateError?: unknown;
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
      configureRelease: {
        targetTrack: "production",
        releaseName: "Candidate 101",
        releaseStatus: options.releaseStatus,
        ...(options.initialRolloutFraction !== undefined
          ? { initialRolloutFraction: options.initialRolloutFraction }
          : {}),
        ...(options.retainVersionCodes !== undefined
          ? { retainVersionCodes: options.retainVersionCodes }
          : {}),
        uploadedBundle: verifiedUpload(),
      },
    },
  );
  await composition.store.save(trackedSession());
  const binding = composition.configureReleaseBinding;
  if (!binding) throw new Error("configure-release binding was not composed");
  const result = await runAgent({
    llm: scriptedLlm(),
    registry: composition.registry,
    bindings: [binding],
    messages: [{ role: "user", content: "Configure the operator-bound release." }],
    limits: { maxSteps: 3, maxToolCalls: 1, maxTotalTokens: 10 },
    ledger: composition.ledger,
    runId: () => "phase46-configure-release-run",
  });
  return { result, composition, fake, dir };
}

function expectForbiddenCalls(fake: ReturnType<typeof fakePublisher>): void {
  expect(fake.counts.insert).toBe(0);
  expect(fake.counts.upload).toBe(0);
  expect(fake.counts.validate).toBe(0);
  expect(fake.counts.commit).toBe(0);
  expect(fake.counts.editDelete).toBe(0);
  expect(fake.counts.trackPatch).toBe(0);
  expect(fake.counts.trackCreate).toBe(0);
  expect(fake.counts.reviewReply).toBe(0);
  expect(fake.counts.trackList).toBe(0);
}

describe("Phase 4.6 through the real Phase 2 runtime", () => {
  it("configures a draft release without a fraction and verifies read-back", async () => {
    const network = vi.fn(() => Promise.reject(new Error("network forbidden in fake-only smoke")));
    vi.stubGlobal("fetch", network);
    const { result, fake, dir } = await runConfiguration({
      initialReleases: [],
      releaseStatus: "draft",
    });

    expect(result).toMatchObject({ ok: true, code: "COMPLETED", externalStateUncertain: false });
    expect(result.finalContent).toBe("Release configuration finished.");
    expect(fake.events).toEqual([
      "edits.get",
      "edits.bundles.list",
      "edits.tracks.get",
      "edits.tracks.update",
      "edits.tracks.get",
    ]);
    expect(fake.update).toHaveBeenCalledTimes(1);
    expect(fake.update.mock.calls[0]?.[1]).toEqual({ retry: false });
    expectForbiddenCalls(fake);
    expect(network).not.toHaveBeenCalled();

    const toolMessage = result.conversation.find((message) => message.role === "tool");
    expect(JSON.parse(toolMessage?.content ?? "null")).toEqual({
      targetTrack: "production",
      releaseName: "Candidate 101",
      status: "draft",
      versionCodes: ["101"],
    });
    expect(toolMessage?.content ?? "").not.toContain(editId);
    expect(toolMessage?.content ?? "").not.toContain(uploadedHash);
    expect(toolMessage?.content ?? "").not.toContain(rawTrackMarker);
    expect(toolMessage?.content ?? "").not.toContain(credentialMarker);

    const audit = readAuditEntries(join(dir, "audit.jsonl"));
    expect(audit.some((entry) => entry.type.startsWith("approval."))).toBe(false);
    expect(audit).toContainEqual(
      expect.objectContaining({
        type: "verification.completed",
        status: "success",
        metadata: expect.objectContaining({
          toolName: RELEASES_CONFIGURE_RELEASE_TOOL_NAME,
          permission: "write",
          required: true,
          status: "passed",
          code: "VERIFIED",
        }),
      }),
    );
    expect(JSON.stringify(audit)).not.toContain(rawTrackMarker);
    expect(JSON.stringify(audit)).not.toContain(credentialMarker);
  });

  it("configures an inProgress release with an exact initial fraction", async () => {
    const { result, fake } = await runConfiguration({
      initialReleases: [{ status: "completed", versionCodes: ["100"] }],
      releaseStatus: "inProgress",
      initialRolloutFraction: 0.05,
    });

    expect(result).toMatchObject({ ok: true, code: "COMPLETED", externalStateUncertain: false });
    expect(fake.update.mock.calls[0]?.[0]).toMatchObject({
      requestBody: {
        track: "production",
        releases: [
          {
            name: "Candidate 101",
            versionCodes: ["101"],
            status: "inProgress",
            userFraction: 0.05,
          },
        ],
      },
    });
    expectForbiddenCalls(fake);
  });

  it("configures completed without userFraction", async () => {
    const { result, fake } = await runConfiguration({
      initialReleases: [{ status: "completed", versionCodes: ["100"] }],
      releaseStatus: "completed",
    });

    expect(result).toMatchObject({ ok: true, code: "COMPLETED", externalStateUncertain: false });
    const body = fake.update.mock.calls[0]?.[0] as {
      requestBody?: { releases?: readonly Record<string, unknown>[] };
    };
    expect(body.requestBody?.releases?.[0]).toEqual({
      name: "Candidate 101",
      versionCodes: ["101"],
      status: "completed",
    });
    expect(body.requestBody?.releases?.[0]).not.toHaveProperty("userFraction");
    expect(body.requestBody?.releases?.[0]).not.toHaveProperty("releaseNotes");
    expect(body.requestBody?.releases?.[0]).not.toHaveProperty("countryTargeting");
    expect(body.requestBody?.releases?.[0]).not.toHaveProperty("inAppUpdatePriority");
    expectForbiddenCalls(fake);
  });

  it("retains only explicit existing codes and sends them in canonical numeric order", async () => {
    const { result, fake } = await runConfiguration({
      initialReleases: [{ status: "completed", versionCodes: ["99", "100"] }],
      releaseStatus: "draft",
      retainVersionCodes: ["100", "99", "100"],
    });

    expect(result).toMatchObject({ ok: true, code: "COMPLETED", externalStateUncertain: false });
    expect(fake.update.mock.calls[0]?.[0]).toMatchObject({
      requestBody: { releases: [{ versionCodes: ["99", "100", "101"] }] },
    });
    expectForbiddenCalls(fake);
  });

  it("blocks inProgress without a fraction and draft with a fraction before any update", async () => {
    await expect(
      runConfiguration({
        initialReleases: [{ status: "completed", versionCodes: ["100"] }],
        releaseStatus: "inProgress",
      }),
    ).rejects.toMatchObject({ code: "INVALID_RELEASE_CONFIGURATION" });

    const { result, fake } = await runConfiguration({
      initialReleases: [],
      releaseStatus: "draft",
    });
    expect(result).toMatchObject({ ok: true, code: "COMPLETED" });
    expect(fake.update).toHaveBeenCalledTimes(1);
  });

  it.each(["draft", "inProgress", "halted"] as const)(
    "blocks outstanding %s before tracks.update",
    async (status) => {
      const { result, fake } = await runConfiguration({
        initialReleases: [{ status, versionCodes: ["100"] }],
        releaseStatus: "draft",
      });
      expect(result).toMatchObject({ ok: false, code: "EXECUTION_FAILED" });
      expect(result.cause).toMatchObject({ code: "OUTSTANDING_RELEASE_EXISTS" });
      expect(fake.update).not.toHaveBeenCalled();
      expectForbiddenCalls(fake);
    },
  );

  it("blocks first-release staged rollout before tracks.update", async () => {
    const { result, fake } = await runConfiguration({
      initialReleases: [{ status: "statusUnspecified", versionCodes: [] }],
      releaseStatus: "inProgress",
      initialRolloutFraction: 0.05,
    });
    expect(result).toMatchObject({ ok: false, code: "EXECUTION_FAILED" });
    expect(result.cause).toMatchObject({ code: "STAGED_ROLLOUT_REQUIRES_EXISTING_RELEASE" });
    expect(fake.update).not.toHaveBeenCalled();
    expectForbiddenCalls(fake);
  });

  it("refreshes the version guard immediately before mutation", async () => {
    const { result, fake } = await runConfiguration({
      initialReleases: [{ status: "completed", versionCodes: ["102"] }],
      releaseStatus: "draft",
    });
    expect(result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: false,
    });
    expect(result.cause).toMatchObject({ code: "VERSION_CODE_NOT_GREATER" });
    expect(fake.update).not.toHaveBeenCalled();
    expectForbiddenCalls(fake);
  });

  it("reports read-back mismatch as VERIFICATION_FAILED and does not retry update", async () => {
    const { result, fake } = await runConfiguration({
      initialReleases: [{ status: "completed", versionCodes: ["100"] }],
      readbackReleases: [{ name: "Wrong", status: "draft", versionCodes: ["101"] }],
      releaseStatus: "completed",
    });
    expect(result).toMatchObject({
      ok: false,
      code: "VERIFICATION_FAILED",
      externalStateUncertain: true,
    });
    expect(fake.update).toHaveBeenCalledTimes(1);
    expect(fake.getTrack).toHaveBeenCalledTimes(2);
    expectForbiddenCalls(fake);
  });

  it.each([
    { label: "429", error: Object.assign(new Error("PRIVATE-429"), { status: 429 }) },
    { label: "500", error: Object.assign(new Error("PRIVATE-500"), { status: 500 }) },
    { label: "network", error: Object.assign(new Error("PRIVATE-NET"), { code: "ECONNRESET" }) },
    { label: "timeout", error: Object.assign(new Error("PRIVATE-TIMEOUT"), { code: "ETIMEDOUT" }) },
  ])("attempts tracks.update once for $label", async ({ error }) => {
    const { result, fake } = await runConfiguration({
      initialReleases: [{ status: "completed", versionCodes: ["100"] }],
      releaseStatus: "draft",
      updateError: error,
    });
    expect(result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: true,
    });
    expect(result.cause).toMatchObject({ code: "TRACK_UPDATE_FAILED" });
    expect(fake.update).toHaveBeenCalledTimes(1);
    expectForbiddenCalls(fake);
  });
});

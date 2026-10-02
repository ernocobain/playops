import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAuditEntries } from "../src/audit/index.js";
import { DEFAULT_CONFIG, type PlayOpsConfig } from "../src/config/index.js";
import type { AndroidPublisherClient } from "../src/googleplay/publisher/index.js";
import { runAgent, type AgentRunResult } from "../src/runtime/agent/index.js";
import type { LlmAdapter } from "../src/runtime/llm/index.js";
import { createReleaseComposition, type ReleaseComposition } from "../src/releases/composition.js";
import type { ReleaseEditSession } from "../src/releases/index.js";
import { RELEASES_INSPECT_TARGET_TRACK_TOOL_NAME } from "../src/releases/target-track-tool.js";

const packageName = "com.example.release";
const editId = "edit-phase45";
const expiryTimeSeconds = "1900000000";
const fixedNow = new Date("2026-09-29T04:00:00.000Z");
const rawTrackMarker = "RAW-PHASE45-TRACK-MARKER";
const credentialMarker = "FAKE-CREDENTIAL-MARKER";
let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs = [];
  vi.unstubAllGlobals();
});

function makeDir(): string {
  const dir = mkdtempSync(
    join(process.env.TMPDIR ?? process.cwd(), "playops-phase45-integration-"),
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

interface FakePublisherOptions {
  readonly requestedTrack: string;
  readonly returnedTrack?: string;
  readonly releases?: readonly unknown[];
}

function fakePublisher(options: FakePublisherOptions) {
  const events: string[] = [];
  const counts = {
    insert: 0,
    upload: 0,
    trackUpdate: 0,
    trackPatch: 0,
    trackCreate: 0,
    validate: 0,
    commit: 0,
    editDelete: 0,
    reviewReply: 0,
    trackList: 0,
  };
  const getEdit = vi.fn(async (params: unknown, requestOptions: unknown) => {
    events.push("edits.get");
    expect(params).toEqual({ packageName, editId });
    expect(requestOptions).toEqual({ retry: false });
    return { data: { id: editId, expiryTimeSeconds } };
  });
  const getTrack = vi.fn(async (params: unknown, requestOptions: unknown) => {
    events.push("edits.tracks.get");
    expect(params).toEqual({ packageName, editId, track: options.requestedTrack });
    expect(requestOptions).toEqual({ retry: false });
    return {
      data: {
        track: options.returnedTrack ?? options.requestedTrack,
        releases: options.releases ?? [],
        rawTrack: rawTrackMarker,
      },
    };
  });
  const forbidden = (name: keyof typeof counts) => async () => {
    counts[name] += 1;
    throw new Error(`unexpected mutation: ${name}`);
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
        list: async () => ({ data: { bundles: [] } }),
        upload: forbidden("upload"),
      },
      tracks: {
        list: async () => {
          counts.trackList += 1;
          throw new Error("tracks.list must not be used by Phase 4.5");
        },
        get: getTrack,
        update: forbidden("trackUpdate"),
        patch: forbidden("trackPatch"),
        create: forbidden("trackCreate"),
        delete: forbidden("trackUpdate"),
      },
    },
  } as unknown as AndroidPublisherClient;
  return { publisher, events, counts, getEdit, getTrack };
}

function scriptedLlm(): LlmAdapter {
  let turn = 0;
  return {
    provider: "fake-phase45-runtime",
    async complete() {
      turn += 1;
      if (turn === 1) {
        return {
          toolCalls: [
            {
              id: "target-track-call",
              name: RELEASES_INSPECT_TARGET_TRACK_TOOL_NAME,
              arguments: {},
            },
          ],
          usage: { totalTokens: 1 },
        };
      }
      return {
        content: "Target-track inspection finished.",
        toolCalls: [],
        usage: { totalTokens: 1 },
      };
    },
  };
}

async function runInspection(options: {
  readonly targetTrack: string;
  readonly returnedTrack?: string;
  readonly releases?: readonly unknown[];
}): Promise<{
  readonly result: AgentRunResult;
  readonly composition: ReleaseComposition;
  readonly fake: ReturnType<typeof fakePublisher>;
  readonly dir: string;
}> {
  const dir = makeDir();
  const fake = fakePublisher({
    requestedTrack: options.targetTrack,
    ...(options.returnedTrack !== undefined ? { returnedTrack: options.returnedTrack } : {}),
    ...(options.releases !== undefined ? { releases: options.releases } : {}),
  });
  const composition = createReleaseComposition(
    makeConfig(dir),
    { publisher: fake.publisher, now: () => new Date(fixedNow) },
    { targetTrackInspection: { targetTrack: options.targetTrack } },
  );
  await composition.store.save(trackedSession());
  const binding = composition.targetTrackInspectionBinding;
  if (!binding) throw new Error("target-track inspection binding was not composed");
  const result = await runAgent({
    llm: scriptedLlm(),
    registry: composition.registry,
    bindings: [binding],
    messages: [{ role: "user", content: "Inspect the operator-selected target track." }],
    limits: { maxSteps: 3, maxToolCalls: 1, maxTotalTokens: 10 },
    ledger: composition.ledger,
    runId: () => "phase45-target-track-run",
  });
  return { result, composition, fake, dir };
}

function expectNoMutation(fake: ReturnType<typeof fakePublisher>): void {
  expect(fake.counts.insert).toBe(0);
  expect(fake.counts.upload).toBe(0);
  expect(fake.counts.trackUpdate).toBe(0);
  expect(fake.counts.trackPatch).toBe(0);
  expect(fake.counts.trackCreate).toBe(0);
  expect(fake.counts.validate).toBe(0);
  expect(fake.counts.commit).toBe(0);
  expect(fake.counts.editDelete).toBe(0);
  expect(fake.counts.reviewReply).toBe(0);
  expect(fake.counts.trackList).toBe(0);
}

describe("Phase 4.5 through the real Phase 2 runtime", () => {
  it("inspects production with complete normalized release state and no mutation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network forbidden in smoke"))),
    );
    const { result, fake, dir } = await runInspection({
      targetTrack: "production",
      releases: [
        { status: "statusUnspecified", versionCodes: [] },
        { name: "draft-release", status: "draft", versionCodes: ["100"] },
        {
          name: "staged-release",
          status: "inProgress",
          versionCodes: ["101", "102"],
          userFraction: 0.2,
          releaseNotes: [{ language: "en-us", text: "Staged note" }],
          countryTargeting: { countries: ["US", "ID"], includeRestOfWorld: false },
          inAppUpdatePriority: 5,
        },
        { status: "halted", versionCodes: ["99"], userFraction: 0.4 },
        { status: "completed", versionCodes: ["98"] },
      ],
    });

    expect(result).toMatchObject({ ok: true, code: "COMPLETED", externalStateUncertain: false });
    expect(result.finalContent).toBe("Target-track inspection finished.");
    expect(fake.events).toEqual(["edits.get", "edits.tracks.get"]);
    expect(fake.getEdit).toHaveBeenCalledTimes(1);
    expect(fake.getTrack).toHaveBeenCalledTimes(1);
    expectNoMutation(fake);

    const toolMessage = result.conversation.find((message) => message.role === "tool");
    expect(JSON.parse(toolMessage?.content ?? "null")).toEqual({
      targetTrack: "production",
      confirmed: true,
      releases: [
        { status: "statusUnspecified", versionCodes: [] },
        { name: "draft-release", status: "draft", versionCodes: ["100"] },
        {
          name: "staged-release",
          status: "inProgress",
          versionCodes: ["101", "102"],
          userFraction: 0.2,
          releaseNotes: [{ language: "en-US", text: "Staged note" }],
          countryTargeting: { countries: ["US", "ID"], includeRestOfWorld: false },
          inAppUpdatePriority: 5,
        },
        { status: "halted", versionCodes: ["99"], userFraction: 0.4 },
        { status: "completed", versionCodes: ["98"] },
      ],
    });
    expect(toolMessage?.content ?? "").not.toContain(editId);
    expect(toolMessage?.content ?? "").not.toContain(rawTrackMarker);
    expect(toolMessage?.content ?? "").not.toContain(credentialMarker);

    const audit = readAuditEntries(join(dir, "audit.jsonl"));
    const auditText = JSON.stringify(audit);
    expect(audit.some((entry) => entry.type.startsWith("approval."))).toBe(false);
    expect(audit).toContainEqual(
      expect.objectContaining({
        type: "verification.completed",
        status: "success",
        metadata: expect.objectContaining({
          toolName: RELEASES_INSPECT_TARGET_TRACK_TOOL_NAME,
          permission: "read",
          required: false,
          status: "skipped",
          code: "VERIFICATION_SKIPPED",
        }),
      }),
    );
    expect(auditText).not.toContain(editId);
    expect(auditText).not.toContain(rawTrackMarker);
    expect(auditText).not.toContain(credentialMarker);
  });

  it("preserves exact form-factor target wear:production", async () => {
    const { result, fake } = await runInspection({
      targetTrack: "wear:production",
      returnedTrack: "wear:production",
      releases: [],
    });
    expect(result).toMatchObject({ ok: true, code: "COMPLETED", externalStateUncertain: false });
    expect(fake.getTrack).toHaveBeenCalledWith(
      { packageName, editId, track: "wear:production" },
      { retry: false },
    );
    const toolMessage = result.conversation.find((message) => message.role === "tool");
    expect(JSON.parse(toolMessage?.content ?? "null")).toEqual({
      targetTrack: "wear:production",
      confirmed: true,
      releases: [],
    });
    expectNoMutation(fake);
  });

  it("blocks a wrong-track response without external-state uncertainty", async () => {
    const { result, fake } = await runInspection({
      targetTrack: "production",
      returnedTrack: "beta",
      releases: [{ status: "completed", versionCodes: ["100"] }],
    });
    expect(result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: false,
    });
    expect(result.cause).toMatchObject({ code: "TRACK_MISMATCH" });
    expect(fake.events).toEqual(["edits.get", "edits.tracks.get"]);
    expectNoMutation(fake);
  });

  it("accepts an existing empty track", async () => {
    const { result, fake } = await runInspection({ targetTrack: "internal", releases: [] });
    expect(result).toMatchObject({ ok: true, code: "COMPLETED", externalStateUncertain: false });
    const toolMessage = result.conversation.find((message) => message.role === "tool");
    expect(JSON.parse(toolMessage?.content ?? "null")).toEqual({
      targetTrack: "internal",
      confirmed: true,
      releases: [],
    });
    expectNoMutation(fake);
  });

  it("fails closed on malformed remote release state", async () => {
    const { result, fake } = await runInspection({
      targetTrack: "production",
      releases: [{ status: "inProgress", userFraction: 1 }],
    });
    expect(result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: false,
    });
    expect(result.cause).toMatchObject({ code: "REMOTE_DATA_INVALID" });
    expectNoMutation(fake);
  });
});

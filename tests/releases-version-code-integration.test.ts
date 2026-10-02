import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { RELEASES_VERIFY_VERSION_CODE_TOOL_NAME } from "../src/releases/version-code-tool.js";

const packageName = "com.example.release";
const editId = "edit-phase-44";
const expiryTimeSeconds = "1900000000";
const fixedNow = new Date("2026-09-28T04:00:00.000Z");
const clock = (): Date => new Date(fixedNow);
const expectedHash = "a".repeat(64);
const wrongHash = "b".repeat(64);
const artifactPathMarker = "/operator/private/candidate.aab";
const rawTrackMarker = "RAW-TRACK-RESPONSE-MUST-NOT-ESCAPE";
let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs = [];
  vi.unstubAllGlobals();
});

function makeDir(): string {
  const dir = mkdtempSync(
    join(process.env.TMPDIR ?? process.cwd(), "playops-version-code-integration-"),
  );
  tempDirs.push(dir);
  return dir;
}

function makeConfig(dir: string): PlayOpsConfig {
  return {
    ...DEFAULT_CONFIG,
    googlePlay: { packageName, serviceAccountJson: "FAKE-CREDENTIAL-PATH" },
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
    createdAt: "2026-09-28T00:00:00.000Z",
  };
}

function verifiedUpload(versionCode: string, sha256 = expectedHash): ReleaseBundleUploadResult {
  return { editId, expiryTimeSeconds, versionCode, sha256, uploaded: true };
}

interface FakePublisherOptions {
  readonly targetTrack: string;
  readonly releases?: readonly unknown[];
  readonly bundles?: readonly { readonly versionCode: number; readonly sha256: string }[];
}

function fakePublisher(options: FakePublisherOptions) {
  const events: string[] = [];
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
    return {
      data: {
        bundles: options.bundles ?? [{ versionCode: 101, sha256: expectedHash }],
      },
    };
  });
  const getTrack = vi.fn(async (params: unknown, requestOptions: unknown) => {
    events.push("edits.tracks.get");
    expect(params).toEqual({ packageName, editId, track: options.targetTrack });
    expect(requestOptions).toEqual({ retry: false });
    return {
      data: {
        track: options.targetTrack,
        releases: options.releases ?? [],
        serverOnly: rawTrackMarker,
      },
    };
  });
  const mutations = {
    insert: vi.fn(),
    bundleUpload: vi.fn(),
    validate: vi.fn(),
    commit: vi.fn(),
    editsDelete: vi.fn(),
    trackUpdate: vi.fn(),
    trackPatch: vi.fn(),
    trackCreate: vi.fn(),
    trackDelete: vi.fn(),
    reviewReply: vi.fn(),
  };
  const publisher = {
    version: "v3",
    reviews: { reply: mutations.reviewReply },
    edits: {
      insert: mutations.insert,
      get: getEdit,
      validate: mutations.validate,
      commit: mutations.commit,
      delete: mutations.editsDelete,
      bundles: { list: listBundles, upload: mutations.bundleUpload },
      tracks: {
        list: vi.fn(),
        get: getTrack,
        update: mutations.trackUpdate,
        patch: mutations.trackPatch,
        create: mutations.trackCreate,
        delete: mutations.trackDelete,
      },
    },
  } as unknown as AndroidPublisherClient;
  return { publisher, events, mutations, getEdit, listBundles, getTrack };
}

function scriptedLlm(): LlmAdapter {
  let turn = 0;
  return {
    provider: "fake-phase44-runtime",
    async complete() {
      turn += 1;
      if (turn === 1) {
        return {
          toolCalls: [
            {
              id: "version-code-call",
              name: RELEASES_VERIFY_VERSION_CODE_TOOL_NAME,
              arguments: {},
            },
          ],
          usage: { totalTokens: 1 },
        };
      }
      return { content: "Version-code check finished.", toolCalls: [], usage: { totalTokens: 1 } };
    },
  };
}

async function runVerification(options: {
  readonly targetTrack?: string;
  readonly uploadedVersionCode: string;
  readonly uploadedSha256?: string;
  readonly releases?: readonly unknown[];
  readonly bundles?: readonly { readonly versionCode: number; readonly sha256: string }[];
}): Promise<{
  readonly result: AgentRunResult;
  readonly composition: ReleaseComposition;
  readonly fake: ReturnType<typeof fakePublisher>;
  readonly dir: string;
}> {
  const dir = makeDir();
  writeFileSync(join(dir, "unused-marker.txt"), artifactPathMarker, "utf8");
  const targetTrack = options.targetTrack ?? "production";
  const fake = fakePublisher({
    targetTrack,
    ...(options.releases !== undefined ? { releases: options.releases } : {}),
    ...(options.bundles !== undefined ? { bundles: options.bundles } : {}),
  });
  const composition = createReleaseComposition(
    makeConfig(dir),
    { publisher: fake.publisher, now: clock },
    {
      versionCodeVerification: {
        targetTrack,
        uploadedBundle: verifiedUpload(options.uploadedVersionCode, options.uploadedSha256),
      },
    },
  );
  await composition.store.save(trackedSession());
  const binding = composition.versionCodeVerificationBinding;
  if (!binding) throw new Error("version-code verification binding was not composed");
  const result = await runAgent({
    llm: scriptedLlm(),
    registry: composition.registry,
    bindings: [binding],
    messages: [{ role: "user", content: "Verify the operator-bound bundle version code." }],
    limits: { maxSteps: 3, maxToolCalls: 1, maxTotalTokens: 10 },
    ledger: composition.ledger,
    runId: () => "phase44-version-code-run",
  });
  return { result, composition, fake, dir };
}

function expectNoMutation(fake: ReturnType<typeof fakePublisher>): void {
  expect(fake.mutations.insert).not.toHaveBeenCalled();
  expect(fake.mutations.bundleUpload).not.toHaveBeenCalled();
  expect(fake.mutations.validate).not.toHaveBeenCalled();
  expect(fake.mutations.commit).not.toHaveBeenCalled();
  expect(fake.mutations.editsDelete).not.toHaveBeenCalled();
  expect(fake.mutations.trackUpdate).not.toHaveBeenCalled();
  expect(fake.mutations.trackPatch).not.toHaveBeenCalled();
  expect(fake.mutations.trackCreate).not.toHaveBeenCalled();
  expect(fake.mutations.trackDelete).not.toHaveBeenCalled();
  expect(fake.mutations.reviewReply).not.toHaveBeenCalled();
}

describe("Phase 4.4 through the real Phase 2 runtime", () => {
  it("confirms the exact Phase 4.3 bundle identity, computes unsorted target max, and safely completes", async () => {
    const network = vi.fn(() => Promise.reject(new Error("network forbidden in fake-only test")));
    vi.stubGlobal("fetch", network);
    const { result, fake, dir } = await runVerification({
      uploadedVersionCode: "101",
      releases: [
        { status: "completed", versionCodes: ["9", "10"] },
        { status: "draft", versionCodes: ["100"] },
        { status: "halted", versionCodes: ["99", "12"] },
      ],
    });

    expect(result).toMatchObject({ ok: true, code: "COMPLETED", externalStateUncertain: false });
    expect(result.finalContent).toBe("Version-code check finished.");
    expect(fake.events).toEqual(["edits.get", "edits.bundles.list", "edits.tracks.get"]);
    expect(fake.getTrack).toHaveBeenCalledTimes(1);
    expect(fake.listBundles).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
    expectNoMutation(fake);

    const toolMessage = result.conversation.find((message) => message.role === "tool");
    expect(JSON.parse(toolMessage?.content ?? "null")).toEqual({
      targetTrack: "production",
      uploadedVersionCode: "101",
      currentMaxVersionCode: "100",
      comparison: "greater",
      verified: true,
    });
    expect(toolMessage?.content ?? "").not.toContain(expectedHash);
    expect(toolMessage?.content ?? "").not.toContain(editId);
    expect(toolMessage?.content ?? "").not.toContain(artifactPathMarker);
    expect(toolMessage?.content ?? "").not.toContain(rawTrackMarker);

    const audit = readAuditEntries(join(dir, "audit.jsonl"));
    expect(audit.some((entry) => entry.type.startsWith("approval."))).toBe(false);
    expect(audit).toContainEqual(
      expect.objectContaining({
        type: "verification.completed",
        status: "success",
        metadata: expect.objectContaining({
          toolName: RELEASES_VERIFY_VERSION_CODE_TOOL_NAME,
          permission: "read",
          required: false,
          status: "skipped",
          code: "VERIFICATION_SKIPPED",
        }),
      }),
    );
    const auditText = JSON.stringify(audit);
    expect(auditText).not.toContain(artifactPathMarker);
    expect(auditText).not.toContain(expectedHash);
    expect(auditText).not.toContain(editId);
    expect(auditText).not.toContain(rawTrackMarker);
  });

  it.each([
    { uploadedVersionCode: "100", bundleVersionCode: 100 },
    { uploadedVersionCode: "99", bundleVersionCode: 99 },
  ])(
    "blocks uploaded versionCode $uploadedVersionCode against target maximum 100",
    async ({ uploadedVersionCode, bundleVersionCode }) => {
      const { result, fake } = await runVerification({
        uploadedVersionCode,
        bundles: [{ versionCode: bundleVersionCode, sha256: expectedHash }],
        releases: [{ status: "completed", versionCodes: ["100"] }],
      });

      expect(result).toMatchObject({
        ok: false,
        code: "EXECUTION_FAILED",
        externalStateUncertain: false,
      });
      expect((result.cause as { code?: string } | undefined)?.code).toBe(
        "VERSION_CODE_NOT_GREATER",
      );
      expect(fake.events).toEqual(["edits.get", "edits.bundles.list", "edits.tracks.get"]);
      expectNoMutation(fake);
    },
  );

  it("accepts an existing empty target track as no-current-version without pretending the baseline is zero", async () => {
    const { result, fake } = await runVerification({
      targetTrack: "internal",
      uploadedVersionCode: "1",
      bundles: [{ versionCode: 1, sha256: expectedHash }],
      releases: [],
    });

    expect(result).toMatchObject({ ok: true, code: "COMPLETED", externalStateUncertain: false });
    const toolMessage = result.conversation.find((message) => message.role === "tool");
    expect(JSON.parse(toolMessage?.content ?? "null")).toEqual({
      targetTrack: "internal",
      uploadedVersionCode: "1",
      currentMaxVersionCode: null,
      comparison: "no-current-version",
      verified: true,
    });
    expect(fake.getTrack).toHaveBeenCalledWith(
      { packageName, editId, track: "internal" },
      { retry: false },
    );
    expectNoMutation(fake);
  });

  it("fails before tracks.get when bundles.list does not contain the exact versionCode+sha256 pair", async () => {
    const { result, fake } = await runVerification({
      uploadedVersionCode: "101",
      bundles: [{ versionCode: 101, sha256: wrongHash }],
      releases: [{ status: "completed", versionCodes: ["100"] }],
    });

    expect(result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: false,
    });
    expect((result.cause as { code?: string } | undefined)?.code).toBe("UPLOADED_BUNDLE_NOT_FOUND");
    expect(fake.events).toEqual(["edits.get", "edits.bundles.list"]);
    expect(fake.getTrack).not.toHaveBeenCalled();
    expectNoMutation(fake);
  });

  it("keeps target track operator-bound and registers no upload tool for this operation", async () => {
    const dir = makeDir();
    const fake = fakePublisher({ targetTrack: "production" });
    const composition = createReleaseComposition(
      makeConfig(dir),
      { publisher: fake.publisher, now: clock },
      {
        versionCodeVerification: {
          targetTrack: "production",
          uploadedBundle: verifiedUpload("101"),
        },
      },
    );

    expect(composition.registry.has(RELEASES_VERIFY_VERSION_CODE_TOOL_NAME)).toBe(true);
    expect(composition.registry.has("releases.upload_bundle")).toBe(false);
    expect(composition.bundleUploadBinding).toBeUndefined();
    expect(composition.versionCodeVerificationBinding?.llm.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(fake.getTrack).not.toHaveBeenCalled();
  });
});

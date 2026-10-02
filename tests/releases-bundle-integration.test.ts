import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAuditEntries } from "../src/audit/index.js";
import { DEFAULT_CONFIG, type PlayOpsConfig } from "../src/config/index.js";
import type { AndroidPublisherClient } from "../src/googleplay/publisher/index.js";
import { runAgent, type AgentRunResult } from "../src/runtime/agent/index.js";
import type { LlmAdapter } from "../src/runtime/llm/index.js";
import { createReleaseComposition, type ReleaseComposition } from "../src/releases/composition.js";
import { RELEASES_UPLOAD_BUNDLE_TOOL_NAME } from "../src/releases/bundle-upload-tool.js";

const packageName = "com.example.bundle";
const editId = "managed-edit-phase-42";
const expiryTimeSeconds = "1900000000";
const fixedNow = new Date("2026-09-28T01:00:00.000+07:00");
const clock = (): Date => new Date(fixedNow);
const fixtureBytes = Buffer.from("FAKE-AAB-PAYLOAD-NOT-A-REAL-BUNDLE");
const fixtureHash = createHash("sha256").update(fixtureBytes).digest("hex");
let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { force: true, recursive: true });
  tempDir = undefined;
  vi.unstubAllGlobals();
});

function makeDir(): string {
  tempDir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-bundle-integration-"));
  return tempDir;
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

async function readStream(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function fakePublisher(
  options: {
    readonly uploadError?: Error;
    readonly readback?: readonly { readonly versionCode: number; readonly sha256: string }[];
    readonly uploadSha256?: string;
  } = {},
) {
  const events: string[] = [];
  const uploadedBytes: Buffer[] = [];
  const insert = vi.fn(async () => {
    events.push("edits.insert");
    return { data: { id: "unexpected-edit", expiryTimeSeconds } };
  });
  const get = vi.fn(
    async (params: { packageName: string; editId: string }, requestOptions: unknown) => {
      events.push("edits.get");
      expect(params).toEqual({ packageName, editId });
      expect(requestOptions).toEqual({ retry: false });
      return { data: { id: editId, expiryTimeSeconds } };
    },
  );
  const upload = vi.fn(
    async (
      params: {
        readonly packageName: string;
        readonly editId: string;
        readonly media: { readonly mimeType: string; readonly body: Readable };
      },
      requestOptions: unknown,
    ) => {
      events.push("edits.bundles.upload");
      if (options.uploadError) throw options.uploadError;
      expect(params.packageName).toBe(packageName);
      expect(params.editId).toBe(editId);
      expect(params.media.mimeType).toBe("application/octet-stream");
      expect(requestOptions).toEqual({ retry: false, timeout: 120_000 });
      uploadedBytes.push(await readStream(params.media.body));
      return {
        data: {
          versionCode: 73,
          sha256: options.uploadSha256 ?? fixtureHash,
          serverOnly: "must-not-escape",
        },
      };
    },
  );
  const list = vi.fn(
    async (params: { packageName: string; editId: string }, requestOptions: unknown) => {
      events.push("edits.bundles.list");
      expect(params).toEqual({ packageName, editId });
      expect(requestOptions).toEqual({ retry: false });
      return { data: { bundles: options.readback ?? [{ versionCode: 73, sha256: fixtureHash }] } };
    },
  );
  const commit = vi.fn();
  const validate = vi.fn();
  const trackUpdate = vi.fn();
  const client = {
    version: "v3",
    reviews: {},
    edits: {
      insert,
      get,
      commit,
      validate,
      bundles: { upload, list },
      tracks: { list: vi.fn(), get: vi.fn(), update: trackUpdate },
    },
  } as unknown as AndroidPublisherClient;
  return {
    client,
    events,
    uploadedBytes,
    insert,
    get,
    upload,
    list,
    commit,
    validate,
    trackUpdate,
  };
}

function scriptedLlm(args: unknown = {}): LlmAdapter {
  let turn = 0;
  return {
    provider: "fake-phase43-integration",
    async complete() {
      turn += 1;
      if (turn === 1) {
        return {
          toolCalls: [
            { id: "bundle-call-1", name: RELEASES_UPLOAD_BUNDLE_TOOL_NAME, arguments: args },
          ],
          usage: { totalTokens: 1 },
        };
      }
      return { content: "Upload workflow finished.", toolCalls: [], usage: { totalTokens: 1 } };
    },
  };
}

async function compositionWith(dir: string, publisher: ReturnType<typeof fakePublisher>) {
  const artifactPath = join(dir, "operator-candidate.aab");
  writeFileSync(artifactPath, fixtureBytes);
  const composition = createReleaseComposition(
    makeConfig(dir),
    { publisher: publisher.client, now: clock },
    { bundleUpload: { artifactPath } },
  );
  await composition.store.save({
    version: 1,
    packageName,
    editId,
    expiryTimeSeconds,
    createdAt: "2026-09-28T00:00:00.000Z",
  });
  return { composition, artifactPath };
}

function runUpload(composition: ReleaseComposition, args: unknown = {}): Promise<AgentRunResult> {
  if (!composition.bundleUploadBinding) throw new Error("bundle upload binding was not composed");
  return runAgent({
    llm: scriptedLlm(args),
    registry: composition.registry,
    bindings: [composition.bundleUploadBinding],
    messages: [{ role: "user", content: "Upload the operator-bound existing bundle." }],
    limits: { maxSteps: 3, maxToolCalls: 1, maxTotalTokens: 10 },
    ledger: composition.ledger,
    runId: () => "phase43-bundle-upload",
  });
}

describe("Phase 4.3 bundle upload through the real Phase 2 agent boundary", () => {
  it("rejects a blank artifact path when composing the operation", () => {
    const dir = makeDir();
    const fake = fakePublisher();

    expect(() =>
      createReleaseComposition(
        makeConfig(dir),
        { publisher: fake.client, now: clock },
        { bundleUpload: { artifactPath: " " } },
      ),
    ).toThrowError(expect.objectContaining({ code: "ARTIFACT_INVALID" }));
    expect(fake.get).not.toHaveBeenCalled();
    expect(fake.upload).not.toHaveBeenCalled();
  });

  it("uploads once into the exact managed edit, verifies list read-back, and emits only safe metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network forbidden in test"))),
    );
    const dir = makeDir();
    const fake = fakePublisher();
    const { composition, artifactPath } = await compositionWith(dir, fake);
    const result = await runUpload(composition);

    expect(result).toMatchObject({
      ok: true,
      code: "COMPLETED",
      externalStateUncertain: false,
    });
    expect(fake.events).toEqual(["edits.get", "edits.bundles.upload", "edits.bundles.list"]);
    expect(fake.insert).not.toHaveBeenCalled();
    expect(fake.get).toHaveBeenCalledTimes(1);
    expect(fake.upload).toHaveBeenCalledTimes(1);
    expect(fake.list).toHaveBeenCalledTimes(1);
    expect(fake.upload.mock.calls[0]?.[0]).not.toHaveProperty("ackBundleInstallationWarning");
    expect(fake.upload).toHaveBeenCalledWith(
      {
        packageName,
        editId,
        media: expect.objectContaining({
          mimeType: "application/octet-stream",
          body: expect.any(Readable),
        }),
      },
      { retry: false, timeout: 120_000 },
    );
    expect(fake.uploadedBytes).toEqual([fixtureBytes]);
    expect(fake.list).toHaveBeenCalledWith({ packageName, editId }, { retry: false });
    expect(fake.commit).not.toHaveBeenCalled();
    expect(fake.validate).not.toHaveBeenCalled();
    expect(fake.trackUpdate).not.toHaveBeenCalled();

    const toolMessage = result.conversation.find((message) => message.role === "tool");
    expect(JSON.parse(toolMessage?.content ?? "null")).toEqual({
      versionCode: "73",
      sha256: fixtureHash,
      uploaded: true,
    });
    expect(toolMessage?.content ?? "").not.toContain(editId);
    expect(toolMessage?.content ?? "").not.toContain(artifactPath);
    expect(toolMessage?.content ?? "").not.toContain(fixtureBytes.toString("utf8"));
    const audit = readAuditEntries(join(dir, "audit.jsonl"));
    expect(JSON.stringify(audit)).not.toContain(artifactPath);
    expect(JSON.stringify(audit)).not.toContain(fixtureBytes.toString("utf8"));
    expect(JSON.stringify(audit)).not.toContain("must-not-escape");
    const persistedSession = await composition.store.load();
    expect(JSON.stringify(persistedSession)).not.toContain(artifactPath);
    expect(JSON.stringify(persistedSession)).not.toContain(fixtureBytes.toString("utf8"));
  });

  it("does not accept a model-supplied path and makes no Publisher call", async () => {
    const dir = makeDir();
    const fake = fakePublisher();
    const { composition } = await compositionWith(dir, fake);

    const result = await runUpload(composition, { artifactPath: "/model/chosen.aab" });

    expect(result).toMatchObject({ ok: false, code: "INPUT_INVALID" });
    expect(fake.events).toEqual([]);
    expect(fake.upload).not.toHaveBeenCalled();
    expect(JSON.stringify(readAuditEntries(join(dir, "audit.jsonl")))).not.toContain(
      "/model/chosen.aab",
    );
  });

  it("treats an ambiguous upload error as uncertain, performs one attempt, and does not list or retry", async () => {
    const failure = Object.assign(new Error("FAKE-429-SENSITIVE"), { status: 429 });
    const dir = makeDir();
    const fake = fakePublisher({ uploadError: failure });
    const { composition } = await compositionWith(dir, fake);

    const result = await runUpload(composition);

    expect(result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: true,
    });
    expect(fake.events).toEqual(["edits.get", "edits.bundles.upload"]);
    expect(fake.upload).toHaveBeenCalledTimes(1);
    expect(fake.list).not.toHaveBeenCalled();
    expect(fake.insert).not.toHaveBeenCalled();
    expect(fake.commit).not.toHaveBeenCalled();
    expect(fake.validate).not.toHaveBeenCalled();
    expect(fake.trackUpdate).not.toHaveBeenCalled();
    expect(JSON.stringify(readAuditEntries(join(dir, "audit.jsonl")))).not.toContain(
      "FAKE-429-SENSITIVE",
    );
  });

  it("fails mandatory verification and marks remote state uncertain when list read-back mismatches", async () => {
    const dir = makeDir();
    const fake = fakePublisher({
      readback: [{ versionCode: 74, sha256: "f".repeat(64) }],
    });
    const { composition } = await compositionWith(dir, fake);

    const result = await runUpload(composition);

    expect(result).toMatchObject({
      ok: false,
      code: "VERIFICATION_FAILED",
      externalStateUncertain: true,
    });
    expect(fake.events).toEqual(["edits.get", "edits.bundles.upload", "edits.bundles.list"]);
    expect(fake.upload).toHaveBeenCalledTimes(1);
    expect(fake.list).toHaveBeenCalledTimes(1);
    expect(result.conversation.some((message) => message.role === "tool")).toBe(false);
  });
});

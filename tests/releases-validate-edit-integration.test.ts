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
import { RELEASES_VALIDATE_EDIT_TOOL_NAME } from "../src/releases/validate-edit-tool.js";

const packageName = "com.example.release";
const editId = "edit-phase48-runtime";
const expiryTimeSeconds = "1900000000";
const fixedNow = new Date("2026-09-29T04:00:00.000Z");
const rawAppEditMarker = "RAW-APP-EDIT-PHASE48";
const privateDiagnostic = "PRIVATE-GOOGLE-VALIDATION-DIAGNOSTIC";
let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs = [];
});

function makeDir(): string {
  const dir = mkdtempSync(
    join(process.env.TMPDIR ?? process.cwd(), "playops-phase48-integration-"),
  );
  tempDirs.push(dir);
  return dir;
}

function configFor(dir: string): PlayOpsConfig {
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

function session(overrides: Partial<ReleaseEditSession> = {}): ReleaseEditSession {
  return {
    version: 1,
    packageName,
    editId,
    expiryTimeSeconds,
    createdAt: "2026-09-29T00:00:00.000Z",
    ...overrides,
  };
}

interface FakeOptions {
  readonly remoteEdit?: { readonly id: string; readonly expiryTimeSeconds?: string };
  readonly validationResponse?: { readonly id: string; readonly expiryTimeSeconds?: string };
  readonly validationError?: unknown;
}

function fakePublisher(options: FakeOptions = {}) {
  const events: string[] = [];
  const counts = { getEdit: 0, validate: 0, insert: 0, upload: 0, trackUpdate: 0, commit: 0 };
  const getEdit = vi.fn(async (params: unknown, requestOptions: unknown) => {
    expect(params).toEqual({ packageName, editId });
    expect(requestOptions).toEqual({ retry: false });
    counts.getEdit += 1;
    events.push("edits.get");
    return {
      data: {
        ...(options.remoteEdit ?? { id: editId, expiryTimeSeconds }),
        rawAppEdit: rawAppEditMarker,
      },
    };
  });
  const validate = vi.fn(async (params: unknown, requestOptions: unknown) => {
    expect(params).toEqual({ packageName, editId });
    expect(requestOptions).toEqual({ retry: false });
    counts.validate += 1;
    events.push("edits.validate");
    if (options.validationError !== undefined) throw options.validationError;
    return {
      data: {
        ...(options.validationResponse ?? { id: editId, expiryTimeSeconds }),
        rawAppEdit: rawAppEditMarker,
      },
    };
  });
  const forbidden = (name: keyof typeof counts) => async () => {
    counts[name] += 1;
    throw new Error(`forbidden ${name}`);
  };
  const publisher = {
    version: "v3",
    reviews: {},
    edits: {
      insert: forbidden("insert"),
      get: getEdit,
      validate,
      tracks: {
        list: async () => ({ data: { tracks: [] } }),
        get: async () => ({ data: { track: "production", releases: [] } }),
        update: forbidden("trackUpdate"),
      },
      bundles: {
        list: async () => ({ data: { bundles: [] } }),
        upload: forbidden("upload"),
      },
      commit: forbidden("commit"),
    },
  } as unknown as AndroidPublisherClient;
  return { publisher, events, counts, validate, getEdit };
}

function scriptedLlm(): LlmAdapter {
  let turn = 0;
  return {
    provider: "fake-phase48-runtime",
    async complete() {
      turn += 1;
      if (turn === 1) {
        return {
          toolCalls: [
            { id: "validate-edit-call", name: RELEASES_VALIDATE_EDIT_TOOL_NAME, arguments: {} },
          ],
          usage: { totalTokens: 1 },
        };
      }
      return { content: "Edit validation finished.", toolCalls: [], usage: { totalTokens: 1 } };
    },
  };
}

async function runValidation(
  options: {
    readonly fake?: FakeOptions;
    readonly trackedSession?: ReleaseEditSession;
  } = {},
): Promise<{
  readonly result: AgentRunResult;
  readonly composition: ReleaseComposition;
  readonly fake: ReturnType<typeof fakePublisher>;
  readonly dir: string;
}> {
  const dir = makeDir();
  const fake = fakePublisher(options.fake);
  const composition = createReleaseComposition(configFor(dir), {
    publisher: fake.publisher,
    now: () => new Date(fixedNow),
  });
  await composition.store.save(options.trackedSession ?? session());
  const result = await runAgent({
    llm: scriptedLlm(),
    registry: composition.registry,
    bindings: [composition.validateEditBinding],
    messages: [{ role: "user", content: "Validate the current edit." }],
    limits: { maxSteps: 3, maxToolCalls: 1, maxTotalTokens: 10 },
    ledger: composition.ledger,
    runId: () => "phase48-validation-run",
  });
  return { result, composition, fake, dir };
}

function expectNoMutation(fake: ReturnType<typeof fakePublisher>): void {
  expect(fake.counts.insert).toBe(0);
  expect(fake.counts.upload).toBe(0);
  expect(fake.counts.trackUpdate).toBe(0);
  expect(fake.counts.commit).toBe(0);
}

describe("Phase 4.8 through the real Phase 2 runtime", () => {
  it("validates the exact managed edit with read permission and skipped verification", async () => {
    const { result, fake, dir } = await runValidation();

    expect(result).toMatchObject({ ok: true, code: "COMPLETED", externalStateUncertain: false });
    expect(result.finalContent).toBe("Edit validation finished.");
    expect(fake.events).toEqual(["edits.get", "edits.validate"]);
    expect(fake.validate).toHaveBeenCalledTimes(1);
    expect(fake.validate.mock.calls[0]?.[1]).toEqual({ retry: false });
    expectNoMutation(fake);

    const toolMessage = result.conversation.find((message) => message.role === "tool");
    expect(JSON.parse(toolMessage?.content ?? "null")).toEqual({
      valid: true,
      expiryTimeSeconds,
    });
    expect(toolMessage?.content ?? "").not.toContain(editId);
    expect(toolMessage?.content ?? "").not.toContain(rawAppEditMarker);

    const audit = readAuditEntries(join(dir, "audit.jsonl"));
    expect(audit.some((entry) => entry.type.startsWith("approval."))).toBe(false);
    expect(audit).toContainEqual(
      expect.objectContaining({
        type: "verification.completed",
        status: "success",
        metadata: expect.objectContaining({
          toolName: RELEASES_VALIDATE_EDIT_TOOL_NAME,
          permission: "read",
          required: false,
          code: "VERIFICATION_SKIPPED",
        }),
      }),
    );
    expect(JSON.stringify(audit)).not.toContain(rawAppEditMarker);
  });

  it("blocks on an explicit Google validation rejection without mutation uncertainty", async () => {
    const failure = Object.assign(new Error(privateDiagnostic), { status: 400 });
    const { result, fake, dir } = await runValidation({ fake: { validationError: failure } });

    expect(result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: false,
    });
    expect(result.cause).toMatchObject({ code: "EDIT_VALIDATION_FAILED" });
    expect(fake.validate).toHaveBeenCalledTimes(1);
    expectNoMutation(fake);
    expect(JSON.stringify(readAuditEntries(join(dir, "audit.jsonl")))).not.toContain(
      privateDiagnostic,
    );
  });

  it("stops at invalidated or expired managed edit before validate", async () => {
    const invalidated = await runValidation({
      fake: { remoteEdit: { id: "other-edit", expiryTimeSeconds } },
    });
    expect(invalidated.result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: false,
    });
    expect(invalidated.result.cause).toMatchObject({ code: "EDIT_SESSION_INVALID" });
    expect(invalidated.fake.counts.validate).toBe(0);
    expectNoMutation(invalidated.fake);

    const expired = await runValidation({ trackedSession: session({ expiryTimeSeconds: "1" }) });
    expect(expired.result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: false,
    });
    expect(expired.result.cause).toMatchObject({ code: "EDIT_SESSION_EXPIRED" });
    expect(expired.fake.counts.validate).toBe(0);
    expectNoMutation(expired.fake);
  });

  it("blocks a mismatched AppEdit response", async () => {
    const { result, fake } = await runValidation({
      fake: { validationResponse: { id: "edit-other", expiryTimeSeconds } },
    });
    expect(result).toMatchObject({
      ok: false,
      code: "EXECUTION_FAILED",
      externalStateUncertain: false,
    });
    expect(result.cause).toMatchObject({ code: "VALIDATION_RESPONSE_MISMATCH" });
    expect(fake.validate).toHaveBeenCalledTimes(1);
    expectNoMutation(fake);
  });
});

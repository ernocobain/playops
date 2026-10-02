import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAuditEntries } from "../src/audit/index.js";
import { DEFAULT_CONFIG, type PlayOpsConfig } from "../src/config/index.js";
import type { AndroidPublisherClient } from "../src/googleplay/publisher/index.js";
import {
  runAgent,
  type AgentApprovalResolver,
  type AgentRunResult,
} from "../src/runtime/agent/index.js";
import { approveInteractively, createFileApprovalLedger } from "../src/runtime/approvals/index.js";
import type { LlmAdapter } from "../src/runtime/llm/index.js";
import { createReleaseComposition, type ReleaseComposition } from "../src/releases/composition.js";
import { RELEASES_OPEN_EDIT_TOOL_NAME } from "../src/releases/open-tool.js";
import { RELEASES_INSPECT_TOOL_NAME } from "../src/releases/tool.js";
import type { ReleaseEditSession } from "../src/releases/index.js";

const packageName = "com.example.release";
const rawMarker = "RAW-GOOGLE-RELEASE-OBJECT";
const fixedNow = 1_800_000_000_000;
const clock = (): Date => new Date(fixedNow);
let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { force: true, recursive: true });
  tempDir = undefined;
  vi.unstubAllGlobals();
});

function makeDir(): string {
  tempDir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-edit-integration-"));
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

function fakePublisher(editId = "edit-1", expiryTimeSeconds = "1900000000") {
  const calls: string[] = [];
  const insert = vi.fn(async () => {
    calls.push("edits.insert");
    return { data: { id: editId, expiryTimeSeconds } };
  });
  const get = vi.fn(async () => {
    calls.push("edits.get");
    return { data: { id: editId, expiryTimeSeconds } };
  });
  const tracksList = vi.fn(async () => {
    calls.push("edits.tracks.list");
    return {
      data: {
        tracks: [
          { track: "internal", releases: [] },
          {
            track: "production",
            releases: [
              {
                name: "staged-release",
                status: "inProgress",
                versionCodes: ["9223372036854775807"],
                userFraction: 0.2,
                releaseNotes: [{ language: "en-us", text: "Staged note" }],
                serverOnly: rawMarker,
              },
            ],
          },
        ],
      },
    };
  });
  const forbidden = {
    commit: vi.fn(),
    validate: vi.fn(),
    upload: vi.fn(),
    update: vi.fn(),
  };
  const client = {
    version: "v3",
    reviews: {},
    edits: {
      insert,
      get,
      commit: forbidden.commit,
      validate: forbidden.validate,
      bundles: { upload: forbidden.upload },
      tracks: { list: tracksList, update: forbidden.update },
    },
  } as unknown as AndroidPublisherClient;
  return { client, calls, insert, get, tracksList, forbidden };
}

function scriptedLlm(toolName: string): LlmAdapter {
  let turn = 0;
  return {
    provider: "fake-phase42-integration",
    async complete() {
      turn += 1;
      if (turn === 1) {
        return {
          toolCalls: [{ id: "c1", name: toolName, arguments: {} }],
          usage: { totalTokens: 1 },
        };
      }
      return { content: "Done.", toolCalls: [], usage: { totalTokens: 1 } };
    },
  };
}

function runOnce(
  composition: ReleaseComposition,
  toolName: string,
  resolver?: AgentApprovalResolver,
): Promise<AgentRunResult> {
  return runAgent({
    llm: scriptedLlm(toolName),
    registry: composition.registry,
    bindings:
      toolName === RELEASES_OPEN_EDIT_TOOL_NAME
        ? [composition.openBinding]
        : [composition.inspectBinding],
    messages: [{ role: "user", content: "Work on the next release." }],
    limits: { maxSteps: 3, maxToolCalls: 1, maxTotalTokens: 10 },
    ledger: composition.ledger,
    ...(resolver ? { approvalResolver: resolver } : {}),
    runId: () => `phase42-${toolName}`,
  });
}

async function compositionWith(dir: string, fake: ReturnType<typeof fakePublisher>) {
  const composition = createReleaseComposition(makeConfig(dir), {
    publisher: fake.client,
    now: clock,
  });
  return composition;
}

describe("Phase 4.2 explicit open → inspect separation", () => {
  it("44. runs open (approved) then inspect with no insert, using the exact tracked edit id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network forbidden in test"))),
    );
    const dir = makeDir();
    const fake = fakePublisher();
    const composition = await compositionWith(dir, fake);
    const auditPath = join(dir, "audit.jsonl");

    const approved: AgentApprovalResolver = {
      resolve: (request) =>
        approveInteractively(
          request,
          { ask: async () => "yes" },
          { ledger: createFileApprovalLedger(auditPath) },
        ),
    };

    const openResult = await runOnce(composition, RELEASES_OPEN_EDIT_TOOL_NAME, approved);
    expect(openResult).toMatchObject({ ok: true, code: "COMPLETED" });
    expect(fake.insert).toHaveBeenCalledTimes(1);

    const inspectResult = await runOnce(composition, RELEASES_INSPECT_TOOL_NAME);
    expect(inspectResult).toMatchObject({
      ok: true,
      code: "COMPLETED",
      externalStateUncertain: false,
    });
    // No insert during inspection: the tracked session is reused.
    expect(fake.insert).toHaveBeenCalledTimes(1);
    expect(fake.get).toHaveBeenCalledWith({ packageName, editId: "edit-1" }, { retry: false });
    expect(fake.tracksList).toHaveBeenCalledWith(
      { packageName, editId: "edit-1" },
      { retry: false },
    );

    const toolMessage = inspectResult.conversation.at(-2);
    expect(toolMessage?.role).toBe("tool");
    expect(JSON.parse(toolMessage?.content ?? "null")).toEqual({
      tracks: [
        { track: "internal", releases: [] },
        {
          track: "production",
          releases: [
            {
              name: "staged-release",
              status: "inProgress",
              versionCodes: ["9223372036854775807"],
              userFraction: 0.2,
              releaseNotes: [{ language: "en-US", text: "Staged note" }],
            },
          ],
        },
      ],
    });
    expect(toolMessage?.content ?? "").not.toContain("edit-1");
    expect(toolMessage?.content ?? "").not.toContain(rawMarker);

    const audit = readAuditEntries(auditPath);
    const inspectRuns = audit.filter(
      (entry) =>
        entry.type === "agent.run.started" &&
        entry.metadata?.["runId"] === "phase42-releases.inspect",
    );
    expect(inspectRuns).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(rawMarker);
    expect(fake.forbidden.commit).not.toHaveBeenCalled();
    expect(fake.forbidden.validate).not.toHaveBeenCalled();
    expect(fake.forbidden.upload).not.toHaveBeenCalled();
    expect(fake.forbidden.update).not.toHaveBeenCalled();
  });

  it("46. blocks inspection of an expired session with insert 0, then requires an explicit new open", async () => {
    const dir = makeDir();
    const fake = fakePublisher();
    const composition = await compositionWith(dir, fake);
    const auditPath = join(dir, "audit.jsonl");

    // Pre-seed an expired session (older than the injected clock).
    await composition.store.save({
      version: 1,
      packageName,
      editId: "edit-expired",
      expiryTimeSeconds: "1700000000",
      createdAt: "2026-01-01T00:00:00.000Z",
    } satisfies ReleaseEditSession);

    const inspectResult = await runOnce(composition, RELEASES_INSPECT_TOOL_NAME);
    expect(inspectResult).toMatchObject({ ok: false, code: "EXECUTION_FAILED" });
    expect(fake.insert).not.toHaveBeenCalled();
    expect(fake.tracksList).not.toHaveBeenCalled();

    const approved: AgentApprovalResolver = {
      resolve: (request) =>
        approveInteractively(
          request,
          { ask: async () => "yes" },
          { ledger: createFileApprovalLedger(auditPath) },
        ),
    };
    const openResult = await runOnce(composition, RELEASES_OPEN_EDIT_TOOL_NAME, approved);
    expect(openResult).toMatchObject({ ok: true, code: "COMPLETED" });
    expect(fake.insert).toHaveBeenCalledTimes(1);
    expect(
      (JSON.parse(readFileSync(join(dir, "edit-session.json"), "utf8")) as ReleaseEditSession)
        .editId,
    ).toBe("edit-1");
  });

  it("45. leaves an existing active session untouched even under explicit approval", async () => {
    const dir = makeDir();
    const fake = fakePublisher();
    const composition = await compositionWith(dir, fake);
    const auditPath = join(dir, "audit.jsonl");
    const seeded = {
      version: 1,
      packageName,
      editId: "edit-existing",
      expiryTimeSeconds: "1900000000",
      createdAt: "2026-09-28T00:00:00.000Z",
    } satisfies ReleaseEditSession;
    await composition.store.save(seeded);

    const approved: AgentApprovalResolver = {
      resolve: (request) =>
        approveInteractively(
          request,
          { ask: async () => "yes" },
          { ledger: createFileApprovalLedger(auditPath) },
        ),
    };
    const result = await runOnce(composition, RELEASES_OPEN_EDIT_TOOL_NAME, approved);

    expect(result).toMatchObject({ ok: false, code: "EXECUTION_FAILED" });
    // Phase 2.6 surfaces a coarse run code; the domain refusal is preserved as the cause.
    expect((result.cause as { code?: string } | undefined)?.code).toBe("EDIT_SESSION_ALREADY_OPEN");
    expect(fake.insert).not.toHaveBeenCalled();
    expect(await composition.store.load()).toEqual(seeded);
  });

  it("42/43. requires approval for open and never touches the store without it", async () => {
    const dir = makeDir();
    const fake = fakePublisher();
    const composition = await compositionWith(dir, fake);

    const refused = await runOnce(composition, RELEASES_OPEN_EDIT_TOOL_NAME);
    expect(refused).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    expect(fake.insert).not.toHaveBeenCalled();
    expect(await composition.store.load()).toBeUndefined();
  });
});

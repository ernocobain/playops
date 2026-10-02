import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type PlayOpsConfig } from "../src/config/index.js";
import type { AndroidPublisherClient } from "../src/googleplay/publisher/index.js";
import { runAgent } from "../src/runtime/agent/index.js";
import { evaluateToolPermission } from "../src/runtime/permissions/index.js";
import { ToolRegistry } from "../src/runtime/tools/index.js";
import { RELEASES_INSPECT_TOOL_NAME, createReleaseInspectionTool } from "../src/releases/tool.js";
import { createReleaseEditOpenTool } from "../src/releases/open-tool.js";
import {
  createFileReleaseEditSessionStore,
  type ReleaseEditSessionStore,
} from "../src/releases/session-store.js";
import type { ReleaseEditGateway } from "../src/releases/gateway.js";
import type { ReleaseEditSession } from "../src/releases/index.js";
import { createReleaseComposition } from "../src/releases/composition.js";

const packageName = "com.example.release";
const otherPackageName = "com.example.other";
const rawMarker = "RAW-GOOGLE-RELEASE-OBJECT";
const fixedNow = 1_800_000_000_000;
const clock = (): Date => new Date(fixedNow);
let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { force: true, recursive: true });
  tempDir = undefined;
  vi.unstubAllGlobals();
});

function makeTempDir(): string {
  tempDir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-release-inspect-"));
  return tempDir;
}

function makeConfig(logPath: string, sessionPath: string): PlayOpsConfig {
  return {
    ...DEFAULT_CONFIG,
    googlePlay: { packageName, serviceAccountJson: "FAKE-CREDENTIAL-PATH" },
    audit: { logPath },
    release: { editSessionPath: sessionPath, editCleanupJournalPath: "" },
  };
}

function trackedSession(overrides: Partial<ReleaseEditSession> = {}): ReleaseEditSession {
  return {
    version: 1,
    packageName,
    editId: "edit-tracked",
    expiryTimeSeconds: "1900000000",
    createdAt: "2026-09-28T00:00:00.000Z",
    ...overrides,
  };
}

function fakeGateway(
  options: {
    readbackId?: string;
    readbackExpiry?: string;
    getEditError?: unknown;
    tracks?: unknown[];
    onGetEdit?: () => void;
  } = {},
) {
  const createEdit = vi.fn(async () => ({ packageName, editId: "edit-created" }));
  const getEdit = vi.fn(async () => {
    options.onGetEdit?.();
    if (options.getEditError) throw options.getEditError;
    return {
      id: options.readbackId ?? "edit-tracked",
      expiryTimeSeconds: options.readbackExpiry ?? "1900000000",
    };
  });
  const listTracks = vi.fn(async () => options.tracks ?? []);
  const gateway: ReleaseEditGateway = { createEdit, getEdit, listTracks };
  return { gateway, createEdit, getEdit, listTracks };
}

async function seededStore(
  session: ReleaseEditSession | undefined,
  expectedPackageName: string = packageName,
): Promise<{ store: ReleaseEditSessionStore; path: string }> {
  const path = join(makeTempDir(), "edit-session.json");
  const store = createFileReleaseEditSessionStore(path, {
    expectedPackageName,
  });
  if (session) await store.save(session);
  return { store, path };
}

describe("releases.inspect runtime tool (Phase 4.2 read-only refactor)", () => {
  it("registers as read, requires no approval, and declares no verifier", async () => {
    const { store } = await seededStore(trackedSession());
    const built = createReleaseInspectionTool({
      packageName,
      gateway: fakeGateway().gateway,
      store,
      now: clock,
    });
    const registry = new ToolRegistry();
    registry.register(built.tool);
    const registered = registry.get(RELEASES_INSPECT_TOOL_NAME);

    expect(registered.permission).toBe("read");
    expect(registered.verify).toBeUndefined();
    expect(evaluateToolPermission(registered)).toMatchObject({
      allowed: true,
      code: "ALLOWED",
      requiresApproval: false,
    });
    expect(registered.description).toContain("never creates");
  });

  it("exposes an empty authoritative input schema; package and edit id are not model inputs", async () => {
    const { store } = await seededStore(trackedSession());
    const built = createReleaseInspectionTool({
      packageName,
      gateway: fakeGateway().gateway,
      store,
      now: clock,
    });

    expect(built.tool.inputSchema.parse({})).toEqual({});
    for (const invalid of [
      null,
      [],
      { packageName },
      { editId: "attacker-choice" },
      { anything: true },
    ]) {
      expect(() => built.tool.inputSchema.parse(invalid)).toThrow();
    }
    expect(built.binding.llm.inputSchema).toMatchObject({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("uses the exact tracked edit id, read-validates the session, and lists tracks", async () => {
    const { store } = await seededStore(trackedSession());
    const fake = fakeGateway({
      tracks: [
        {
          track: "production",
          releases: [
            {
              status: "inProgress",
              versionCodes: ["123"],
              userFraction: 0.1,
              releaseNotes: [{ language: "en-us", text: "Public note" }],
              apiSecret: rawMarker,
            },
          ],
        },
      ],
    });
    const built = createReleaseInspectionTool({
      packageName,
      gateway: fake.gateway,
      store,
      now: clock,
    });

    const result = await built.tool.execute({}, {});

    expect(fake.createEdit).not.toHaveBeenCalled();
    expect(fake.getEdit).toHaveBeenCalledWith({
      packageName,
      editId: "edit-tracked",
      expiryTimeSeconds: "1900000000",
    });
    expect(fake.listTracks).toHaveBeenCalledWith({
      packageName,
      editId: "edit-tracked",
      expiryTimeSeconds: "1900000000",
    });
    expect(result.session.editId).toBe("edit-tracked");

    const serialized = built.binding.serializeResult(result, {
      toolName: RELEASES_INSPECT_TOOL_NAME,
      permission: "read",
      required: false,
      status: "skipped",
      code: "VERIFICATION_SKIPPED",
      verified: false,
    });
    expect(JSON.parse(serialized)).toEqual({
      tracks: [
        {
          track: "production",
          releases: [
            {
              status: "inProgress",
              versionCodes: ["123"],
              userFraction: 0.1,
              releaseNotes: [{ language: "en-US", text: "Public note" }],
            },
          ],
        },
      ],
    });
    expect(serialized).not.toContain("edit-tracked");
    expect(serialized).not.toContain(rawMarker);
  });

  it("fails with EDIT_SESSION_REQUIRED and performs no edit creation when nothing is tracked", async () => {
    const { store } = await seededStore(undefined);
    const fake = fakeGateway();
    const built = createReleaseInspectionTool({
      packageName,
      gateway: fake.gateway,
      store,
      now: clock,
    });

    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      name: "ReleaseError",
      code: "EDIT_SESSION_REQUIRED",
    });
    expect(fake.createEdit).not.toHaveBeenCalled();
    expect(fake.getEdit).not.toHaveBeenCalled();
    expect(fake.listTracks).not.toHaveBeenCalled();
  });

  it("fails with EDIT_SESSION_EXPIRED for an expired tracked session and never replaces it", async () => {
    const { store, path } = await seededStore(trackedSession({ expiryTimeSeconds: "1700000000" }));
    const fake = fakeGateway();
    const built = createReleaseInspectionTool({
      packageName,
      gateway: fake.gateway,
      store,
      now: clock,
    });

    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "EDIT_SESSION_EXPIRED",
    });
    expect(fake.createEdit).not.toHaveBeenCalled();
    expect(fake.listTracks).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(path, "utf8")).editId).toBe("edit-tracked");
  });

  it("fails on package mismatch without using, deleting, or replacing the session", async () => {
    const { path } = await seededStore(
      trackedSession({ packageName: otherPackageName }),
      otherPackageName,
    );
    const boundStore = createFileReleaseEditSessionStore(path, {
      expectedPackageName: packageName,
    });
    const fake = fakeGateway();
    const built = createReleaseInspectionTool({
      packageName,
      gateway: fake.gateway,
      store: boundStore,
      now: clock,
    });

    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "EDIT_SESSION_PACKAGE_MISMATCH",
    });
    expect(fake.createEdit).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(path, "utf8")).packageName).toBe(otherPackageName);
  });

  it("fails with EDIT_SESSION_INVALID when the remote edit no longer matches", async () => {
    const { store, path } = await seededStore(trackedSession());
    const fake = fakeGateway({ readbackId: "different-edit" });
    const built = createReleaseInspectionTool({
      packageName,
      gateway: fake.gateway,
      store,
      now: clock,
    });

    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "EDIT_SESSION_INVALID",
    });
    expect(fake.createEdit).not.toHaveBeenCalled();
    expect(fake.listTracks).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(path, "utf8")).editId).toBe("edit-tracked");
  });

  it("fails with EDIT_SESSION_INVALID when the tracked edit cannot be read back", async () => {
    const { store } = await seededStore(trackedSession());
    const fake = fakeGateway({ getEditError: new Error("FAKE-READ-FAILURE-SECRET") });
    const built = createReleaseInspectionTool({
      packageName,
      gateway: fake.gateway,
      store,
      now: clock,
    });

    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "EDIT_SESSION_INVALID",
    });
    expect(fake.createEdit).not.toHaveBeenCalled();
  });

  it("treats corrupt tracked state as a safe failure and does not overwrite it", async () => {
    const dir = makeTempDir();
    const path = join(dir, "edit-session.json");
    writeFileSync(path, "{ not json", "utf8");
    const store = createFileReleaseEditSessionStore(path, { expectedPackageName: packageName });
    const fake = fakeGateway();
    const built = createReleaseInspectionTool({
      packageName,
      gateway: fake.gateway,
      store,
      now: clock,
    });

    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      code: "EDIT_SESSION_STORE_INVALID",
    });
    expect(fake.createEdit).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });

  it("runs through the real Phase 2 runtime with no insert and no approval", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network forbidden in test"))),
    );
    const dir = makeTempDir();
    const insert = vi.fn();
    const publisher = {
      version: "v3",
      reviews: {},
      edits: {
        insert,
        get: vi.fn(async () => ({
          data: { id: "edit-tracked", expiryTimeSeconds: "1900000000" },
        })),
        tracks: {
          list: vi.fn(async () => ({
            data: { tracks: [{ track: "production", releases: [{ status: "completed" }] }] },
          })),
        },
      },
    } as unknown as AndroidPublisherClient;
    const composition = createReleaseComposition(
      makeConfig(join(dir, "audit.jsonl"), join(dir, "edit-session.json")),
      { publisher, now: clock },
    );
    await composition.store.save(trackedSession());

    const turns: number[] = [];
    const llm = {
      provider: "fake-phase42",
      async complete() {
        const turn = turns.length;
        turns.push(turn);
        if (turn === 0) {
          return {
            toolCalls: [{ id: "c1", name: RELEASES_INSPECT_TOOL_NAME, arguments: {} }],
            usage: { totalTokens: 1 },
          };
        }
        return { content: "Inspection done.", toolCalls: [], usage: { totalTokens: 1 } };
      },
    };

    const result = await runAgent({
      llm,
      registry: composition.registry,
      bindings: [composition.inspectBinding],
      messages: [{ role: "user", content: "Inspect release state." }],
      limits: { maxSteps: 3, maxToolCalls: 1, maxTotalTokens: 10 },
      ledger: composition.ledger,
      runId: () => "phase42-inspect-run",
    });

    expect(result).toMatchObject({ ok: true, code: "COMPLETED", externalStateUncertain: false });
    expect(result.finalContent).toBe("Inspection done.");
    expect(insert).not.toHaveBeenCalled();
    const auditText = readFileSync(join(dir, "audit.jsonl"), "utf8");
    expect(auditText).toContain("verification.completed");
    expect(auditText).not.toContain("edit-tracked");
    expect(auditText).not.toMatch(/approval\./u);
  });

  it("source-scans Phase 4.2 tool/gateway files for forbidden release mutations", () => {
    const paths = [
      "src/releases/index.ts",
      "src/releases/gateway.ts",
      "src/releases/session-store.ts",
      "src/releases/androidpublisher.ts",
      "src/releases/tool.ts",
      "src/releases/open-tool.ts",
      "src/releases/composition.ts",
    ];
    const source = paths
      .map((path) => readFileSync(join(process.cwd(), path), "utf8"))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/(^|[^:])\/\/.*$/gmu, "$1");

    expect(source).not.toMatch(/edits\.commit|commit\s*\(/u);
    expect(source).not.toMatch(/\.validate\s*\(/u);
    expect(source).not.toMatch(/bundles\s*\.\s*upload/u);
    expect(source).not.toMatch(/tracks\s*\.\s*update/u);
    expect(source).not.toMatch(/runtime\/browser/u);

    const inspectSource = readFileSync(join(process.cwd(), "src/releases/tool.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/(^|[^:])\/\/.*$/gmu, "$1");
    expect(inspectSource).not.toMatch(/createEdit/u);
    expect(inspectSource).not.toMatch(/insert/u);

    const openSource = readFileSync(join(process.cwd(), "src/releases/open-tool.ts"), "utf8");
    expect(openSource).not.toMatch(/bundles/u);
    expect(openSource).not.toMatch(/tracks\.update/u);
    expect(openSource).not.toMatch(/\.commit\s*\(/u);
    expect(openSource).not.toMatch(/\.validate\s*\(/u);
  });

  it("never exposes a force/replace/overwrite option on either tool", async () => {
    const { store } = await seededStore(trackedSession());
    const fake = fakeGateway();
    const open = createReleaseEditOpenTool({
      packageName,
      gateway: fake.gateway,
      store,
      now: clock,
    });
    const inspect = createReleaseInspectionTool({
      packageName,
      gateway: fake.gateway,
      store,
      now: clock,
    });
    for (const built of [open.binding, inspect.binding]) {
      const schema = JSON.stringify(built.llm.inputSchema);
      expect(schema).not.toMatch(/force|replace|overwrite/u);
      expect(schema).not.toMatch(/packageName|editId|path|credential|retry/u);
    }
  });
});

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateToolPermission } from "../src/runtime/permissions/index.js";
import { ToolRegistry } from "../src/runtime/tools/index.js";
import {
  createFileReleaseEditSessionStore,
  type ReleaseEditSessionStore,
} from "../src/releases/session-store.js";
import {
  createReleaseBundleUploadTool,
  RELEASES_UPLOAD_BUNDLE_TOOL_NAME,
} from "../src/releases/bundle-upload-tool.js";
import type { ReleaseBundleUploadGateway } from "../src/releases/gateway.js";
import type { ReleaseBundle, ReleaseEditSession } from "../src/releases/index.js";

const packageName = "com.example.bundle";
const editId = "edit-managed-42";
const expiryTimeSeconds = "1900000000";
const fixedNow = new Date("2027-01-15T08:00:00.000Z");
const clock = (): Date => new Date(fixedNow);
let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { force: true, recursive: true });
  tempDir = undefined;
  vi.unstubAllGlobals();
});

function makeDir(): string {
  tempDir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-bundle-upload-"));
  return tempDir;
}

function makeSession(overrides: Partial<ReleaseEditSession> = {}): ReleaseEditSession {
  return {
    version: 1,
    packageName,
    editId,
    expiryTimeSeconds,
    createdAt: "2026-09-28T00:00:00.000Z",
    ...overrides,
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function storeAt(
  path: string,
  session?: ReleaseEditSession,
): Promise<ReleaseEditSessionStore> {
  const store = createFileReleaseEditSessionStore(path, { expectedPackageName: packageName });
  if (session) await store.save(session);
  return store;
}

function fakeGateway(
  options: {
    readonly remoteId?: string;
    readonly remoteExpiry?: string;
    readonly readback?: readonly ReleaseBundle[];
    readonly uploadResult?: ReleaseBundle;
    readonly getError?: unknown;
    readonly uploadError?: unknown;
    readonly listError?: unknown;
  } = {},
) {
  const calls: {
    readonly getEdit: unknown[];
    readonly uploadBundle: unknown[];
    readonly listBundles: unknown[];
  } = { getEdit: [], uploadBundle: [], listBundles: [] };
  const uploaded: Buffer[] = [];
  const getEdit = vi.fn(async (session: unknown) => {
    calls.getEdit.push(session);
    if (options.getError) throw options.getError;
    return {
      id: options.remoteId ?? editId,
      expiryTimeSeconds: options.remoteExpiry ?? expiryTimeSeconds,
    };
  });
  const uploadBundle = vi.fn(async (_session: unknown, request: { body: Readable }) => {
    calls.uploadBundle.push({
      session: _session,
      requestKeys: Object.keys(request),
    });
    if (options.uploadError) throw options.uploadError;
    const chunks: Buffer[] = [];
    for await (const chunk of request.body) chunks.push(Buffer.from(chunk));
    uploaded.push(Buffer.concat(chunks));
    return (
      options.uploadResult ?? {
        versionCode: "73",
        sha256: sha256(uploaded.at(-1) ?? Buffer.alloc(0)),
      }
    );
  });
  const listBundles = vi.fn(async (session: unknown) => {
    calls.listBundles.push(session);
    if (options.listError) throw options.listError;
    return options.readback ?? [];
  });
  const gateway: ReleaseBundleUploadGateway = { getEdit, uploadBundle, listBundles };
  return { gateway, calls, getEdit, uploadBundle, listBundles, uploaded };
}

async function fixture(
  dir = makeDir(),
  name = "candidate.aab",
): Promise<{ path: string; bytes: Buffer }> {
  const bytes = Buffer.from([0, 1, 2, 255, 16, 32, 64]);
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return { path, bytes };
}

function buildTool(options: {
  readonly artifactPath: string;
  readonly store: ReleaseEditSessionStore;
  readonly gateway: ReleaseBundleUploadGateway;
}) {
  return createReleaseBundleUploadTool({
    packageName,
    artifactPath: options.artifactPath,
    sessionStore: options.store,
    gateway: options.gateway,
    now: clock,
  });
}

describe("releases.upload_bundle tool contract", () => {
  it("registers as write with a mandatory verifier and no model-supplied path", async () => {
    const dir = makeDir();
    const { path } = await fixture(dir);
    const store = await storeAt(join(dir, "edit-session.json"), makeSession());
    const fake = fakeGateway();
    const built = buildTool({ artifactPath: path, store, gateway: fake.gateway });
    const registry = new ToolRegistry();
    registry.register(built.tool);
    const registered = registry.get(RELEASES_UPLOAD_BUNDLE_TOOL_NAME);

    expect(registered.permission).toBe("write");
    expect(registered.verify).toBeTypeOf("function");
    expect(evaluateToolPermission(registered)).toMatchObject({
      allowed: true,
      code: "ALLOWED",
      requiresApproval: false,
    });
    expect(registered.inputSchema.parse({})).toEqual({});
    expect(() => registered.inputSchema.parse({ artifactPath: "/tmp/other.aab" })).toThrow();
    expect(built.binding.approval).toBeUndefined();
    expect(JSON.stringify(built.binding.llm.inputSchema)).not.toMatch(
      /path|packageName|editId|retry|timeout|ackBundle/i,
    );
  });

  it("hashes and streams the exact existing bytes into the tracked edit once without legacy acknowledgement", async () => {
    const dir = makeDir();
    const { path, bytes } = await fixture(dir);
    const store = await storeAt(join(dir, "edit-session.json"), makeSession());
    const localHash = sha256(bytes);
    const fake = fakeGateway({ readback: [{ versionCode: "73", sha256: localHash }] });
    const legacyBoundOptions = Object.assign(
      {
        packageName,
        artifactPath: path,
        sessionStore: store,
        gateway: fake.gateway,
        now: clock,
      },
      { ackBundleInstallationWarning: true },
    );
    const built = createReleaseBundleUploadTool(legacyBoundOptions);

    const output = await built.tool.execute({}, {});

    expect(fake.getEdit).toHaveBeenCalledTimes(1);
    expect(fake.getEdit).toHaveBeenCalledWith({ packageName, editId, expiryTimeSeconds });
    expect(fake.uploadBundle).toHaveBeenCalledTimes(1);
    expect(fake.calls.uploadBundle).toEqual([
      { session: { packageName, editId, expiryTimeSeconds }, requestKeys: ["body"] },
    ]);
    expect(fake.uploaded).toEqual([bytes]);
    expect(output).toMatchObject({
      editId,
      expiryTimeSeconds,
      versionCode: "73",
      sha256: localHash,
      uploaded: true,
    });
    expect(readFileSync(path)).toEqual(bytes);

    const verify = built.tool.verify;
    expect(verify).toBeTypeOf("function");
    if (!verify) throw new Error("upload_bundle must have a verifier");
    await expect(verify({}, output, {})).resolves.toBe(true);
    expect(fake.listBundles).toHaveBeenCalledTimes(1);
    expect(fake.listBundles).toHaveBeenCalledWith({ packageName, editId, expiryTimeSeconds });
  });

  it("stops before upload if the bound artifact changes during remote session validation", async () => {
    const dir = makeDir();
    const { path } = await fixture(dir);
    const store = await storeAt(join(dir, "edit-session.json"), makeSession());
    const fake = fakeGateway();
    const getEdit = vi.fn(async () => {
      writeFileSync(path, Buffer.from("different fake bytes"));
      return { id: editId, expiryTimeSeconds };
    });
    const gateway: ReleaseBundleUploadGateway = { ...fake.gateway, getEdit };

    const failure = await buildTool({ artifactPath: path, store, gateway })
      .tool.execute({}, {})
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toMatchObject({ code: "ARTIFACT_CHANGED" });
    expect(fake.uploadBundle).not.toHaveBeenCalled();
  });

  it("rejects a blank operator path at factory composition time", async () => {
    const dir = makeDir();
    const store = await storeAt(join(dir, "edit-session.json"));
    const fake = fakeGateway();

    expect(() => buildTool({ artifactPath: "  ", store, gateway: fake.gateway })).toThrowError(
      expect.objectContaining({ code: "ARTIFACT_INVALID" }),
    );
    expect(fake.getEdit).not.toHaveBeenCalled();
    expect(fake.uploadBundle).not.toHaveBeenCalled();
  });

  it("rejects an absent tracked session before any Google boundary call", async () => {
    const dir = makeDir();
    const { path } = await fixture(dir);
    const store = await storeAt(join(dir, "edit-session.json"));
    const fake = fakeGateway();
    const built = buildTool({ artifactPath: path, store, gateway: fake.gateway });

    await expect(built.tool.execute({}, {})).rejects.toMatchObject({
      name: "ReleaseError",
      code: "EDIT_SESSION_REQUIRED",
    });
    expect(fake.getEdit).not.toHaveBeenCalled();
    expect(fake.uploadBundle).not.toHaveBeenCalled();
  });

  it("rejects a missing, empty, non-file, or wrong-extension artifact before Google calls", async () => {
    const dir = makeDir();
    const store = await storeAt(join(dir, "edit-session.json"), makeSession());
    const fake = fakeGateway();
    const missing = join(dir, "missing.aab");
    const empty = join(dir, "empty.aab");
    writeFileSync(empty, Buffer.alloc(0));
    const folder = join(dir, "folder.aab");
    mkdirSync(folder);
    const wrong = join(dir, "candidate.zip");
    writeFileSync(wrong, Buffer.from("bytes"));

    expect(() => buildTool({ artifactPath: wrong, store, gateway: fake.gateway })).toThrowError(
      expect.objectContaining({ code: "ARTIFACT_INVALID" }),
    );
    for (const [path, code] of [
      [missing, "ARTIFACT_NOT_FOUND"],
      [folder, "ARTIFACT_INVALID"],
      [empty, "ARTIFACT_INVALID"],
    ] as const) {
      const built = buildTool({ artifactPath: path, store, gateway: fake.gateway });
      const failure = await built.tool.execute({}, {}).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ code });
      if (failure instanceof Error) expect(failure.message).not.toContain(path);
    }
    expect(fake.getEdit).not.toHaveBeenCalled();
    expect(fake.uploadBundle).not.toHaveBeenCalled();
  });

  it("rejects a session belonging to another configured package before remote validation", async () => {
    const dir = makeDir();
    const { path } = await fixture(dir);
    const store = createFileReleaseEditSessionStore(join(dir, "other-package.json"), {
      expectedPackageName: "com.other.bundle",
    });
    await store.save(makeSession({ packageName: "com.other.bundle" }));
    const fake = fakeGateway();

    await expect(
      buildTool({ artifactPath: path, store, gateway: fake.gateway }).tool.execute({}, {}),
    ).rejects.toMatchObject({ code: "EDIT_SESSION_PACKAGE_MISMATCH" });
    expect(fake.getEdit).not.toHaveBeenCalled();
    expect(fake.uploadBundle).not.toHaveBeenCalled();
  });

  it("rejects an expired or mismatched tracked remote session without uploading", async () => {
    const dir = makeDir();
    const { path } = await fixture(dir);
    const expiredStore = await storeAt(
      join(dir, "expired.json"),
      makeSession({ expiryTimeSeconds: "1700000000" }),
    );
    const expiredGateway = fakeGateway();
    await expect(
      buildTool({
        artifactPath: path,
        store: expiredStore,
        gateway: expiredGateway.gateway,
      }).tool.execute({}, {}),
    ).rejects.toMatchObject({ code: "EDIT_SESSION_EXPIRED" });
    expect(expiredGateway.getEdit).not.toHaveBeenCalled();
    expect(expiredGateway.uploadBundle).not.toHaveBeenCalled();

    const validStore = await storeAt(join(dir, "valid.json"), makeSession());
    const invalidGateway = fakeGateway({ remoteId: "different-edit" });
    await expect(
      buildTool({
        artifactPath: path,
        store: validStore,
        gateway: invalidGateway.gateway,
      }).tool.execute({}, {}),
    ).rejects.toMatchObject({ code: "EDIT_SESSION_INVALID" });
    expect(invalidGateway.uploadBundle).not.toHaveBeenCalled();

    const expiryGateway = fakeGateway({ remoteExpiry: "1900000001" });
    await expect(
      buildTool({
        artifactPath: path,
        store: validStore,
        gateway: expiryGateway.gateway,
      }).tool.execute({}, {}),
    ).rejects.toMatchObject({ code: "EDIT_SESSION_INVALID" });
    expect(expiryGateway.uploadBundle).not.toHaveBeenCalled();

    const malformedExpiryGateway = fakeGateway({ remoteExpiry: "not-epoch-seconds" });
    await expect(
      buildTool({
        artifactPath: path,
        store: validStore,
        gateway: malformedExpiryGateway.gateway,
      }).tool.execute({}, {}),
    ).rejects.toMatchObject({ code: "EDIT_SESSION_INVALID" });
    expect(malformedExpiryGateway.uploadBundle).not.toHaveBeenCalled();

    const unavailableGateway = fakeGateway({ getError: new Error("fake read failure") });
    await expect(
      buildTool({
        artifactPath: path,
        store: validStore,
        gateway: unavailableGateway.gateway,
      }).tool.execute({}, {}),
    ).rejects.toMatchObject({ code: "EDIT_SESSION_INVALID" });
    expect(unavailableGateway.uploadBundle).not.toHaveBeenCalled();
  });

  it("rejects a Google upload hash that differs from the operator-bound local SHA-256", async () => {
    const dir = makeDir();
    const { path } = await fixture(dir);
    const store = await storeAt(join(dir, "edit-session.json"), makeSession());
    const fake = fakeGateway({ uploadResult: { versionCode: "73", sha256: "f".repeat(64) } });

    await expect(
      buildTool({ artifactPath: path, store, gateway: fake.gateway }).tool.execute({}, {}),
    ).rejects.toMatchObject({ code: "UPLOAD_RESPONSE_INVALID" });
    expect(fake.uploadBundle).toHaveBeenCalledTimes(1);
  });

  it("searches list results for the exact versionCode+sha256 pair regardless of order", async () => {
    const dir = makeDir();
    const { path, bytes } = await fixture(dir);
    const store = await storeAt(join(dir, "edit-session.json"), makeSession());
    const localHash = sha256(bytes);
    const fake = fakeGateway({
      readback: [
        { versionCode: "73", sha256: "f".repeat(64) },
        { versionCode: "74", sha256: localHash },
        { versionCode: "73", sha256: localHash },
      ],
    });
    const built = buildTool({ artifactPath: path, store, gateway: fake.gateway });
    const output = await built.tool.execute({}, {});
    const verify = built.tool.verify;
    if (!verify) throw new Error("upload_bundle must have a verifier");

    await expect(verify({}, output, {})).resolves.toBe(true);
    expect(fake.listBundles).toHaveBeenCalledTimes(1);
  });

  it("does not accept a matching hash or versionCode in isolation", async () => {
    const dir = makeDir();
    const { path, bytes } = await fixture(dir);
    const store = await storeAt(join(dir, "edit-session.json"), makeSession());
    const localHash = sha256(bytes);
    const fake = fakeGateway({
      readback: [
        { versionCode: "73", sha256: "f".repeat(64) },
        { versionCode: "74", sha256: localHash },
      ],
    });
    const built = buildTool({ artifactPath: path, store, gateway: fake.gateway });
    const output = await built.tool.execute({}, {});
    const verify = built.tool.verify;
    if (!verify) throw new Error("upload_bundle must have a verifier");

    await expect(verify({}, output, {})).resolves.toBe(false);
  });

  it("fails mandatory verification closed when bundles.list cannot be read", async () => {
    const dir = makeDir();
    const { path } = await fixture(dir);
    const store = await storeAt(join(dir, "edit-session.json"), makeSession());
    const fake = fakeGateway({ listError: new Error("fake readback failure") });
    const built = buildTool({ artifactPath: path, store, gateway: fake.gateway });
    const output = await built.tool.execute({}, {});
    const verify = built.tool.verify;
    if (!verify) throw new Error("upload_bundle must have a verifier");

    await expect(verify({}, output, {})).resolves.toBe(false);
    expect(fake.listBundles).toHaveBeenCalledTimes(1);
  });
});

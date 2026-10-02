import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateToolPermission } from "../src/runtime/permissions/index.js";
import { ToolRegistry } from "../src/runtime/tools/index.js";
import type { AndroidPublisherClient } from "../src/googleplay/publisher/index.js";
import {
  compareVersionCodeAgainstTrack,
  normalizeReleaseTracks,
  ReleaseError,
  type GooglePlayEditSession,
  type ReleaseBundle,
  type ReleaseEditSession,
  type ReleaseTrackState,
} from "../src/releases/index.js";
import { createAndroidPublisherReleaseGateway } from "../src/releases/androidpublisher.js";
import type { ReleaseVersionCodeVerificationGateway } from "../src/releases/gateway.js";
import {
  createFileReleaseEditSessionStore,
  type ReleaseEditSessionStore,
} from "../src/releases/session-store.js";
import {
  createReleaseVersionCodeVerificationTool,
  RELEASES_VERIFY_VERSION_CODE_TOOL_NAME,
} from "../src/releases/version-code-tool.js";

const packageName = "com.example.release";
const otherPackageName = "com.example.other";
const editId = "edit-managed-44";
const expiryTimeSeconds = "1900000000";
const fixedNow = new Date("2026-09-28T04:00:00.000Z");
const clock = (): Date => new Date(fixedNow);
const bundleHash = "a".repeat(64);
const otherHash = "b".repeat(64);
const uploadedBundle: ReleaseBundle = { versionCode: "101", sha256: bundleHash };
let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs = [];
});

function makeDir(): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-version-code-"));
  tempDirs.push(dir);
  return dir;
}

function session(overrides: Partial<ReleaseEditSession> = {}): ReleaseEditSession {
  return {
    version: 1,
    packageName,
    editId,
    expiryTimeSeconds,
    createdAt: "2026-09-28T00:00:00.000Z",
    ...overrides,
  };
}

function track(
  releases: readonly Record<string, unknown>[] = [],
  trackName = "production",
): ReleaseTrackState {
  const [normalized] = normalizeReleaseTracks([{ track: trackName, releases }]);
  if (!normalized) throw new Error("test fixture track did not normalize");
  return normalized;
}

interface FakeGatewayOptions {
  readonly remoteEdit?: { readonly id: string; readonly expiryTimeSeconds?: string };
  readonly getEditError?: unknown;
  readonly bundles?: readonly ReleaseBundle[];
  readonly listBundlesError?: unknown;
  readonly track?: ReleaseTrackState;
  readonly getTrackError?: unknown;
}

function fakeGateway(options: FakeGatewayOptions = {}) {
  const events: string[] = [];
  const getEdit = vi.fn(async (_session: GooglePlayEditSession) => {
    events.push("getEdit");
    if (options.getEditError) throw options.getEditError;
    return options.remoteEdit ?? { id: editId, expiryTimeSeconds };
  });
  const listBundles = vi.fn(async (_session: GooglePlayEditSession) => {
    events.push("listBundles");
    if (options.listBundlesError) throw options.listBundlesError;
    return options.bundles ?? [uploadedBundle];
  });
  const getTrack = vi.fn(async (_session: GooglePlayEditSession, trackName: string) => {
    events.push("getTrack");
    if (options.getTrackError) throw options.getTrackError;
    return options.track ?? track([], trackName);
  });
  const gateway: ReleaseVersionCodeVerificationGateway = { getEdit, listBundles, getTrack };
  return { gateway, events, getEdit, listBundles, getTrack };
}

async function setup(
  options: {
    readonly seededSession?: ReleaseEditSession | false;
    readonly targetTrack?: string;
    readonly bundle?: ReleaseBundle;
    readonly gateway?: FakeGatewayOptions;
  } = {},
): Promise<{
  readonly tool: ReturnType<typeof createReleaseVersionCodeVerificationTool>;
  readonly store: ReleaseEditSessionStore;
  readonly fake: ReturnType<typeof fakeGateway>;
}> {
  const dir = makeDir();
  const store = createFileReleaseEditSessionStore(join(dir, "edit-session.json"), {
    expectedPackageName: packageName,
  });
  if (options.seededSession !== false) {
    await store.save(options.seededSession ?? session());
  }
  const fake = fakeGateway(options.gateway);
  const tool = createReleaseVersionCodeVerificationTool({
    packageName,
    targetTrack: options.targetTrack ?? "production",
    uploadedBundle: options.bundle ?? uploadedBundle,
    gateway: fake.gateway,
    sessionStore: store,
    now: clock,
  });
  return { tool, store, fake };
}

describe("pure target-track versionCode comparison", () => {
  it.each([
    ["2", ["1"], "greater"],
    ["10", ["9"], "greater"],
    ["100", ["99"], "greater"],
    ["10", ["2"], "greater"],
    ["9", ["10"], "lower"],
    ["100", ["100"], "equal"],
    ["99", ["100"], "lower"],
  ] as const)("compares uploaded %s to current %j as %s", (uploaded, current, relation) => {
    const result = compareVersionCodeAgainstTrack(
      uploaded,
      track([{ status: "completed", versionCodes: current }]),
    );
    expect(result.relation).toBe(relation);
  });

  it("finds the maximum across unsorted releases, versionCodes, statuses, and duplicates", () => {
    const result = compareVersionCodeAgainstTrack(
      "101",
      track([
        { status: "completed", versionCodes: ["9", "10"] },
        { status: "draft", versionCodes: ["100", "50"] },
        { status: "halted", versionCodes: ["100", "70"] },
        { status: "inProgress", versionCodes: ["11"] },
      ]),
    );
    expect(result).toEqual({
      uploadedVersionCode: "101",
      currentMaxVersionCode: "100",
      relation: "greater",
    });
  });

  it("returns null and no-current-version for zero releases or releases without codes", () => {
    expect(compareVersionCodeAgainstTrack("1", track([]))).toMatchObject({
      currentMaxVersionCode: null,
      relation: "no-current-version",
    });
    expect(
      compareVersionCodeAgainstTrack(
        "1",
        track([{ status: "draft" }, { status: "completed", versionCodes: [] }]),
      ),
    ).toMatchObject({ currentMaxVersionCode: null, relation: "no-current-version" });
  });

  it("compares validated very large decimal values losslessly without converting to Number", () => {
    const result = compareVersionCodeAgainstTrack(
      "9007199254740993",
      track([{ status: "completed", versionCodes: ["9007199254740992"] }]),
    );
    expect(result).toEqual({
      uploadedVersionCode: "9007199254740993",
      currentMaxVersionCode: "9007199254740992",
      relation: "greater",
    });
    expect(
      compareVersionCodeAgainstTrack(
        "9223372036854775807",
        track([{ status: "completed", versionCodes: ["9223372036854775806"] }]),
      ).relation,
    ).toBe("greater");
    expect(
      compareVersionCodeAgainstTrack(
        "9223372036854775806",
        track([{ status: "completed", versionCodes: ["9223372036854775807"] }]),
      ).relation,
    ).toBe("lower");
  });

  it("rejects malformed version codes using the existing normalized release contract", () => {
    for (const invalid of [12, "0", "01", "-1", "1.2", "9223372036854775808"]) {
      expect(() =>
        normalizeReleaseTracks([
          { track: "production", releases: [{ status: "completed", versionCodes: [invalid] }] },
        ]),
      ).toThrowError(ReleaseError);
    }
  });

  it("returns a frozen comparison result", () => {
    const result = compareVersionCodeAgainstTrack(
      "101",
      track([{ status: "completed", versionCodes: ["100"] }]),
    );
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe("Android Publisher target-track read adapter", () => {
  it("uses bounded read retry and forwards the exact package/edit/track with generated retry disabled", async () => {
    const calls: { readonly params: unknown; readonly options: unknown }[] = [];
    const temporary = Object.assign(new Error("PRIVATE-TRACK-RETRY-DETAIL"), { status: 503 });
    const responses: unknown[] = [
      temporary,
      {
        track: "production",
        releases: [{ status: "completed", versionCodes: ["9", "10"] }],
        serverOnly: "RAW-TRACK-DETAIL",
      },
    ];
    const getTrack = vi.fn(async (params: unknown, options: unknown) => {
      calls.push({ params, options });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { data: next };
    });
    const publisher = {
      version: "v3",
      reviews: {},
      edits: { get: vi.fn(), tracks: { get: getTrack } },
    } as unknown as AndroidPublisherClient;
    const sleeps: number[] = [];
    const gateway = createAndroidPublisherReleaseGateway(publisher, packageName, {
      policy: { maxAttempts: 2, baseDelayMs: 2, maxDelayMs: 2 },
      sleep: async (delay) => void sleeps.push(delay),
      random: () => 0,
    });

    const trackResult = await gateway.getTrack(
      { packageName, editId, expiryTimeSeconds },
      "production",
    );

    expect(calls).toEqual([
      {
        params: { packageName, editId, track: "production" },
        options: { retry: false },
      },
      {
        params: { packageName, editId, track: "production" },
        options: { retry: false },
      },
    ]);
    expect(sleeps).toEqual([1]);
    expect(trackResult).toEqual({
      track: "production",
      releases: [{ status: "completed", versionCodes: ["9", "10"] }],
    });
    expect(JSON.stringify(trackResult)).not.toContain("RAW-TRACK-DETAIL");
  });
});

describe("releases.verify_version_code tool contract", () => {
  it("registers as read, with no verifier or approval, and an empty model input", async () => {
    const { tool, fake } = await setup();
    const registry = new ToolRegistry();
    registry.register(tool.tool);
    const registered = registry.get(RELEASES_VERIFY_VERSION_CODE_TOOL_NAME);

    expect(registered.permission).toBe("read");
    expect(registered.verify).toBeUndefined();
    expect(evaluateToolPermission(registered)).toMatchObject({
      allowed: true,
      code: "ALLOWED",
      requiresApproval: false,
    });
    expect(tool.binding.approval).toBeUndefined();
    expect(registered.inputSchema.parse({})).toEqual({});
    for (const invalid of [
      null,
      [],
      { targetTrack: "production" },
      { uploadedVersionCode: "101" },
      { sha256: bundleHash },
      { packageName },
      { editId },
      { sessionPath: "/operator/session.json" },
      { credentials: "not-accepted" },
    ]) {
      expect(() => registered.inputSchema.parse(invalid)).toThrow();
    }
    expect(tool.binding.llm.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(fake.events).toEqual([]);
  });

  it("reconfirms the exact uploaded versionCode+sha256 on the tracked edit before reading the track", async () => {
    const { tool, fake } = await setup({
      gateway: {
        bundles: [
          { versionCode: "102", sha256: otherHash },
          { versionCode: "101", sha256: otherHash },
          { versionCode: "100", sha256: bundleHash },
          { versionCode: "101", sha256: bundleHash },
        ],
        track: track([{ status: "completed", versionCodes: ["100"] }]),
      },
    });

    const result = await tool.tool.execute({}, {});

    expect(fake.events).toEqual(["getEdit", "listBundles", "getTrack"]);
    expect(fake.getEdit).toHaveBeenCalledWith({ packageName, editId, expiryTimeSeconds });
    expect(fake.listBundles).toHaveBeenCalledWith({ packageName, editId, expiryTimeSeconds });
    expect(fake.getTrack).toHaveBeenCalledWith(
      { packageName, editId, expiryTimeSeconds },
      "production",
    );
    expect(result).toEqual({
      targetTrack: "production",
      uploadedVersionCode: "101",
      currentMaxVersionCode: "100",
      comparison: "greater",
      verified: true,
    });
  });

  it.each([
    { bundles: [{ versionCode: "101", sha256: otherHash }] },
    { bundles: [{ versionCode: "100", sha256: bundleHash }] },
    { bundles: [] },
  ])("fails closed when the exact uploaded bundle identity is absent: %j", async ({ bundles }) => {
    const { tool, fake } = await setup({ gateway: { bundles } });

    await expect(tool.tool.execute({}, {})).rejects.toMatchObject({
      name: "ReleaseError",
      code: "UPLOADED_BUNDLE_NOT_FOUND",
    });
    expect(fake.events).toEqual(["getEdit", "listBundles"]);
    expect(fake.getTrack).not.toHaveBeenCalled();
  });

  it("fails safely when bundle-list read fails and does not read a track", async () => {
    const upstream = new Error("PRIVATE-BUNDLE-LIST-DETAIL");
    const { tool, fake } = await setup({ gateway: { listBundlesError: upstream } });

    const failure = await tool.tool.execute({}, {}).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ code: "BUNDLE_LIST_FAILED", cause: upstream });
    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error)
      expect(failure.message).not.toContain("PRIVATE-BUNDLE-LIST-DETAIL");
    expect(fake.getTrack).not.toHaveBeenCalled();
  });

  it("uses the exact operator-bound target track without case normalization or substitution", async () => {
    const customTrack = "wear:production";
    const { tool, fake } = await setup({
      targetTrack: customTrack,
      gateway: { track: track([{ status: "completed", versionCodes: ["100"] }], customTrack) },
    });

    const result = await tool.tool.execute({}, {});

    expect(fake.getTrack).toHaveBeenCalledWith(
      { packageName, editId, expiryTimeSeconds },
      customTrack,
    );
    expect(result.targetTrack).toBe(customTrack);
  });

  it("rejects a returned track identity mismatch before comparison", async () => {
    const { tool, fake } = await setup({
      gateway: { track: track([{ status: "completed", versionCodes: ["1"] }], "internal") },
    });

    await expect(tool.tool.execute({}, {})).rejects.toMatchObject({
      name: "ReleaseError",
      code: "TRACK_MISMATCH",
    });
    expect(fake.getTrack).toHaveBeenCalledWith(
      { packageName, editId, expiryTimeSeconds },
      "production",
    );
  });

  it("maps an absent or unreadable target track to a safe domain failure", async () => {
    const upstream = new Error("PRIVATE-TRACK-READ-DETAIL");
    const { tool, fake } = await setup({ gateway: { getTrackError: upstream } });

    const failure = await tool.tool.execute({}, {}).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ code: "TRACK_READ_FAILED", cause: upstream });
    if (failure instanceof Error)
      expect(failure.message).not.toContain("PRIVATE-TRACK-READ-DETAIL");
    expect(fake.events).toEqual(["getEdit", "listBundles", "getTrack"]);
  });

  it("accepts an existing empty target track without inventing remote zero", async () => {
    const { tool } = await setup({ gateway: { track: track([]) } });

    await expect(tool.tool.execute({}, {})).resolves.toEqual({
      targetTrack: "production",
      uploadedVersionCode: "101",
      currentMaxVersionCode: null,
      comparison: "no-current-version",
      verified: true,
    });
  });

  it("allows only a strictly greater code and blocks equal or lower codes", async () => {
    const greater = await setup({
      bundle: { versionCode: "101", sha256: bundleHash },
      gateway: { track: track([{ status: "completed", versionCodes: ["100"] }]) },
    });
    await expect(greater.tool.tool.execute({}, {})).resolves.toMatchObject({
      comparison: "greater",
    });

    const equal = await setup({
      bundle: { versionCode: "100", sha256: bundleHash },
      gateway: {
        bundles: [{ versionCode: "100", sha256: bundleHash }],
        track: track([{ status: "completed", versionCodes: ["100"] }]),
      },
    });
    await expect(equal.tool.tool.execute({}, {})).rejects.toMatchObject({
      name: "ReleaseError",
      code: "VERSION_CODE_NOT_GREATER",
    });

    const lower = await setup({
      bundle: { versionCode: "99", sha256: bundleHash },
      gateway: {
        bundles: [{ versionCode: "99", sha256: bundleHash }],
        track: track([{ status: "completed", versionCodes: ["100"] }]),
      },
    });
    await expect(lower.tool.tool.execute({}, {})).rejects.toMatchObject({
      name: "ReleaseError",
      code: "VERSION_CODE_NOT_GREATER",
    });
  });

  it("fails session preflight before bundle or track reads", async () => {
    const missing = await setup({ seededSession: false });
    await expect(missing.tool.tool.execute({}, {})).rejects.toMatchObject({
      code: "EDIT_SESSION_REQUIRED",
    });
    expect(missing.fake.events).toEqual([]);

    const expired = await setup({ seededSession: session({ expiryTimeSeconds: "1700000000" }) });
    await expect(expired.tool.tool.execute({}, {})).rejects.toMatchObject({
      code: "EDIT_SESSION_EXPIRED",
    });
    expect(expired.fake.events).toEqual([]);

    const mismatchDir = makeDir();
    const mismatchedStore = createFileReleaseEditSessionStore(join(mismatchDir, "other.json"), {
      expectedPackageName: otherPackageName,
    });
    await mismatchedStore.save(session({ packageName: otherPackageName }));
    const mismatchGateway = fakeGateway();
    const mismatchTool = createReleaseVersionCodeVerificationTool({
      packageName,
      targetTrack: "production",
      uploadedBundle,
      gateway: mismatchGateway.gateway,
      sessionStore: mismatchedStore,
      now: clock,
    });
    await expect(mismatchTool.tool.execute({}, {})).rejects.toMatchObject({
      code: "EDIT_SESSION_PACKAGE_MISMATCH",
    });
    expect(mismatchGateway.events).toEqual([]);
  });

  it("fails when the remote edit no longer matches and never reads bundles or track", async () => {
    const { tool, fake } = await setup({
      gateway: { remoteEdit: { id: "different-edit", expiryTimeSeconds } },
    });

    await expect(tool.tool.execute({}, {})).rejects.toMatchObject({ code: "EDIT_SESSION_INVALID" });
    expect(fake.events).toEqual(["getEdit"]);
  });

  it("serializes only the safe success allowlist and validates its output schema", async () => {
    const { tool } = await setup();
    const result = await tool.tool.execute({}, {});
    const verification = {
      toolName: RELEASES_VERIFY_VERSION_CODE_TOOL_NAME,
      permission: "read",
      required: false,
      status: "skipped",
      code: "VERIFICATION_SKIPPED",
      verified: false,
    } as const;

    const serialized = tool.binding.serializeResult(result, verification);
    expect(JSON.parse(serialized)).toEqual({
      targetTrack: "production",
      uploadedVersionCode: "101",
      currentMaxVersionCode: null,
      comparison: "no-current-version",
      verified: true,
    });
    expect(serialized).not.toContain(bundleHash);
    expect(serialized).not.toContain(editId);
    expect(serialized).not.toContain("sessionPath");
    expect(() =>
      tool.tool.outputSchema.parse({ ...result, localArtifactPath: "/secret/a.aab" }),
    ).toThrow();
  });

  it("source-excludes every prohibited mutation call from the Phase 4.4 tool", () => {
    const source = readFileSync(join(process.cwd(), "src/releases/version-code-tool.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/(^|[^:])\/\/.*$/gmu, "$1")
      .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gu, '""');

    expect(source).not.toMatch(/edits\.insert|bundles\.upload|tracks\.(?:update|patch|create)/u);
    expect(source).not.toMatch(/edits\.(?:validate|commit|delete)|reviews\.reply/u);
    expect(source).not.toMatch(
      /\b(?:createEdit|uploadBundle|updateTrack|patchTrack|createTrack|validateEdit|commitEdit|deleteEdit|replyToReview)\s*\(/u,
    );
  });
});

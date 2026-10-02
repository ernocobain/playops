import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateToolPermission } from "../src/runtime/permissions/index.js";
import { ToolRegistry } from "../src/runtime/tools/index.js";
import {
  RELEASE_STATUSES,
  normalizeReleaseTracks,
  ReleaseError,
  type GooglePlayEditSession,
  type ReleaseEditSession,
  type ReleaseTrackState,
} from "../src/releases/index.js";
import type { ReleaseTargetTrackInspectionGateway } from "../src/releases/gateway.js";
import {
  createFileReleaseEditSessionStore,
  type ReleaseEditSessionStore,
} from "../src/releases/session-store.js";
import {
  createReleaseTargetTrackInspectionTool,
  RELEASES_INSPECT_TARGET_TRACK_TOOL_NAME,
} from "../src/releases/target-track-tool.js";

const packageName = "com.example.release";
const editId = "edit-target-track";
const expiryTimeSeconds = "1900000000";
const fixedNow = new Date("2026-09-29T04:00:00.000Z");
const clock = (): Date => new Date(fixedNow);
const rawMarker = "RAW-TARGET-TRACK-OBJECT-MARKER";
let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs = [];
});

function makeDir(): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "playops-target-track-"));
  tempDirs.push(dir);
  return dir;
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

function normalizedTrack(
  releases: readonly Record<string, unknown>[] = [],
  trackName = "production",
): ReleaseTrackState {
  const [normalized] = normalizeReleaseTracks([{ track: trackName, releases }]);
  if (!normalized) throw new Error("target-track fixture did not normalize");
  return normalized;
}

interface FakeGatewayOptions {
  readonly remoteEdit?: { readonly id: string; readonly expiryTimeSeconds?: string };
  readonly getEditError?: unknown;
  readonly track?: unknown;
  readonly getTrackError?: unknown;
}

function fakeGateway(options: FakeGatewayOptions = {}) {
  const events: string[] = [];
  const getEdit = vi.fn(async (_session: GooglePlayEditSession) => {
    events.push("getEdit");
    if (options.getEditError) throw options.getEditError;
    return options.remoteEdit ?? { id: editId, expiryTimeSeconds };
  });
  const getTrack = vi.fn(async (_session: GooglePlayEditSession, targetTrack: string) => {
    events.push("getTrack");
    if (options.getTrackError) throw options.getTrackError;
    const returned = Object.prototype.hasOwnProperty.call(options, "track")
      ? options.track
      : { track: targetTrack, releases: [], serverOnly: rawMarker };
    return returned as ReleaseTrackState;
  });
  const gateway: ReleaseTargetTrackInspectionGateway = { getEdit, getTrack };
  return { gateway, events, getEdit, getTrack };
}

async function setup(
  options: {
    readonly seededSession?: ReleaseEditSession | false;
    readonly targetTrack?: string;
    readonly gateway?: FakeGatewayOptions;
  } = {},
): Promise<{
  readonly tool: ReturnType<typeof createReleaseTargetTrackInspectionTool>;
  readonly store: ReleaseEditSessionStore;
  readonly fake: ReturnType<typeof fakeGateway>;
}> {
  const dir = makeDir();
  const store = createFileReleaseEditSessionStore(join(dir, "edit-session.json"), {
    expectedPackageName: packageName,
  });
  if (options.seededSession !== false) await store.save(options.seededSession ?? session());
  const fake = fakeGateway(options.gateway);
  const tool = createReleaseTargetTrackInspectionTool({
    packageName,
    targetTrack: options.targetTrack ?? "production",
    sessionStore: store,
    gateway: fake.gateway,
    now: clock,
  });
  return { tool, store, fake };
}

describe("normalized target-track release model", () => {
  it("normalizes country targeting and in-app update priority", () => {
    const [track] = normalizeReleaseTracks([
      {
        track: "production",
        releases: [
          {
            status: "inProgress",
            versionCodes: ["100", "101"],
            userFraction: 0.25,
            countryTargeting: { countries: ["US", "ID"], includeRestOfWorld: false },
            inAppUpdatePriority: 5,
          },
        ],
      },
    ]);

    expect(track).toEqual({
      track: "production",
      releases: [
        {
          status: "inProgress",
          versionCodes: ["100", "101"],
          userFraction: 0.25,
          countryTargeting: { countries: ["US", "ID"], includeRestOfWorld: false },
          inAppUpdatePriority: 5,
        },
      ],
    });
  });

  it("omits absent optional targeting and priority without inventing values", () => {
    expect(
      normalizeReleaseTracks([
        { track: "production", releases: [{ status: "completed", versionCodes: ["1"] }] },
      ]),
    ).toEqual([{ track: "production", releases: [{ status: "completed", versionCodes: ["1"] }] }]);
  });

  it.each(RELEASE_STATUSES)("accepts supported status %s", (status) => {
    expect(
      normalizeReleaseTracks([{ track: "production", releases: [{ status, versionCodes: [] }] }]),
    ).toEqual([{ track: "production", releases: [{ status, versionCodes: [] }] }]);
  });

  it("preserves release order, version-code order, names, and notes", () => {
    const [track] = normalizeReleaseTracks([
      {
        track: "production",
        releases: [
          {
            name: "first",
            status: "draft",
            versionCodes: ["100", "101"],
            releaseNotes: [
              { language: "en-us", text: "First" },
              { language: "id-ID", text: "Pertama" },
            ],
          },
          { name: "second", status: "completed", versionCodes: ["99"] },
        ],
      },
    ]);

    expect(track?.releases.map((release) => release.name)).toEqual(["first", "second"]);
    expect(track?.releases[0]?.versionCodes).toEqual(["100", "101"]);
    expect(track?.releases[0]?.releaseNotes).toEqual([
      { language: "en-US", text: "First" },
      { language: "id-ID", text: "Pertama" },
    ]);
  });

  it.each([
    ["inProgress", 0.01],
    ["inProgress", 0.99],
    ["halted", 0.5],
  ] as const)("accepts valid staged fraction %s/%s", (status, userFraction) => {
    expect(
      normalizeReleaseTracks([{ track: "production", releases: [{ status, userFraction }] }]),
    ).toEqual([{ track: "production", releases: [{ status, versionCodes: [], userFraction }] }]);
  });

  it.each([
    ["draft", 0.5],
    ["completed", 0.5],
    ["statusUnspecified", 0.5],
    ["inProgress", 0],
    ["inProgress", 1],
    ["halted", -0.1],
    ["halted", Number.NaN],
    ["halted", Number.POSITIVE_INFINITY],
    ["halted", "0.5"],
  ] as const)("rejects structurally invalid staged fraction %s/%s", (status, userFraction) => {
    expect(() =>
      normalizeReleaseTracks([{ track: "production", releases: [{ status, userFraction }] }]),
    ).toThrowError(ReleaseError);
  });

  it.each([0, 5])("accepts in-app update priority %s", (priority) => {
    expect(
      normalizeReleaseTracks([
        { track: "production", releases: [{ status: "completed", inAppUpdatePriority: priority }] },
      ]),
    ).toEqual([
      {
        track: "production",
        releases: [{ status: "completed", versionCodes: [], inAppUpdatePriority: priority }],
      },
    ]);
  });

  it.each([-1, 6, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3"])(
    "rejects malformed in-app update priority %s",
    (priority) => {
      expect(() =>
        normalizeReleaseTracks([
          {
            track: "production",
            releases: [{ status: "completed", inAppUpdatePriority: priority }],
          },
        ]),
      ).toThrowError(ReleaseError);
    },
  );

  it("rejects malformed country targeting while preserving valid country order", () => {
    expect(
      normalizeReleaseTracks([
        {
          track: "production",
          releases: [
            {
              status: "inProgress",
              countryTargeting: { countries: ["ID", "US"], includeRestOfWorld: true },
            },
          ],
        },
      ]),
    ).toEqual([
      {
        track: "production",
        releases: [
          {
            status: "inProgress",
            versionCodes: [],
            countryTargeting: { countries: ["ID", "US"], includeRestOfWorld: true },
          },
        ],
      },
    ]);

    for (const countryTargeting of [
      null,
      {},
      { countries: "US", includeRestOfWorld: true },
      { countries: ["USA"], includeRestOfWorld: true },
      { countries: ["US", 7], includeRestOfWorld: true },
      { countries: ["US"], includeRestOfWorld: "yes" },
    ]) {
      expect(() =>
        normalizeReleaseTracks([
          { track: "production", releases: [{ status: "inProgress", countryTargeting }] },
        ]),
      ).toThrowError(ReleaseError);
    }
  });

  it("rejects malformed statuses, notes, and version codes", () => {
    for (const status of ["ready", "production", null, 1]) {
      expect(() =>
        normalizeReleaseTracks([{ track: "production", releases: [{ status }] }]),
      ).toThrowError(ReleaseError);
    }
    for (const releaseNotes of ["not-array", [null], [{}], [{ language: "en", text: 7 }]]) {
      expect(() =>
        normalizeReleaseTracks([
          { track: "production", releases: [{ status: "completed", releaseNotes }] },
        ]),
      ).toThrowError(ReleaseError);
    }
    for (const versionCodes of [[12], ["0"], ["01"], ["9223372036854775808"], "12"]) {
      expect(() =>
        normalizeReleaseTracks([
          { track: "production", releases: [{ status: "completed", versionCodes }] },
        ]),
      ).toThrowError(ReleaseError);
    }
  });

  it("drops arbitrary Google fields and keeps the snapshot safe", () => {
    const [track] = normalizeReleaseTracks([
      {
        track: "production",
        rawTrackField: rawMarker,
        releases: [
          {
            status: "halted",
            versionCodes: ["8"],
            countryTargeting: { countries: ["US"], includeRestOfWorld: false },
            inAppUpdatePriority: 2,
            rawReleaseField: rawMarker,
          },
        ],
      },
    ]);
    expect(JSON.stringify(track)).not.toContain(rawMarker);
  });
});

describe("releases.inspect_target_track tool contract", () => {
  it.each([
    "production",
    "beta",
    "qa",
    "closed-track-2026",
    "wear:production",
    "automotive:production",
    "tv:production",
    "android_xr:production",
    "google_play_games_pc:production",
  ])("accepts and preserves operator target %s", async (targetTrack) => {
    const { tool, fake } = await setup({
      targetTrack,
      gateway: { track: normalizedTrack([], targetTrack) },
    });
    await expect(tool.tool.execute({}, {})).resolves.toMatchObject({
      targetTrack,
      confirmed: true,
      releases: [],
    });
    expect(fake.getTrack).toHaveBeenCalledWith(
      { packageName, editId, expiryTimeSeconds },
      targetTrack,
    );
  });

  it("preserves case and internal characters without lowercasing or alias rewriting", async () => {
    const targetTrack = "Wear:Production";
    const { tool, fake } = await setup({
      targetTrack,
      gateway: { track: normalizedTrack([], targetTrack) },
    });
    await expect(tool.tool.execute({}, {})).resolves.toMatchObject({ targetTrack });
    expect(fake.getTrack).toHaveBeenCalledWith(
      { packageName, editId, expiryTimeSeconds },
      "Wear:Production",
    );
  });

  it.each(["", "   ", " production", "production ", "\tproduction"])(
    "rejects invalid target identifier %j at composition boundary",
    (targetTrack) => {
      const dir = makeDir();
      const store = createFileReleaseEditSessionStore(join(dir, "session.json"), {
        expectedPackageName: packageName,
      });
      const fake = fakeGateway();
      expect(() =>
        createReleaseTargetTrackInspectionTool({
          packageName,
          targetTrack,
          sessionStore: store,
          gateway: fake.gateway,
          now: clock,
        }),
      ).toThrowError(ReleaseError);
    },
  );

  it("registers as read with no verifier, no approval, and empty authoritative input", async () => {
    const { tool, fake } = await setup();
    const registry = new ToolRegistry();
    registry.register(tool.tool);
    const registered = registry.get(RELEASES_INSPECT_TARGET_TRACK_TOOL_NAME);
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
      { targetTrack: "beta" },
      { packageName },
      { editId },
      { sessionPath: "/operator/session.json" },
      { releaseStatus: "draft" },
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

  it("performs session preflight before the exact target-track read", async () => {
    const { tool, fake } = await setup({
      targetTrack: "wear:production",
      gateway: { track: normalizedTrack([], "wear:production") },
    });
    await tool.tool.execute({}, {});
    expect(fake.events).toEqual(["getEdit", "getTrack"]);
    expect(fake.getEdit).toHaveBeenCalledWith({ packageName, editId, expiryTimeSeconds });
    expect(fake.getTrack).toHaveBeenCalledWith(
      { packageName, editId, expiryTimeSeconds },
      "wear:production",
    );
  });

  it.each([
    { seededSession: false, code: "EDIT_SESSION_REQUIRED" },
    { seededSession: session({ expiryTimeSeconds: "1700000000" }), code: "EDIT_SESSION_EXPIRED" },
  ] as const)("fails session preflight safely: $code", async ({ seededSession, code }) => {
    const { tool, fake } = await setup({ seededSession });
    await expect(tool.tool.execute({}, {})).rejects.toMatchObject({ code });
    expect(fake.events).toEqual([]);
  });

  it("rejects a package-mismatched session before any Google read", async () => {
    const dir = makeDir();
    const store = createFileReleaseEditSessionStore(join(dir, "session.json"), {
      expectedPackageName: "com.example.other",
    });
    await store.save(session({ packageName: "com.example.other" }));
    const fake = fakeGateway();
    const tool = createReleaseTargetTrackInspectionTool({
      packageName,
      targetTrack: "production",
      sessionStore: store,
      gateway: fake.gateway,
      now: clock,
    });
    await expect(tool.tool.execute({}, {})).rejects.toMatchObject({
      code: "EDIT_SESSION_PACKAGE_MISMATCH",
    });
    expect(fake.events).toEqual([]);
  });

  it("fails when the remote edit no longer matches", async () => {
    const { tool, fake } = await setup({
      gateway: { remoteEdit: { id: "different-edit", expiryTimeSeconds } },
    });
    await expect(tool.tool.execute({}, {})).rejects.toMatchObject({
      code: "EDIT_SESSION_INVALID",
    });
    expect(fake.events).toEqual(["getEdit"]);
  });

  it("confirms the exact returned track identity and preserves all release state", async () => {
    const targetTrack = "production";
    const track = normalizedTrack(
      [
        { status: "statusUnspecified", versionCodes: [] },
        { status: "draft", versionCodes: ["1"] },
        {
          name: "staged",
          status: "inProgress",
          versionCodes: ["100", "101"],
          userFraction: 0.2,
          releaseNotes: [{ language: "en-us", text: "Staged" }],
          countryTargeting: { countries: ["US"], includeRestOfWorld: false },
          inAppUpdatePriority: 5,
        },
        { status: "halted", versionCodes: ["99"], userFraction: 0.4 },
        { status: "completed", versionCodes: ["98"] },
      ],
      targetTrack,
    );
    const { tool } = await setup({ gateway: { track } });
    await expect(tool.tool.execute({}, {})).resolves.toEqual({
      targetTrack,
      confirmed: true,
      releases: track.releases,
    });
  });

  it("preserves an empty track and multiple release order", async () => {
    const track = normalizedTrack([
      { name: "first", status: "draft", versionCodes: ["2"] },
      { name: "second", status: "completed", versionCodes: ["1"] },
    ]);
    const { tool } = await setup({ gateway: { track } });
    const result = await tool.tool.execute({}, {});
    expect(result.releases.map((release) => release.name)).toEqual(["first", "second"]);

    const empty = await setup({ gateway: { track: normalizedTrack([]) } });
    await expect(empty.tool.tool.execute({}, {})).resolves.toEqual({
      targetTrack: "production",
      confirmed: true,
      releases: [],
    });
  });

  it.each([
    { track: undefined, code: "TRACK_MISMATCH" },
    { track: { releases: [] }, code: "TRACK_MISMATCH" },
    { track: { track: "", releases: [] }, code: "TRACK_MISMATCH" },
    { track: { track: "beta", releases: [] }, code: "TRACK_MISMATCH" },
  ])("fails closed for returned identity %j", async ({ track, code }) => {
    const { tool, fake } = await setup({ gateway: { track } });
    await expect(tool.tool.execute({}, {})).rejects.toMatchObject({ code });
    expect(fake.events).toEqual(["getEdit", "getTrack"]);
  });

  it("fails closed for malformed remote release state", async () => {
    const { tool, fake } = await setup({
      gateway: {
        track: {
          track: "production",
          releases: [{ status: "inProgress", userFraction: 1 }],
        },
      },
    });
    await expect(tool.tool.execute({}, {})).rejects.toMatchObject({
      code: "REMOTE_DATA_INVALID",
    });
    expect(fake.events).toEqual(["getEdit", "getTrack"]);
  });

  it("maps an unreadable target track to a safe failure", async () => {
    const cause = new Error("PRIVATE-TRACK-DETAIL");
    const { tool, fake } = await setup({ gateway: { getTrackError: cause } });
    const error = await tool.tool.execute({}, {}).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({ code: "TRACK_READ_FAILED", cause });
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) expect(error.message).not.toContain("PRIVATE-TRACK-DETAIL");
    expect(fake.events).toEqual(["getEdit", "getTrack"]);
  });

  it("serializes only targetTrack, confirmed, and normalized releases", async () => {
    const { tool } = await setup({
      gateway: {
        track: normalizedTrack([
          {
            status: "inProgress",
            versionCodes: ["101"],
            userFraction: 0.2,
            countryTargeting: { countries: ["US"], includeRestOfWorld: false },
            inAppUpdatePriority: 3,
          },
        ]),
      },
    });
    const result = await tool.tool.execute({}, {});
    const serialized = tool.binding.serializeResult(result, {
      toolName: RELEASES_INSPECT_TARGET_TRACK_TOOL_NAME,
      permission: "read",
      required: false,
      status: "skipped",
      code: "VERIFICATION_SKIPPED",
      verified: false,
    });
    expect(JSON.parse(serialized)).toEqual(result);
    expect(serialized).not.toContain(editId);
    expect(serialized).not.toContain(rawMarker);
    expect(() => tool.tool.outputSchema.parse({ ...result, editId })).toThrow();
  });

  it("source-excludes all Phase 4.5 mutation paths and nested LLM use", () => {
    const source = readFileSync(join(process.cwd(), "src/releases/target-track-tool.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/(^|[^:])\/\/.*$/gmu, "$1")
      .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gu, '""');
    expect(source).not.toMatch(/edits\.insert|bundles\.upload|tracks\.(?:update|patch|create)/u);
    expect(source).not.toMatch(/edits\.(?:validate|commit|delete)|reviews\.reply/u);
    expect(source).not.toMatch(/\bcomplete\s*\(/u);
  });
});
